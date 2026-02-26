const { successResponse, errorResponse } = require('../utils/response');
const spendingPatternService = require('../services/spendingPatternAnalyzer.service');
const anomalyDetectionService = require('../services/anomalyDetection.service');
const budgetRecommendationService = require('../services/budgetRecommendation.service');
const savingsSuggestionService = require('../services/savingsSuggestion.service');
const aiCategorizationService = require('../services/aiCategorization.service');

/**
 * @swagger
 * tags:
 *   name: Insights
 *   description: AI-powered financial insights and recommendations
 */

/**
 * Get comprehensive spending pattern analysis
 * @route GET /api/v1/insights/spending-patterns
 * @param {Number} req.query.months - Number of months to analyze (default: 3)
 */
exports.getSpendingPatterns = async (req, res) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months) || 3;

    if (months < 1 || months > 12) {
      return errorResponse(res, 'Months must be between 1 and 12', 400);
    }

    const patterns = await spendingPatternService.analyzeSpendingPatterns(userId, { months });

    return successResponse(res, patterns, 'Spending patterns analyzed successfully');
  } catch (error) {
    console.error('Get spending patterns error:', error);
    return errorResponse(res, 'Failed to analyze spending patterns', 500);
  }
};

/**
 * Get spending anomalies detection
 * @route GET /api/v1/insights/anomalies
 * @param {Number} req.query.lookbackDays - Days to analyze (default: 30)
 * @param {Number} req.query.threshold - Sensitivity 1-5 (default: 3)
 */
exports.getAnomalies = async (req, res) => {
  try {
    const userId = req.user._id;
    const lookbackDays = parseInt(req.query.lookbackDays) || 30;
    const threshold = parseInt(req.query.threshold) || 3;

    if (lookbackDays < 7 || lookbackDays > 365) {
      return errorResponse(res, 'Lookback days must be between 7 and 365', 400);
    }

    if (threshold < 1 || threshold > 5) {
      return errorResponse(res, 'Threshold must be between 1 and 5', 400);
    }

    const anomalies = await anomalyDetectionService.detectAnomalies(userId, { lookbackDays, threshold });

    return successResponse(res, anomalies, 'Anomalies detected successfully');
  } catch (error) {
    console.error('Get anomalies error:', error);
    return errorResponse(res, 'Failed to detect anomalies', 500);
  }
};

/**
 * Get anomaly summary for dashboard
 * @route GET /api/v1/insights/anomalies/summary
 */
exports.getAnomalySummary = async (req, res) => {
  try {
    const userId = req.user._id;

    const summary = await anomalyDetectionService.getAnomalySummary(userId);

    return successResponse(res, summary, 'Anomaly summary retrieved successfully');
  } catch (error) {
    console.error('Get anomaly summary error:', error);
    return errorResponse(res, 'Failed to get anomaly summary', 500);
  }
};

/**
 * Get budget recommendations
 * @route GET /api/v1/insights/budget-recommendations
 * @param {Number} req.query.months - Number of months to analyze (default: 3)
 */
exports.getBudgetRecommendations = async (req, res) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months) || 3;

    if (months < 1 || months > 12) {
      return errorResponse(res, 'Months must be between 1 and 12', 400);
    }

    const recommendations = await budgetRecommendationService.generateBudgetRecommendations(userId, { months });

    return successResponse(res, recommendations, 'Budget recommendations generated successfully');
  } catch (error) {
    console.error('Get budget recommendations error:', error);
    return errorResponse(res, 'Failed to generate budget recommendations', 500);
  }
};

/**
 * Get savings suggestions
 * @route GET /api/v1/insights/savings-suggestions
 * @param {Number} req.query.months - Number of months to analyze (default: 3)
 */
exports.getSavingsSuggestions = async (req, res) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months) || 3;

    if (months < 1 || months > 12) {
      return errorResponse(res, 'Months must be between 1 and 12', 400);
    }

    const suggestions = await savingsSuggestionService.generateSavingsSuggestions(userId, { months });

    return successResponse(res, suggestions, 'Savings suggestions generated successfully');
  } catch (error) {
    console.error('Get savings suggestions error:', error);
    return errorResponse(res, 'Failed to generate savings suggestions', 500);
  }
};

/**
 * Categorize a single transaction using AI
 * @route POST /api/v1/insights/categorize-transaction
 * @body {String} description - Transaction description
 * @body {Number} amount - Transaction amount
 * @body {String} type - Transaction type ('income' or 'expense')
 */
exports.categorizeTransaction = async (req, res) => {
  try {
    const userId = req.user._id;
    const { description, amount, type } = req.body;

    if (!description || !amount || !type) {
      return errorResponse(res, 'Description, amount, and type are required', 400);
    }

    if (!['income', 'expense'].includes(type)) {
      return errorResponse(res, 'Type must be either "income" or "expense"', 400);
    }

    const transaction = { description, amount, type };
    const categorization = await aiCategorizationService.categorizeTransaction(transaction, userId);

    return successResponse(res, categorization, 'Transaction categorized successfully');
  } catch (error) {
    console.error('Categorize transaction error:', error);
    return errorResponse(res, 'Failed to categorize transaction', 500);
  }
};

