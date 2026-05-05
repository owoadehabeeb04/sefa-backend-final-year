const BankConnection = require('../models/BankConnection');
const SyncLog = require('../models/SyncLog');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Category = require('../models/Category');

const monoService = require('./mono.service');
const { buildScopedExternalId: buildIngestScopedExternalId, ingestTransactions } = require('./transactionIngest.service');
const deduplicationService = require('./deduplication.service');
const transferDetectionService = require('./transfer.service');
const aiCategorizationService = require('./aiCategorization.service');
const AppError = require('../utils/AppError');
const { appendBankAccessAuditLog } = require('./bankAccessAudit.service');
const { applyReadOnlyContract } = require('./bankReadOnly.service');

const ACTIVE_SYNC_STATUSES = ['queued', 'syncing', 'pending', 'processing'];
const MAX_SYNC_ERRORS = 20;
const AI_TIMEOUT_MS = 1500;

const calculateNextSync = (intervalHours = 12) => {
  const parsed = Number(intervalHours);
  const safeHours = Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
  return new Date(Date.now() + safeHours * 60 * 60 * 1000);
};

const buildScopedExternalId = (connectionId, externalId) =>
  buildIngestScopedExternalId(`mono:${String(connectionId)}`, String(externalId));

const withTimeout = async (promise, timeoutMs) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('AI categorization timed out')), timeoutMs);
    }),
  ]);

const normalizeMonoTransaction = (rawTransaction, { connectionId, userId }) => {
  if (!rawTransaction) return null;

  const externalId = String(
    rawTransaction._id ||
      rawTransaction.id ||
      rawTransaction.transactionId ||
      rawTransaction.reference ||
      '',
  ).trim();

  const postedAt = new Date(rawTransaction.date || rawTransaction.createdAt || rawTransaction.postedAt || Date.now());
  if (!externalId || Number.isNaN(postedAt.getTime())) {
    return null;
  }

  const direction = rawTransaction.type === 'credit' ? 'credit' : 'debit';
  const amount = Math.abs(Number(rawTransaction.amount || 0));

  if (!amount || amount <= 0) {
    return null;
  }

  return {
    externalId,
    scopedExternalId: buildScopedExternalId(connectionId, externalId),
    connectionId: String(connectionId),
    userId: String(userId),
    amount,
    postedAt,
    description: String(rawTransaction.narration || rawTransaction.description || 'Bank transaction').trim() || 'Bank transaction',
    direction,
    provider: 'mono',
    type: direction,
    date: postedAt,
    rawRef: {
      monoTransactionId: externalId,
      balance: Number(rawTransaction.balance || 0),
    },
  };
};

const getSyncType = ({ syncType, isInitialSync, triggeredBy }) => {
  if (syncType) return syncType;
  if (isInitialSync) return 'initial_connect';
  if (triggeredBy === 'webhook') return 'webhook';
  if (triggeredBy === 'cron') return 'scheduled';
  return 'manual';
};

const buildConnectionSnapshot = (connection) => ({
  institutionName: connection.institutionName,
  accountNumber: connection.accountNumber,
  accountId: connection.accountId,
  syncInterval: connection.syncInterval,
});

const getActiveSyncLog = async (connectionId) =>
  SyncLog.findOne({
    connectionId,
    status: { $in: ACTIVE_SYNC_STATUSES },
  }).sort({ createdAt: -1 });

const saveConnectionDocument = async (connection) => {
  if (typeof connection?.save === 'function') {
    return connection.save();
  }

  return BankConnection.findByIdAndUpdate(connection._id, connection, {
    new: true,
  });
};

const createSyncLog = async (connection, userId, options = {}) => {
  return SyncLog.create({
    userId,
    connectionId: connection._id,
    syncType: getSyncType(options),
    status: 'queued',
    phase: 'queued',
    syncParams: {
      isInitialSync: Boolean(options.isInitialSync),
      forceSync: Boolean(options.forceSync),
      startDate: options.startDate || undefined,
      endDate: options.endDate || undefined,
    },
    connectionSnapshot: buildConnectionSnapshot(connection),
  metadata: {
    source: 'mono',
    triggeredBy: options.triggeredBy || 'user',
      ipAddress: options.requestMeta?.ipAddress,
      userAgent: options.requestMeta?.userAgent,
    },
  });
};

