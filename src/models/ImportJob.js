const mongoose = require('mongoose');
const { normalizeImportStage, normalizeImportStatus } = require('../utils/importJobState');

const importJobSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },

  // Import source
  source: {
    type: String,
    required: [true, 'Source is required'],
    enum: ['mono_sync', 'csv_upload', 'pdf_upload'],
    index: true
  },
  bankConnectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BankConnection',
    default: null
  },

  // File metadata (for uploads)
  fileName: {
    type: String,
    trim: true
  },
  fileSize: {
    type: Number,
    min: 0
  },
  fileType: {
    type: String,
    enum: ['text/csv', 'application/pdf', null],
    default: null
  },
  fileUrl: {
    type: String,
    trim: true
  },
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null // GridFS file ID
  },
  queueJobId: {
    type: String,
    default: null,
    index: true
  },

  // Processing status
  status: {
    type: String,
    required: true,
    enum: ['pending', 'queued', 'processing', 'completed', 'failed', 'undone'],
    default: 'queued',
    index: true
  },
  stage: {
    type: String,
    enum: [
      'queued',
      'download',
      'parse',
      'ocr',
      'normalize',
      'deduplicate',
      'categorize',
      'save',
      'deduplicate_internal',
      'deduplicate_database',
      'detect_transfers',
      'parsing',
      'deduplicating',
      'categorizing',
      'saving',
      'completed',
      'failed',
      'fetch'
    ],
    default: 'queued'
  },
  progress: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },

  // Results
  sourceRecordCount: {
    type: Number,
    default: 0,
    min: 0
  },
  validRecordCount: {
    type: Number,
    default: 0,
    min: 0
  },
  totalTransactions: {
    type: Number,
    default: 0,
    min: 0
  },
  importedCount: {
    type: Number,
    default: 0,
    min: 0
  },
  duplicateCount: {
    type: Number,
    default: 0,
    min: 0
  },
  errorCount: {
    type: Number,
    default: 0,
    min: 0
  },
  skippedCount: {
    type: Number,
    default: 0,
    min: 0
  },
  errorMessages: [{
    type: String
  }],
  warnings: [{
    type: String
  }],
  detectedBank: {
    type: String,
    default: 'unknown',
    trim: true
  },
  detectedBankDisplayName: {
    type: String,
    default: 'Unknown bank',
    trim: true
  },
  bankDetectionConfidence: {
    type: String,
    enum: ['high', 'medium', 'low', 'unknown'],
    default: 'unknown'
  },
  bankDetectionSource: {
    type: String,
    default: 'unknown',
    trim: true
  },
  bankHint: {
    type: String,
    default: null,
    trim: true
  },
  accountNumberHint: {
    type: String,
    default: null,
    trim: true
  },
  parser: {
    type: String,
    default: null,
    trim: true
  },
  ocrProvider: {
    type: String,
    enum: ['azure', 'google', null],
    default: null
  },

  // Import metadata
  statementDateRange: {
    from: {
      type: Date
    },
    to: {
      type: Date
    }
  },
  dateRange: {
    from: {
      type: Date
    },
    to: {
      type: Date
    }
  },
  qualityFlags: [{
    type: String
  }],
  needsReview: {
    type: Boolean,
    default: false
  },

  // Undo tracking
  isUndone: {
    type: Boolean,
    default: false,
    index: true
  },
  undoneAt: {
    type: Date
  },
  retentionExpiresAt: {
    type: Date,
    index: true
  },

  // Timestamps
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
importJobSchema.index({ userId: 1, createdAt: -1 });
importJobSchema.index({ status: 1, retentionExpiresAt: 1 }); // For cleanup job
importJobSchema.index({ userId: 1, source: 1, status: 1 });

// Pre-save hook to set retention expiry date
importJobSchema.pre('save', function(next) {
  // Set retention expiry to 90 days from creation if not already set
  if (this.isNew && !this.retentionExpiresAt) {
    const retentionDays = parseInt(process.env.IMPORT_RETENTION_DAYS) || 90;
    this.retentionExpiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  }

  this.status = normalizeImportStatus(this.status);
  this.stage = normalizeImportStage(this.stage, this.status);

  next();
});

