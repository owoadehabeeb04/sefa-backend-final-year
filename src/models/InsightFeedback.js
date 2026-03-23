const mongoose = require('mongoose');

const insightFeedbackSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InsightSession',
    default: null,
    index: true,
  },
  insightKey: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
  },
  insightType: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  },
  rating: {
    type: String,
    required: true,
    enum: ['helpful', 'not_helpful', 'wrong', 'already_knew', 'took_action'],
    index: true,
  },
  comment: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
});

insightFeedbackSchema.index({ userId: 1, createdAt: -1 });
insightFeedbackSchema.index({ userId: 1, insightType: 1, rating: 1 });

module.exports = mongoose.model('InsightFeedback', insightFeedbackSchema);
