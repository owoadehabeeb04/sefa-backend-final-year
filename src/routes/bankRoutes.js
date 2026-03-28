const express = require('express');
const router = express.Router();

const bankController = require('../controllers/bankConnectionController');
const {
  authenticate,
  requireVerifiedEmail,
  requireOnboardingComplete,
} = require('../middleware/auth.middleware');
const { handleFileUpload } = require('../middleware/upload.middleware');
const { 
  verifyMonoWebhook, 
  logWebhookEvent, 
  handleWebhookEvent 
} = require('../middleware/webhookAuth.middleware');

const gated = [authenticate, requireVerifiedEmail, requireOnboardingComplete];

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
router.post('/connect', gated, bankController.connectBankAccount);

/**
 * @route   GET /api/bank/connections
 * @desc    Get all user's bank connections
 * @access  Private
 */
router.get('/connections', gated, bankController.getBankConnections);

/**
 * @route   GET /api/bank/connections/:id
 * @desc    Get single bank connection
 * @access  Private
 */
router.get('/connections/:id', gated, bankController.getBankConnection);

/**
 * @route   POST /api/bank/connections/:id/sync
 * @desc    Manually trigger bank sync
 * @access  Private
 */
router.post('/connections/:id/sync', gated, bankController.syncBankTransactions);

/**
 * @route   DELETE /api/bank/connections/:id
 * @desc    Disconnect bank account
 * @access  Private
 */
router.delete('/connections/:id', gated, bankController.disconnectBankAccount);

/**
 * @route   POST /api/bank/upload
 * @desc    Upload bank statement (CSV/PDF)
 * @access  Private
 * @body    FormData with 'file' field
 */
router.post('/upload', gated, handleFileUpload, bankController.uploadBankStatement);

/**
 * @route   GET /api/bank/import/:jobId
 * @desc    Get import job status
 * @access  Private
 */
router.get('/import/:jobId', gated, bankController.getImportJobStatus);

/**
 * @route   GET /api/bank/imports
 * @desc    Get import history
 * @access  Private
 * @query   { page: number, limit: number }
 */
router.get('/imports', gated, bankController.getImportHistory);

/**
 * @route   POST /api/bank/import/:jobId/undo
 * @desc    Undo import (delete imported transactions)
 * @access  Private
 */
router.post('/import/:jobId/undo', gated, bankController.undoImport);

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
