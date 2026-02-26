const express = require('express');
const router = express.Router();
const {
  getSchedulerStatus,
  getSchedule,
  triggerJob,
  startScheduler,
  stopScheduler,
  testBudgetCheck,
  testWeeklySummary,
  testSpendingInsights
} = require('../controllers/scheduler.controller');
const { protect } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/requireAdmin');

// Public routes (none)

// Protected routes (user)
router.use(protect);

// Test endpoints for users to test their own notifications
router.post('/test/budget-check', testBudgetCheck);
router.post('/test/weekly-summary', testWeeklySummary);
router.post('/test/spending-insights', testSpendingInsights);

// Admin-only routes
router.get('/status', requireAdmin, getSchedulerStatus);
router.get('/schedule', requireAdmin, getSchedule);
router.post('/start', requireAdmin, startScheduler);
router.post('/stop', requireAdmin, stopScheduler);
router.post('/trigger/:jobName', requireAdmin, triggerJob);

module.exports = router;
