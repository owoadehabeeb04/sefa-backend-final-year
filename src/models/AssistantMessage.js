const mongoose = require('mongoose');

const assistantMessageVersionSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 12000,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
    },
    editedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const assistantSourceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    sourceName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    priceText: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
    },
    numericPrice: {
      type: Number,
      default: null,
      min: 0,
    },
    currency: {
      type: String,
      default: null,
      trim: true,
      maxlength: 12,
    },
    snippet: {
      type: String,
      default: null,
      trim: true,
      maxlength: 240,
    },
  },
  { _id: false },
);

const assistantRetrievalSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ['none', 'general_web', 'shopping'],
      default: 'none',
    },
    market: {
      type: String,
      default: 'NG',
      trim: true,
      maxlength: 12,
    },
    query: {
      type: String,
      default: '',
      trim: true,
      maxlength: 240,
    },
    status: {
      type: String,
      enum: ['not_needed', 'used', 'unavailable'],
      default: 'not_needed',
    },
    providers: {
      type: [String],
      default: [],
    },
    sourceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    priceRangeSummary: {
      low: { type: Number, default: null, min: 0 },
      high: { type: Number, default: null, min: 0 },
      median: { type: Number, default: null, min: 0 },
      currency: { type: String, default: null, trim: true, maxlength: 12 },
      sourceCount: { type: Number, default: 0, min: 0 },
    },
    reason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 160,
    },
  },
  { _id: false },
);

const assistantActionSummarySchema = new mongoose.Schema(
  {
    actionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantAction',
      required: true,
    },
    actionType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    status: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    confirmationMessage: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    missingFields: {
      type: [String],
      default: [],
    },
  },
  { _id: false },
);

const assistantMessageSchema = new mongoose.Schema(
  {
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantChat',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
      index: true,
    },
    content: {
      type: String,
      default: '',
      trim: true,
      maxlength: 12000,
    },
    status: {
      type: String,
      enum: ['queued', 'generating', 'streaming', 'completed', 'failed', 'cancelled', 'superseded'],
      default: 'completed',
      index: true,
    },
    editedAt: {
      type: Date,
      default: null,
    },
    isEdited: {
      type: Boolean,
      default: false,
      index: true,
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    previousVersions: {
      type: [assistantMessageVersionSchema],
      default: [],
    },
    parentMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantMessage',
      default: null,
    },
    supersededByMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantMessage',
      default: null,
    },
    supersedesMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantMessage',
      default: null,
    },
    generatedFromMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantMessage',
      default: null,
      index: true,
    },
    errorMessage: {
      type: String,
      default: null,
      trim: true,
      maxlength: 1000,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    hiddenAt: {
      type: Date,
      default: null,
      index: true,
    },
    jobId: {
      type: String,
      default: null,
      index: true,
    },
    sources: {
      type: [assistantSourceSchema],
      default: [],
    },
    retrieval: {
      type: assistantRetrievalSchema,
      default: null,
    },
    actions: {
      type: [assistantActionSummarySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

assistantMessageSchema.index({ userId: 1, chatId: 1, createdAt: 1 });
assistantMessageSchema.index({ chatId: 1, hiddenAt: 1, createdAt: 1 });
assistantMessageSchema.index({ chatId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('AssistantMessage', assistantMessageSchema);
