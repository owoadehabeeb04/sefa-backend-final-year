const mongoose = require('mongoose');

const statementImportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    fileType: {
      type: String,
      required: true,
      trim: true,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 0,
    },
    source: {
      type: String,
      default: 'manual_upload',
      trim: true,
    },
    bankName: {
      type: String,
      default: null,
      trim: true,
    },
    statementPeriodStart: {
      type: Date,
      default: null,
    },
    statementPeriodEnd: {
      type: Date,
      default: null,
    },
    currency: {
      type: String,
      default: 'NGN',
      trim: true,
    },
    status: {
      type: String,
      enum: ['uploaded', 'extracting', 'parsed', 'reviewing', 'imported', 'failed', 'cancelled'],
      default: 'uploaded',
      index: true,
    },
    extractionMethod: {
      type: String,
      default: null,
      trim: true,
    },
    extractionProvider: {
      type: String,
      default: null,
      trim: true,
    },
    extractionModel: {
      type: String,
      default: null,
      trim: true,
    },
    extractionQualityScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    extractionConfidenceSummary: {
      averageConfidence: {
        type: Number,
        default: 0,
        min: 0,
        max: 1,
      },
      highConfidenceCount: {
        type: Number,
        default: 0,
        min: 0,
      },
      mediumConfidenceCount: {
        type: Number,
        default: 0,
        min: 0,
      },
      lowConfidenceCount: {
        type: Number,
        default: 0,
        min: 0,
      },
      unknownConfidenceCount: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    totalRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    readyRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    needsReviewRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    duplicateRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    failedRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    ignoredRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    importedRows: {
      type: Number,
      default: 0,
      min: 0,
    },
    errorMessage: {
      type: String,
      default: null,
      trim: true,
    },

    // --- Live progress (AI-first pipeline) ---
    // Current step key from the progress taxonomy, e.g. 'ai.reading.page'.
    progressStep: {
      type: String,
      default: null,
      trim: true,
    },
    progressPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Ordered timeline of steps for the story-like mobile screen.
    progress: {
      type: [
        new mongoose.Schema(
          {
            step: { type: String, required: true },
            label: { type: String, default: '' },
            percent: { type: Number, default: 0 },
            meta: { type: mongoose.Schema.Types.Mixed, default: null },
            at: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    pageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    processedPageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

statementImportSchema.index({ userId: 1, createdAt: -1 });
statementImportSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('StatementImport', statementImportSchema);
