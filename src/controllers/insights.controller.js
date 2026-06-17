const { successResponse, errorResponse } = require('../utils/response');
const spendingPatternService = require('../services/spendingPatternAnalyzer.service');
const anomalyDetectionService = require('../services/anomalyDetection.service');
const budgetRecommendationService = require('../services/budgetRecommendation.service');
const savingsSuggestionService = require('../services/savingsSuggestion.service');
const aiCategorizationService = require('../services/aiCategorization.service');
const insightHubService = require('../services/insights/insightHub.service');
const forecastService = require('../services/insights/forecast.service');
const healthScoreService = require('../services/insights/healthScore.service');
const copilotService = require('../services/insights/copilot.service');
const insightSnapshotService = require('../services/insights/insightSnapshot.service');
const insightAiSummaryService = require('../services/insights/insightAiSummary.service');

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

exports.getInsightsHub = async (req, res) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months, 10) || 3;
    const days = parseInt(req.query.days, 10) === 7 ? 7 : 30;

    if (months < 1 || months > 12) {
      return errorResponse(res, 'Months must be between 1 and 12', 400);
    }

    const hub = await insightHubService.buildInsightsHub(userId, { months, days });
    return successResponse(res, hub, 'Insights hub generated successfully');
  } catch (error) {
    console.error('Get insights hub error:', error);
    return errorResponse(res, 'Failed to generate insights hub', 500);
  }
};

exports.getHealthScore = async (req, res) => {
  try {
    const userId = req.user._id;
    const score = await healthScoreService.generateHealthScore(userId, { days: 90 });
    return successResponse(res, score, 'Health score generated successfully');
  } catch (error) {
    console.error('Get health score error:', error);
    return errorResponse(res, 'Failed to generate health score', 500);
  }
};

exports.getForecast = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = parseInt(req.query.days, 10) === 7 ? 7 : 30;
    const forecast = await forecastService.generateForecast(userId, { days });
    return successResponse(res, forecast, 'Forecast generated successfully');
  } catch (error) {
    console.error('Get forecast error:', error);
    return errorResponse(res, 'Failed to generate forecast', 500);
  }
};

exports.runWhatIfScenario = async (req, res) => {
  try {
    const userId = req.user._id;
    const scenario = await insightHubService.runWhatIfScenario(userId, req.body || {});
    return successResponse(res, scenario, 'Scenario simulated successfully');
  } catch (error) {
    console.error('Run what-if scenario error:', error);
    return errorResponse(res, 'Failed to simulate scenario', 500);
  }
};

exports.chatWithCopilot = async (req, res) => {
  try {
    const userId = req.user._id;
    const question = String(req.body?.question || '').trim();

    if (!question) {
      return errorResponse(res, 'Question is required', 400);
    }

    const answer = await copilotService.answerInsightQuestion(userId, question, {
      months: parseInt(req.body?.months, 10) || 3,
      days: parseInt(req.body?.days, 10) === 7 ? 7 : 30,
    });

    return successResponse(res, answer, 'Copilot response generated successfully');
  } catch (error) {
    console.error('Copilot chat error:', error);
    return errorResponse(res, 'Failed to generate copilot response', 500);
  }
};

exports.submitFeedback = async (req, res) => {
  try {
    const userId = req.user._id;
    const { insightKey, insightType, rating } = req.body || {};

    if (!insightKey || !insightType || !rating) {
      return errorResponse(res, 'insightKey, insightType, and rating are required', 400);
    }

    const feedback = await insightHubService.submitInsightFeedback(userId, req.body);
    return successResponse(res, feedback, 'Insight feedback recorded successfully', 201);
  } catch (error) {
    console.error('Submit insight feedback error:', error);
    return errorResponse(res, 'Failed to record insight feedback', 500);
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

/* ------------------------------------------------------------------ *
 * Financial Intelligence Dashboard (calculated-first, AI explains)
 * ------------------------------------------------------------------ */

const resolvePeriodKey = (req) => {
  const raw = String(req.query.period || req.query.periodKey || '').trim();
  return /^\d{4}-\d{2}$/.test(raw) ? raw : undefined;
};

/**
 * Full layered dashboard payload (snapshot + breakdown + drivers + savings +
 * budget health). Cached via MonthlyInsightSnapshot. AI summary is loaded
 * separately (or streamed) so the dashboard renders fast.
 * @route GET /api/v1/insights/dashboard
 */
exports.getDashboard = async (req, res) => {
  try {
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, {
      periodKey: resolvePeriodKey(req),
      forceRefresh: req.query.refresh === 'true',
    });
    return successResponse(res, dashboard, 'Insights dashboard generated successfully');
  } catch (error) {
    console.error('Get insights dashboard error:', error);
    return errorResponse(res, 'Failed to generate insights dashboard', 500);
  }
};

/**
 * Financial snapshot only (Layer 1).
 * @route GET /api/v1/insights/overview
 */
exports.getOverview = async (req, res) => {
  try {
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, {
      periodKey: resolvePeriodKey(req),
      forceRefresh: req.query.refresh === 'true',
    });
    return successResponse(
      res,
      {
        period: dashboard.period,
        periodKey: dashboard.periodKey,
        hasData: dashboard.hasData,
        hasBudgets: dashboard.hasBudgets,
        lastCalculatedAt: dashboard.lastCalculatedAt,
        ...dashboard.snapshot,
      },
      'Financial overview generated successfully'
    );
  } catch (error) {
    console.error('Get insights overview error:', error);
    return errorResponse(res, 'Failed to generate financial overview', 500);
  }
};

