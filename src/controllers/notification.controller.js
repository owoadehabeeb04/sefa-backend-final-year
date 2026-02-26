const Notification = require('../models/Notification');
const NotificationPreferences = require('../models/NotificationPreferences');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * Get notifications for authenticated user
 * GET /api/v1/notifications
 * Query: page, limit, status (read|unread), type
 */
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const filter = { userId };

    if (req.query.status === 'read') filter.isRead = true;
    if (req.query.status === 'unread') filter.isRead = false;
    if (req.query.type) filter.type = req.query.type;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      Notification.countDocuments(filter),
      Notification.countDocuments({ userId, isRead: false }),
    ]);

    return successResponse(res, {
      notifications,
      summary: {
        unreadCount,
        total,
      },
      pagination: {
        page,
        limit,
        pages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    return errorResponse(res, 'Failed to fetch notifications', 500, error.message);
  }
};

/**
 * Get unread notification count
 * GET /api/v1/notifications/unread-count
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.userId;
    const count = await Notification.getUnreadCount(userId);
    return successResponse(res, { count });
  } catch (error) {
    console.error('Get unread count error:', error);
    return errorResponse(res, 'Failed to get unread count', 500, error.message);
  }
};

/**
 * Mark a single notification as read
 * PATCH /api/v1/notifications/:id/read
 */
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const notification = await Notification.findOne({ _id: req.params.id, userId });

    if (!notification) {
      return errorResponse(res, 'Notification not found', 404);
    }

    await notification.markAsRead();
    return successResponse(res, null, 'Notification marked as read');
  } catch (error) {
    console.error('Mark as read error:', error);
    return errorResponse(res, 'Failed to mark notification as read', 500, error.message);
  }
};

/**
 * Mark all notifications as read
 * PATCH /api/v1/notifications/read-all
 */
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await Notification.markAllAsRead(userId);
    return successResponse(res, { updatedCount: result.modifiedCount }, 'All notifications marked as read');
  } catch (error) {
    console.error('Mark all as read error:', error);
    return errorResponse(res, 'Failed to mark all notifications as read', 500, error.message);
  }
};

/**
 * Delete a notification
 * DELETE /api/v1/notifications/:id
 */
exports.deleteNotification = async (req, res) => {
  try {
    const userId = req.user.userId;
    const notification = await Notification.findOneAndDelete({ _id: req.params.id, userId });

    if (!notification) {
      return errorResponse(res, 'Notification not found', 404);
    }

    return successResponse(res, null, 'Notification deleted');
  } catch (error) {
    console.error('Delete notification error:', error);
    return errorResponse(res, 'Failed to delete notification', 500, error.message);
  }
};

/**
 * Get a single notification by ID
 * GET /api/v1/notifications/:id
 */
exports.getNotification = async (req, res) => {
  try {
    const userId = req.user.userId;
    const notification = await Notification.findOne({ _id: req.params.id, userId }).lean({ virtuals: true });

    if (!notification) {
      return errorResponse(res, 'Notification not found', 404);
    }

    // Auto-mark as read on open
    if (!notification.isRead) {
      await Notification.findByIdAndUpdate(req.params.id, {
        $set: { isRead: true, readAt: new Date() },
      });
    }

    return successResponse(res, { notification });
  } catch (error) {
    console.error('Get notification error:', error);
    return errorResponse(res, 'Failed to fetch notification', 500, error.message);
  }
};

/**
 * Register Expo push token
 * POST /api/v1/notifications/register-token
 */
exports.registerPushToken = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { expoPushToken, deviceType } = req.body;

    if (!expoPushToken) {
      return errorResponse(res, 'Expo push token is required', 400);
    }

    await NotificationPreferences.updatePushToken(userId, expoPushToken, deviceType || 'mobile');

    return successResponse(res, null, 'Push token registered successfully');
  } catch (error) {
    console.error('Register push token error:', error);
    return errorResponse(res, 'Failed to register push token', 500, error.message);
  }
};
