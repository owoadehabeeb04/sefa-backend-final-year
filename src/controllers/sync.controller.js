const syncScheduler = require('../services/syncScheduler.service');
const SyncLog = require('../models/SyncLog');
const BankConnection = require('../models/BankConnection');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const ACTIVE_STATUSES = new Set(syncScheduler.ACTIVE_SYNC_STATUSES);

const buildLatestSyncPayload = (syncLog) => {
  if (!syncLog) return null;

  return {
    syncLogId: syncLog._id,
    status: syncLog.status,
    phase: syncLog.phase,
    startedAt: syncLog.startedAt,
    completedAt: syncLog.completedAt,
    duration: syncLog.duration,
    cancelRequested: syncLog.cancelRequested,
    results: {
      totalFetched: syncLog.results?.totalFetched || 0,
      importedCount: syncLog.results?.importedCount ?? syncLog.results?.newTransactions ?? 0,
      duplicateCount: syncLog.results?.duplicateCount ?? syncLog.results?.duplicates ?? 0,
      skippedCount: syncLog.results?.skippedCount || 0,
      failedCount: syncLog.results?.failedCount || 0,
      transferCount: syncLog.results?.transferCount ?? syncLog.results?.transfers ?? 0,
    },
    error: syncLog.error,
    errorList: syncLog.errorList || [],
    syncType: syncLog.syncType,
  };
};

const getLatestConnectionSync = async (connectionId) =>
  SyncLog.findOne({ connectionId }).sort({ createdAt: -1 }).lean();

/**
 * @desc    Queue sync for all user's active bank connections
 * @route   POST /api/v1/sync/all
 * @access  Private
 */
const syncAllUserConnections = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

  const result = await syncScheduler.syncUserConnections(userId, {
    syncType: 'manual',
    triggeredBy: 'user',
  });

  if (result.totalConnections === 0) {
    return res.status(404).json({
      success: false,
      message: 'No active bank connections found. Please connect a bank account first.',
    });
  }

  res.status(202).json({
    success: true,
    message: result.message,
    data: {
      totalConnections: result.totalConnections,
      queued: result.synced,
      alreadyActive: result.skipped,
      failed: result.failed,
      errors: result.errors,
    },
  });
});

/**
 * @desc    Queue sync for a specific bank connection
 * @route   POST /api/v1/sync/connections/:id
 * @access  Private
 */
const syncConnection = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  const connection = await BankConnection.findOne({
    _id: id,
    userId,
    isActive: true,
  });

  if (!connection) {
    throw new AppError('Bank connection not found or inactive', 404);
  }

  const queuedSync = await syncScheduler.queueConnectionSync(connection, userId, {
    syncType: 'manual',
    triggeredBy: 'user',
    forceSync: true,
    requestMeta: {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    },
  });

  res.status(202).json({
    success: true,
    message: queuedSync.existing ? 'Sync already queued or in progress' : 'Sync queued successfully',
    data: {
      connectionId: connection._id,
      syncLogId: queuedSync.syncLogId,
      status: queuedSync.status,
    },
  });
});

/**
 * @desc    Get sync status for a connection
 * @route   GET /api/v1/sync/connections/:id/status
 * @access  Private
 */
const getSyncStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  const connection = await BankConnection.findOne({
    _id: id,
    userId,
  }).lean();

  if (!connection) {
    throw new AppError('Bank connection not found', 404);
  }

  const latestSync = await getLatestConnectionSync(connection._id);
  const latestSyncPayload = buildLatestSyncPayload(latestSync);

  res.json({
    success: true,
    data: {
      connectionId: connection._id,
      currentSyncLogId: connection.currentSyncLogId || latestSync?._id || null,
      institutionName: connection.institutionName,
      syncStatus: connection.syncStatus,
      phase: latestSync?.phase || (ACTIVE_STATUSES.has(connection.syncStatus) ? connection.syncStatus : 'completed'),
      cancelRequested: connection.cancelRequested,
      lastSyncAt: connection.lastSyncAt,
      lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
      nextSyncAt: connection.nextSyncAt,
      autoSync: connection.autoSync,
      syncInterval: connection.syncInterval,
      errorMessage: connection.lastSyncError,
      lastErrorSummary: connection.lastSyncErrorSummary,
      fetchedCount: latestSync?.results?.totalFetched || 0,
      importedCount: latestSync?.results?.importedCount ?? latestSync?.results?.newTransactions ?? 0,
      duplicateCount: latestSync?.results?.duplicateCount ?? latestSync?.results?.duplicates ?? 0,
      skippedCount: latestSync?.results?.skippedCount || 0,
      failedCount: latestSync?.results?.failedCount || 0,
      startedAt: latestSync?.startedAt,
      finishedAt: latestSync?.completedAt,
      latestSync: latestSyncPayload,
    },
  });
});

