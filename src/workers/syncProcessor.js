const syncScheduler = require('../services/syncScheduler.service');

/**
 * Sync Queue Processor
 * Canonical worker entrypoint for all bank sync jobs.
 */
const processSyncJob = async (job) => {
  return syncScheduler.runQueuedSync(job);
};

module.exports = {
  processSyncJob,
};
