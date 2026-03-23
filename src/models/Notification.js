const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },

  // Notification content
  type: {
    type: String,
    required: [true, 'Notification type is required'],
    enum: ['transaction_alert', 'weekly_summary', 'budget_warning', 'spending_insight', 'goal_progress', 'import_complete'],
    index: true
  },
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  message: {
    type: String,
    required: [true, 'Message is required'],
    trim: true,
    maxlength: [500, 'Message cannot exceed 500 characters']
  },
  icon: {
    type: String,
    enum: ['alert', 'info', 'success', 'warning', 'money', 'import', 'goal'],
    default: 'info'
  },

  // Related transaction (optional)
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  transactionType: {
    type: String,
    enum: ['expense', 'income', null],
    default: null
  },
  amount: {
    type: Number,
    min: 0
  },
  category: {
    type: String,
    trim: true
  },

  // AI insight
  aiAdvice: {
    type: String,
    trim: true,
    maxlength: [1000, 'AI advice cannot exceed 1000 characters']
  },
  urgency: {
    type: String,
    required: [true, 'Urgency is required'],
    enum: ['instant', 'daily', 'weekly'],
    default: 'daily',
    index: true
  },
  riskScore: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },

  // Read/delivery status
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date
  },
  isSent: {
    type: Boolean,
    default: false
  },
  sentAt: {
    type: Date
  },
  deliveryStatus: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'failed'],
    default: 'pending'
  },

  // Push notification details
  pushTicket: {
    type: String // Expo push ticket ID
  },
  pushReceipt: {
    type: mongoose.Schema.Types.Mixed // Expo push receipt
  },

  // Metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // Scheduled delivery
  scheduledFor: {
    type: Date
  },
  expiresAt: {
    type: Date,
    index: true
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1, createdAt: -1 });
notificationSchema.index({ urgency: 1, isSent: 1, scheduledFor: 1 }); // For sending job

// Pre-save hook to set expiry date
notificationSchema.pre('save', function(next) {
  // Set expiry to 90 days from creation if not already set
  if (this.isNew && !this.expiresAt) {
    const retentionDays = parseInt(process.env.NOTIFICATION_RETENTION_DAYS) || 90;
    this.expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  }
  next();
});

// Instance method to mark as read
notificationSchema.methods.markAsRead = async function() {
  if (!this.isRead) {
    this.isRead = true;
    this.readAt = new Date();
    return this.save();
  }
  return this;
};

// Instance method to mark as sent
notificationSchema.methods.markAsSent = async function(ticket) {
  this.isSent = true;
  this.sentAt = new Date();
  this.deliveryStatus = 'sent';
  if (ticket) {
    this.pushTicket = ticket;
  }
  return this.save();
};

// Instance method to update delivery status
notificationSchema.methods.updateDeliveryStatus = async function(status, receipt) {
  this.deliveryStatus = status;
  if (receipt) {
    this.pushReceipt = receipt;
  }
  return this.save();
};

// Virtual for time ago
notificationSchema.virtual('timeAgo').get(function() {
  const now = new Date();
  const diff = now - this.createdAt;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return this.createdAt.toLocaleDateString();
});

// Virtual for urgency display
notificationSchema.virtual('urgencyDisplay').get(function() {
  const urgencyMap = {
    instant: 'High',
    daily: 'Medium',
    weekly: 'Low'
  };
  return urgencyMap[this.urgency] || this.urgency;
});

// Static method to get unread count for user
notificationSchema.statics.getUnreadCount = async function(userId) {
  return this.countDocuments({ userId, isRead: false });
};

// Static method to get recent notifications
notificationSchema.statics.getRecent = async function(userId, limit = 10) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to get unread notifications
notificationSchema.statics.getUnread = async function(userId) {
  return this.find({ userId, isRead: false })
    .sort({ createdAt: -1 });
};

// Static method to mark all as read for user
notificationSchema.statics.markAllAsRead = async function(userId) {
  return this.updateMany(
    { userId, isRead: false },
    { 
      $set: { 
        isRead: true, 
        readAt: new Date() 
      } 
    }
  );
};

// Static method to get notifications to send
notificationSchema.statics.getNotificationsToSend = async function() {
  const now = new Date();
  return this.find({
    isSent: false,
    deliveryStatus: { $ne: 'failed' },
    $or: [
      { scheduledFor: { $lte: now } },
      { scheduledFor: null }
    ]
  }).limit(100); // Batch processing
};

// Static method to get expired notifications for cleanup
notificationSchema.statics.getExpiredNotifications = async function() {
  const now = new Date();
  return this.find({
    isRead: true,
    expiresAt: { $lt: now }
  });
};

// Ensure virtuals are included in JSON
notificationSchema.set('toJSON', { virtuals: true });
notificationSchema.set('toObject', { virtuals: true });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
