const mongoose = require('mongoose');

const notificationPreferencesSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    unique: true,
    index: true
  },

  // Push notification settings
  pushEnabled: {
    type: Boolean,
    default: true
  },
  pushToken: {
    type: String,
    trim: true
  },
  deviceType: {
    type: String,
    enum: ['ios', 'android', 'web', null],
    default: null
  },

  // Notification type preferences
  transactionAlerts: {
    type: Boolean,
    default: true
  },
  budgetWarnings: {
    type: Boolean,
    default: true
  },
  weeklyReports: {
    type: Boolean,
    default: true
  },
  goalUpdates: {
    type: Boolean,
    default: true
  },
  importNotifications: {
    type: Boolean,
    default: true
  },

  // Frequency settings
  maxNotificationsPerDay: {
    type: Number,
    min: 1,
    max: 50,
    default: 10
  },
  dailyDigestEnabled: {
    type: Boolean,
    default: false
  },
  dailyDigestTime: {
    type: String,
    default: '09:00', // HH:MM format
    validate: {
      validator: function(v) {
        return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
      },
      message: 'Daily digest time must be in HH:MM format'
    }
  },

  // Weekly summary settings
  weeklySummaryEnabled: {
    type: Boolean,
    default: true
  },
  weeklySummaryDay: {
    type: Number,
    min: 0,
    max: 6,
    default: 0 // 0 = Sunday, 1 = Monday, etc.
  },
  weeklySummaryTime: {
    type: String,
    default: '20:00', // HH:MM format
    validate: {
      validator: function(v) {
        return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
      },
      message: 'Weekly summary time must be in HH:MM format'
    }
  },

  // Quiet hours
  quietHoursEnabled: {
    type: Boolean,
    default: false
  },
  quietHoursStart: {
    type: String,
    default: '22:00',
    validate: {
      validator: function(v) {
        return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
      },
      message: 'Quiet hours start time must be in HH:MM format'
    }
  },
  quietHoursEnd: {
    type: String,
    default: '07:00',
    validate: {
      validator: function(v) {
        return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
      },
      message: 'Quiet hours end time must be in HH:MM format'
    }
  },

  // Urgency thresholds
  largeTransactionMinAmount: {
    type: Number,
    min: 0,
    default: 10000 // NGN
  },
  budgetWarningThreshold: {
    type: Number,
    min: 0,
    max: 100,
    default: 80 // Percentage of budget
  },

  // Metadata
  timezone: {
    type: String,
    default: 'Africa/Lagos'
  },
  lastNotificationAt: {
    type: Date
  },
  notificationCount: {
    type: Number,
    default: 0,
    min: 0
  },
  dailyCount: {
    type: Number,
    default: 0,
    min: 0
  },
  dailyCountResetAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
notificationPreferencesSchema.index({ userId: 1 }, { unique: true });

// Virtual for weekly summary day name
notificationPreferencesSchema.virtual('weeklySummaryDayName').get(function() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[this.weeklySummaryDay];
});

// Instance method to check if in quiet hours
notificationPreferencesSchema.methods.isInQuietHours = function() {
  if (!this.quietHoursEnabled) return false;

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const start = this.quietHoursStart;
  const end = this.quietHoursEnd;

  // Handle overnight quiet hours (e.g., 22:00 - 07:00)
  if (start > end) {
    return currentTime >= start || currentTime <= end;
  } else {
    return currentTime >= start && currentTime <= end;
  }
};

// Instance method to check if daily limit reached
notificationPreferencesSchema.methods.isDailyLimitReached = function() {
  // Reset daily count if it's a new day
  const now = new Date();
  const resetTime = new Date(this.dailyCountResetAt);

  if (now.toDateString() !== resetTime.toDateString()) {
    return false; // New day, count will be reset
  }

  return this.dailyCount >= this.maxNotificationsPerDay;
};

// Instance method to increment daily count
notificationPreferencesSchema.methods.incrementDailyCount = async function() {
  const now = new Date();
  const resetTime = new Date(this.dailyCountResetAt);

  // Reset count if it's a new day
  if (now.toDateString() !== resetTime.toDateString()) {
    this.dailyCount = 1;
    this.dailyCountResetAt = now;
  } else {
    this.dailyCount += 1;
  }

  this.lastNotificationAt = now;
  this.notificationCount += 1;

  return this.save();
};

// Instance method to check if should send notification
notificationPreferencesSchema.methods.shouldSendNotification = function(type) {
  // Check if push notifications are enabled
  if (!this.pushEnabled || !this.pushToken) return false;

  // Check type-specific preferences
  const typeMap = {
    transaction_alert: 'transactionAlerts',
    budget_warning: 'budgetWarnings',
    weekly_summary: 'weeklyReports',
    goal_progress: 'goalUpdates',
    import_complete: 'importNotifications'
  };

  const preferenceKey = typeMap[type];
  if (preferenceKey && !this[preferenceKey]) return false;

  // Check quiet hours
  if (this.isInQuietHours()) return false;

  // Check daily limit
  if (this.isDailyLimitReached()) return false;

  return true;
};

// Static method to get or create preferences for user
notificationPreferencesSchema.statics.getOrCreate = async function(userId) {
  let preferences = await this.findOne({ userId });

  if (!preferences) {
    preferences = await this.create({ userId });
  }

  return preferences;
};

// Static method to update push token
notificationPreferencesSchema.statics.updatePushToken = async function(userId, pushToken, deviceType) {
  return this.findOneAndUpdate(
    { userId },
    { 
      $set: { 
        pushToken, 
        deviceType,
        pushEnabled: true 
      } 
    },
    { 
      upsert: true, 
      new: true 
    }
  );
};

// Ensure virtuals are included in JSON
notificationPreferencesSchema.set('toJSON', { virtuals: true });
notificationPreferencesSchema.set('toObject', { virtuals: true });

const NotificationPreferences = mongoose.model('NotificationPreferences', notificationPreferencesSchema);

module.exports = NotificationPreferences;
