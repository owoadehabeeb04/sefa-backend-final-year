const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Category name is required'],
    trim: true
  },
  type: {
    type: String,
    enum: ['income', 'expense'],
    required: [true, 'Category type is required']
  },
  icon: {
    type: String,
    default: 'folder'
  },
  color: {
    type: String,
    default: '#3498db'
  },
  source: {
    type: String,
    enum: ['system', 'user'],
    default: 'user'
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for faster queries
categorySchema.index({ userId: 1, type: 1, isActive: 1 });
categorySchema.index({ userId: 1, type: 1, name: 1 }, { unique: true });

// Invalidate cached insight snapshots when categories change.
categorySchema.plugin(require('./plugins/invalidateInsightSnapshot'));

module.exports = mongoose.model('Category', categorySchema);
