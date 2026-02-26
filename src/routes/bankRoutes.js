const express = require('express');
const router = express.Router();

const bankController = require('../controllers/bankConnectionController');
const { authenticate } = require('../middleware/auth.middleware');
const { handleFileUpload } = require('../middleware/upload.middleware');
const { 
  verifyMonoWebhook, 
  logWebhookEvent, 
  handleWebhookEvent 
} = require('../middleware/webhookAuth.middleware');

/**
 * Bank Connection Routes
 * Base path: /api/bank
 */

// ============================================
// AUTHENTICATED ROUTES (Require JWT)
// ============================================

/**
 * @route   POST /api/bank/connect
 * @desc    Connect bank account via Mono
 * @access  Private
 * @body    { code: string }
 */
router.post('/connect', authenticate, bankController.connectBankAccount);

/**
 * @route   GET /api/bank/connections
 * @desc    Get all user's bank connections
 * @access  Private
 */
router.get('/connections', authenticate, bankController.getBankConnections);

/**
 * @route   GET /api/bank/connections/:id
 * @desc    Get single bank connection
 * @access  Private
 */
router.get('/connections/:id', authenticate, bankController.getBankConnection);

/**
 * @route   POST /api/bank/connections/:id/sync
 * @desc    Manually trigger bank sync
 * @access  Private
 */
router.post('/connections/:id/sync', authenticate, bankController.syncBankTransactions);

/**
 * @route   DELETE /api/bank/connections/:id
 * @desc    Disconnect bank account
 * @access  Private
 */
router.delete('/connections/:id', authenticate, bankController.disconnectBankAccount);

/**
 * @route   POST /api/bank/upload
 * @desc    Upload bank statement (CSV/PDF)
 * @access  Private
 * @body    FormData with 'file' field
 */
router.post('/upload', authenticate, handleFileUpload, bankController.uploadBankStatement);

/**
 * @route   GET /api/bank/import/:jobId
 * @desc    Get import job status
 * @access  Private
 */
router.get('/import/:jobId', authenticate, bankController.getImportJobStatus);

/**
 * @route   GET /api/bank/imports
 * @desc    Get import history
 * @access  Private
 * @query   { page: number, limit: number }
 */
router.get('/imports', authenticate, bankController.getImportHistory);

/**
 * @route   POST /api/bank/import/:jobId/undo
 * @desc    Undo import (delete imported transactions)
 * @access  Private
 */
router.post('/import/:jobId/undo', authenticate, bankController.undoImport);

// ============================================
// WEBHOOK ROUTES (No JWT, uses signature)
// ============================================

/**
 * @route   POST /api/bank/webhook
 * @desc    Receive Mono webhooks
 * @access  Public (secured by signature verification)
 * @body    Mono webhook payload
 */
router.post(
  '/webhook',
  logWebhookEvent,
  verifyMonoWebhook,
  handleWebhookEvent,
  bankController.handleMonoWebhook
);

module.exports = router;
