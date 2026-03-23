const Queue = require('bull');
const Redis = require('ioredis');

// Import processors
const { processImportJob } = require('../workers/importProcessor');
const { processSyncJob } = require('../workers/syncProcessor');
const { processNotificationJob } = require('../workers/notificationProcessor');

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_URL?.split('://')[1]?.split(':')[0] || 'localhost',
  port: parseInt(process.env.REDIS_URL?.split(':')[2]) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB) || 0,
  maxRetriesPerRequest: null,
  enableReadyCheck: false
};

// Create Redis client
const redisClient = new Redis(redisConfig);

// Queue options
const queueOptions = {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: true,
    removeOnFail: false
  }
};

// Create queues
const importQueue = new Queue('import-processing', queueOptions);
const syncQueue = new Queue('bank-sync', queueOptions);
const notificationQueue = new Queue('notifications', queueOptions);

// Queue event handlers
const setupQueueHandlers = (queue, queueName) => {
  queue.on('error', (error) => {
    console.error(`❌ ${queueName} queue error:`, error.message);
  });

  queue.on('waiting', (jobId) => {
    console.log(`⏳ ${queueName} job ${jobId} is waiting`);
  });

  queue.on('active', (job) => {
    console.log(`▶️  ${queueName} job ${job.id} started processing`);
  });

  queue.on('completed', (job, result) => {
    console.log(`✅ ${queueName} job ${job.id} completed`);
  });

  queue.on('failed', (job, error) => {
    console.error(`❌ ${queueName} job ${job.id} failed:`, error.message);
  });

  queue.on('stalled', (job) => {
    console.warn(`⚠️  ${queueName} job ${job.id} stalled`);
  });
};

// Setup handlers for all queues
setupQueueHandlers(importQueue, 'Import');
setupQueueHandlers(syncQueue, 'Sync');
setupQueueHandlers(notificationQueue, 'Notification');

/**
 * Add import job to queue
 * @param {Object} data - Job data
 * @returns {Promise<Job>}
 */
const addImportJob = async (data) => {
  return await importQueue.add('process-import', data, {
    priority: data.priority || 1,
    timeout: 300000 // 5 minutes
  });
};

/**
 * Add sync job to queue
 * @param {Object} data - Job data
 * @returns {Promise<Job>}
 */
const addSyncJob = async (data, options = {}) => {
  return await syncQueue.add('sync-transactions', data, {
    priority: data.priority || 2,
    timeout: 180000, // 3 minutes
    ...(options.jobId ? { jobId: options.jobId } : {})
  });
};

/**
 * Add notification job to queue
 * @param {Object} data - Job data
 * @returns {Promise<Job>}
 */
const addNotificationJob = async (data) => {
  return await notificationQueue.add('send-notification', data, {
    priority: data.urgency === 'instant' ? 1 : data.urgency === 'daily' ? 2 : 3,
    timeout: 30000, // 30 seconds
    delay: data.delay || 0
  });
};

/**
 * Get job status
 * @param {string} queueName - Queue name
 * @param {string} jobId - Job ID
 * @returns {Promise<Object>}
 */
const getJobStatus = async (queueName, jobId) => {
  let queue;
  
  switch (queueName) {
    case 'import':
      queue = importQueue;
      break;
    case 'sync':
      queue = syncQueue;
      break;
    case 'notification':
      queue = notificationQueue;
      break;
    default:
      throw new Error('Invalid queue name');
  }

  const job = await queue.getJob(jobId);
  
  if (!job) {
    return null;
  }

  const state = await job.getState();
  
  return {
    id: job.id,
    state,
    progress: job.progress(),
    data: job.data,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    attemptsMade: job.attemptsMade,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn
  };
};

/**
 * Get queue statistics
 * @param {string} queueName - Queue name
 * @returns {Promise<Object>}
 */
const getQueueStats = async (queueName) => {
  let queue;
  
  switch (queueName) {
    case 'import':
      queue = importQueue;
      break;
    case 'sync':
      queue = syncQueue;
      break;
    case 'notification':
      queue = notificationQueue;
      break;
    default:
      throw new Error('Invalid queue name');
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount()
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + completed + failed + delayed
  };
};

/**
 * Clean old jobs from queue
 * @param {string} queueName - Queue name
 * @param {number} grace - Grace period in ms (default 24h)
 * @returns {Promise<void>}
 */
const cleanQueue = async (queueName, grace = 86400000) => {
  let queue;
  
  switch (queueName) {
    case 'import':
      queue = importQueue;
      break;
    case 'sync':
      queue = syncQueue;
      break;
    case 'notification':
      queue = notificationQueue;
      break;
    default:
      throw new Error('Invalid queue name');
  }

  await queue.clean(grace, 'completed');
  await queue.clean(grace, 'failed');
};

/**
 * Initialize queue processors
 * Must be called after all models are loaded
 * @returns {void}
 */
const initializeProcessors = () => {
  // Register import processor
  importQueue.process('process-import', 1, async (job) => {
    return await processImportJob(job);
  });

  // Register sync processor
  syncQueue.process('sync-transactions', 1, async (job) => {
    return await processSyncJob(job);
  });

  // Register notification processor
  notificationQueue.process('send-notification', 5, async (job) => {
    return await processNotificationJob(job);
  });

  console.log('✅ Queue processors initialized');
};

/**
 * Gracefully close all queues
 * @returns {Promise<void>}
 */
const closeQueues = async () => {
  await Promise.all([
    importQueue.close(),
    syncQueue.close(),
    notificationQueue.close()
  ]);
  
  await redisClient.quit();
  console.log('✅ All queues closed');
};

module.exports = {
  redisClient,
  importQueue,
  syncQueue,
  notificationQueue,
  initializeProcessors,
  addImportJob,
  addSyncJob,
  addNotificationJob,
  getJobStatus,
  getQueueStats,
  cleanQueue,
  closeQueues
};
