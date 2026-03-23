const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const insightsController = require('../controllers/insights.controller');

/**
 * All routes require authentication
 */
router.use(protect);

/**
 * @swagger
 * /api/v1/insights/comprehensive:
 *   get:
 *     summary: Get comprehensive financial insights
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 3
 *         description: Number of months to analyze
 *     responses:
 *       200:
 *         description: Comprehensive insights generated
 *       401:
 *         description: Unauthorized
 */
router.get('/comprehensive', insightsController.getComprehensiveInsights);
router.get('/hub', insightsController.getInsightsHub);
router.get('/health-score', insightsController.getHealthScore);
router.get('/forecast', insightsController.getForecast);

/**
 * @swagger
 * /api/v1/insights/spending-patterns:
 *   get:
 *     summary: Get spending pattern analysis
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 3
 *         description: Number of months to analyze
 *     responses:
 *       200:
 *         description: Spending patterns analyzed
 */
router.get('/spending-patterns', insightsController.getSpendingPatterns);

/**
 * @swagger
 * /api/v1/insights/anomalies:
 *   get:
 *     summary: Detect spending anomalies
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: lookbackDays
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Days to analyze
 *       - in: query
 *         name: threshold
 *         schema:
 *           type: integer
 *           default: 3
 *         description: Sensitivity (1-5)
 *     responses:
 *       200:
 *         description: Anomalies detected
 */
router.get('/anomalies', insightsController.getAnomalies);

/**
 * @swagger
 * /api/v1/insights/anomalies/summary:
 *   get:
 *     summary: Get anomaly summary for dashboard
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Anomaly summary retrieved
 */
router.get('/anomalies/summary', insightsController.getAnomalySummary);

/**
 * @swagger
 * /api/v1/insights/budget-recommendations:
 *   get:
 *     summary: Get AI-powered budget recommendations
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 3
 *         description: Number of months to analyze
 *     responses:
 *       200:
 *         description: Budget recommendations generated
 */
router.get('/budget-recommendations', insightsController.getBudgetRecommendations);

/**
 * @swagger
 * /api/v1/insights/savings-suggestions:
 *   get:
 *     summary: Get personalized savings suggestions
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 3
 *         description: Number of months to analyze
 *     responses:
 *       200:
 *         description: Savings suggestions generated
 */
router.get('/savings-suggestions', insightsController.getSavingsSuggestions);

/**
 * @swagger
 * /api/v1/insights/category-trends:
 *   get:
 *     summary: Get category spending trends
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 3
 *         description: Number of months to analyze
 *     responses:
 *       200:
 *         description: Category trends analyzed
 */
router.get('/category-trends', insightsController.getCategoryTrends);

/**
 * @swagger
 * /api/v1/insights/temporal-patterns:
 *   get:
 *     summary: Get temporal spending patterns
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: lookbackDays
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Days to analyze
 *     responses:
 *       200:
 *         description: Temporal patterns analyzed
 */
router.get('/temporal-patterns', insightsController.getTemporalPatterns);

/**
 * @swagger
 * /api/v1/insights/monthly-comparison:
 *   get:
 *     summary: Get monthly spending comparison
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 3
 *         description: Number of months to compare
 *     responses:
 *       200:
 *         description: Monthly comparison generated
 */
router.get('/monthly-comparison', insightsController.getMonthlyComparison);

/**
 * @swagger
 * /api/v1/insights/categorize-transaction:
 *   post:
 *     summary: Categorize a single transaction using AI
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - description
 *               - amount
 *               - type
 *             properties:
 *               description:
 *                 type: string
 *               amount:
 *                 type: number
 *               type:
 *                 type: string
 *                 enum: [income, expense]
 *     responses:
 *       200:
 *         description: Transaction categorized
 */
router.post('/categorize-transaction', insightsController.categorizeTransaction);
router.post('/what-if', insightsController.runWhatIfScenario);
router.post('/chat', insightsController.chatWithCopilot);
router.post('/feedback', insightsController.submitFeedback);

/**
 * @swagger
 * /api/v1/insights/categorize-batch:
 *   post:
 *     summary: Batch categorize multiple transactions
 *     tags: [Insights]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - transactions
 *             properties:
 *               transactions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     description:
 *                       type: string
 *                     amount:
 *                       type: number
 *                     type:
 *                       type: string
 *     responses:
 *       200:
 *         description: Transactions categorized
 */
router.post('/categorize-batch', insightsController.categorizeBatch);

module.exports = router;
