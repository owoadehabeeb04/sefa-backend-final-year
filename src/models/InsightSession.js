const mongoose = require('mongoose');

const insightSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  question: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000,
  },
  normalizedIntent: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  },
  answer: {
    type: String,
    required: true,
    trim: true,
    maxlength: 4000,
  },
  confidence: {
    type: Number,
    required: true,
    min: 0,
    max: 1,
  },
  evidenceCards: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
  },
  actions: {
    type: [String],
    default: [],
  },
  suggestedQuestions: {
    type: [String],
    default: [],
  },
  hubSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
});

insightSessionSchema.index({ userId: 1, createdAt: -1 });
insightSessionSchema.index({ userId: 1, normalizedIntent: 1, createdAt: -1 });

module.exports = mongoose.model('InsightSession', insightSessionSchema);
