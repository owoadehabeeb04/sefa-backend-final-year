const { processStatementImportJob } = require('../services/statementImport.service');

const processQueuedStatementImport = async (job) => {
  return processStatementImportJob(job.data);
};

module.exports = {
  processQueuedStatementImport,
};