const getOrCreateCategory = async (userId, type, name, overrides = {}) => {
  let category = await Category.findOne({
    userId,
    type,
    name,
    isActive: true,
  }).select('_id name').lean();

  if (category) return category;

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
    return { _id: created._id, name: created.name };
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

    if (!category) throw error;
    return category;
  }
};

const resolveFallbackCategory = async (userId, type, isTransfer = false) => {
  if (isTransfer) {
    return getOrCreateCategory(userId, type, 'Transfer', {
      icon: 'swap-horizontal',
      color: '#16A34A',
    });
  }

  return getOrCreateCategory(
    userId,
    type,
    type === 'expense' ? 'Uncategorized Expense' : 'Uncategorized Income',
    {
      icon: 'folder',
      color: '#95A5A6',
    },
  );
};

const resolveTransactionCategory = async (transaction, userId, options = {}) => {
  const type = transaction.direction === 'credit' ? 'income' : 'expense';
  const fallbackCategory = await resolveFallbackCategory(userId, type, Boolean(options.isTransfer));

  if (options.isTransfer) {
    return {
      categoryId: fallbackCategory._id,
      categoryName: fallbackCategory.name,
      usedFallback: true,
    };
  }

  try {
    const categorization = await withTimeout(
      aiCategorizationService.categorizeTransaction(
        {
          description: transaction.description,
          amount: transaction.amount,
          type,
        },
        userId,
      ),
      AI_TIMEOUT_MS,
    );

    if (categorization?.categoryId) {
      return {
        categoryId: categorization.categoryId,
        categoryName: categorization.categoryName,
        usedFallback: false,
      };
    }
  } catch (error) {
    console.warn('AI categorization skipped:', error.message);
  }

  return {
    categoryId: fallbackCategory._id,
    categoryName: fallbackCategory.name,
    usedFallback: true,
  };
};

const summarizeSyncResult = (result) => ({
  totalFetched: result.totalFetched,
  importedCount: result.importedCount,
  newTransactions: result.importedCount,
  duplicateCount: result.duplicateCount,
  duplicates: result.duplicateCount,
  transferCount: result.transferCount,
  transfers: result.transferCount,
  skippedCount: result.skippedCount,
  failedCount: result.failedCount,
  errorCount: result.failedCount + result.skippedCount,
});

const determineTerminalStatus = (result, wasCancelled) => {
  if (wasCancelled) return 'cancelled';
  if (result.failedCount > 0 || result.skippedCount > 0) {
    return result.importedCount > 0 ? 'partial_success' : 'failed';
  }
  return 'completed';
};

const findExistingMappingIds = async (userId, connectionId, externalIds) => {
  if (!externalIds.length) return new Set();

  const existingMaps = await ImportedTransactionMap.find({
    userId,
    sourceType: 'bank_connection',
    sourceRefId: connectionId,
    externalId: { $in: externalIds },
  })
    .select('externalId')
    .lean();

  return new Set(existingMaps.map((mapping) => mapping.externalId));
};

const deduplicateTransactions = async (transactions, userId, connectionId) => {
  const result = {
    uniqueTransactions: [],
    duplicateCount: 0,
    skippedCount: 0,
    skippedErrors: [],
  };

  const seenExternalIds = new Set();
  const filtered = [];

  for (const transaction of transactions) {
    if (!transaction?.externalId) {
      result.skippedCount += 1;
      result.skippedErrors.push({
        stage: 'normalizing',
        message: 'Transaction missing provider external ID',
      });
      continue;
    }

    if (seenExternalIds.has(transaction.externalId)) {
      result.duplicateCount += 1;
      continue;
    }

    seenExternalIds.add(transaction.externalId);
    filtered.push(transaction);
  }

  const existingExternalIds = await findExistingMappingIds(
    userId,
    connectionId,
    filtered.map((transaction) => transaction.externalId),
  );

  for (const transaction of filtered) {
    if (existingExternalIds.has(transaction.externalId)) {
      result.duplicateCount += 1;
      continue;
    }

    const duplicateCheck = await deduplicationService.checkDuplicate(
      {
        amount: transaction.amount,
        date: transaction.postedAt,
        description: transaction.description,
        externalId: transaction.scopedExternalId,
        type: transaction.direction === 'credit' ? 'income' : 'expense',
      },
      userId,
    );

    if (duplicateCheck?.isDuplicate) {
      result.duplicateCount += 1;
      continue;
    }

    result.uniqueTransactions.push(transaction);
  }

  return result;
};

