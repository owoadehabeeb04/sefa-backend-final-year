const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const notificationController = require('../controllers/notification.controller');
const notificationPreferencesController = require('../controllers/notificationPreferences.controller');

// All routes require authentication
router.use(authenticate);

// ─── Notification CRUD ────────────────────────────────────────────────────────

// GET /api/v1/notifications - list with pagination + filters
router.get('/', notificationController.getNotifications);

// GET /api/v1/notifications/unread-count - badge count
router.get('/unread-count', notificationController.getUnreadCount);

// PATCH /api/v1/notifications/read-all - mark all as read
router.patch('/read-all', notificationController.markAllAsRead);

// POST /api/v1/notifications/register-token - Expo push token
router.post('/register-token', notificationController.registerPushToken);

// GET /api/v1/notifications/preferences
router.get('/preferences', notificationPreferencesController.getNotificationPreferences);

// PATCH /api/v1/notifications/preferences
router.patch('/preferences', notificationPreferencesController.updateNotificationPreferences);

// GET /api/v1/notifications/:id - single notification (auto-marks read)
router.get('/:id', notificationController.getNotification);

// PATCH /api/v1/notifications/:id/read - mark one as read
router.patch('/:id/read', notificationController.markAsRead);

// DELETE /api/v1/notifications/:id
router.delete('/:id', notificationController.deleteNotification);

module.exports = router;
