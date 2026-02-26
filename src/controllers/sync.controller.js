const syncScheduler = require('../services/syncScheduler.service');
const SyncLog = require('../models/SyncLog');
const BankConnection = require('../models/BankConnection');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Sync Controller
 * 
 * Handles sync-related API endpoints:
 * - Manual sync triggers
 * - Sync status monitoring
 * - Sync history
 * - Sync statistics
 */

/**
 * @desc    Sync all user's bank connections
 * @route   POST /api/v1/sync/all
 * @access  Private
 */
const syncAllUserConnections = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Create initial sync logs for each connection
  const connections = await BankConnection.find({
    userId,
    isActive: true,
    autoSync: true
  });

  if (connections.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'No active bank connections found. Please connect a bank account first.'
    });
  }

  // Trigger sync
  const result = await syncScheduler.syncUserConnections(userId, {
    forceSync: true
  });

  res.json({
    success: true,
    message: result.message,
    data: {
      totalConnections: result.totalConnections,
      synced: result.synced,
      failed: result.failed,
      errors: result.errors
    }
  });
});

/**
 * @desc    Sync a specific bank connection
 * @route   POST /api/v1/sync/connections/:id
 * @access  Private
 */
const syncConnection = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  // Verify connection ownership
  const connection = await BankConnection.findOne({
    _id: id,
    userId,
    isActive: true
  });

  if (!connection) {
    throw new AppError('Bank connection not found or inactive', 404);
  }

  // Check if already syncing
  if (connection.syncStatus === 'syncing') {
    return res.status(409).json({
      success: false,
      message: 'Sync already in progress for this connection'
    });
  }

  // Create sync log
  const syncLog = await SyncLog.create({
    userId,
    connectionId: connection._id,
    syncType: 'manual',
    status: 'pending',
    syncParams: {
      forceSync: true
    },
    connectionSnapshot: {
      institutionName: connection.institutionName,
      accountNumber: connection.accountNumber,
      accountId: connection.accountId,
      syncInterval: connection.syncInterval
    },
    metadata: {
      triggeredBy: 'user',
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    }
  });

  // Start sync
  try {
    await syncLog.markAsStarted();

    const result = await syncScheduler.syncBankConnection(id, userId, {
      isInitialSync: false,
      forceSync: true
    });

    await syncLog.markAsCompleted({
      totalFetched: result.newTransactions + result.duplicates,
      newTransactions: result.newTransactions,
      duplicates: result.duplicates,
      transfers: result.transfers
    });

    res.json({
      success: true,
      message: result.message,
      data: {
        newTransactions: result.newTransactions,
        duplicates: result.duplicates,
        transfers: result.transfers,
        connection: result.connection,
        syncLogId: syncLog._id
      }
    });
  } catch (error) {
    await syncLog.markAsFailed(error);
    throw error;
  }
});

/**
 * @desc    Get sync status for a connection
 * @route   GET /api/v1/sync/connections/:id/status
 * @access  Private
 */
const getSyncStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const connection = await BankConnection.findOne({
    _id: id,
    userId
  });

  if (!connection) {
    throw new AppError('Bank connection not found', 404);
  }

  // Get latest sync log
  const latestSync = await SyncLog.findOne({
    connectionId: connection._id
  })
    .sort({ startedAt: -1 })
    .lean();

  res.json({
    success: true,
    data: {
      connectionId: connection._id,
      institutionName: connection.institutionName,
      syncStatus: connection.syncStatus,
      lastSyncAt: connection.lastSyncAt,
      nextSyncAt: connection.nextSyncAt,
      autoSync: connection.autoSync,
      syncInterval: connection.syncInterval,
      errorMessage: connection.errorMessage,
      latestSync: latestSync ? {
        syncLogId: latestSync._id,
        status: latestSync.status,
        startedAt: latestSync.startedAt,
        completedAt: latestSync.completedAt,
        duration: latestSync.duration,
        results: latestSync.results,
        error: latestSync.error
      } : null
    }
  });
});

/**
 * @desc    Get sync history
 * @route   GET /api/v1/sync/history
 * @access  Private
 * @query   page, limit, status, connectionId
 */
const getSyncHistory = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const {
    page = 1,
    limit = 20,
    status,
    connectionId
  } = req.query;

  const result = await SyncLog.getUserSyncHistory(userId, {
    page: parseInt(page),
    limit: parseInt(limit),
    status,
    connectionId
  });

  res.json({
    success: true,
    data: result.logs,
    pagination: result.pagination
  });
});

/**
 * @desc    Get sync statistics
 * @route   GET /api/v1/sync/stats
 * @access  Private
 */
const getSyncStatistics = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { days = 30 } = req.query;

  // Get user's connections
  const connections = await BankConnection.find({ userId }).lean();

  const stats = await Promise.all(
    connections.map(async (connection) => {
      const connectionStats = await SyncLog.getConnectionStats(
        connection._id,
        parseInt(days)
      );

      return {
        connectionId: connection._id,
        institutionName: connection.institutionName,
        accountNumber: connection.accountNumber,
        ...connectionStats
      };
    })
  );

  // Overall statistics
  const totalSyncs = stats.reduce((sum, s) => sum + s.totalSyncs, 0);
  const totalSuccessful = stats.reduce((sum, s) => sum + s.successful, 0);
  const totalFailed = stats.reduce((sum, s) => sum + s.failed, 0);
  const totalTransactions = stats.reduce((sum, s) => sum + s.transactions.total, 0);

  res.json({
    success: true,
    data: {
      overall: {
        totalSyncs,
        successful: totalSuccessful,
        failed: totalFailed,
        successRate: totalSyncs > 0 ? ((totalSuccessful / totalSyncs) * 100).toFixed(2) : 0,
        totalTransactions
      },
      byConnection: stats,
      period: {
        days: parseInt(days),
        startDate: new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000),
        endDate: new Date()
      }
    }
  });
});

