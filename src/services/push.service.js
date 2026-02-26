const { Expo } = require('expo-server-sdk');

/**
 * Push Notification Service (Expo)
 * Sends push notifications to mobile devices
 */

// Create Expo SDK client
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
  useFcmV1: true // Use FCM v1 API
});

/**
 * Send push notification
 * @param {string} pushToken - Expo push token
 * @param {Object} notification - Notification data
 * @returns {Promise<Object>} Send result
 */
const sendPushNotification = async (pushToken, notification) => {
  const { title, body, data } = notification;
  
  // Validate push token
  if (!Expo.isExpoPushToken(pushToken)) {
    throw new Error(`Invalid Expo push token: ${pushToken}`);
  }
  
  // Create message
  const message = {
    to: pushToken,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: notification.priority || 'default',
    badge: notification.badge || 1
  };
  
  try {
    // Send notification
    const chunks = expo.chunkPushNotifications([message]);
    const tickets = [];
    
    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('❌ Error sending chunk:', error);
        throw error;
      }
    }
    
    const ticket = tickets[0];
    
    if (ticket.status === 'error') {
      console.error('❌ Push notification error:', ticket.message);
      throw new Error(ticket.message);
    }
    
    console.log('✅ Push notification sent:', ticket.id);
    
    return {
      success: true,
      ticketId: ticket.id,
      status: ticket.status
    };
    
  } catch (error) {
    console.error('❌ Failed to send push notification:', error);
    throw error;
  }
};

/**
 * Send batch push notifications
 * @param {Array} notifications - Array of { pushToken, title, body, data }
 * @returns {Promise<Object>} Batch send result
 */
const sendBatchPushNotifications = async (notifications) => {
  // Create messages
  const messages = notifications
    .filter(n => Expo.isExpoPushToken(n.pushToken))
    .map(n => ({
      to: n.pushToken,
      sound: 'default',
      title: n.title,
      body: n.body,
      data: n.data || {},
      priority: n.priority || 'default',
      badge: n.badge || 1
    }));
  
  if (messages.length === 0) {
    return {
      success: false,
      message: 'No valid push tokens',
      sent: 0,
      failed: 0
    };
  }
  
  try {
    // Chunk and send
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];
    
    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('❌ Error sending chunk:', error);
      }
    }
    
    // Count results
    const sent = tickets.filter(t => t.status === 'ok').length;
    const failed = tickets.filter(t => t.status === 'error').length;
    
    console.log(`📤 Batch sent: ${sent} successful, ${failed} failed`);
    
    return {
      success: true,
      sent,
      failed,
      tickets
    };
    
  } catch (error) {
    console.error('❌ Batch send failed:', error);
    throw error;
  }
};

/**
 * Check delivery receipts
 * @param {Array} ticketIds - Expo push ticket IDs
 * @returns {Promise<Array>} Receipt results
 */
const checkPushReceipts = async (ticketIds) => {
  try {
    const receiptIdChunks = expo.chunkPushNotificationReceiptIds(ticketIds);
    const receipts = [];
    
    for (const chunk of receiptIdChunks) {
      try {
        const receiptChunk = await expo.getPushNotificationReceiptsAsync(chunk);
        receipts.push(receiptChunk);
      } catch (error) {
        console.error('❌ Error fetching receipts:', error);
      }
    }
    
    return receipts;
  } catch (error) {
    console.error('❌ Failed to check receipts:', error);
    throw error;
  }
};

/**
 * Validate push token
 * @param {string} pushToken - Expo push token
 * @returns {boolean} True if valid
 */
const validatePushToken = (pushToken) => {
  return Expo.isExpoPushToken(pushToken);
};

/**
 * Get push notification priority
 * @param {string} urgency - Notification urgency
 * @returns {string} Expo priority
 */
const getPriority = (urgency) => {
  switch (urgency) {
    case 'instant':
      return 'high';
    case 'daily':
      return 'default';
    case 'weekly':
      return 'normal';
    default:
      return 'default';
  }
};

/**
 * Format notification for Expo
 * @param {Object} notification - Notification data
 * @returns {Object} Formatted notification
 */
const formatNotification = (notification) => {
  return {
    title: notification.title,
    body: notification.body || notification.message,
    data: {
      notificationId: notification._id?.toString(),
      type: notification.type,
      ...notification.data
    },
    priority: getPriority(notification.urgency),
    badge: 1,
    sound: notification.urgency === 'instant' ? 'default' : 'default'
  };
};

module.exports = {
  sendPushNotification,
  sendBatchPushNotifications,
  checkPushReceipts,
  validatePushToken,
  getPriority,
  formatNotification
};
