const express = require('express');

const assistantController = require('../controllers/assistantController');
const { authenticate, requireVerifiedEmail, requireOnboardingComplete } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, requireVerifiedEmail, requireOnboardingComplete);

router.get('/chats/search', assistantController.searchChats);
router.post('/chats', assistantController.createChat);
router.get('/chats', assistantController.listChats);
router.get('/chats/:chatId/stream', assistantController.streamChat);
router.get('/chats/:chatId', assistantController.getChat);
router.patch('/chats/:chatId', assistantController.updateChat);
router.delete('/chats/:chatId', assistantController.deleteChat);

router.post('/chats/:chatId/messages', assistantController.sendMessage);
router.patch('/chats/:chatId/messages/:messageId', assistantController.editMessage);
router.post('/chats/:chatId/messages/:messageId/regenerate', assistantController.regenerateMessage);
router.post('/chats/:chatId/messages/:messageId/retry', assistantController.retryMessage);
router.post('/chats/:chatId/messages/:messageId/cancel', assistantController.cancelMessage);

router.post('/actions/:actionId/confirm', assistantController.confirmAction);
router.post('/actions/:actionId/cancel', assistantController.cancelAction);
router.post('/actions/:actionId/edit', assistantController.editAction);

module.exports = router;