const buildMappingPayload = (base, transaction, savedTransaction) => ({
  syncLogId: base.syncLogId,
  userId: base.userId,
  sourceType: 'bank_connection',
  sourceRefId: base.connectionId,
  provider: 'mono',
  expenseId: base.kind === 'expense' ? savedTransaction._id : null,
  incomeId: base.kind === 'income' ? savedTransaction._id : null,
  externalId: transaction.externalId,
  rawData: {
    description: transaction.description,
    amount: transaction.amount,
    postedAt: transaction.postedAt,
    direction: transaction.direction,
    provider: 'mono',
    monoTransactionId: transaction.externalId,
  },
});

const toActorType = (triggeredBy) => {
  if (triggeredBy === 'webhook') return 'webhook';
  if (triggeredBy === 'user') return 'user';
  return 'system';
};

const persistSingleTransaction = async (transaction, context, options = {}) => {
  const transactionType = transaction.direction === 'credit' ? 'income' : 'expense';
  const category = await resolveTransactionCategory(transaction, context.userId, {
    isTransfer: Boolean(options.isTransfer),
  });

  if (transactionType === 'expense') {
    const expense = await Expense.create({
      userId: context.userId,
      categoryId: category.categoryId,
      amount: transaction.amount,
      description: transaction.description,
      date: transaction.postedAt,
      paymentMethod: 'bank_transfer',
      isImported: true,
      externalId: transaction.scopedExternalId,
      isTransfer: Boolean(options.isTransfer),
      transferPairId: options.transferPairId || null,
    });

    try {
      await ImportedTransactionMap.create(
        buildMappingPayload(
          {
            syncLogId: context.syncLogId,
            userId: context.userId,
            connectionId: context.connectionId,
            kind: 'expense',
          },
          transaction,
          expense,
        ),
      );
    } catch (error) {
      await Expense.deleteOne({ _id: expense._id });
      throw error;
    }

    return {
      kind: 'expense',
      categoryName: category.categoryName,
      usedFallbackCategory: category.usedFallback,
      document: expense,
    };
  }

  const income = await Income.create({
    userId: context.userId,
    categoryId: category.categoryId,
    amount: transaction.amount,
    source: options.source || (options.isTransfer ? 'Transfer' : transaction.description),
    description: transaction.description,
    date: transaction.postedAt,
    paymentMethod: 'bank_transfer',
    isImported: true,
    externalId: transaction.scopedExternalId,
    isTransfer: Boolean(options.isTransfer),
    transferPairId: options.transferPairId || null,
  });

  try {
    await ImportedTransactionMap.create(
      buildMappingPayload(
        {
          syncLogId: context.syncLogId,
          userId: context.userId,
          connectionId: context.connectionId,
          kind: 'income',
        },
        transaction,
        income,
      ),
    );
  } catch (error) {
    await Income.deleteOne({ _id: income._id });
    throw error;
  }

  return {
    kind: 'income',
    categoryName: category.categoryName,
    usedFallbackCategory: category.usedFallback,
    document: income,
  };
};

const hasCancellationRequest = async (connectionId, syncLogId) => {
  const [connection, syncLog] = await Promise.all([
    BankConnection.findById(connectionId).select('cancelRequested').lean(),
    SyncLog.findById(syncLogId).select('cancelRequested').lean(),
  ]);

  return Boolean(connection?.cancelRequested || syncLog?.cancelRequested);
};

