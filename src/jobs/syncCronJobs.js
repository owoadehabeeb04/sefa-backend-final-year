const cron = require('node-cron');
const syncScheduler = require('../services/syncScheduler.service');
const SyncLog = require('../models/SyncLog');

/**
 * Sync Cron Jobs
 * 
 * Manages scheduled background synchronization:
 * - Main sync job (every 2 hours)
 * - Retry failed syncs (every 30 minutes)
 * - Clean old logs (daily)
 * - Monitoring and health checks
 */

/**
 * Main sync job
 * Runs every 2 hours to sync connections due for update
 */
const mainSyncJob = cron.schedule('0 */2 * * *', async () => {
  console.log('[Sync Cron] Starting scheduled sync job...');
  
  try {
    const result = await syncScheduler.syncAllConnections({ forceSync: false });
    
    console.log('[Sync Cron] Sync completed:', {
      synced: result.synced,
      failed: result.failed,
      skipped: result.skipped,
      totalConnections: result.totalConnections
    });

    // Log to database for monitoring
    if (result.failed > 0) {
      console.error('[Sync Cron] Some syncs failed:', result.errors);
    }
  } catch (error) {
    console.error('[Sync Cron] Sync job failed:', error);
  }
}, {
  scheduled: false,
  timezone: 'Africa/Lagos' // Nigerian timezone
});

/**
 * Retry failed syncs job
 * Runs every 30 minutes to retry failed syncs with exponential backoff
 */
const retryFailedSyncsJob = cron.schedule('*/30 * * * *', async () => {
  console.log('[Retry Cron] Starting retry job...');
  
  try {
    const failedLogs = await SyncLog.getLogsForRetry();
    
    if (failedLogs.length === 0) {
      console.log('[Retry Cron] No failed syncs to retry');
      return;
    }

    console.log(`[Retry Cron] Found ${failedLogs.length} failed syncs to retry`);

    let retried = 0;
    let successful = 0;
    let failed = 0;

    for (const log of failedLogs) {
      try {
        if (!log.connectionId || !log.connectionId.isActive) {
          continue;
        }

        retried++;

        // Update log for retry attempt
        log.syncType = 'retry';
        await log.save();

        await syncScheduler.queueConnectionSync(log.connectionId, log.userId, {
          syncType: 'retry',
          triggeredBy: 'system',
          forceSync: true,
        });

        successful++;
        console.log(`[Retry Cron] Successfully retried sync for connection ${log.connectionId._id}`);
      } catch (error) {
        failed++;
        console.error(`[Retry Cron] Retry failed for connection ${log.connectionId._id}:`, error.message);
        
        // Update log with failure
        await log.markAsFailed(error);
      }
    }

    console.log('[Retry Cron] Retry job completed:', {
      retried,
      successful,
      failed
    });
  } catch (error) {
    console.error('[Retry Cron] Retry job failed:', error);
  }
}, {
  scheduled: false,
  timezone: 'Africa/Lagos'
});

/**
 * Clean old logs job
 * Runs daily at 2:00 AM to remove logs older than 90 days
 */
const cleanOldLogsJob = cron.schedule('0 2 * * *', async () => {
  console.log('[Cleanup Cron] Starting log cleanup...');
  
  try {
    const result = await SyncLog.cleanOldLogs(90);
    
    console.log('[Cleanup Cron] Cleanup completed:', {
      deleted: result.deleted,
      cutoffDate: result.cutoffDate
    });
  } catch (error) {
    console.error('[Cleanup Cron] Cleanup job failed:', error);
  }
}, {
  scheduled: false,
  timezone: 'Africa/Lagos'
});

/**
 * Health check job
 * Runs every hour to monitor sync system health
 */
const healthCheckJob = cron.schedule('0 * * * *', async () => {
  try {
    const stats = await syncScheduler.getSyncStats();
    
    // Alert conditions
    const alerts = [];

    // Too many connections in error state
    if (stats.errorConnections > stats.totalConnections * 0.2) {
      alerts.push({
        severity: 'warning',
        message: `High error rate: ${stats.errorConnections}/${stats.totalConnections} connections in error state`
      });
    }

    // Too many connections syncing (possible stuck syncs)
    if (stats.syncingNow > 10) {
      alerts.push({
        severity: 'warning',
        message: `Many syncs in progress: ${stats.syncingNow} connections currently syncing`
      });
    }

    // Too many connections due for sync (backlog)
    if (stats.dueForSync > stats.autoSyncEnabled * 0.5) {
      alerts.push({
        severity: 'info',
        message: `Sync backlog: ${stats.dueForSync} connections due for sync`
      });
    }

    if (alerts.length > 0) {
      console.warn('[Health Check] Alerts detected:', alerts);
      // In production, send alerts via email, Slack, etc.
    } else {
      console.log('[Health Check] System healthy:', stats);
    }
  } catch (error) {
    console.error('[Health Check] Health check failed:', error);
  }
}, {
  scheduled: false,
  timezone: 'Africa/Lagos'
});

/**
 * Start all cron jobs
 */
const startSyncCronJobs = () => {
  console.log('[Sync Cron] Starting all sync cron jobs...');
  
  mainSyncJob.start();
  retryFailedSyncsJob.start();
  cleanOldLogsJob.start();
  healthCheckJob.start();
  
  console.log('[Sync Cron] All sync cron jobs started:');
  console.log('  - Main sync: Every 2 hours');
  console.log('  - Retry failed: Every 30 minutes');
  console.log('  - Cleanup: Daily at 2:00 AM');
  console.log('  - Health check: Every hour');
};

/**
 * Stop all cron jobs
 */
const stopSyncCronJobs = () => {
  console.log('[Sync Cron] Stopping all sync cron jobs...');
  
  mainSyncJob.stop();
  retryFailedSyncsJob.stop();
  cleanOldLogsJob.stop();
  healthCheckJob.stop();
  
  console.log('[Sync Cron] All sync cron jobs stopped');
};

/**
 * Get cron job status
 */
const getCronJobStatus = () => {
  return {
    mainSync: {
      running: mainSyncJob.running,
      schedule: '0 */2 * * *',
      description: 'Sync connections due for update'
    },
    retryFailed: {
      running: retryFailedSyncsJob.running,
      schedule: '*/30 * * * *',
      description: 'Retry failed syncs'
    },
    cleanup: {
      running: cleanOldLogsJob.running,
      schedule: '0 2 * * *',
      description: 'Clean old logs (90+ days)'
    },
    healthCheck: {
      running: healthCheckJob.running,
      schedule: '0 * * * *',
      description: 'Monitor system health'
    }
  };
};

module.exports = {
  startSyncCronJobs,
  stopSyncCronJobs,
  getCronJobStatus,
  mainSyncJob,
  retryFailedSyncsJob,
  cleanOldLogsJob,
  healthCheckJob
};
