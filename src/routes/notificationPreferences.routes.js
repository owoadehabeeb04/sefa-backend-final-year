const express = require('express');
const router = express.Router();
const {
  getNotificationPreferences,
  updateNotificationPreferences
} = require('../controllers/notificationPreferences.controller');
const { authenticate, requireVerifiedEmail, requireOnboardingComplete } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate, requireVerifiedEmail, requireOnboardingComplete);

/**
 * @route   GET /api/v1/notifications/preferences
 * @desc    Get notification preferences
 * @access  Private
 */
router.get('/preferences', getNotificationPreferences);

/**
 * @route   PATCH /api/v1/notifications/preferences
 * @desc    Update notification preferences
 * @access  Private
 */
router.patch('/preferences', updateNotificationPreferences);

module.exports = router;