const queueConnectionSync = async (connectionOrId, userId, options = {}) => {
  const connection =
    typeof connectionOrId === 'object' && connectionOrId?._id
      ? connectionOrId
      : await BankConnection.findOne({
          _id: connectionOrId,
          userId,
          isActive: true,
        });

  if (!connection) {
    throw new AppError('Bank connection not found or inactive', 404);
  }

  const existingSync = await getActiveSyncLog(connection._id);
  if (existingSync) {
    if (options.triggeredBy === 'webhook' && !connection.pendingResync) {
      connection.pendingResync = true;
      await BankConnection.findByIdAndUpdate(connection._id, {
        pendingResync: true,
      });
    }

    if (existingSync.status === 'queued' && connection.syncStatus !== 'queued') {
      connection.syncStatus = 'queued';
      connection.currentSyncLogId = existingSync._id;
      await BankConnection.findByIdAndUpdate(connection._id, {
        syncStatus: 'queued',
        currentSyncLogId: existingSync._id,
      });
    }

    return {
      success: true,
      existing: true,
      status: existingSync.status === 'syncing' ? 'syncing' : 'queued',
      syncLogId: existingSync._id,
      connection,
    };
  }

  const syncLog = await createSyncLog(connection, userId, options);

  connection.syncStatus = 'queued';
  connection.currentSyncLogId = syncLog._id;
  connection.cancelRequested = false;
  await saveConnectionDocument(connection);

  await appendBankAccessAuditLog({
    userId,
    connectionId: connection._id,
    eventType: 'sync_queued',
    actorType: toActorType(options.triggeredBy),
    requestMeta: options.requestMeta || {},
    metadata: {
      syncType: syncLog.syncType,
      syncLogId: syncLog._id,
      triggeredBy: options.triggeredBy || 'user',
    },
  });

  const { addSyncJob } = require('../config/queue');
  const job = await addSyncJob(
    {
      connectionId: String(connection._id),
      userId: String(userId),
      accountId: connection.accountId,
      syncLogId: String(syncLog._id),
      isInitialSync: Boolean(options.isInitialSync),
      forceSync: Boolean(options.forceSync),
      triggeredBy: options.triggeredBy || 'user',
    },
    { jobId: String(syncLog._id) },
  );

  syncLog.queueJobId = String(job.id);
  await syncLog.save();

  return {
    success: true,
    existing: false,
    status: 'queued',
    syncLogId: syncLog._id,
    connection,
  };
};

