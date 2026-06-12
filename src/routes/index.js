const express = require('express');
const router = express.Router();

// Import routes
const authRoutes = require('./authRoutes');
const onboardingRoutes = require('./onboardingRoutes');
const categoryRoutes = require('./categoryRoutes');
const expenseRoutes = require('./expenseRoutes');
const incomeRoutes = require('./incomeRoutes');
const transactionRoutes = require('./transactionRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const schedulerRoutes = require('./scheduler.routes');
const budgetRoutes = require('./budget.routes');
const syncRoutes = require('./sync.routes');
const insightsRoutes = require('./insights.routes');
const bankRoutes = require('./bankRoutes');
const notificationRoutes = require('./notification.routes');
const statementImportRoutes = require('./statementImportRoutes');
const assistantRoutes = require('./assistantRoutes');

// Mount routes
router.use('/auth', authRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/categories', categoryRoutes);
router.use('/expenses', expenseRoutes);
router.use('/income', incomeRoutes);
router.use('/transactions', transactionRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/scheduler', schedulerRoutes);
router.use('/budgets', budgetRoutes);
router.use('/sync', syncRoutes);
router.use('/insights', insightsRoutes);
router.use('/bank', bankRoutes);
router.use('/notifications', notificationRoutes);
router.use('/statement-imports', statementImportRoutes);
router.use('/assistant', assistantRoutes);

// Health check
router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API is running',
    version: '1.0.0'
  });
});

module.exports = router;
