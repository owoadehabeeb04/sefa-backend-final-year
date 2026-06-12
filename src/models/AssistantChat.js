const mongoose = require('mongoose');

const assistantChatSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    titleSource: {
      type: String,
      enum: ['auto', 'manual'],
      default: 'auto',
      index: true,
    },
    status: {
      type: String,
      enum: ['idle', 'generating', 'failed', 'archived'],
      default: 'idle',
      index: true,
    },
    lastMessageAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastVisibleMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssistantMessage',
      default: null,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

assistantChatSchema.index({ userId: 1, status: 1, lastMessageAt: -1 });
assistantChatSchema.index({ userId: 1, archivedAt: 1, lastMessageAt: -1 });

module.exports = mongoose.model('AssistantChat', assistantChatSchema);
