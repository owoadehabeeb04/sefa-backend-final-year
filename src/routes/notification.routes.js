const express = require('express');
const router = express.Router();
const { authenticate, requireVerifiedEmail, requireOnboardingComplete } = require('../middleware/auth');
const notificationController = require('../controllers/notification.controller');
const notificationPreferencesController = require('../controllers/notificationPreferences.controller');

// All routes require authentication
router.use(authenticate, requireVerifiedEmail, requireOnboardingComplete);

// ─── Notification CRUD ────────────────────────────────────────────────────────

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: In-app notifications management
 */

/**
 * @swagger
 * /api/v1/notifications:
 *   get:
 *     summary: List notifications (paginated)
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Items per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [read, unread]
 *         description: Filter by read status
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [transaction_alert, weekly_summary, budget_warning, spending_insight, goal_progress, import_complete]
 *         description: Filter by notification type
 *     responses:
 *       200:
 *         description: Paginated list of notifications
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     notifications:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Notification'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         hasMore:
 *                           type: boolean
 *                     summary:
 *                       type: object
 *                       properties:
 *                         unreadCount:
 *                           type: integer
 */
// GET /api/v1/notifications - list with pagination + filters
router.get('/', notificationController.getNotifications);

/**
 * @swagger
 * /api/v1/notifications/unread-count:
 *   get:
 *     summary: Get unread notification count (badge)
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 */
// GET /api/v1/notifications/unread-count - badge count
router.get('/unread-count', notificationController.getUnreadCount);

/**
 * @swagger
 * /api/v1/notifications/read-all:
 *   patch:
 *     summary: Mark all notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Updated count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     updatedCount:
 *                       type: integer
 */
// PATCH /api/v1/notifications/read-all - mark all as read
router.patch('/read-all', notificationController.markAllAsRead);

/**
 * @swagger
 * /api/v1/notifications/register-token:
 *   post:
 *     summary: Register Expo push notification token
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - expoPushToken
 *             properties:
 *               expoPushToken:
 *                 type: string
 *                 example: ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]
 *               deviceType:
 *                 type: string
 *                 enum: [ios, android, web]
 *     responses:
 *       200:
 *         description: Token registered
 */
// POST /api/v1/notifications/register-token - Expo push token
router.post('/register-token', notificationController.registerPushToken);

/**
 * @swagger
 * /api/v1/notifications/preferences:
 *   get:
 *     summary: Get notification preferences
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User notification preferences
 *   patch:
 *     summary: Update notification preferences
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pushEnabled:
 *                 type: boolean
 *               transactionAlerts:
 *                 type: boolean
 *               budgetWarnings:
 *                 type: boolean
 *               weeklyReports:
 *                 type: boolean
 *               goalUpdates:
 *                 type: boolean
 *               importNotifications:
 *                 type: boolean
 *               quietHoursEnabled:
 *                 type: boolean
 *               quietHoursStart:
 *                 type: string
 *                 example: "22:00"
 *               quietHoursEnd:
 *                 type: string
 *                 example: "07:00"
 *               maxNotificationsPerDay:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 50
 *     responses:
 *       200:
 *         description: Updated preferences
 */
// GET /api/v1/notifications/preferences
router.get('/preferences', notificationPreferencesController.getNotificationPreferences);

// PATCH /api/v1/notifications/preferences
router.patch('/preferences', notificationPreferencesController.updateNotificationPreferences);

/**
 * @swagger
 * /api/v1/notifications/{id}:
 *   get:
 *     summary: Get single notification (auto-marks as read)
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification detail
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     notification:
 *                       $ref: '#/components/schemas/Notification'
 *       404:
 *         description: Notification not found
 *   delete:
 *     summary: Delete a notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification deleted
 *       404:
 *         description: Notification not found
 */
// GET /api/v1/notifications/:id - single notification (auto-marks read)
router.get('/:id', notificationController.getNotification);

/**
 * @swagger
 * /api/v1/notifications/{id}/read:
 *   patch:
 *     summary: Mark a single notification as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification marked as read
 *       404:
 *         description: Notification not found
 */
// PATCH /api/v1/notifications/:id/read - mark one as read
router.patch('/:id/read', notificationController.markAsRead);

// DELETE /api/v1/notifications/:id
router.delete('/:id', notificationController.deleteNotification);

/**
 * @swagger
 * components:
 *   schemas:
 *     Notification:
 *       type: object
 *       properties:
 *         _id:
 *           type: string
 *         userId:
 *           type: string
 *         type:
 *           type: string
 *           enum: [transaction_alert, weekly_summary, budget_warning, spending_insight, goal_progress, import_complete]
 *         urgency:
 *           type: string
 *           enum: [instant, daily, weekly]
 *         title:
 *           type: string
 *         message:
 *           type: string
 *         icon:
 *           type: string
 *           enum: [alert, info, success, warning, money, import, goal]
 *         aiAdvice:
 *           type: string
 *         riskScore:
 *           type: number
 *         amount:
 *           type: number
 *         category:
 *           type: string
 *         transactionId:
 *           type: string
 *         transactionType:
 *           type: string
 *           enum: [expense, income]
 *         isRead:
 *           type: boolean
 *         readAt:
 *           type: string
 *           format: date-time
 *         metadata:
 *           type: object
 *         timeAgo:
 *           type: string
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 */

module.exports = router;