/**
 * Batch categorize multiple transactions
 * @route POST /api/v1/insights/categorize-batch
 * @body {Array} transactions - Array of transactions to categorize
 */
exports.categorizeBatch = async (req, res) => {
  try {
    const userId = req.user._id;
    const { transactions } = req.body;

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return errorResponse(res, 'Transactions array is required', 400);
    }

    if (transactions.length > 100) {
      return errorResponse(res, 'Maximum 100 transactions per batch', 400);
    }

    // Validate each transaction
    for (const transaction of transactions) {
      if (!transaction.description || !transaction.amount || !transaction.type) {
        return errorResponse(res, 'Each transaction must have description, amount, and type', 400);
      }
      if (!['income', 'expense'].includes(transaction.type)) {
        return errorResponse(res, 'Transaction type must be either "income" or "expense"', 400);
      }
    }

    const categorizations = await aiCategorizationService.batchCategorizeTransactions(transactions, userId);

    return successResponse(res, { categorizations, count: categorizations.length }, 'Transactions categorized successfully');
  } catch (error) {
    console.error('Batch categorize error:', error);
    return errorResponse(res, 'Failed to categorize transactions', 500);
  }
};

/**
 * Get comprehensive financial insights (all-in-one)
 * @route GET /api/v1/insights/comprehensive
 * @param {Number} req.query.months - Number of months to analyze (default: 3)
 */
exports.getComprehensiveInsights = async (req, res) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months) || 3;

    if (months < 1 || months > 12) {
      return errorResponse(res, 'Months must be between 1 and 12', 400);
    }

    // Get all insights in parallel
    const [
      spendingPatterns,
      anomalies,
      budgetRecommendations,
      savingsSuggestions
    ] = await Promise.all([
      spendingPatternService.analyzeSpendingPatterns(userId, { months }),
      anomalyDetectionService.detectAnomalies(userId, { lookbackDays: 30, threshold: 3 }),
      budgetRecommendationService.generateBudgetRecommendations(userId, { months }),
      savingsSuggestionService.generateSavingsSuggestions(userId, { months })
    ]);

    const insights = {
      spendingPatterns: {
        categoryTrends: spendingPatterns.categoryTrends,
        velocity: spendingPatterns.spendingVelocity,
        weekdayPatterns: spendingPatterns.weekdayPatterns,
        insights: spendingPatterns.insights
      },
      anomalies: {
        summary: anomalies.summary,
        recent: anomalies.anomalies.slice(0, 5), // Top 5 anomalies
        recommendations: anomalies.recommendations
      },
      budgetRecommendations: {
        overall: budgetRecommendations.overall,
        topCategories: budgetRecommendations.categories.slice(0, 5),
        savingsGoal: budgetRecommendations.savingsGoal,
        aiAdvice: budgetRecommendations.aiAdvice
      },
      savingsSuggestions: {
        summary: savingsSuggestions.summary,
        quickWins: savingsSuggestions.quickWins,
        topOpportunities: savingsSuggestions.opportunities.categories.slice(0, 5),
        aiAdvice: savingsSuggestions.aiAdvice
      }
    };

    return successResponse(res, insights, 'Comprehensive insights generated successfully');
  } catch (error) {
    console.error('Get comprehensive insights error:', error);
    return errorResponse(res, 'Failed to generate comprehensive insights', 500);
  }
};

/**
 * Get category trends analysis
 * @route GET /api/v1/insights/category-trends
 * @param {Number} req.query.months - Number of months to analyze (default: 3)
 */
exports.getCategoryTrends = async (req, res) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months) || 3;

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const trends = await spendingPatternService.analyzeCategoryTrends(
      userId, 
      startDate, 
      new Date()
    );

    return successResponse(res, trends, 'Category trends analyzed successfully');
  } catch (error) {
    console.error('Get category trends error:', error);
    return errorResponse(res, 'Failed to analyze category trends', 500);
  }
};

/**
 * Get temporal spending patterns
 * @route GET /api/v1/insights/temporal-patterns
 * @param {Number} req.query.lookbackDays - Days to analyze (default: 30)
 */
exports.getTemporalPatterns = async (req, res) => {
  try {
    const userId = req.user._id;
    const lookbackDays = parseInt(req.query.lookbackDays) || 30;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);

    const patterns = await spendingPatternService.analyzeTemporalPatterns(
      userId,
      startDate,
      new Date()
    );

    return successResponse(res, patterns, 'Temporal patterns analyzed successfully');
  } catch (error) {
    console.error('Get temporal patterns error:', error);
    return errorResponse(res, 'Failed to analyze temporal patterns', 500);
  }
};

/**
 * Get monthly comparison
 * @route GET /api/v1/insights/monthly-comparison
 * @param {Number} req.query.months - Number of months to compare (default: 3)
 */
exports.getMonthlyComparison = async (req, res) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months) || 3;

    if (months < 2 || months > 12) {
      return errorResponse(res, 'Months must be between 2 and 12', 400);
    }

    const comparison = await spendingPatternService.analyzeMonthlyComparison(userId, months);

    return successResponse(res, comparison, 'Monthly comparison generated successfully');
  } catch (error) {
    console.error('Get monthly comparison error:', error);
    return errorResponse(res, 'Failed to generate monthly comparison', 500);
  }
};

module.exports = exports;
