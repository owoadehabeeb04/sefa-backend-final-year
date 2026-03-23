const crypto = require('crypto');

const Category = require('../models/Category');
const Expense = require('../models/Expense');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Income = require('../models/Income');

const aiCategorizationService = require('./aiCategorization.service');
const transferService = require('./transfer.service');
const { isSimilar, normalizeDescription } = require('../utils/stringMatch');

const AI_TIMEOUT_MS = 1500;
const MAX_ISSUES = 50;

const directionToType = (direction) => (direction === 'credit' ? 'income' : 'expense');

const normalizeDirection = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['credit', 'cr', 'income', 'deposit'].includes(normalized)) return 'credit';
  if (['debit', 'dr', 'expense', 'withdrawal'].includes(normalized)) return 'debit';
  return null;
};

const dayKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
};

const amountKey = (amount) => Number(amount || 0).toFixed(2);

const buildScopedExternalId = (scope, externalId) => `${scope}:${externalId}`;

const buildSyntheticExternalId = (transaction) => {
  const hash = crypto.createHash('sha256');
  hash.update(
    [
      dayKey(transaction.postedAt),
      transaction.direction,
      amountKey(transaction.amount),
      normalizeDescription(transaction.description),
      String(transaction.reference || '').trim(),
    ].join('|'),
  );
  return hash.digest('hex').slice(0, 24);
};

const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const withTimeout = async (promise, timeoutMs) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('AI categorization timed out')), timeoutMs);
    }),
  ]);

const pushIssue = (issues, issue) => {
  if (issues.length < MAX_ISSUES) {
    issues.push(issue);
  }
};

const normalizeRecord = (record, context, index) => {
  const postedAt = new Date(record.postedAt || record.date || record.createdAt || Date.now());
  if (Number.isNaN(postedAt.getTime())) {
    return {
      error: {
        stage: 'normalize',
        message: `Row ${index + 1}: invalid or missing date`,
      },
    };
  }

  const direction = normalizeDirection(record.direction || record.type);
  if (!direction) {
    return {
      error: {
        stage: 'normalize',
        message: `Row ${index + 1}: unable to determine whether the transaction is debit or credit`,
      },
    };
  }

  const amount = Math.abs(Number(record.amount || 0));
  if (!amount || amount <= 0) {
    return {
      error: {
        stage: 'normalize',
        message: `Row ${index + 1}: invalid amount`,
      },
    };
  }

  const description = String(record.description || record.narration || record.details || record.source || '').trim();
  if (!description) {
    return {
      error: {
        stage: 'normalize',
        message: `Row ${index + 1}: missing description`,
      },
    };
  }

  const rawExternalId = String(
    record.mappingExternalId || record.externalId || record.reference || record.transactionId || '',
  ).trim();

  const normalized = {
    amount,
    description,
    direction,
    postedAt,
    provider: record.provider || context.provider || null,
    rawData: record.rawData || record.rawRef || record,
    reference: record.reference || null,
    source: record.source || null,
    sourceIndex: index,
  };

  const mappingExternalId = rawExternalId || buildSyntheticExternalId(normalized);
  const scope = context.externalIdScope || context.provider || context.sourceType || 'import';

  normalized.mappingExternalId = mappingExternalId;
  normalized.scopedExternalId =
    record.scopedExternalId || buildScopedExternalId(scope, mappingExternalId);

  return { transaction: normalized };
};

