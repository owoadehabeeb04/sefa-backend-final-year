const cron = require('node-cron');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Budget = require('../models/Budget');
const User = require('../models/User');
const NotificationPreferences = require('../models/NotificationPreferences');
const { addNotificationJob } = require('../config/queue');

/**
 * Notification Scheduler Service
 * Manages automated scheduled notifications for users
 */

class SchedulerService {
  constructor() {
    this.jobs = new Map();
    this.isRunning = false;
  }

  /**
   * Start all scheduled jobs
   */
  start() {
    if (this.isRunning) {
      console.log('⚠️  Scheduler already running');
      return;
    }

    console.log('🕐 Starting notification schedulers...');

    // Daily budget checks at 8 PM
    this.jobs.set('daily-budget-check', cron.schedule('0 20 * * *', async () => {
      console.log('[Scheduler] Running daily budget check...');
      await this.checkBudgets();
    }));

    // Weekly summaries on Sundays at 9 AM
    this.jobs.set('weekly-summary', cron.schedule('0 9 * * 0', async () => {
      console.log('[Scheduler] Generating weekly summaries...');
      await this.generateWeeklySummaries();
    }));

    // Spending insights on Fridays at 6 PM
    this.jobs.set('spending-insights', cron.schedule('0 18 * * 5', async () => {
      console.log('[Scheduler] Analyzing spending insights...');
      await this.analyzeSpendingInsights();
    }));

    // Reset daily notification counters at midnight
    this.jobs.set('reset-counters', cron.schedule('0 0 * * *', async () => {
      console.log('[Scheduler] Resetting daily notification counters...');
      await this.resetDailyCounters();
    }));

    // Monthly budget reset on 1st of month at 12 AM
    this.jobs.set('monthly-budget-reset', cron.schedule('0 0 1 * *', async () => {
      console.log('[Scheduler] Resetting monthly budgets...');
      await this.resetMonthlyBudgets();
    }));

    this.isRunning = true;
    console.log('✅ All schedulers started');
  }

  /**
   * Stop all scheduled jobs
   */
  stop() {
    if (!this.isRunning) {
      console.log('⚠️  Scheduler not running');
      return;
    }

    console.log('🛑 Stopping notification schedulers...');
    
    for (const [name, job] of this.jobs.entries()) {
      job.stop();
      console.log(`  Stopped: ${name}`);
    }

    this.jobs.clear();
    this.isRunning = false;
    console.log('✅ All schedulers stopped');
  }

