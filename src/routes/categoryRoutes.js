const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { authenticate, requireVerifiedEmail, requireOnboardingComplete } = require('../middleware/auth');

router.use(authenticate, requireVerifiedEmail, requireOnboardingComplete);

router.get('/', categoryController.getCategories);
router.post('/', categoryController.createCategory);
router.get('/:id', categoryController.getCategory);
router.put('/:id', categoryController.updateCategory);
router.patch('/:id/disable', categoryController.disableCategory);
router.patch('/:id/enable', categoryController.enableCategory);
router.delete('/:id', categoryController.deleteCategory);

module.exports = router;
