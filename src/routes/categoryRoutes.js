const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, categoryController.getCategories);
router.post('/', authenticate, categoryController.createCategory);
router.get('/:id', authenticate, categoryController.getCategory);
router.put('/:id', authenticate, categoryController.updateCategory);
router.patch('/:id/disable', authenticate, categoryController.disableCategory);
router.patch('/:id/enable', authenticate, categoryController.enableCategory);
router.delete('/:id', authenticate, categoryController.deleteCategory);

module.exports = router;

