const express = require('express');
const router = express.Router();
const syncController = require('../controllers/sync.controller');
const { protect } = require('../middleware/auth.middleware');

/**
 * Sync Routes
 * Base path: /api/v1/sync
 * 
 * Handles bank transaction synchronization:
 * - Manual sync triggers
 * - Sync status monitoring
 * - Sync history and logs
 * - Sync statistics
 * - Sync settings management
 */

// All routes require authentication
router.use(protect);

/**
 * @route   POST /api/v1/sync/all
 * @desc    Sync all user's bank connections
 * @access  Private
 */
router.post('/all', syncController.syncAllUserConnections);

/**
 * @route   GET /api/v1/sync/history
 * @desc    Get sync history
 * @access  Private
 * @query   page, limit, status, connectionId
 */
router.get('/history', syncController.getSyncHistory);

/**
 * @route   DELETE /api/v1/sync/history/:id/transactions
 * @desc    Clear transactions imported by a specific sync log
 * @access  Private
 */
router.delete('/history/:id/transactions', syncController.clearSyncTransactions);

/**
 * @route   GET /api/v1/sync/stats
 * @desc    Get sync statistics
 * @access  Private
 * @query   days (default: 30)
 */
router.get('/stats', syncController.getSyncStatistics);

/**
 * @route   GET /api/v1/sync/global-stats
 * @desc    Get global sync statistics (monitoring)
 * @access  Private (Admin only in production)
 */
router.get('/global-stats', syncController.getGlobalSyncStats);

/**
 * @route   POST /api/v1/sync/retry
 * @desc    Retry failed syncs
 * @access  Private
 */
router.post('/retry', syncController.retryFailedSyncs);

/**
 * @route   POST /api/v1/sync/connections/:id
 * @desc    Sync a specific bank connection
 * @access  Private
 * @param   id - Bank connection ID
 */
router.post('/connections/:id', syncController.syncConnection);

/**
 * @route   GET /api/v1/sync/connections/:id/status
 * @desc    Get sync status for a connection
 * @access  Private
 * @param   id - Bank connection ID
 */
router.get('/connections/:id/status', syncController.getSyncStatus);

/**
 * @route   POST /api/v1/sync/connections/:id/cancel
 * @desc    Cancel ongoing sync
 * @access  Private
 * @param   id - Bank connection ID
 */
router.post('/connections/:id/cancel', syncController.cancelSync);

/**
 * @route   PATCH /api/v1/sync/connections/:id/settings
 * @desc    Update sync settings
 * @access  Private
 * @param   id - Bank connection ID
 * @body    { autoSync: boolean, syncInterval: number }
 */
router.patch('/connections/:id/settings', syncController.updateSyncSettings);

module.exports = router;