const getOrCreateCategory = async (userId, type, name, cache, overrides = {}) => {
  const cacheKey = `${type}:${name}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  let category = await Category.findOne({
    userId,
    type,
    name,
    isActive: true,
  }).select('_id name').lean();

  if (!category) {
    try {
      const created = await Category.create({
        userId,
        type,
        name,
        icon: overrides.icon || 'folder',
        color: overrides.color || '#95A5A6',
        source: 'system',
        isActive: true,
      });
      category = { _id: created._id, name: created.name };
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }

      category = await Category.findOne({
        userId,
        type,
        name,
        isActive: true,
      }).select('_id name').lean();
    }
  }

  cache.set(cacheKey, category);
  return category;
};

const loadUserCategories = async (userId) => {
  const [expenseCategories, incomeCategories] = await Promise.all([
    Category.find({ userId, type: 'expense', isActive: true }).select('_id name').lean(),
    Category.find({ userId, type: 'income', isActive: true }).select('_id name').lean(),
  ]);

  return {
    expense: expenseCategories,
    income: incomeCategories,
  };
};

const resolveCategories = async (entries, userId, options = {}) => {
  const categoryCache = new Map();
  const categoriesByType = await loadUserCategories(userId);
  const aiCandidates = [];
  const resolved = new Array(entries.length);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const type = directionToType(entry.direction);

    if (entry.isTransfer) {
      const category = await getOrCreateCategory(userId, type, 'Transfer', categoryCache, {
        icon: 'swap-horizontal',
        color: '#16A34A',
      });
      resolved[index] = {
        categoryId: category._id,
        categoryName: category.name,
        usedFallback: false,
      };
      continue;
    }

    const availableCategories = categoriesByType[type];
    const deterministic = aiCategorizationService.getFallbackCategory(
      entry.description,
      type,
      availableCategories,
    );

    if (deterministic?.categoryId && deterministic.confidence !== 'low') {
      resolved[index] = {
        categoryId: deterministic.categoryId,
        categoryName: deterministic.categoryName,
        usedFallback: false,
      };
      continue;
    }

    aiCandidates.push({
      id: String(index),
      description: entry.description,
      amount: entry.amount,
      type,
    });
  }

  if (options.allowAi !== false && aiCandidates.length > 0) {
    try {
      const aiResults = await withTimeout(
        aiCategorizationService.batchCategorizeTransactions(aiCandidates, userId),
        AI_TIMEOUT_MS * Math.max(1, Math.ceil(aiCandidates.length / 5)),
      );

      for (const result of aiResults) {
        const index = Number(result.transactionId);
        if (Number.isNaN(index)) continue;

        if (result.categoryId && result.confidence !== 'low') {
          resolved[index] = {
            categoryId: result.categoryId,
            categoryName: result.categoryName,
            usedFallback: false,
          };
        }
      }
    } catch (_error) {
      // Best effort only.
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    if (resolved[index]) continue;

    const type = directionToType(entries[index].direction);
    const uncategorizedName = type === 'expense' ? 'Uncategorized Expense' : 'Uncategorized Income';
    const category = await getOrCreateCategory(userId, type, uncategorizedName, categoryCache);

    resolved[index] = {
      categoryId: category._id,
      categoryName: category.name,
      usedFallback: true,
    };
  }

  return resolved;
};

const findExistingSourceMappings = async (context, externalIds) => {
  if (!externalIds.length || !context.sourceType || !context.sourceRefId) {
    return new Set();
  }

  const mappings = await ImportedTransactionMap.find({
    userId: context.userId,
    sourceType: context.sourceType,
    sourceRefId: context.sourceRefId,
    externalId: { $in: externalIds },
  }).select('externalId').lean();

  return new Set(mappings.map((entry) => entry.externalId));
};

const findExistingScopedIds = async (userId, scopedExternalIds) => {
  if (!scopedExternalIds.length) {
    return new Set();
  }

  const [expenses, incomes] = await Promise.all([
    Expense.find({ userId, externalId: { $in: scopedExternalIds } }).select('externalId').lean(),
    Income.find({ userId, externalId: { $in: scopedExternalIds } }).select('externalId').lean(),
  ]);

  return new Set([...expenses, ...incomes].map((entry) => entry.externalId));
};

const buildCandidateQuery = (userId, transactions) => {
  const dates = transactions.map((transaction) => transaction.postedAt);
  const amounts = [...new Set(transactions.map((transaction) => transaction.amount))];

  return {
    userId,
    amount: { $in: amounts },
    date: {
      $gte: startOfDay(new Date(Math.min(...dates.map((date) => date.getTime())))),
      $lte: endOfDay(new Date(Math.max(...dates.map((date) => date.getTime())))),
    },
  };
};

const buildComparisonMaps = (candidates) => {
  const exactKeys = new Set();
  const fuzzyGroups = new Map();

  for (const candidate of candidates) {
    const key = [
      dayKey(candidate.date),
      amountKey(candidate.amount),
      normalizeDescription(candidate.description),
    ].join('|');
    exactKeys.add(key);

    const fuzzyKey = [dayKey(candidate.date), amountKey(candidate.amount)].join('|');
    const current = fuzzyGroups.get(fuzzyKey) || [];
    current.push(normalizeDescription(candidate.description));
    fuzzyGroups.set(fuzzyKey, current);
  }

  return { exactKeys, fuzzyGroups };
};

const removeDatabaseDuplicates = async (transactions, context) => {
  if (!transactions.length) {
    return {
      uniqueTransactions: [],
      duplicateCount: 0,
    };
  }

  const existingSourceMappings = await findExistingSourceMappings(
    context,
    transactions.map((transaction) => transaction.mappingExternalId),
  );

  const remaining = [];
  let duplicateCount = 0;

  for (const transaction of transactions) {
    if (existingSourceMappings.has(transaction.mappingExternalId)) {
      duplicateCount += 1;
      continue;
    }
    remaining.push(transaction);
  }

  const existingScopedIds = await findExistingScopedIds(
    context.userId,
    remaining.map((transaction) => transaction.scopedExternalId),
  );

  const byType = {
    expense: remaining.filter((transaction) => directionToType(transaction.direction) === 'expense'),
    income: remaining.filter((transaction) => directionToType(transaction.direction) === 'income'),
  };

  const [expenseCandidates, incomeCandidates] = await Promise.all([
    byType.expense.length
      ? Expense.find(buildCandidateQuery(context.userId, byType.expense)).select('amount description date').lean()
      : [],
    byType.income.length
      ? Income.find(buildCandidateQuery(context.userId, byType.income)).select('amount description date').lean()
      : [],
  ]);

  const expenseMaps = buildComparisonMaps(expenseCandidates);
  const incomeMaps = buildComparisonMaps(incomeCandidates);

  const uniqueTransactions = [];

  for (const transaction of remaining) {
    if (existingScopedIds.has(transaction.scopedExternalId)) {
      duplicateCount += 1;
      continue;
    }

    const maps = directionToType(transaction.direction) === 'expense' ? expenseMaps : incomeMaps;
    const normalizedDescription = normalizeDescription(transaction.description);
    const exactKey = [dayKey(transaction.postedAt), amountKey(transaction.amount), normalizedDescription].join('|');

    if (maps.exactKeys.has(exactKey)) {
      duplicateCount += 1;
      continue;
    }

    const fuzzyKey = [dayKey(transaction.postedAt), amountKey(transaction.amount)].join('|');
    const fuzzyCandidates = maps.fuzzyGroups.get(fuzzyKey) || [];

    if (fuzzyCandidates.some((candidate) => isSimilar(candidate, normalizedDescription, 85))) {
      duplicateCount += 1;
      continue;
    }

    uniqueTransactions.push(transaction);
  }

  return {
    uniqueTransactions,
    duplicateCount,
  };
};

const prepareTransactions = async (records, context) => {
  const issues = [];
  const seenMappingExternalIds = new Set();
  const normalizedTransactions = [];
  let invalidCount = 0;
  let internalDuplicateCount = 0;

  for (let index = 0; index < records.length; index += 1) {
    const { transaction, error } = normalizeRecord(records[index], context, index);
    if (error) {
      invalidCount += 1;
      pushIssue(issues, error);
      continue;
    }

    if (seenMappingExternalIds.has(transaction.mappingExternalId)) {
      internalDuplicateCount += 1;
      pushIssue(issues, {
        externalId: transaction.mappingExternalId,
        stage: 'deduplicate',
        message: 'Duplicate transaction found within the same import batch',
      });
      continue;
    }

    seenMappingExternalIds.add(transaction.mappingExternalId);
    normalizedTransactions.push(transaction);
  }

  const deduped = await removeDatabaseDuplicates(normalizedTransactions, context);
  return {
    uniqueTransactions: deduped.uniqueTransactions,
    duplicateCount: internalDuplicateCount + deduped.duplicateCount,
    skippedCount: invalidCount,
    issues,
  };
};

const buildEntries = (transactions) => {
  const transferDetection = transferService.detectTransfers(transactions);
  const entries = [];

  for (let index = 0; index < (transferDetection.pairs || []).length; index += 1) {
    const pair = transferDetection.pairs[index];
    const pairKey = `pair-${index}`;
    entries.push({
      ...pair.debit,
      isTransfer: true,
      pairKey,
    });
    entries.push({
      ...pair.credit,
      isTransfer: true,
      pairKey,
    });
  }

  for (const transaction of transferDetection.unmatchedDebits || []) {
    entries.push({
      ...transaction,
      isTransfer: false,
      pairKey: null,
    });
  }

  for (const transaction of transferDetection.unmatchedCredits || []) {
    entries.push({
      ...transaction,
      isTransfer: false,
      pairKey: null,
    });
  }

  return {
    entries,
    pairCount: transferDetection.pairCount || 0,
  };
};

const upsertDocuments = async (Model, docs, userId) => {
  if (!docs.length) {
    return new Map();
  }

  await Model.bulkWrite(
    docs.map((document) => ({
      updateOne: {
        filter: {
          userId,
          externalId: document.externalId,
        },
        update: {
          $setOnInsert: document,
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  const persisted = await Model.find({
    userId,
    externalId: { $in: docs.map((document) => document.externalId) },
  }).select('_id externalId').lean();

  return new Map(persisted.map((document) => [document.externalId, document._id]));
};

const ingestTransactions = async (input, context, options = {}) => {
  const issues = [];
  const result = {
    totalReceived: input.length,
    validCount: 0,
    importedCount: 0,
    duplicateCount: 0,
    transferCount: 0,
    skippedCount: 0,
    failedCount: 0,
    issues,
  };

  if (typeof options.onStage === 'function') {
    await options.onStage('normalize');
  }

  const prepared = await prepareTransactions(input, context);
  result.validCount = prepared.uniqueTransactions.length;
  result.duplicateCount = prepared.duplicateCount;
  result.skippedCount = prepared.skippedCount;
  prepared.issues.forEach((issue) => pushIssue(issues, issue));

  if (!prepared.uniqueTransactions.length) {
    return result;
  }

  if (typeof options.onStage === 'function') {
    await options.onStage('deduplicate');
  }

  const { entries, pairCount } = buildEntries(prepared.uniqueTransactions);
  result.transferCount = pairCount;

  if (typeof options.onStage === 'function') {
    await options.onStage('categorize');
  }

  const categories = await resolveCategories(entries, context.userId, {
    allowAi: options.allowAi !== false,
  });

  const expenseDocs = [];
  const incomeDocs = [];
  const entryDescriptors = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const category = categories[index];
    const common = {
      userId: context.userId,
      categoryId: category.categoryId,
      amount: entry.amount,
      description: entry.description,
      date: entry.postedAt,
      paymentMethod: 'bank_transfer',
      isImported: true,
      importJobId: context.importJobId || null,
      externalId: entry.scopedExternalId,
      isTransfer: Boolean(entry.isTransfer),
      transferPairId: null,
    };

    if (directionToType(entry.direction) === 'expense') {
      expenseDocs.push(common);
      entryDescriptors.push({
        kind: 'expense',
        externalId: entry.scopedExternalId,
        mappingExternalId: entry.mappingExternalId,
        pairKey: entry.pairKey,
        rawData: entry.rawData,
      });
    } else {
      incomeDocs.push({
        ...common,
        source: entry.isTransfer ? 'Transfer' : entry.source || entry.description,
      });
      entryDescriptors.push({
        kind: 'income',
        externalId: entry.scopedExternalId,
        mappingExternalId: entry.mappingExternalId,
        pairKey: entry.pairKey,
        rawData: entry.rawData,
      });
    }
  }

  if (typeof options.onStage === 'function') {
    await options.onStage('save');
  }

  const [expenseIds, incomeIds] = await Promise.all([
    upsertDocuments(Expense, expenseDocs, context.userId),
    upsertDocuments(Income, incomeDocs, context.userId),
  ]);

  const pairIds = new Map();
  const mappingOps = [];

  for (const descriptor of entryDescriptors) {
    const transactionId =
      descriptor.kind === 'expense'
        ? expenseIds.get(descriptor.externalId)
        : incomeIds.get(descriptor.externalId);

    if (!transactionId) {
      result.failedCount += 1;
      pushIssue(issues, {
        externalId: descriptor.mappingExternalId,
        stage: 'save',
        message: 'Failed to resolve the saved transaction for mapping',
      });
      continue;
    }

    result.importedCount += 1;

    if (descriptor.pairKey) {
      const currentPair = pairIds.get(descriptor.pairKey) || {};
      currentPair[descriptor.kind] = transactionId;
      pairIds.set(descriptor.pairKey, currentPair);
    }

    mappingOps.push({
      updateOne: {
        filter: {
          userId: context.userId,
          sourceType: context.sourceType,
          sourceRefId: context.sourceRefId,
          externalId: descriptor.mappingExternalId,
        },
        update: {
          $set: {
            importJobId: context.importJobId || null,
            syncLogId: context.syncLogId || null,
            userId: context.userId,
            sourceType: context.sourceType,
            sourceRefId: context.sourceRefId,
            provider: context.provider || null,
            externalId: descriptor.mappingExternalId,
            expenseId: descriptor.kind === 'expense' ? transactionId : null,
            incomeId: descriptor.kind === 'income' ? transactionId : null,
            rawData: descriptor.rawData,
          },
        },
        upsert: true,
      },
    });
  }

  if (mappingOps.length > 0) {
    await ImportedTransactionMap.bulkWrite(mappingOps, { ordered: false });
  }

  const expensePairOps = [];
  const incomePairOps = [];

  for (const pair of pairIds.values()) {
    if (!pair.expense || !pair.income) continue;
    expensePairOps.push({
      updateOne: {
        filter: { _id: pair.expense },
        update: { $set: { transferPairId: pair.income, isTransfer: true } },
      },
    });
    incomePairOps.push({
      updateOne: {
        filter: { _id: pair.income },
        update: { $set: { transferPairId: pair.expense, isTransfer: true } },
      },
    });
  }

  if (expensePairOps.length > 0) {
    await Expense.bulkWrite(expensePairOps, { ordered: false });
  }

  if (incomePairOps.length > 0) {
    await Income.bulkWrite(incomePairOps, { ordered: false });
  }

  return result;
};

module.exports = {
  buildScopedExternalId,
  buildSyntheticExternalId,
  ingestTransactions,
};
