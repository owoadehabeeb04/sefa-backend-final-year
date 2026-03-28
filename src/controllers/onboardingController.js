const User = require('../models/User');
const Category = require('../models/Category');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * @swagger
 * tags:
 *   name: Onboarding
 *   description: User onboarding process endpoints
 */

// Default system categories
const DEFAULT_EXPENSE_CATEGORIES = [
  { name: 'Food & Dining', icon: '🍽️', color: '#e74c3c' },
  { name: 'Transportation', icon: '🚗', color: '#3498db' },
  { name: 'Rent', icon: '🏠', color: '#9b59b6' },
  { name: 'Utilities', icon: '💡', color: '#f39c12' },
  { name: 'Entertainment', icon: '🎬', color: '#e67e22' },
  { name: 'Shopping', icon: '🛍️', color: '#1abc9c' },
  { name: 'Healthcare', icon: '🏥', color: '#c0392b' },
  { name: 'Education', icon: '📚', color: '#2980b9' },
  { name: 'Personal Care', icon: '💅', color: '#8e44ad' },
  { name: 'Savings', icon: '💰', color: '#27ae60' },
  { name: 'Other', icon: '📦', color: '#95a5a6' }
];

const DEFAULT_INCOME_CATEGORIES = [
  { name: 'Salary', icon: '💼', color: '#27ae60' },
  { name: 'Business', icon: '🏢', color: '#2ecc71' },
  { name: 'Freelance', icon: '💻', color: '#16a085' },
  { name: 'Investments', icon: '📈', color: '#27ae60' },
  { name: 'Other Income', icon: '💵', color: '#2ecc71' }
];

/**
 * @swagger
 * /api/v1/onboarding/profile:
 *   post:
 *     summary: Setup financial profile during onboarding
 *     tags: [Onboarding]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - incomeType
 *               - incomeFrequency
 *             properties:
 *               incomeType:
 *                 type: string
 *                 enum: [salary, business, freelance, mixed, other]
 *               incomeFrequency:
 *                 type: string
 *                 enum: [weekly, bi-weekly, monthly, quarterly, annually]
 *               averageIncome:
 *                 type: number
 *               financialGoals:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Profile setup successful
 */
exports.setupProfile = async (req, res, next) => {
  try {
    const { incomeType, incomeFrequency, averageIncome, financialGoals } = req.body;
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Update financial profile
    user.financialProfile = {
      incomeType,
      incomeFrequency,
      averageIncome,
      financialGoals: financialGoals || []
    };
    user.onboardingStatus = 'profile_completed';

    await user.save();

    return successResponse(
      res,
      {
        user: {
          id: user._id,
          onboardingStatus: user.onboardingStatus,
          financialProfile: user.financialProfile
        }
      },
      'Financial profile setup successful'
    );
  } catch (error) {
    console.error('Setup profile error:', error);
    return errorResponse(res, 'Failed to setup profile', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/onboarding/consent:
 *   post:
 *     summary: Record user consent for data analysis
 *     tags: [Onboarding]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - dataAnalysis
 *             properties:
 *               dataAnalysis:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Consent recorded successfully
 */
exports.recordConsent = async (req, res, next) => {
  try {
    const { dataAnalysis } = req.body;
    const userId = req.user.userId;

    if (typeof dataAnalysis !== 'boolean') {
      return errorResponse(res, 'dataAnalysis must be a boolean', 400);
    }

    if (!dataAnalysis) {
      return errorResponse(res, 'Data analysis consent is required to continue', 400, {
        code: 'CONSENT_REQUIRED',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Record consent
    user.consent = {
      dataAnalysis,
      timestamp: new Date()
    };
    user.onboardingStatus = 'consent_given';

    await user.save();

    // Initialize default categories after consent
    await initializeDefaultCategories(userId);
    user.onboardingStatus = 'categories_initialized';
    await user.save();

    return successResponse(
      res,
      {
        user: {
          id: user._id,
          onboardingStatus: user.onboardingStatus,
          consent: user.consent
        }
      },
      'Consent recorded and categories initialized'
    );
  } catch (error) {
    console.error('Record consent error:', error);
    return errorResponse(res, 'Failed to record consent', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/onboarding/complete:
 *   post:
 *     summary: Complete onboarding process
 *     tags: [Onboarding]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Onboarding completed successfully
 */
exports.completeOnboarding = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    if (!user.consent || !user.consent.dataAnalysis) {
      return errorResponse(res, 'Please accept consent terms', 400);
    }

    // Check if categories exist
    const categoriesCount = await Category.countDocuments({ userId, isActive: true });
    if (categoriesCount === 0) {
      return errorResponse(res, 'No categories found. Please initialize categories.', 400);
    }

    // Mark onboarding as completed
    user.onboardingCompleted = true;
    user.onboardingStatus = 'completed';
    await user.save();

    return successResponse(
      res,
      {
        user: {
          id: user._id,
          onboardingCompleted: user.onboardingCompleted,
          onboardingStatus: user.onboardingStatus
        }
      },
      'Onboarding completed successfully. Welcome to the app!'
    );
  } catch (error) {
    console.error('Complete onboarding error:', error);
    return errorResponse(res, 'Failed to complete onboarding', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/onboarding/status:
 *   get:
 *     summary: Get current onboarding status
 *     tags: [Onboarding]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Onboarding status retrieved
 */
exports.getOnboardingStatus = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    const categoriesCount = await Category.countDocuments({ userId, isActive: true });

    return successResponse(
      res,
      {
        onboardingCompleted: user.onboardingCompleted,
        onboardingStatus: user.onboardingStatus,
        isVerified: user.isVerified,
        steps: {
          budgetSet: user.monthlyBudgetLimit != null && user.monthlyBudgetLimit > 0,
          consentGiven: !!user.consent?.dataAnalysis,
          categoriesInitialized: categoriesCount > 0
        },
        categoriesCount
      },
      'Onboarding status retrieved'
    );
  } catch (error) {
    console.error('Get onboarding status error:', error);
    return errorResponse(res, 'Failed to get onboarding status', 500, error.message);
  }
};

// Helper function to initialize default categories
async function initializeDefaultCategories(userId) {
  try {
    // Check if categories already exist
    const existingCategories = await Category.countDocuments({ userId });
    if (existingCategories > 0) {
      return; // Categories already initialized
    }

    // Create expense categories
    const expenseCategories = DEFAULT_EXPENSE_CATEGORIES.map(cat => ({
      userId,
      name: cat.name,
      type: 'expense',
      icon: cat.icon,
      color: cat.color,
      source: 'system',
      isActive: true
    }));

    // Create income categories
    const incomeCategories = DEFAULT_INCOME_CATEGORIES.map(cat => ({
      userId,
      name: cat.name,
      type: 'income',
      icon: cat.icon,
      color: cat.color,
      source: 'system',
      isActive: true
    }));

    // Insert all categories
    await Category.insertMany([...expenseCategories, ...incomeCategories]);
  } catch (error) {
    console.error('Initialize default categories error:', error);
    throw error;
  }
}
