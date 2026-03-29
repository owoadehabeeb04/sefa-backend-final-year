#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongoose = require('mongoose');
const Queue = require('bull');

const connectDB = require('../src/config/database');
const Expense = require('../src/models/Expense');
const Income = require('../src/models/Income');
const ImportedTransactionMap = require('../src/models/ImportedTransactionMap');

const STATEMENT_PROVIDER_PATTERN = /^statement_/i;

const parseArgs = (argv) => {
  const args = new Set(argv.slice(2));
  return {
    apply: args.has('--apply'),
    dryRun: !args.has('--apply') || args.has('--dry-run'),
  };
};

const uniqueObjectIds = (values) => {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const asString = String(value);
    if (seen.has(asString)) {
      continue;
    }

    seen.add(asString);
    result.push(value);
  }

  return result;
};

const uniqueStrings = (values) => {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
};

const getRedisConfig = () => ({
  host: process.env.REDIS_URL?.split('://')[1]?.split(':')[0] || 'localhost',
  port: parseInt(process.env.REDIS_URL?.split(':')[2], 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB, 10) || 0,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const getImportQueueSummary = async () => {
  const queue = new Queue('import-processing', { redis: getRedisConfig() });

  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      queue,
      stats: {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed,
      },
    };
  } catch (error) {
    await queue.close().catch(() => {});
    throw error;
  }
};

const buildStatementMapQuery = (importJobIds) => {
  const or = [
    { sourceType: 'import_job' },
    { provider: STATEMENT_PROVIDER_PATTERN },
    { 'rawData.statementImportJobId': { $exists: true, $ne: null } },
  ];

  if (importJobIds.length) {
    or.push({ importJobId: { $in: importJobIds } });
  }

  return { $or: or };
};

const main = async () => {
  const { apply, dryRun } = parseArgs(process.argv);

  if (apply && dryRun) {
    console.log('Running in apply mode. Changes will be permanent.');
  } else {
    console.log('Running in dry-run mode. No data will be deleted.');
  }

  await connectDB();

  const db = mongoose.connection.db;
  const importJobsCollection = db.collection('importjobs');
  const importDraftRowsCollection = db.collection('importdraftrows');
  const uploadFilesCollection = db.collection('uploads.files');
  const uploadChunksCollection = db.collection('uploads.chunks');

  const importJobs = await importJobsCollection
    .find({}, { projection: { _id: 1, fileId: 1 } })
    .toArray();
  const importJobIds = uniqueObjectIds(importJobs.map((job) => job._id));
  const fileIds = uniqueObjectIds(importJobs.map((job) => job.fileId).filter(Boolean));

  const statementMapQuery = buildStatementMapQuery(importJobIds);
  const mappings = await ImportedTransactionMap.find(statementMapQuery)
    .select('_id expenseId incomeId externalId importJobId provider rawData')
    .lean();

  const mappingIds = uniqueObjectIds(mappings.map((mapping) => mapping._id));
  const mappedExpenseIds = uniqueObjectIds(
    mappings.map((mapping) => mapping.expenseId).filter(Boolean),
  );
  const mappedIncomeIds = uniqueObjectIds(
    mappings.map((mapping) => mapping.incomeId).filter(Boolean),
  );
  const mappedExternalIds = uniqueStrings(mappings.map((mapping) => mapping.externalId));

  const orphanExpenseClauses = [];
  const orphanIncomeClauses = [];

  if (importJobIds.length) {
    orphanExpenseClauses.push({ importJobId: { $in: importJobIds }, isImported: true });
    orphanIncomeClauses.push({ importJobId: { $in: importJobIds }, isImported: true });
  }

  if (mappedExternalIds.length) {
    orphanExpenseClauses.push({ externalId: { $in: mappedExternalIds }, isImported: true });
    orphanIncomeClauses.push({ externalId: { $in: mappedExternalIds }, isImported: true });
  }

  const [orphanExpenses, orphanIncomes, draftRowCount, uploadFileCount] = await Promise.all([
    orphanExpenseClauses.length
      ? Expense.find({ $or: orphanExpenseClauses }).select('_id').lean()
      : [],
    orphanIncomeClauses.length
      ? Income.find({ $or: orphanIncomeClauses }).select('_id').lean()
      : [],
    importDraftRowsCollection.countDocuments({}),
    fileIds.length
      ? uploadFilesCollection.countDocuments({ _id: { $in: fileIds } })
      : 0,
  ]);

  const expenseIdsToDelete = uniqueObjectIds([
    ...mappedExpenseIds,
    ...orphanExpenses.map((doc) => doc._id),
  ]);
  const incomeIdsToDelete = uniqueObjectIds([
    ...mappedIncomeIds,
    ...orphanIncomes.map((doc) => doc._id),
  ]);

  const summary = {
    importJobs: importJobIds.length,
    importDraftRows: draftRowCount,
    importMappings: mappingIds.length,
    expensesToDelete: expenseIdsToDelete.length,
    incomesToDelete: incomeIdsToDelete.length,
    uploadFilesToDelete: uploadFileCount,
  };

  console.log('Cleanup summary:');
  console.table(summary);

  let queue;
  try {
    const queueSummary = await getImportQueueSummary();
    queue = queueSummary.queue;
    console.log('Import queue summary:');
    console.table(queueSummary.stats);
  } catch (error) {
    console.warn('⚠️ Unable to inspect import-processing queue:', error.message);
  }

  if (!apply) {
    if (queue) {
      await queue.close().catch(() => {});
    }
    await mongoose.disconnect();
    return;
  }

  const deletions = await Promise.all([
    expenseIdsToDelete.length
      ? Expense.deleteMany({ _id: { $in: expenseIdsToDelete } })
      : Promise.resolve({ deletedCount: 0 }),
    incomeIdsToDelete.length
      ? Income.deleteMany({ _id: { $in: incomeIdsToDelete } })
      : Promise.resolve({ deletedCount: 0 }),
    mappingIds.length
      ? ImportedTransactionMap.deleteMany({ _id: { $in: mappingIds } })
      : Promise.resolve({ deletedCount: 0 }),
    draftRowCount
      ? importDraftRowsCollection.deleteMany({})
      : Promise.resolve({ deletedCount: 0 }),
    importJobIds.length
      ? importJobsCollection.deleteMany({ _id: { $in: importJobIds } })
      : Promise.resolve({ deletedCount: 0 }),
    fileIds.length
      ? uploadChunksCollection.deleteMany({ files_id: { $in: fileIds } })
      : Promise.resolve({ deletedCount: 0 }),
    fileIds.length
      ? uploadFilesCollection.deleteMany({ _id: { $in: fileIds } })
      : Promise.resolve({ deletedCount: 0 }),
  ]);

  console.log('Deletion results:');
  console.table({
    expensesDeleted: deletions[0].deletedCount || 0,
    incomesDeleted: deletions[1].deletedCount || 0,
    mappingsDeleted: deletions[2].deletedCount || 0,
    draftRowsDeleted: deletions[3].deletedCount || 0,
    importJobsDeleted: deletions[4].deletedCount || 0,
    uploadChunksDeleted: deletions[5].deletedCount || 0,
    uploadFilesDeleted: deletions[6].deletedCount || 0,
  });

  if (queue) {
    try {
      await queue.obliterate({ force: true });
      console.log('✅ Cleared import-processing queue jobs');
    } catch (error) {
      console.warn('⚠️ Unable to purge import-processing queue:', error.message);
    } finally {
      await queue.close().catch(() => {});
    }
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error('❌ Statement import cleanup failed:', error);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect().catch(() => {});
  }
  process.exit(1);
});
