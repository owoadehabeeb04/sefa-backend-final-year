const express = require('express');

const statementImportController = require('../controllers/statementImportController');
const { authenticate, requireVerifiedEmail, requireOnboardingComplete } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit.middleware');
const { statementUploadMiddleware } = require('../services/statementExtraction.service');

const router = express.Router();

router.use(authenticate, requireVerifiedEmail, requireOnboardingComplete);

router.post('/upload', uploadLimiter, statementUploadMiddleware, statementImportController.uploadStatement);
router.get('/', statementImportController.listImports);
// Live progress stream (SSE). Registered before '/:id' so it is matched first.
router.get('/:id/events', statementImportController.streamImportEvents);
router.get('/:id/rows', statementImportController.getImportRows);
router.patch('/:id/rows/:rowId', statementImportController.updateImportRow);
router.post('/:id/confirm', statementImportController.confirmImport);
router.get('/:id', statementImportController.getImport);
router.delete('/:id', statementImportController.deleteImport);

module.exports = router;
