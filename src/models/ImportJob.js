const mongoose = require('mongoose');

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

  // Processing status
  status: {
    type: String,
    required: true,
    enum: ['pending', 'processing', 'completed', 'failed', 'undone'],
    default: 'pending',
    index: true
  },
  stage: {
    type: String,
    enum: ['parsing', 'deduplicating', 'categorizing', 'saving', 'completed'],
    default: 'parsing'
  },
  progress: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },

  // Results
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
  errors: [{
    type: String
  }],

  // Import metadata
  dateRange: {
    from: {
      type: Date
    },
    to: {
      type: Date
    }
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
    pending: 'Pending',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    undone: 'Undone'
  };
  return statusMap[this.status] || this.status;
});

// Instance method to check if can be undone
importJobSchema.methods.canBeUndone = function() {
  return (
    this.status === 'completed' &&
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
  return this.save();
};

// Instance method to update progress
importJobSchema.methods.updateProgress = async function(stage, progress) {
  this.stage = stage;
  this.progress = Math.min(100, Math.max(0, progress));
  if (progress >= 100 && stage === 'completed') {
    this.status = 'completed';
    this.completedAt = new Date();
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

// Ensure virtuals are included in JSON
importJobSchema.set('toJSON', { virtuals: true });
importJobSchema.set('toObject', { virtuals: true });

const ImportJob = mongoose.model('ImportJob', importJobSchema);

module.exports = ImportJob;