  /**
   * Check budgets for all users and send warnings
   */
  async checkBudgets() {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      // Find all active budgets
      const activeBudgets = await Budget.find({
        period: 'monthly',
        isActive: true
      }).populate('userId');

      let warningsSent = 0;
      let criticalSent = 0;

      for (const budget of activeBudgets) {
        // Calculate spending for this budget
        const spending = await Expense.aggregate([
          {
            $match: {
              userId: budget.userId._id,
              category: budget.category,
              date: { $gte: startOfMonth, $lte: endOfMonth }
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' }
            }
          }
        ]);

        const totalSpent = spending[0]?.total || 0;
        const percentage = (totalSpent / budget.amount) * 100;
        const remaining = budget.amount - totalSpent;

        // Send warning at 80%
        if (percentage >= 80 && percentage < 100 && !budget.warningNotificationSent) {
          await addNotificationJob({
            userId: budget.userId._id.toString(),
            type: 'budget_warning',
            data: {
              budget: {
                id: budget._id,
                category: budget.category,
                amount: budget.amount,
                spent: totalSpent,
                remaining,
                percentage: Math.round(percentage)
              }
            },
            urgency: 'daily'
          });

          budget.warningNotificationSent = true;
          await budget.save();
          warningsSent++;
        }

        // Send critical alert at 100%
        if (percentage >= 100 && !budget.criticalNotificationSent) {
          await addNotificationJob({
            userId: budget.userId._id.toString(),
            type: 'budget_exceeded',
            data: {
              budget: {
                id: budget._id,
                category: budget.category,
                amount: budget.amount,
                spent: totalSpent,
                overspent: totalSpent - budget.amount,
                percentage: Math.round(percentage)
              }
            },
            urgency: 'instant'
          });

          budget.criticalNotificationSent = true;
          await budget.save();
          criticalSent++;
        }
      }

      console.log(`✅ Budget check complete: ${warningsSent} warnings, ${criticalSent} critical alerts`);
      return { warningsSent, criticalSent };

    } catch (error) {
      console.error('❌ Error checking budgets:', error);
      throw error;
    }
  }

  /**
   * Generate weekly summaries for all users
   */
  async generateWeeklySummaries() {
    try {
      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Find all active users with weekly summaries enabled
      const users = await User.find({ isVerified: true });
      let summariesSent = 0;

      for (const user of users) {
        // Check if user has weekly summaries enabled
        const preferences = await NotificationPreferences.getEffectivePreferences(user._id);
        
        if (!preferences.types.weekly_summary) {
          continue;
        }

        // Calculate weekly spending
        const expenses = await Expense.aggregate([
          {
            $match: {
              userId: user._id,
              date: { $gte: oneWeekAgo, $lte: now }
            }
          },
          {
            $group: {
              _id: '$category',
              total: { $sum: '$amount' },
              count: { $sum: 1 }
            }
          },
          { $sort: { total: -1 } }
        ]);

        const income = await Income.aggregate([
          {
            $match: {
              userId: user._id,
              date: { $gte: oneWeekAgo, $lte: now }
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' }
            }
          }
        ]);

        const totalExpenses = expenses.reduce((sum, cat) => sum + cat.total, 0);
        const totalIncome = income[0]?.total || 0;
        const netSavings = totalIncome - totalExpenses;
        const transactionCount = expenses.reduce((sum, cat) => sum + cat.count, 0);

        // Skip if no activity
        if (transactionCount === 0) {
          continue;
        }

        // Get top 3 categories
        const topCategories = expenses.slice(0, 3).map(cat => ({
          category: cat._id,
          amount: cat.total,
          count: cat.count
        }));

        await addNotificationJob({
          userId: user._id.toString(),
          type: 'weekly_summary',
          data: {
            summary: {
              startDate: oneWeekAgo,
              endDate: now,
              totalExpenses,
              totalIncome,
              netSavings,
              transactionCount,
              topCategories,
              categoryBreakdown: expenses
            }
          },
          urgency: 'weekly'
        });

        summariesSent++;
      }

      console.log(`✅ Weekly summaries generated: ${summariesSent} sent`);
      return { summariesSent };

    } catch (error) {
      console.error('❌ Error generating weekly summaries:', error);
      throw error;
    }
  }

  /**
   * Analyze spending patterns and send insights
   */
  async analyzeSpendingInsights() {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      const users = await User.find({ isVerified: true });
      let insightsSent = 0;

      for (const user of users) {
        // Check if user has spending insights enabled
        const preferences = await NotificationPreferences.getEffectivePreferences(user._id);
        
        if (!preferences.types.spending_insight) {
          continue;
        }

        // Get current month spending
        const currentMonthSpending = await Expense.aggregate([
          {
            $match: {
              userId: user._id,
              date: { $gte: thirtyDaysAgo, $lte: now }
            }
          },
          {
            $group: {
              _id: '$category',
              total: { $sum: '$amount' },
              count: { $sum: 1 },
              avgAmount: { $avg: '$amount' }
            }
          }
        ]);

        // Get previous month spending for comparison
        const previousMonthSpending = await Expense.aggregate([
          {
            $match: {
              userId: user._id,
              date: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo }
            }
          },
          {
            $group: {
              _id: '$category',
              total: { $sum: '$amount' }
            }
          }
        ]);

        // Create map for easy comparison
        const previousSpendingMap = new Map(
          previousMonthSpending.map(cat => [cat._id, cat.total])
        );

        // Find significant changes
        for (const currentCat of currentMonthSpending) {
          const previousAmount = previousSpendingMap.get(currentCat._id) || 0;
          const increase = currentCat.total - previousAmount;
          const percentageChange = previousAmount > 0 
            ? ((increase / previousAmount) * 100) 
            : 100;

          // Alert if spending increased by >30% and >₦5,000
          if (percentageChange > 30 && increase > 5000) {
            await addNotificationJob({
              userId: user._id.toString(),
              type: 'spending_insight',
              data: {
                insight: {
                  pattern: 'increased_spending',
                  category: currentCat._id,
                  currentAmount: currentCat.total,
                  previousAmount,
                  change: increase,
                  percentageChange: Math.round(percentageChange),
                  transactionCount: currentCat.count,
                  avgTransactionAmount: Math.round(currentCat.avgAmount)
                }
              },
              urgency: 'daily'
            });

            insightsSent++;
          }

          // Alert for unusual frequency
          if (currentCat.count > 20 && currentCat.avgAmount < 2000) {
            await addNotificationJob({
              userId: user._id.toString(),
              type: 'spending_insight',
              data: {
                insight: {
                  pattern: 'frequent_small_purchases',
                  category: currentCat._id,
                  transactionCount: currentCat.count,
                  totalAmount: currentCat.total,
                  avgAmount: Math.round(currentCat.avgAmount)
                }
              },
              urgency: 'daily'
            });

            insightsSent++;
          }
        }
      }

      console.log(`✅ Spending insights analyzed: ${insightsSent} insights sent`);
      return { insightsSent };

    } catch (error) {
      console.error('❌ Error analyzing spending insights:', error);
      throw error;
    }
  }

  /**
   * Reset daily notification counters for all users
   */
  async resetDailyCounters() {
    try {
      const result = await NotificationPreferences.updateMany(
        {},
        {
          $set: { notificationsSentToday: 0 }
        }
      );

      console.log(`✅ Reset notification counters for ${result.modifiedCount} users`);
      return { resetCount: result.modifiedCount };

    } catch (error) {
      console.error('❌ Error resetting daily counters:', error);
      throw error;
    }
  }

  /**
   * Reset monthly budget notification flags
   */
  async resetMonthlyBudgets() {
    try {
      const result = await Budget.updateMany(
        { period: 'monthly' },
        {
          $set: {
            warningNotificationSent: false,
            criticalNotificationSent: false
          }
        }
      );

      console.log(`✅ Reset budget flags for ${result.modifiedCount} budgets`);
      return { resetCount: result.modifiedCount };

    } catch (error) {
      console.error('❌ Error resetting monthly budgets:', error);
      throw error;
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      jobs: Array.from(this.jobs.keys()),
      jobCount: this.jobs.size
    };
  }

  /**
   * Manually trigger a specific job
   */
  async triggerJob(jobName) {
    switch (jobName) {
      case 'daily-budget-check':
        return await this.checkBudgets();
      case 'weekly-summary':
        return await this.generateWeeklySummaries();
      case 'spending-insights':
        return await this.analyzeSpendingInsights();
      case 'reset-counters':
        return await this.resetDailyCounters();
      case 'monthly-budget-reset':
        return await this.resetMonthlyBudgets();
      default:
        throw new Error(`Unknown job: ${jobName}`);
    }
  }

  /**
   * Get next scheduled execution times
   */
  getSchedule() {
    return [
      { job: 'daily-budget-check', schedule: '8:00 PM daily', cron: '0 20 * * *' },
      { job: 'weekly-summary', schedule: '9:00 AM Sundays', cron: '0 9 * * 0' },
      { job: 'spending-insights', schedule: '6:00 PM Fridays', cron: '0 18 * * 5' },
      { job: 'reset-counters', schedule: '12:00 AM daily', cron: '0 0 * * *' },
      { job: 'monthly-budget-reset', schedule: '12:00 AM on 1st', cron: '0 0 1 * *' }
    ];
  }
}

// Export singleton instance
const schedulerService = new SchedulerService();

module.exports = schedulerService;