/**
 * @desc    Get global sync statistics (admin/monitoring)
 * @route   GET /api/v1/sync/global-stats
 * @access  Private (Admin only in production)
 */
const getGlobalSyncStats = asyncHandler(async (req, res) => {
  const stats = await syncScheduler.getSyncStats();

  // Get recent errors
  const recentErrors = await SyncLog.getRecentErrors(24);

  res.json({
    success: true,
    data: {
      ...stats,
      recentErrors: recentErrors.map(err => ({
        syncLogId: err._id,
        userId: err.userId,
        institution: err.connectionId?.institutionName,
        error: err.error?.message,
        occurredAt: err.startedAt
      }))
    }
  });
});

/**
 * @desc    Retry failed syncs
 * @route   POST /api/v1/sync/retry
 * @access  Private
 */
const retryFailedSyncs = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Get user's failed syncs that are retryable
  const failedLogs = await SyncLog.find({
    userId,
    status: 'failed',
    'error.retryable': true,
    retryCount: { $lt: 3 }
  })
    .sort({ startedAt: -1 })
    .limit(10); // Limit retries to prevent overload

  if (failedLogs.length === 0) {
    return res.json({
      success: true,
      message: 'No failed syncs to retry',
      data: {
        retried: 0
      }
    });
  }

  const results = {
    retried: 0,
    successful: 0,
    failed: 0,
    errors: []
  };

  for (const log of failedLogs) {
    try {
      const connection = await BankConnection.findById(log.connectionId);
      
      if (!connection || !connection.isActive) {
        continue;
      }

      results.retried++;

      // Update retry count
      log.retryCount++;
      log.syncType = 'retry';
      await log.save();

      // Retry sync
      await syncScheduler.syncBankConnection(
        log.connectionId,
        userId,
        { forceSync: true }
      );

      results.successful++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        connectionId: log.connectionId,
        error: error.message
      });
    }
  }

  res.json({
    success: true,
    message: `Retried ${results.retried} failed syncs`,
    data: results
  });
});

/**
 * @desc    Cancel ongoing sync
 * @route   POST /api/v1/sync/connections/:id/cancel
 * @access  Private
 */
const cancelSync = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const connection = await BankConnection.findOne({
    _id: id,
    userId
  });

  if (!connection) {
    throw new AppError('Bank connection not found', 404);
  }

  if (connection.syncStatus !== 'syncing') {
    return res.status(400).json({
      success: false,
      message: 'No sync in progress to cancel'
    });
  }

  // Update connection status
  connection.syncStatus = 'active';
  await connection.save();

  // Mark latest sync log as failed
  const latestLog = await SyncLog.findOne({
    connectionId: connection._id,
    status: 'processing'
  }).sort({ startedAt: -1 });

  if (latestLog) {
    latestLog.status = 'failed';
    latestLog.completedAt = new Date();
    latestLog.error = {
      message: 'Sync cancelled by user',
      code: 'USER_CANCELLED',
      retryable: false
    };
    await latestLog.save();
  }

  res.json({
    success: true,
    message: 'Sync cancelled successfully',
    data: {
      connectionId: connection._id
    }
  });
});

/**
 * @desc    Update sync settings
 * @route   PATCH /api/v1/sync/connections/:id/settings
 * @access  Private
 */
const updateSyncSettings = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;
  const { autoSync, syncInterval } = req.body;

  const connection = await BankConnection.findOne({
    _id: id,
    userId
  });

  if (!connection) {
    throw new AppError('Bank connection not found', 404);
  }

  // Update settings
  if (autoSync !== undefined) {
    connection.autoSync = autoSync;
  }

  if (syncInterval !== undefined) {
    // Validate interval (min 1 hour, max 168 hours/7 days)
    if (syncInterval < 1 || syncInterval > 168) {
      throw new AppError('Sync interval must be between 1 and 168 hours', 400);
    }
    connection.syncInterval = syncInterval;
  }

  // Recalculate next sync time
  if (connection.autoSync) {
    connection.nextSyncAt = syncScheduler.calculateNextSync(connection.syncInterval);
  } else {
    connection.nextSyncAt = null;
  }

  await connection.save();

  res.json({
    success: true,
    message: 'Sync settings updated successfully',
    data: {
      connectionId: connection._id,
      autoSync: connection.autoSync,
      syncInterval: connection.syncInterval,
      nextSyncAt: connection.nextSyncAt
    }
  });
});

module.exports = {
  syncAllUserConnections,
  syncConnection,
  getSyncStatus,
  getSyncHistory,
  getSyncStatistics,
  getGlobalSyncStats,
  retryFailedSyncs,
  cancelSync,
  updateSyncSettings
};
