const mongoose = require('mongoose');

const importedTransactionMapSchema = new mongoose.Schema({
  importJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImportJob',
    default: null,
    index: true
  },
  syncLogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SyncLog',
    default: null,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },
  sourceType: {
    type: String,
    enum: ['bank_connection', 'import_job'],
    default: null,
    index: true
  },
  sourceRefId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    index: true
  },
  provider: {
    type: String,
    default: null
  },

  // Transaction links (one or the other, not both)
  expenseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Expense',
    default: null,
    sparse: true
  },
  incomeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Income',
    default: null,
    sparse: true
  },

  // Original data (for undo and audit)
  externalId: {
    type: String,
    trim: true,
    index: true
  },
  rawData: {
    type: mongoose.Schema.Types.Mixed, // Store original transaction object
    default: {}
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
importedTransactionMapSchema.index({ importJobId: 1, userId: 1 });
importedTransactionMapSchema.index({ syncLogId: 1, userId: 1 });
importedTransactionMapSchema.index(
  { userId: 1, sourceType: 1, sourceRefId: 1, externalId: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      sourceType: { $type: 'string' },
      sourceRefId: { $exists: true, $ne: null },
      externalId: { $type: 'string' },
    },
  },
);
importedTransactionMapSchema.index(
  { userId: 1, externalId: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      sourceType: null,
      externalId: { $type: 'string' },
    },
  },
);

// Validation: ensure either expenseId or incomeId is set, not both
importedTransactionMapSchema.pre('save', function(next) {
  if (this.expenseId && this.incomeId) {
    next(new Error('Transaction map cannot have both expenseId and incomeId'));
  } else if (!this.expenseId && !this.incomeId) {
    next(new Error('Transaction map must have either expenseId or incomeId'));
  } else {
    next();
  }
});

// Virtual for transaction type
importedTransactionMapSchema.virtual('transactionType').get(function() {
  return this.expenseId ? 'expense' : 'income';
});

// Virtual for transaction ID
importedTransactionMapSchema.virtual('transactionId').get(function() {
  return this.expenseId || this.incomeId;
});

// Instance method to get the actual transaction
importedTransactionMapSchema.methods.getTransaction = async function() {
  if (this.expenseId) {
    const Expense = mongoose.model('Expense');
    return await Expense.findById(this.expenseId);
  } else if (this.incomeId) {
    const Income = mongoose.model('Income');
    return await Income.findById(this.incomeId);
  }
  return null;
};

// Static method to find map by transaction ID
importedTransactionMapSchema.statics.findByTransactionId = async function(transactionId, transactionType) {
  const query = transactionType === 'expense'
    ? { expenseId: transactionId }
    : { incomeId: transactionId };
  
  return this.findOne(query);
};

// Static method to get all maps for an import job
importedTransactionMapSchema.statics.getByImportJob = async function(importJobId) {
  return this.find({ importJobId })
    .populate('expenseId')
    .populate('incomeId');
};

// Static method to count transactions for an import job
importedTransactionMapSchema.statics.countByImportJob = async function(importJobId) {
  return this.countDocuments({ importJobId });
};

// Static method to delete maps for an import job (for undo)
importedTransactionMapSchema.statics.deleteByImportJob = async function(importJobId) {
  return this.deleteMany({ importJobId });
};

// Static method to check if external ID already exists
importedTransactionMapSchema.statics.existsByExternalId = async function(userId, externalId, options = {}) {
  if (!externalId) return false;
  const query = { userId, externalId };

  if (options.sourceType) query.sourceType = options.sourceType;
  if (options.sourceRefId) query.sourceRefId = options.sourceRefId;

  const count = await this.countDocuments(query);
  return count > 0;
};

// Ensure virtuals are included in JSON
importedTransactionMapSchema.set('toJSON', { virtuals: true });
importedTransactionMapSchema.set('toObject', { virtuals: true });

const ImportedTransactionMap = mongoose.model('ImportedTransactionMap', importedTransactionMapSchema);

module.exports = ImportedTransactionMap;