/**
 * @desc    Get sync history
 * @route   GET /api/v1/sync/history
 * @access  Private
 */
const getSyncHistory = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const {
    page = 1,
    limit = 20,
    status,
    connectionId,
  } = req.query;

  const result = await SyncLog.getUserSyncHistory(userId, {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    status,
    connectionId,
  });

  res.json({
    success: true,
    data: result.logs.map((log) => ({
      ...log,
      syncLogId: log._id,
      triggerSource: log.syncType,
      results: {
        totalFetched: log.results?.totalFetched || 0,
        importedCount: log.results?.importedCount ?? log.results?.newTransactions ?? 0,
        duplicateCount: log.results?.duplicateCount ?? log.results?.duplicates ?? 0,
        skippedCount: log.results?.skippedCount || 0,
        failedCount: log.results?.failedCount || 0,
        transferCount: log.results?.transferCount ?? log.results?.transfers ?? 0,
      },
    })),
    pagination: result.pagination,
  });
});

/**
 * @desc    Get a specific sync log detail
 * @route   GET /api/v1/sync/logs/:id
 * @access  Private
 */
const getSyncLogDetails = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const syncLog = await syncScheduler.getSyncLogDetails(req.params.id, userId);

  res.json({
    success: true,
    data: {
      ...syncLog,
      syncLogId: syncLog._id,
      triggerSource: syncLog.syncType,
      results: {
        totalFetched: syncLog.results?.totalFetched || 0,
        importedCount: syncLog.results?.importedCount ?? syncLog.results?.newTransactions ?? 0,
        duplicateCount: syncLog.results?.duplicateCount ?? syncLog.results?.duplicates ?? 0,
        skippedCount: syncLog.results?.skippedCount || 0,
        failedCount: syncLog.results?.failedCount || 0,
        transferCount: syncLog.results?.transferCount ?? syncLog.results?.transfers ?? 0,
      },
    },
  });
});

/**
 * @desc    Get sync statistics
 * @route   GET /api/v1/sync/stats
 * @access  Private
 */
const getSyncStatistics = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { days = 30 } = req.query;

  const connections = await BankConnection.find({ userId }).lean();
  const stats = await Promise.all(
    connections.map(async (connection) => ({
      connectionId: connection._id,
      institutionName: connection.institutionName,
      accountNumber: connection.accountNumber,
      ...(await SyncLog.getConnectionStats(connection._id, parseInt(days, 10))),
    })),
  );

  const totalSyncs = stats.reduce((sum, item) => sum + (item.totalSyncs || 0), 0);
  const totalSuccessful = stats.reduce((sum, item) => sum + (item.successful || 0), 0);
  const totalFailed = stats.reduce((sum, item) => sum + (item.failed || 0), 0);
  const totalTransactions = stats.reduce((sum, item) => sum + (item.transactions?.total || 0), 0);

  res.json({
    success: true,
    data: {
      overall: {
        totalSyncs,
        successful: totalSuccessful,
        failed: totalFailed,
        successRate: totalSyncs > 0 ? ((totalSuccessful / totalSyncs) * 100).toFixed(2) : 0,
        totalTransactions,
      },
      byConnection: stats,
      period: {
        days: parseInt(days, 10),
        startDate: new Date(Date.now() - parseInt(days, 10) * 24 * 60 * 60 * 1000),
        endDate: new Date(),
      },
    },
  });
});

/**
 * @desc    Get global sync statistics
 * @route   GET /api/v1/sync/global-stats
 * @access  Private
 */
const getGlobalSyncStats = asyncHandler(async (req, res) => {
  const stats = await syncScheduler.getSyncStats();
  const recentErrors = await SyncLog.getRecentErrors(24);

  res.json({
    success: true,
    data: {
      ...stats,
      recentErrors: recentErrors.map((errorLog) => ({
        syncLogId: errorLog._id,
        userId: errorLog.userId,
        institution: errorLog.connectionId?.institutionName,
        error: errorLog.error?.message,
        occurredAt: errorLog.startedAt,
      })),
    },
  });
});

/**
 * @desc    Retry failed syncs
 * @route   POST /api/v1/sync/retry
 * @access  Private
 */