/**
 * Category breakdown + pie chart data (Layer 2).
 * @route GET /api/v1/insights/category-breakdown
 */
exports.getCategoryBreakdown = async (req, res) => {
  try {
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, {
      periodKey: resolvePeriodKey(req),
    });
    return successResponse(
      res,
      {
        period: dashboard.period,
        hasData: dashboard.hasData,
        totalExpenses: dashboard.snapshot.totalExpenses,
        categoryBreakdown: dashboard.categoryBreakdown,
        pieChart: dashboard.pieChart,
      },
      'Category breakdown generated successfully'
    );
  } catch (error) {
    console.error('Get category breakdown error:', error);
    return errorResponse(res, 'Failed to generate category breakdown', 500);
  }
};

/**
 * Spending drivers — "what's taking most of your money" (Layer 3).
 * @route GET /api/v1/insights/spending-drivers
 */
exports.getSpendingDrivers = async (req, res) => {
  try {
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, {
      periodKey: resolvePeriodKey(req),
    });
    return successResponse(
      res,
      {
        period: dashboard.period,
        hasData: dashboard.hasData,
        spendingDrivers: dashboard.spendingDrivers,
      },
      'Spending drivers generated successfully'
    );
  } catch (error) {
    console.error('Get spending drivers error:', error);
    return errorResponse(res, 'Failed to generate spending drivers', 500);
  }
};

/**
 * Savings opportunities (Layer 3).
 * @route GET /api/v1/insights/savings-opportunities
 */
exports.getSavingsOpportunities = async (req, res) => {
  try {
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, {
      periodKey: resolvePeriodKey(req),
    });
    return successResponse(
      res,
      {
        period: dashboard.period,
        hasData: dashboard.hasData,
        savingsPotential: dashboard.snapshot.savingsPotential,
        savingsSummary: dashboard.savingsSummary,
        savingsOpportunities: dashboard.savingsOpportunities,
      },
      'Savings opportunities generated successfully'
    );
  } catch (error) {
    console.error('Get savings opportunities error:', error);
    return errorResponse(res, 'Failed to generate savings opportunities', 500);
  }
};

/**
 * Budget health (Layer 3).
 * @route GET /api/v1/insights/budget-health
 */
exports.getBudgetHealth = async (req, res) => {
  try {
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, {
      periodKey: resolvePeriodKey(req),
    });
    return successResponse(
      res,
      {
        period: dashboard.period,
        hasData: dashboard.hasData,
        hasBudgets: dashboard.hasBudgets,
        budgetUsage: dashboard.snapshot.budgetUsage,
        budgetHealth: dashboard.budgetHealth,
      },
      'Budget health generated successfully'
    );
  } catch (error) {
    console.error('Get budget health error:', error);
    return errorResponse(res, 'Failed to generate budget health', 500);
  }
};

/**
 * Grounded AI summary (buffered). Reads the cached dashboard, asks the AI to
 * explain (never invent) the numbers, persists the summary onto the snapshot.
 * @route GET /api/v1/insights/summary
 */
exports.getSummary = async (req, res) => {
  try {
    const periodKey = resolvePeriodKey(req);
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, { periodKey });
    const summary = await insightAiSummaryService.generateSummary(dashboard);
    await insightSnapshotService.saveAiSummary(req.user._id, dashboard.periodKey, summary);
    return successResponse(res, { period: dashboard.period, aiSummary: summary }, 'Insight summary generated successfully');
  } catch (error) {
    console.error('Get insight summary error:', error);
    return errorResponse(res, 'Failed to generate insight summary', 500);
  }
};

/**
 * Streaming grounded AI summary via SSE (Layer 4).
 * @route GET /api/v1/insights/summary/stream
 */
exports.streamSummary = async (req, res) => {
  const sendEvent = (type, payload) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const periodKey = resolvePeriodKey(req);
    const dashboard = await insightSnapshotService.getDashboard(req.user._id, { periodKey });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sendEvent('ready', { period: dashboard.period, hasData: dashboard.hasData });

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const finalSummary = await insightAiSummaryService.streamSummary(dashboard, async ({ delta, fullText, isFinal }) => {
      if (closed) return;
      if (delta) sendEvent('delta', { delta, fullText });
      if (isFinal) sendEvent('done', { fullText });
    });

    if (!closed) {
      await insightSnapshotService.saveAiSummary(req.user._id, dashboard.periodKey, finalSummary);
      sendEvent('summary', { aiSummary: finalSummary });
      res.end();
    }
  } catch (error) {
    console.error('Stream insight summary error:', error);
    if (!res.headersSent) {
      return errorResponse(res, 'Failed to stream insight summary', 500);
    }
    sendEvent('error', { message: 'Failed to stream insight summary' });
    res.end();
  }
};

module.exports = exports;
