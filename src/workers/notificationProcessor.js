const Notification = require('../models/Notification');
const NotificationPreferences = require('../models/NotificationPreferences');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Budget = require('../models/Budget');

const notificationGenService = require('../services/notificationGen.service');
const pushService = require('../services/push.service');

/**
 * Map notification type to icon
 */
const getIconForType = (type) => {
  const iconMap = {
    transaction_alert: 'money',
    budget_warning: 'warning',
    weekly_summary: 'info',
    spending_insight: 'alert',
    goal_progress: 'goal',
    import_complete: 'import',
  };
  return iconMap[type] || 'info';
};

/**
 * Notification Queue Processor
 * Generates and sends push notifications with AI advice
 */

/**
 * Process notification job
 * @param {Object} job - Bull job object
 * @returns {Promise<Object>} Processing result
 */
const processNotificationJob = async (job) => {
  const { userId, type, urgency, data } = job.data;
  
  console.log(`\n🔔 Processing notification job ${job.id}`);
  console.log(`   User: ${userId}, Type: ${type}, Urgency: ${urgency}`);
  
  try {
    // Step 1: Get user notification preferences
    const preferences = await NotificationPreferences.getOrCreate(userId);
    
    // Check type-specific preference only (NOT push/token — those gate delivery, not creation)
    const typeMap = {
      transaction_alert: 'transactionAlerts',
      budget_warning: 'budgetWarnings',
      weekly_summary: 'weeklyReports',
      goal_progress: 'goalUpdates',
      import_complete: 'importNotifications'
    };
    const preferenceKey = typeMap[type];
    if (preferenceKey && !preferences[preferenceKey]) {
      console.log(`   ⏭️  Notification type "${type}" disabled by user preferences`);
      return {
        success: false,
        reason: 'Disabled by user preferences'
      };
    }
    
    job.progress(20);
    
    // Step 2: Generate notification content
    console.log('✍️  Step 2: Generating notification content...');
    
    const title = notificationGenService.generateNotificationTitle(type, data);
    const body = notificationGenService.generateNotificationBody(type, data);
    
    job.progress(40);
    
    // Step 3: Generate AI advice
    console.log('🤖 Step 3: Generating AI advice...');
    
    let aiAdvice = null;
    let riskScore = 0;
    
    try {
      const context = await getNotificationContext(userId, type, data);
      
      switch (type) {
        case 'transaction_alert':
          aiAdvice = await notificationGenService.generateTransactionAdvice(data, context);
          riskScore = notificationGenService.calculateRiskScore(type, { ...data, ...context });
          break;
          
        case 'budget_warning':
          aiAdvice = await notificationGenService.generateBudgetWarningAdvice(data, context);
          riskScore = notificationGenService.calculateRiskScore(type, data);
          break;
          
        case 'weekly_summary':
          aiAdvice = await notificationGenService.generateWeeklySummaryAdvice(data);
          break;
          
        case 'spending_insight':
          aiAdvice = await notificationGenService.generateSpendingInsightAdvice(data);
          riskScore = notificationGenService.calculateRiskScore(type, data);
          break;
          
        default:
          aiAdvice = notificationGenService.getFallbackAdvice();
      }
    } catch (error) {
      console.warn('⚠️  AI advice generation failed:', error.message);
      aiAdvice = notificationGenService.getFallbackAdvice();
    }
    
    console.log(`   ✅ AI advice: ${aiAdvice}`);
    console.log(`   Risk score: ${riskScore}`);
    
    job.progress(60);
    
    // Step 4: Create notification record
    console.log('💾 Step 4: Creating notification record...');
    
    const notification = await Notification.create({
      userId,
      type,
      urgency,
      title,
      message: body,
      icon: getIconForType(type),
      aiAdvice,
      riskScore,
      amount: data.amount || null,
      category: data.category || null,
      transactionId: data.transactionId || null,
      transactionType: data.transactionType || null,
      metadata: data
    });
    
    job.progress(70);
    
    // Step 5: Send push notification (if enabled, token available, not in quiet hours, within daily limit)
    const canPush = preferences.pushEnabled && preferences.pushToken
      && !preferences.isInQuietHours() && !preferences.isDailyLimitReached();

    if (canPush) {
      console.log('📤 Step 5: Sending push notification...');
      
      try {
        const pushNotification = pushService.formatNotification({
          ...notification.toObject(),
          title,
          body: aiAdvice || body // Use AI advice as body if available
        });
        
        const result = await pushService.sendPushNotification(
          preferences.pushToken,
          pushNotification
        );
        
        // Update notification with push ticket
        notification.deliveryStatus = 'sent';
        notification.pushTicket = result.ticketId;
        await notification.save();
        
        // Increment daily count
        await preferences.incrementDailyCount();
        
        console.log('   ✅ Push notification sent');
        
        job.progress(100);
        
        return {
          success: true,
          notificationId: notification._id,
          pushTicket: result.ticketId,
          aiAdvice
        };
        
      } catch (pushError) {
        console.error('❌ Push notification failed:', pushError.message);
        
        // Update notification status
        notification.deliveryStatus = 'failed';
        notification.deliveryError = pushError.message;
        await notification.save();
        
        // Still return success (notification created, push failed)
        return {
          success: true,
          notificationId: notification._id,
          pushFailed: true,
          error: pushError.message
        };
      }
    } else {
      console.log('   ⏭️  Push notifications disabled or no token');
      
      job.progress(100);
      
      return {
        success: true,
        notificationId: notification._id,
        pushSkipped: true
      };
    }
    
  } catch (error) {
    console.error('❌ Notification processing failed:', error);
    throw error;
  }
};

