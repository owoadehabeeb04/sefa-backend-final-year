const Notification = require('../models/Notification');
const NotificationPreferences = require('../models/NotificationPreferences');
const Expense = require('../models/Expense');
const Income = require('../models/Income');

const notificationGenService = require('../services/notificationGen.service');
const pushService = require('../services/push.service');

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
    
    // Check if notification should be sent
    if (!preferences.shouldSendNotification(type)) {
      console.log('   ⏭️  Notification disabled by user preferences');
      return {
        success: false,
        reason: 'Disabled by user preferences'
      };
    }
    
    // Check quiet hours
    if (preferences.isInQuietHours()) {
      console.log('   🌙 In quiet hours, skipping notification');
      return {
        success: false,
        reason: 'In quiet hours'
      };
    }
    
    // Check daily limit
    if (preferences.isDailyLimitReached()) {
      console.log('   ⚠️  Daily notification limit reached');
      return {
        success: false,
        reason: 'Daily limit reached'
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
      aiAdvice,
      riskScore,
      data
    });
    
    job.progress(70);
    
    // Step 5: Send push notification (if enabled and token available)
    if (preferences.pushEnabled && preferences.pushToken) {
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
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    
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
