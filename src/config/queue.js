const Queue = require('bull');
const Redis = require('ioredis');

const { processSyncJob } = require('../workers/syncProcessor');
const { processNotificationJob } = require('../workers/notificationProcessor');
const { processQueuedStatementImport } = require('../workers/statementImportProcessor');
const { processQueuedAssistantJob } = require('../workers/assistantProcessor');

const redisConfig = {
  host: process.env.REDIS_URL?.split('://')[1]?.split(':')[0] || 'localhost',
  port: parseInt(process.env.REDIS_URL?.split(':')[2], 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB, 10) || 0,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const redisClient = new Redis(redisConfig);

const queueOptions = {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
};

const syncQueue = new Queue('bank-sync', queueOptions);
const notificationQueue = new Queue('notifications', queueOptions);
const statementImportQueue = new Queue('statement-imports', queueOptions);
const assistantQueue = new Queue('assistant', queueOptions);

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

  queue.on('completed', (job) => {
    console.log(`✅ ${queueName} job ${job.id} completed`);
  });

  queue.on('failed', (job, error) => {
    console.error(`❌ ${queueName} job ${job.id} failed:`, error.message);
  });

  queue.on('stalled', (job) => {
    console.warn(`⚠️  ${queueName} job ${job.id} stalled`);
  });
};

setupQueueHandlers(syncQueue, 'Sync');
setupQueueHandlers(notificationQueue, 'Notification');
setupQueueHandlers(statementImportQueue, 'Statement import');
setupQueueHandlers(assistantQueue, 'Assistant');

const addSyncJob = async (data, options = {}) => {
  return syncQueue.add('sync-transactions', data, {
    priority: data.priority || 2,
    timeout: 180000,
    ...(options.jobId ? { jobId: options.jobId } : {}),
  });
};

const addNotificationJob = async (data) => {
  return notificationQueue.add('send-notification', data, {
    priority: data.urgency === 'instant' ? 1 : data.urgency === 'daily' ? 2 : 3,
    timeout: 30000,
    delay: data.delay || 0,
  });
};

const addStatementImportJob = async (data) => {
  return statementImportQueue.add('process-statement-import', data, {
    priority: 2,
    timeout: 240000,
    attempts: 1,
  });
};

const addAssistantJob = async (data) => {
  return assistantQueue.add('process-assistant-message', data, {
    priority: 2,
    timeout: 300000,
  });
};

const getNamedQueue = (queueName) => {
  switch (queueName) {
    case 'sync':
      return syncQueue;
    case 'notification':
      return notificationQueue;
    case 'statement-import':
      return statementImportQueue;
    case 'assistant':
      return assistantQueue;
    default:
      throw new Error('Invalid queue name');
  }
};

const getJobStatus = async (queueName, jobId) => {
  const queue = getNamedQueue(queueName);
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
    finishedOn: job.finishedOn,
  };
};

const getQueueStats = async (queueName) => {
  const queue = getNamedQueue(queueName);
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + completed + failed + delayed,
  };
};

const cleanQueue = async (queueName, grace = 86400000) => {
  const queue = getNamedQueue(queueName);

  await queue.clean(grace, 'completed');
  await queue.clean(grace, 'failed');
};

const initializeProcessors = () => {
  syncQueue.process('sync-transactions', 1, async (job) => {
    return processSyncJob(job);
  });

  notificationQueue.process('send-notification', 5, async (job) => {
    return processNotificationJob(job);
  });

  statementImportQueue.process('process-statement-import', 1, async (job) => {
    return processQueuedStatementImport(job);
  });

  assistantQueue.process('process-assistant-message', 2, async (job) => {
    return processQueuedAssistantJob(job);
  });

  console.log('✅ Queue processors initialized');
};

const closeQueues = async () => {
  await Promise.all([syncQueue.close(), notificationQueue.close(), statementImportQueue.close(), assistantQueue.close()]);
  await redisClient.quit();
  console.log('✅ All queues closed');
};

module.exports = {
  redisClient,
  syncQueue,
  notificationQueue,
  statementImportQueue,
  assistantQueue,
  initializeProcessors,
  addSyncJob,
  addNotificationJob,
  addStatementImportJob,
  addAssistantJob,
  getJobStatus,
  getQueueStats,
  cleanQueue,
  closeQueues,
};