const retryFailedSyncs = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

  const failedLogs = await SyncLog.find({
    userId,
    status: 'failed',
    'error.retryable': true,
    retryCount: { $lt: 3 },
  })
    .sort({ startedAt: -1 })
    .limit(10);

  if (!failedLogs.length) {
    return res.json({
      success: true,
      message: 'No failed syncs to retry',
      data: {
        retried: 0,
      },
    });
  }

  const seenConnections = new Set();
  let retried = 0;
  let queued = 0;
  let failed = 0;
  const errors = [];

  for (const log of failedLogs) {
    const connectionId = String(log.connectionId);
    if (seenConnections.has(connectionId)) {
      continue;
    }

    seenConnections.add(connectionId);

    const connection = await BankConnection.findOne({
      _id: log.connectionId,
      userId,
      isActive: true,
    });

    if (!connection) {
      continue;
    }

    retried += 1;
    log.retryCount += 1;
    log.syncType = 'retry';
    await log.save();

    try {
      const queuedSync = await syncScheduler.queueConnectionSync(connection, userId, {
        syncType: 'retry',
        triggeredBy: 'system',
        forceSync: true,
      });

      if (!queuedSync.existing) {
        queued += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({
        connectionId: log.connectionId,
        error: error.message,
      });
    }
  }

  res.status(202).json({
    success: true,
    message: `Queued ${queued} retry sync(s)`,
    data: {
      retried,
      queued,
      failed,
      errors,
    },
  });
});

/**
 * @desc    Cancel ongoing or queued sync
 * @route   POST /api/v1/sync/connections/:id/cancel
 * @access  Private
 */
const cancelSync = asyncHandler(async (req, res) => {
  const result = await syncScheduler.cancelQueuedOrActiveSync(req.params.id, req.user.userId);

  res.json({
    success: true,
    message: result.status === 'cancelling' ? 'Sync cancellation requested' : 'Sync cancelled successfully',
    data: result,
  });
});

/**
 * @desc    Update sync settings
 * @route   PATCH /api/v1/sync/connections/:id/settings
 * @access  Private
 */
const updateSyncSettings = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const { autoSync, syncInterval } = req.body;

  const connection = await BankConnection.findOne({
    _id: id,
    userId,
  });

  if (!connection) {
    throw new AppError('Bank connection not found', 404);
  }

  if (autoSync !== undefined) {
    connection.autoSync = autoSync;
  }

  if (syncInterval !== undefined) {
    if (syncInterval < 1 || syncInterval > 168) {
      throw new AppError('Sync interval must be between 1 and 168 hours', 400);
    }
    connection.syncInterval = syncInterval;
  }

  connection.nextSyncAt = connection.autoSync ? syncScheduler.calculateNextSync(connection.syncInterval) : null;
  await connection.save();

  res.json({
    success: true,
    message: 'Sync settings updated successfully',
    data: {
      connectionId: connection._id,
      autoSync: connection.autoSync,
      syncInterval: connection.syncInterval,
      nextSyncAt: connection.nextSyncAt,
    },
  });
});

/**
 * @desc    Clear transactions imported by a specific sync log
 * @route   DELETE /api/v1/sync/history/:id/transactions
 * @access  Private
 */
const clearSyncTransactions = asyncHandler(async (req, res) => {
  const syncLogId = req.params.id;
  const userId = req.user.userId;

  const syncLog = await SyncLog.findOne({ _id: syncLogId, userId }).lean();
  if (!syncLog) {
    throw new AppError('Sync log not found', 404);
  }

  const mappings = await ImportedTransactionMap.find({
    userId,
    $or: [
      { syncLogId: syncLog._id },
      { importJobId: syncLog._id },
      { 'rawData.syncLogId': syncLog._id },
      { 'rawData.syncLogId': String(syncLog._id) },
    ],
  });

  const expenseIds = mappings.filter((mapping) => mapping.expenseId).map((mapping) => mapping.expenseId);
  const incomeIds = mappings.filter((mapping) => mapping.incomeId).map((mapping) => mapping.incomeId);

  await Promise.all([
    expenseIds.length ? Expense.deleteMany({ _id: { $in: expenseIds }, userId }) : Promise.resolve(),
    incomeIds.length ? Income.deleteMany({ _id: { $in: incomeIds }, userId }) : Promise.resolve(),
    mappings.length ? ImportedTransactionMap.deleteMany({ _id: { $in: mappings.map((mapping) => mapping._id) }, userId }) : Promise.resolve(),
  ]);

  res.json({
    success: true,
    message: 'Transactions for this sync were cleared',
    data: {
      syncLogId,
      deletedExpenses: expenseIds.length,
      deletedIncomes: incomeIds.length,
      totalDeleted: expenseIds.length + incomeIds.length,
    },
  });
});

module.exports = {
  syncAllUserConnections,
  syncConnection,
  getSyncStatus,
  getSyncHistory,
  getSyncLogDetails,
  getSyncStatistics,
  getGlobalSyncStats,
  retryFailedSyncs,
  cancelSync,
  updateSyncSettings,
  clearSyncTransactions,
};