// Virtual for success rate
importJobSchema.virtual('successRate').get(function() {
  if (this.totalTransactions === 0) return 0;
  return Math.round((this.importedCount / this.totalTransactions) * 100);
});

// Virtual for status display
importJobSchema.virtual('statusDisplay').get(function() {
  const statusMap = {
    queued: 'Queued',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    undone: 'Undone'
  };
  return statusMap[normalizeImportStatus(this.status)] || this.status;
});

// Instance method to check if can be undone
importJobSchema.methods.canBeUndone = function() {
  return (
    normalizeImportStatus(this.status) === 'completed' &&
    !this.isUndone &&
    this.importedCount > 0 &&
    new Date() < this.retentionExpiresAt
  );
};

// Instance method to mark as undone
importJobSchema.methods.markAsUndone = async function() {
  this.isUndone = true;
  this.undoneAt = new Date();
  this.status = 'undone';
  this.stage = 'completed';
  return this.save();
};

// Instance method to update progress
importJobSchema.methods.updateProgress = async function(stage, progress) {
  this.stage = normalizeImportStage(stage, this.status);
  this.progress = Math.min(100, Math.max(0, progress));
  if (this.stage !== 'queued' && !this.startedAt) {
    this.startedAt = new Date();
  }
  if (progress >= 100 && this.stage === 'completed') {
    this.status = 'completed';
    this.completedAt = new Date();
  } else if (this.stage === 'failed') {
    this.status = 'failed';
    this.completedAt = new Date();
  } else if (this.stage === 'queued') {
    this.status = 'queued';
  } else {
    this.status = 'processing';
  }
  return this.save();
};

// Static method to get recent imports for user
importJobSchema.statics.getRecentImports = async function(userId, limit = 10) {
  return this.find({
    userId,
    isUndone: false
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('bankConnectionId', 'institutionName accountNumber');
};

// Static method to get jobs for cleanup (expired and completed)
importJobSchema.statics.getExpiredJobs = async function() {
  const now = new Date();
  return this.find({
    status: { $in: ['completed', 'undone'] },
    retentionExpiresAt: { $lt: now }
  });
};

// Static method to get import statistics for user
importJobSchema.statics.getUserStats = async function(userId) {
  const result = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        status: 'completed',
        isUndone: false
      }
    },
    {
      $group: {
        _id: null,
        totalJobs: { $sum: 1 },
        totalTransactions: { $sum: '$importedCount' },
        totalDuplicates: { $sum: '$duplicateCount' },
        totalErrors: { $sum: '$errorCount' }
      }
    }
  ]);

  return result[0] || {
    totalJobs: 0,
    totalTransactions: 0,
    totalDuplicates: 0,
    totalErrors: 0
  };
};

const normalizeSerializedImportJob = (_doc, ret) => {
  ret.status = normalizeImportStatus(ret.status);
  ret.stage = normalizeImportStage(ret.stage, ret.status);
  ret.errorMessages = ret.errorMessages || ret.errors || [];
  ret.errors = ret.errorMessages;
  ret.statementDateRange = ret.statementDateRange || ret.dateRange || null;
  ret.dateRange = ret.statementDateRange || ret.dateRange || null;
  ret.detectedBankDisplayName = ret.detectedBankDisplayName || 'Unknown bank';
  ret.bankDetectionConfidence = ret.bankDetectionConfidence || 'unknown';
  ret.bankDetectionSource = ret.bankDetectionSource || 'unknown';
  ret.qualityFlags = ret.qualityFlags || [];
  ret.needsReview = Boolean(ret.needsReview);
  return ret;
};

// Ensure virtuals are included in JSON
importJobSchema.set('toJSON', { virtuals: true, transform: normalizeSerializedImportJob });
importJobSchema.set('toObject', { virtuals: true, transform: normalizeSerializedImportJob });

const ImportJob = mongoose.model('ImportJob', importJobSchema);

module.exports = ImportJob;
