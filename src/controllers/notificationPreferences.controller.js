const NotificationPreferences = require('../models/NotificationPreferences');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * Get notification preferences
 * GET /api/v1/notifications/preferences
 */
exports.getNotificationPreferences = async (req, res) => {
  try {
    const userId = req.user.userId;
    const preferences = await NotificationPreferences.getOrCreate(userId);

    return successResponse(res, preferences, 'Notification preferences retrieved');
  } catch (error) {
    console.error('Get notification preferences error:', error);
    return errorResponse(res, 'Failed to fetch notification preferences', 500, error.message);
  }
};

/**
 * Update notification preferences
 * PATCH /api/v1/notifications/preferences
 */
exports.updateNotificationPreferences = async (req, res) => {
  try {
    const userId = req.user.userId;
    const preferences = await NotificationPreferences.getOrCreate(userId);

    const allowedFields = [
      'pushEnabled',
      'transactionAlerts',
      'budgetWarnings',
      'weeklyReports',
      'goalUpdates',
      'importNotifications',
      'maxNotificationsPerDay',
      'dailyDigestEnabled',
      'dailyDigestTime',
      'weeklySummaryEnabled',
      'weeklySummaryDay',
      'weeklySummaryTime',
      'quietHoursEnabled',
      'quietHoursStart',
      'quietHoursEnd',
      'largeTransactionMinAmount',
      'budgetWarningThreshold'
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        preferences[field] = req.body[field];
      }
    });

    await preferences.save();

    return successResponse(res, preferences, 'Notification preferences updated');
  } catch (error) {
    console.error('Update notification preferences error:', error);
    return errorResponse(res, 'Failed to update notification preferences', 500, error.message);
  }
};