/**
 * Get context for notification generation
 * @param {string} userId - User ID
 * @param {string} type - Notification type
 * @param {Object} data - Notification data
 * @returns {Promise<Object>} Context data
 */
const getNotificationContext = async (userId, type, data) => {
  const context = {};
  
  try {
    // Get current month spending
    const now = new Date();
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    
    const monthlyExpenses = await Expense.aggregate([
      {
        $match: {
          userId: userId,
          date: { $gte: startOfMonth },
          isTransfer: false
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);
    
    context.monthlySpending = monthlyExpenses[0]?.total || 0;

    // Get current month income
    const monthlyIncome = await Income.aggregate([
      {
        $match: {
          userId: userId,
          date: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);

    context.monthlyIncome = monthlyIncome[0]?.total || 0;
    
    // Get category spending (if category provided)
    if (data.category) {
      const categoryExpenses = await Expense.aggregate([
        {
          $match: {
            userId: userId,
            date: { $gte: startOfMonth },
            category: data.category,
            isTransfer: false
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ]);
      
      context.categorySpending = categoryExpenses[0]?.total || 0;

      // Get active monthly budget for this category
      const categoryBudget = await Budget.findOne({
        userId,
        isActive: true,
        period: 'monthly',
        startDate: { $lte: now },
        endDate: { $gte: startOfMonth },
        category: { $regex: new RegExp(`^${String(data.category).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      }).lean();

      if (categoryBudget) {
        const categoryBudgetSpent = context.categorySpending || 0;
        const categoryBudgetLimit = Number(categoryBudget.amount) || 0;
        const categoryBudgetRemaining = categoryBudgetLimit - categoryBudgetSpent;
        const categoryBudgetPercentage = categoryBudgetLimit > 0
          ? (categoryBudgetSpent / categoryBudgetLimit) * 100
          : 0;

        context.categoryBudgetLimit = categoryBudgetLimit;
        context.categoryBudgetSpent = categoryBudgetSpent;
        context.categoryBudgetRemaining = categoryBudgetRemaining;
        context.categoryBudgetPercentage = Math.round(categoryBudgetPercentage * 100) / 100;
        context.categoryBudgetStatus = categoryBudgetPercentage >= 100
          ? 'exceeded'
          : categoryBudgetPercentage >= Number(categoryBudget.warningThreshold || 80)
            ? 'warning'
            : 'ok';

        // Backward-compatible key used by prompt service
        context.budgetLimit = categoryBudgetLimit;
      }
    }

    // Get total active monthly budget and month-level status
    const totalMonthlyBudget = await Budget.aggregate([
      {
        $match: {
          userId,
          isActive: true,
          period: 'monthly',
          startDate: { $lte: now },
          endDate: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);

    context.totalMonthlyBudgetLimit = totalMonthlyBudget[0]?.total || 0;
    context.totalMonthlyBudgetSpent = context.monthlySpending || 0;
    context.totalMonthlyBudgetRemaining = context.totalMonthlyBudgetLimit - context.totalMonthlyBudgetSpent;
    context.totalMonthlyBudgetPercentage = context.totalMonthlyBudgetLimit > 0
      ? Math.round(((context.totalMonthlyBudgetSpent / context.totalMonthlyBudgetLimit) * 100) * 100) / 100
      : 0;
    context.totalMonthlyBudgetStatus = context.totalMonthlyBudgetLimit > 0
      ? (context.totalMonthlyBudgetSpent >= context.totalMonthlyBudgetLimit ? 'exceeded' : 'ok')
      : 'no_budget';

    // For budget warnings, verify budget status directly from DB if budget id is provided
    if (type === 'budget_warning' && data?.budget?.id) {
      const budgetDoc = await Budget.findById(data.budget.id).lean();

      if (budgetDoc) {
        const verifiedSpendResult = await Expense.aggregate([
          {
            $match: {
              userId,
              category: budgetDoc.category,
              date: {
                $gte: budgetDoc.startDate,
                $lte: budgetDoc.endDate
              },
              isTransfer: false
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' }
            }
          }
        ]);

        const verifiedSpent = verifiedSpendResult[0]?.total || 0;
        const verifiedLimit = Number(budgetDoc.amount) || 0;
        const verifiedPercentage = verifiedLimit > 0 ? (verifiedSpent / verifiedLimit) * 100 : 0;

        context.verifiedBudget = {
          category: budgetDoc.category,
          limit: verifiedLimit,
          spent: verifiedSpent,
          remaining: Math.max(verifiedLimit - verifiedSpent, 0),
          overspent: Math.max(verifiedSpent - verifiedLimit, 0),
          percentage: Math.round(verifiedPercentage * 100) / 100,
          status: verifiedPercentage >= 100
            ? 'exceeded'
            : verifiedPercentage >= Number(budgetDoc.warningThreshold || 80)
              ? 'warning'
              : 'ok'
        };
      }
    }
    
    // Calculate monthly average
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const avgExpenses = await Expense.aggregate([
      {
        $match: {
          userId: userId,
          date: { $gte: threeMonthsAgo },
          isTransfer: false
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' }
          },
          total: { $sum: '$amount' }
        }
      }
    ]);
    
    if (avgExpenses.length > 0) {
      const sum = avgExpenses.reduce((acc, month) => acc + month.total, 0);
      context.monthlyAverage = sum / avgExpenses.length;
    }
    
  } catch (error) {
    console.warn('⚠️  Failed to get notification context:', error.message);
  }
  
  return context;
};

/**
 * Process batch notifications (for weekly summaries, etc.)
 * @param {Array} jobs - Array of notification jobs
 * @returns {Promise<Object>} Batch processing result
 */
const processBatchNotifications = async (jobs) => {
  console.log(`\n📬 Processing batch of ${jobs.length} notifications`);
  
  const results = {
    total: jobs.length,
    successful: 0,
    failed: 0,
    skipped: 0
  };
  
  for (const job of jobs) {
    try {
      const result = await processNotificationJob(job);
      
      if (result.success) {
        results.successful++;
      } else {
        results.skipped++;
      }
    } catch (error) {
      console.error('❌ Batch notification failed:', error.message);
      results.failed++;
    }
  }
  
  console.log(`✅ Batch complete: ${results.successful} sent, ${results.failed} failed, ${results.skipped} skipped`);
  
  return results;
};

module.exports = {
  processNotificationJob,
  getNotificationContext,
  processBatchNotifications
};