const runQueuedSync = async (job) => {
  const { connectionId, userId, syncLogId, isInitialSync } = job.data;
  const now = new Date();

  const syncLog = await SyncLog.findOne({
    _id: syncLogId,
    userId,
    connectionId,
  });

  if (!syncLog) {
    throw new Error('Sync log not found for queued sync job');
  }

  const connection = await BankConnection.findOne({
    _id: connectionId,
    userId,
    isActive: true,
  });

  if (!connection) {
    await syncLog.markAsFailed(new Error('Bank connection not found or inactive'));
    throw new Error('Bank connection not found or inactive');
  }

  if (await hasCancellationRequest(connection._id, syncLog._id)) {
    connection.syncStatus = 'cancelled';
    connection.currentSyncLogId = syncLog._id;
    connection.cancelRequested = false;
    connection.lastSyncAt = now;
    connection.lastSyncError = 'Sync cancelled by user';
    connection.lastSyncErrorSummary = 'Sync cancelled before it started';
    await Promise.all([connection.save(), syncLog.markAsCancelled('Sync cancelled before it started')]);
    return {
      success: true,
      status: 'cancelled',
      syncLogId: syncLog._id,
    };
  }

  syncLog.status = 'syncing';
  syncLog.phase = 'fetching';
  syncLog.startedAt = new Date();
  syncLog.queueJobId = String(job.id);
  await syncLog.save();

  connection.syncStatus = 'syncing';
  connection.currentSyncLogId = syncLog._id;
  connection.cancelRequested = false;
  connection.lastSyncAttemptAt = syncLog.startedAt;
  applyReadOnlyContract(connection, { touchSecurityVerifiedAt: true });
  await connection.save();

  await appendBankAccessAuditLog({
    userId,
    connectionId: connection._id,
    eventType: 'sync_started',
    actorType: toActorType(syncLog.metadata?.triggeredBy),
    requestMeta: {
      ipAddress: syncLog.metadata?.ipAddress,
      userAgent: syncLog.metadata?.userAgent,
    },
    metadata: {
      syncType: syncLog.syncType,
      syncLogId: syncLog._id,
    },
  });

  const result = {
    totalFetched: 0,
    importedCount: 0,
    duplicateCount: 0,
    transferCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errors: [],
  };

  const captureError = (errorItem) => {
    if (result.errors.length < MAX_SYNC_ERRORS) {
      result.errors.push(errorItem);
    }
  };

  try {
    let syncStartDate = syncLog.syncParams?.startDate ? new Date(syncLog.syncParams.startDate) : null;
    const syncEndDate = syncLog.syncParams?.endDate ? new Date(syncLog.syncParams.endDate) : new Date();

    if (!syncStartDate || Number.isNaN(syncStartDate.getTime())) {
      if (isInitialSync || syncLog.syncType === 'initial_connect' || !connection.lastSuccessfulSyncAt) {
        syncStartDate = new Date();
        syncStartDate.setMonth(syncStartDate.getMonth() - 3);
      } else {
        syncStartDate = new Date(connection.lastSuccessfulSyncAt || connection.lastSyncAt);
      }
    }

    const monoTransactions = await monoService.getTransactions(connection.accountId, {
      start: syncStartDate,
      end: syncEndDate,
    });

    if (await hasCancellationRequest(connection._id, syncLog._id)) {
      throw Object.assign(new Error('Sync cancelled by user'), { code: 'SYNC_CANCELLED' });
    }

    syncLog.phase = 'normalizing';
    await syncLog.save();

    const normalizedTransactions = monoTransactions
      .map((transaction) => normalizeMonoTransaction(transaction, { connectionId: connection._id, userId }))
      .filter(Boolean);

    result.totalFetched = normalizedTransactions.length;

    syncLog.results.totalFetched = result.totalFetched;
    syncLog.phase = 'normalizing';
    await syncLog.save();

    const stageToPhase = {
      normalize: 'normalizing',
      deduplicate: 'deduplicating',
      categorize: 'categorizing',
      save: 'persisting',
    };

    const ingestResult = await ingestTransactions(
      normalizedTransactions,
      {
        userId,
        sourceType: 'bank_connection',
        sourceRefId: connection._id,
        syncLogId: syncLog._id,
        provider: 'mono',
        externalIdScope: `mono:${String(connection._id)}`,
      },
      {
        onStage: async (stage) => {
          if (await hasCancellationRequest(connection._id, syncLog._id)) {
            throw Object.assign(new Error('Sync cancelled by user'), { code: 'SYNC_CANCELLED' });
          }
          syncLog.phase = stageToPhase[stage] || syncLog.phase;
          await syncLog.save();
        },
      },
    );

    result.importedCount = ingestResult.importedCount;
    result.duplicateCount = ingestResult.duplicateCount;
    result.transferCount = ingestResult.transferCount;
    result.skippedCount = ingestResult.skippedCount;
    result.failedCount = ingestResult.failedCount;
    ingestResult.issues.forEach(captureError);

    const wasCancelled = await hasCancellationRequest(connection._id, syncLog._id);
    const terminalStatus = determineTerminalStatus(result, wasCancelled);
    const summary = summarizeSyncResult(result);

    syncLog.errorList = result.errors;
    if (terminalStatus === 'cancelled') {
      await syncLog.markAsCancelled('Sync cancelled by user');
    } else if (terminalStatus === 'partial_success') {
      await syncLog.markAsPartial(summary);
    } else if (terminalStatus === 'failed') {
      const syncError = new Error(result.errors[0]?.message || 'Sync failed without importing any transactions');
      await syncLog.markAsFailed(syncError);
      syncLog.results = {
        ...syncLog.results,
        ...summary,
      };
      syncLog.errorList = result.errors;
      await syncLog.save();
    } else {
      await syncLog.markAsCompleted(summary);
      syncLog.errorList = result.errors;
      await syncLog.save();
    }

    const followUpNeeded = Boolean(connection.pendingResync) && terminalStatus !== 'cancelled';

    connection.syncStatus = terminalStatus;
    connection.currentSyncLogId = syncLog._id;
    connection.cancelRequested = false;
    connection.pendingResync = false;
    connection.lastSyncAt = new Date();
    connection.nextSyncAt = connection.autoSync ? calculateNextSync(connection.syncInterval) : null;
    connection.lastSyncError = terminalStatus === 'completed' ? null : (result.errors[0]?.message || null);
    connection.lastSyncErrorSummary =
      terminalStatus === 'completed'
        ? null
        : terminalStatus === 'partial_success'
          ? `${result.importedCount} imported, ${result.failedCount + result.skippedCount} issue(s)`
          : result.errors[0]?.message || 'Sync ended with errors';

    if (['completed', 'partial_success'].includes(terminalStatus)) {
      connection.lastSuccessfulSyncAt = connection.lastSyncAt;
    }

    await connection.save();

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: terminalStatus === 'cancelled' ? 'sync_cancelled' : terminalStatus === 'failed' ? 'sync_failed' : 'sync_completed',
      actorType: toActorType(syncLog.metadata?.triggeredBy),
      requestMeta: {
        ipAddress: syncLog.metadata?.ipAddress,
        userAgent: syncLog.metadata?.userAgent,
      },
      metadata: {
        syncType: syncLog.syncType,
        syncLogId: syncLog._id,
        importedCount: result.importedCount,
        duplicateCount: result.duplicateCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount,
        status: terminalStatus,
      },
    });

    if (result.importedCount > 0) {
      const { addNotificationJob } = require('../config/queue');
      await addNotificationJob({
        userId,
        type: 'import_complete',
        urgency: 'instant',
        data: {
          importedCount: result.importedCount,
          duplicateCount: result.duplicateCount,
          institutionName: connection.institutionName,
          source: connection.institutionName || 'Bank Sync',
        },
      });
    }

    if (followUpNeeded) {
      await queueConnectionSync(connection._id, userId, {
        syncType: 'webhook',
        triggeredBy: 'webhook',
        forceSync: true,
      });
    }

    return {
      success: terminalStatus !== 'failed',
      status: terminalStatus,
      syncLogId: syncLog._id,
      ...summary,
    };
  } catch (error) {
    const isCancelled = error.code === 'SYNC_CANCELLED' || /cancel/i.test(error.message || '');
    const summary = summarizeSyncResult(result);

    syncLog.results = {
      ...syncLog.results,
      ...summary,
    };
    syncLog.errorList = result.errors;

    if (isCancelled) {
      await syncLog.markAsCancelled('Sync cancelled by user');
      connection.syncStatus = 'cancelled';
      connection.lastSyncError = 'Sync cancelled by user';
      connection.lastSyncErrorSummary = 'Sync cancelled by user';
    } else {
      await syncLog.markAsFailed(error);
      syncLog.results = {
        ...syncLog.results,
        ...summary,
      };
      syncLog.errorList = result.errors;
      await syncLog.save();
      connection.syncStatus = 'failed';
      connection.lastSyncError = error.message;
      connection.lastSyncErrorSummary = error.message;
    }

    connection.currentSyncLogId = syncLog._id;
    connection.cancelRequested = false;
    connection.lastSyncAt = new Date();
    connection.nextSyncAt = connection.autoSync ? calculateNextSync(connection.syncInterval) : null;
    applyReadOnlyContract(connection, { touchSecurityVerifiedAt: true });
    await connection.save();

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: isCancelled ? 'sync_cancelled' : 'sync_failed',
      actorType: toActorType(syncLog.metadata?.triggeredBy),
      requestMeta: {
        ipAddress: syncLog.metadata?.ipAddress,
        userAgent: syncLog.metadata?.userAgent,
      },
      metadata: {
        syncType: syncLog.syncType,
        syncLogId: syncLog._id,
        error: error.message,
        importedCount: result.importedCount,
        duplicateCount: result.duplicateCount,
      },
    });

    if (isCancelled) {
      return {
        success: true,
        status: 'cancelled',
        syncLogId: syncLog._id,
        ...summary,
      };
    }

    throw error;
  }
};

