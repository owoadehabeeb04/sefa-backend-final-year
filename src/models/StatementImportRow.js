const mongoose = require('mongoose');

const statementImportRowSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    statementImportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StatementImport',
      required: true,
      index: true,
    },
    transactionDate: {
      type: Date,
      default: null,
    },
    transactionTimeProvided: {
      type: Boolean,
      default: false,
    },
    transactionType: {
      type: String,
      default: null,
      trim: true,
    },
    rawDescription: {
      type: String,
      default: '',
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    counterParty: {
      type: String,
      default: null,
      trim: true,
    },
    transactionId: {
      type: String,
      default: null,
      trim: true,
    },
    debit: {
      type: Number,
      default: 0,
      min: 0,
    },
    credit: {
      type: Number,
      default: 0,
      min: 0,
    },
    amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    balance: {
      type: Number,
      default: null,
    },
    direction: {
      type: String,
      enum: ['debit', 'credit', 'unknown'],
      default: 'unknown',
      index: true,
    },
    classification: {
      type: String,
      enum: ['income', 'expense', 'unknown'],
      default: 'unknown',
      index: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    suggestedCategoryName: {
      type: String,
      default: null,
      trim: true,
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    status: {
      type: String,
      enum: ['ready', 'needs_review', 'duplicate', 'ignored', 'imported', 'failed'],
      default: 'needs_review',
      index: true,
    },
    duplicateHash: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    isDuplicate: {
      type: Boolean,
      default: false,
    },
    validationErrors: [
      {
        type: String,
        trim: true,
      },
    ],
    importedTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

statementImportRowSchema.index({ userId: 1, statementImportId: 1, status: 1 });
statementImportRowSchema.index({ userId: 1, statementImportId: 1, transactionDate: -1 });

module.exports = mongoose.model('StatementImportRow', statementImportRowSchema);
