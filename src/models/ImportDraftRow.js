const mongoose = require('mongoose');

const importDraftRowSchema = new mongoose.Schema(
  {
    importJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ImportJob',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    rowIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    originalRowIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    direction: {
      type: String,
      enum: ['debit', 'credit'],
      required: true,
    },
    balance: {
      type: Number,
      default: null,
    },
    reference: {
      type: String,
      default: null,
      trim: true,
    },
    suggestedCategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    suggestedCategoryName: {
      type: String,
      default: null,
      trim: true,
    },
    suggestedCategoryIcon: {
      type: String,
      default: null,
    },
    suggestedCategoryColor: {
      type: String,
      default: null,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    categoryName: {
      type: String,
      default: null,
      trim: true,
    },
    categoryIcon: {
      type: String,
      default: null,
    },
    categoryColor: {
      type: String,
      default: null,
    },
    confidence: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
    },
    issueFlags: [
      {
        type: String,
      },
    ],
    excluded: {
      type: Boolean,
      default: false,
    },
    sourceText: {
      type: String,
      default: null,
      trim: true,
    },
    mappingExternalId: {
      type: String,
      required: true,
      trim: true,
    },
    scopedExternalId: {
      type: String,
      required: true,
      trim: true,
    },
    rawData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

importDraftRowSchema.index({ importJobId: 1, rowIndex: 1 }, { unique: true });
importDraftRowSchema.index({ importJobId: 1, userId: 1, excluded: 1 });

importDraftRowSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.issueFlags = ret.issueFlags || [];
    ret.excluded = Boolean(ret.excluded);
    return ret;
  },
});

importDraftRowSchema.set('toObject', {
  virtuals: true,
});

module.exports = mongoose.model('ImportDraftRow', importDraftRowSchema);
