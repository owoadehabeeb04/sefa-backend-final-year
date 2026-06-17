const mongoose = require('mongoose');

const assistantActionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantChat',
      required: true,
      index: true,
    },
    assistantMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantMessage',
      default: null,
      index: true,
    },
    actionType: {
      type: String,
      enum: [
        'create_expense',
        'create_income',
        'create_category',
      ],
      required: true,
      index: true,
    },
    extractedPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    missingFields: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['pending_fields', 'pending_confirmation', 'confirmed', 'cancelled', 'executed', 'failed'],
      default: 'pending_confirmation',
      index: true,
    },
    confirmationMessage: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
      trim: true,
      maxlength: 1000,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  {
    timestamps: true,
  },
);

assistantActionSchema.index({ userId: 1, chatId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('AssistantAction', assistantActionSchema);