const syncAllConnections = async (options = {}) => {
  const connections = options.forceSync
    ? await BankConnection.find({ isActive: true, autoSync: true })
    : await BankConnection.getConnectionsForSync();

  if (connections.length === 0) {
    return {
      success: true,
      message: 'No connections due for sync',
      totalConnections: 0,
      synced: 0,
      failed: 0,
      skipped: 0,
    };
  }

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const connection of connections) {
    try {
      const queued = await queueConnectionSync(connection, connection.userId, {
        syncType: 'scheduled',
        triggeredBy: 'cron',
        forceSync: Boolean(options.forceSync),
      });

      if (queued.existing) {
        skipped += 1;
      } else {
        synced += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({
        connectionId: connection._id,
        institutionName: connection.institutionName,
        error: error.message,
      });
    }
  }

  return {
    success: true,
    message: `Queued ${synced} sync(s)`,
    totalConnections: connections.length,
    synced,
    failed,
    skipped,
    errors,
  };
};

const syncUserConnections = async (userId, options = {}) => {
  const connections = await BankConnection.find({
    userId,
    isActive: true,
    autoSync: true,
  });

  if (!connections.length) {
    return {
      success: true,
      message: 'No active connections found',
      totalConnections: 0,
      synced: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };
  }

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const connection of connections) {
    try {
      const queued = await queueConnectionSync(connection, userId, {
        syncType: options.syncType || 'manual',
        triggeredBy: options.triggeredBy || 'user',
        forceSync: true,
      });

      if (queued.existing) {
        skipped += 1;
      } else {
        synced += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({
        connectionId: connection._id,
        institutionName: connection.institutionName,
        error: error.message,
      });
    }
  }

  return {
    success: true,
    message: `Queued ${synced} sync(s)`,
    totalConnections: connections.length,
    synced,
    failed,
    skipped,
    errors,
  };
};

