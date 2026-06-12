const { processAssistantGenerationJob } = require('../services/assistant.service');

const processQueuedAssistantJob = async (job) => {
  return processAssistantGenerationJob(job.data);
};

module.exports = {
  processQueuedAssistantJob,
};
