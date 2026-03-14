const mongoose = require('mongoose');

/**
 * SyncLog Model
 * 
 * Tracks all sync operations for debugging and monitoring:
 * - Manual and automatic syncs
 * - Success/failure status
 * - Transaction counts
 * - Error messages
 * - Performance metrics
 */

const syncLogSchema = new mongoose.Schema({
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Connection reference
  connectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BankConnection',
    required: true,
    index: true
  },

  // Sync type
  syncType: {
    type: String,
    enum: ['manual', 'automatic', 'initial', 'retry', 'scheduled'],
    default: 'automatic'
  },

  // Sync status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'partial'],
    default: 'pending',
    index: true
  },

  // Timestamps
  startedAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  completedAt: {
    type: Date
  },

  // Duration in milliseconds
  duration: {
    type: Number
  },

  // Sync parameters
  syncParams: {
    startDate: Date,
    endDate: Date,
    isInitialSync: Boolean,
    forceSync: Boolean
  },

  // Results
  results: {
    totalFetched: {
      type: Number,
      default: 0
    },
    newTransactions: {
      type: Number,
      default: 0
    },
    duplicates: {
      type: Number,
      default: 0
    },
    transfers: {
      type: Number,
      default: 0
    },
    errors: {
      type: Number,
      default: 0
    }
  },

  // Error information
  error: {
    message: String,
    code: String,
    stack: String,
    retryable: Boolean
  },

  // Connection details at time of sync
  connectionSnapshot: {
    institutionName: String,
    accountNumber: String,
    accountId: String,
    syncInterval: Number
  },

  // Retry information
  retryCount: {
    type: Number,
    default: 0
  },

  maxRetries: {
    type: Number,
    default: 3
  },

  nextRetryAt: {
    type: Date
  },

  // Metadata
  metadata: {
    source: {
      type: String,
      default: 'mono'
    },
    triggeredBy: String, // 'cron', 'user', 'webhook', 'system'
    ipAddress: String,
    userAgent: String
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
syncLogSchema.index({ userId: 1, startedAt: -1 });
syncLogSchema.index({ connectionId: 1, startedAt: -1 });
syncLogSchema.index({ status: 1, startedAt: -1 });
syncLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // TTL: 90 days

// Virtual for success rate
syncLogSchema.virtual('successRate').get(function() {
  if (this.results.totalFetched === 0) return 0;
  return ((this.results.newTransactions / this.results.totalFetched) * 100).toFixed(2);
});

// Instance Methods

/**
 * Mark sync as started
 */
syncLogSchema.methods.markAsStarted = function() {
  this.status = 'processing';
  this.startedAt = new Date();
  return this.save();
};

/**
 * Mark sync as completed
 * @param {Object} results - Sync results
 */
syncLogSchema.methods.markAsCompleted = function(results = {}) {
  this.status = 'completed';
  this.completedAt = new Date();
  this.duration = this.completedAt - this.startedAt;
  this.results = {
    ...this.results,
    ...results
  };
  return this.save();
};

/**
 * Mark sync as failed
 * @param {Error} error - Error object
 */
syncLogSchema.methods.markAsFailed = function(error) {
  this.status = 'failed';
  this.completedAt = new Date();
  this.duration = this.completedAt - this.startedAt;
  this.error = {
    message: error.message,
    code: error.code || 'SYNC_ERROR',
    stack: error.stack,
    retryable: this.isRetryableError(error)
  };

  // Schedule retry if retryable and under max retries
  if (this.error.retryable && this.retryCount < this.maxRetries) {
    const backoffMinutes = Math.pow(2, this.retryCount) * 5; // Exponential backoff
    this.nextRetryAt = new Date(Date.now() + backoffMinutes * 60 * 1000);
    this.retryCount++;
  }

  return this.save();
};

/**
 * Check if error is retryable
 * @param {Error} error - Error object
 * @returns {Boolean}
 */
syncLogSchema.methods.isRetryableError = function(error) {
  const retryableCodes = [
    'NETWORK_ERROR',
    'TIMEOUT_ERROR',
    'RATE_LIMIT_ERROR',
    'SERVICE_UNAVAILABLE',
    'ECONNREFUSED',
    'ETIMEDOUT'
  ];

  const retryableMessages = [
    'network',
    'timeout',
    'rate limit',
    'temporarily unavailable',
    'service unavailable',
    'connection refused'
  ];

  // Check error code
  if (error.code && retryableCodes.includes(error.code)) {
    return true;
  }

  // Check error message
  const message = error.message.toLowerCase();
  return retryableMessages.some(msg => message.includes(msg));
};

/**
 * Mark sync as partial (some transactions succeeded, some failed)
 * @param {Object} results - Partial results
 */
syncLogSchema.methods.markAsPartial = function(results = {}) {
  this.status = 'partial';
  this.completedAt = new Date();
  this.duration = this.completedAt - this.startedAt;
  this.results = {
    ...this.results,
    ...results
  };
  return this.save();
};

// Static Methods

/**
 * Get sync history for a user
 * @param {String} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Sync logs
 */
syncLogSchema.statics.getUserSyncHistory = async function(userId, options = {}) {
  const {
    page = 1,
    limit = 20,
    status,
    connectionId,
    syncType
  } = options;

  const query = { userId };

  if (status) query.status = status;
  if (connectionId) query.connectionId = connectionId;
  if (syncType) query.syncType = syncType;

  const logs = await this.find(query)
    .sort({ startedAt: -1 })
    .limit(limit)
    .skip((page - 1) * limit)
    .populate('connectionId', 'institutionName accountNumber')
    .lean();

  const total = await this.countDocuments(query);

  return {
    logs,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * Get sync statistics for a connection
 * @param {String} connectionId - Connection ID
 * @param {Number} days - Number of days to analyze
 * @returns {Promise<Object>} Statistics
 */
syncLogSchema.statics.getConnectionStats = async function(connectionId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const logs = await this.find({
    connectionId,
    startedAt: { $gte: startDate }
  });

  const total = logs.length;
  const successful = logs.filter(log => log.status === 'completed').length;
  const failed = logs.filter(log => log.status === 'failed').length;
  const partial = logs.filter(log => log.status === 'partial').length;

  const totalTransactions = logs.reduce((sum, log) => sum + (log.results.newTransactions || 0), 0);
  const totalDuplicates = logs.reduce((sum, log) => sum + (log.results.duplicates || 0), 0);
  const totalTransfers = logs.reduce((sum, log) => sum + (log.results.transfers || 0), 0);

  const avgDuration = logs.filter(log => log.duration).reduce((sum, log) => sum + log.duration, 0) / (logs.filter(log => log.duration).length || 1);

  return {
    period: {
      days,
      startDate,
      endDate: new Date()
    },
    totalSyncs: total,
    successful,
    failed,
    partial,
    successRate: total > 0 ? ((successful / total) * 100).toFixed(2) : 0,
    transactions: {
      total: totalTransactions,
      duplicates: totalDuplicates,
      transfers: totalTransfers
    },
    performance: {
      avgDuration: Math.round(avgDuration),
      avgDurationFormatted: `${(avgDuration / 1000).toFixed(2)}s`
    }
  };
};

/**
 * Get logs pending retry
 * @returns {Promise<Array>} Logs to retry
 */
syncLogSchema.statics.getLogsForRetry = async function() {
  return this.find({
    status: 'failed',
    'error.retryable': true,
    retryCount: { $lt: 3 },
    nextRetryAt: { $lte: new Date() }
  }).populate('connectionId');
};

/**
 * Get recent errors for monitoring
 * @param {Number} hours - Hours to look back
 * @returns {Promise<Array>} Recent error logs
 */
syncLogSchema.statics.getRecentErrors = async function(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  return this.find({
    status: 'failed',
    startedAt: { $gte: since }
  })
  .sort({ startedAt: -1 })
  .populate('connectionId', 'institutionName accountNumber')
  .populate('userId', 'email name')
  .limit(50)
  .lean();
};

/**
 * Clean old logs (beyond retention period)
 * @param {Number} days - Retention period in days
 * @returns {Promise<Object>} Deletion result
 */
syncLogSchema.statics.cleanOldLogs = async function(days = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const result = await this.deleteMany({
    createdAt: { $lt: cutoffDate }
  });

  return {
    deleted: result.deletedCount,
    cutoffDate
  };
};

const SyncLog = mongoose.model('SyncLog', syncLogSchema);

module.exports = SyncLog;