const getSyncStats = async () => {
  const totalConnections = await BankConnection.countDocuments({ isActive: true });
  const autoSyncEnabled = await BankConnection.countDocuments({ isActive: true, autoSync: true });
  const syncingNow = await BankConnection.countDocuments({ isActive: true, syncStatus: { $in: ['queued', 'syncing'] } });
  const errorConnections = await BankConnection.countDocuments({ isActive: true, syncStatus: { $in: ['failed', 'error'] } });
  const dueForSync = await BankConnection.countDocuments({
    isActive: true,
    autoSync: true,
    nextSyncAt: { $lte: new Date() },
    syncStatus: { $nin: ['queued', 'syncing', 'disconnected', 'reauth_required'] },
  });

  return {
    totalConnections,
    autoSyncEnabled,
    syncingNow,
    errorConnections,
    dueForSync,
    lastChecked: new Date(),
  };
};

const cancelQueuedOrActiveSync = async (connectionId, userId) => {
  const connection = await BankConnection.findOne({
    _id: connectionId,
    userId,
  });

  if (!connection) {
    throw new AppError('Bank connection not found', 404);
  }

  const syncLog = connection.currentSyncLogId
    ? await SyncLog.findOne({
        _id: connection.currentSyncLogId,
        userId,
      })
    : await getActiveSyncLog(connection._id);

  if (!syncLog || !ACTIVE_SYNC_STATUSES.includes(syncLog.status)) {
    throw new AppError('No active or queued sync found for this connection', 400);
  }

  if (syncLog.status === 'queued') {
    const { syncQueue } = require('../config/queue');
    const job = await syncQueue.getJob(syncLog.queueJobId || String(syncLog._id));
    if (job) {
      await job.remove();
    }

    await syncLog.markAsCancelled('Sync cancelled before it started');

    connection.syncStatus = 'cancelled';
    connection.cancelRequested = false;
    connection.currentSyncLogId = syncLog._id;
    connection.lastSyncAt = new Date();
    connection.lastSyncError = 'Sync cancelled by user';
    connection.lastSyncErrorSummary = 'Sync cancelled before it started';
    await connection.save();

    return {
      connectionId: connection._id,
      syncLogId: syncLog._id,
      status: 'cancelled',
    };
  }

  syncLog.cancelRequested = true;
  await syncLog.save();

  connection.cancelRequested = true;
  await connection.save();

  return {
    connectionId: connection._id,
    syncLogId: syncLog._id,
    status: 'cancelling',
  };
};

const getSyncLogDetails = async (syncLogId, userId) => {
  const syncLog = await SyncLog.findOne({
    _id: syncLogId,
    userId,
  })
    .populate('connectionId', 'institutionName accountNumber syncStatus lastSyncAt lastSuccessfulSyncAt')
    .lean();

  if (!syncLog) {
    throw new AppError('Sync log not found', 404);
  }

  return syncLog;
};

module.exports = {
  ACTIVE_SYNC_STATUSES,
  calculateNextSync,
  queueConnectionSync,
  runQueuedSync,
  syncAllConnections,
  syncUserConnections,
  getSyncStats,
  cancelQueuedOrActiveSync,
  getSyncLogDetails,
  buildScopedExternalId,
};
