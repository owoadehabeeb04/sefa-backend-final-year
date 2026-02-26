const Category = require('../models/Category');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * @swagger
 * tags:
 *   name: Categories
 *   description: Income and expense categories management
 */

/**
 * @swagger
 * /api/v1/categories:
 *   get:
 *     summary: Get all active categories for user
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [income, expense]
 *         description: Filter by category type
 *     responses:
 *       200:
 *         description: Categories retrieved successfully
 */
exports.getCategories = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { type } = req.query;

    const filter = { userId, isActive: true };
    if (type) {
      filter.type = type;
    }

    const categories = await Category.find(filter).sort({ source: 1, name: 1 });

    const grouped = {
      income: categories.filter(c => c.type === 'income'),
      expense: categories.filter(c => c.type === 'expense')
    };

    return successResponse(
      res,
      {
        categories: type ? categories : grouped,
        total: categories.length,
        income: grouped.income.length,
        expense: grouped.expense.length
      },
      'Categories retrieved successfully'
    );
  } catch (error) {
    console.error('Get categories error:', error);
    return errorResponse(res, 'Failed to retrieve categories', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/categories:
 *   post:
 *     summary: Create a custom category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [income, expense]
 *               icon:
 *                 type: string
 *               color:
 *                 type: string
 *     responses:
 *       201:
 *         description: Category created successfully
 */
exports.createCategory = async (req, res, next) => {
  try {
    const { name, type, icon, color } = req.body;
    const userId = req.user.userId;

    // Check if category already exists
    const existingCategory = await Category.findOne({ userId, name, isActive: true });
    if (existingCategory) {
      return errorResponse(res, 'Category with this name already exists', 409);
    }

    const category = await Category.create({
      userId,
      name,
      type,
      icon: icon || 'folder',
      color: color || '#3498db',
      source: 'user',
      isActive: true
    });

    return successResponse(
      res,
      { category },
      'Category created successfully',
      201
    );
  } catch (error) {
    console.error('Create category error:', error);
    return errorResponse(res, 'Failed to create category', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/categories/{id}:
 *   get:
 *     summary: Get a single category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category retrieved successfully
 */
exports.getCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const category = await Category.findOne({ _id: id, userId });
    if (!category) {
      return errorResponse(res, 'Category not found', 404);
    }

    return successResponse(
      res,
      { category },
      'Category retrieved successfully'
    );
  } catch (error) {
    console.error('Get category error:', error);
    return errorResponse(res, 'Failed to retrieve category', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/categories/{id}:
 *   put:
 *     summary: Update a category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               icon:
 *                 type: string
 *               color:
 *                 type: string
 *     responses:
 *       200:
 *         description: Category updated successfully
 */
exports.updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, icon, color } = req.body;
    const userId = req.user.userId;

    const category = await Category.findOne({ _id: id, userId });
    if (!category) {
      return errorResponse(res, 'Category not found', 404);
    }

    // Don't allow updating system categories
    if (category.source === 'system') {
      return errorResponse(res, 'Cannot update system categories', 403);
    }

    // Update fields
    if (name) category.name = name;
    if (icon) category.icon = icon;
    if (color) category.color = color;

    await category.save();

    return successResponse(
      res,
      { category },
      'Category updated successfully'
    );
  } catch (error) {
    console.error('Update category error:', error);
    return errorResponse(res, 'Failed to update category', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/categories/{id}/disable:
 *   patch:
 *     summary: Disable a category (soft delete)
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category disabled successfully
 */
exports.disableCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const category = await Category.findOne({ _id: id, userId });
    if (!category) {
      return errorResponse(res, 'Category not found', 404);
    }

    category.isActive = false;
    await category.save();

    return successResponse(
      res,
      { category },
      'Category disabled successfully'
    );
  } catch (error) {
    console.error('Disable category error:', error);
    return errorResponse(res, 'Failed to disable category', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/categories/{id}/enable:
 *   patch:
 *     summary: Enable a previously disabled category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category enabled successfully
 */
exports.enableCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const category = await Category.findOne({ _id: id, userId });
    if (!category) {
      return errorResponse(res, 'Category not found', 404);
    }

    category.isActive = true;
    await category.save();

    return successResponse(
      res,
      { category },
      'Category enabled successfully'
    );
  } catch (error) {
    console.error('Enable category error:', error);
    return errorResponse(res, 'Failed to enable category', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/categories/{id}:
 *   delete:
 *     summary: Delete a category (permanent delete, only for user-created categories)
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category deleted successfully
 */
exports.deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const category = await Category.findOne({ _id: id, userId });
    if (!category) {
      return errorResponse(res, 'Category not found', 404);
    }

    // Don't allow deleting system categories
    if (category.source === 'system') {
      return errorResponse(res, 'Cannot delete system categories. Use disable instead.', 403);
    }

    await category.deleteOne();

    return successResponse(
      res,
      { message: 'Category deleted successfully' },
      'Category deleted successfully'
    );
  } catch (error) {
    console.error('Delete category error:', error);
    return errorResponse(res, 'Failed to delete category', 500, error.message);
  }
};

