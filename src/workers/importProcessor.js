const ImportJob = require('../models/ImportJob');

const { deleteFromGridFS, downloadFromGridFS } = require('../config/gridfs');
const { parseStatementFile } = require('../services/parsing.service');
const { ingestTransactions } = require('../services/transactionIngest.service');
const { normalizeImportStatus } = require('../utils/importJobState');

const STAGE_PROGRESS = {
  queued: 0,
  download: 10,
  parse: 35,
  ocr: 45,
  normalize: 58,
  deduplicate: 72,
  categorize: 84,
  save: 94,
  completed: 100,
  failed: 100,
};

const updateImportJob = async (importJob, stage, extra = {}) => {
  importJob.stage = stage;
  importJob.progress = STAGE_PROGRESS[stage] ?? importJob.progress ?? 0;

  if (stage === 'queued') {
    importJob.status = 'queued';
  } else if (stage === 'completed') {
    importJob.status = 'completed';
    importJob.completedAt = new Date();
  } else if (stage === 'failed') {
    importJob.status = 'failed';
    importJob.completedAt = new Date();
  } else {
    importJob.status = 'processing';
    importJob.startedAt = importJob.startedAt || new Date();
  }

  Object.assign(importJob, extra);
  await importJob.save();
};

const summarizeIssue = (issue) => {
  if (!issue) return null;
  if (typeof issue === 'string') return issue;
  if (issue.externalId) return `${issue.stage || 'processing'}: ${issue.message} (${issue.externalId})`;
  return `${issue.stage || 'processing'}: ${issue.message}`;
};

const processImportJob = async (job) => {
  const { importJobId, userId, fileId, fileName, fileType } = job.data;

  console.log(`\n🔵 Processing import job ${job.id} for import ${importJobId}`);

  let fileBuffer = null;
  let shouldDeleteFile = false;
  let importJob = null;

  try {
    importJob = await ImportJob.findOne({
      _id: importJobId,
      userId,
    });

    if (!importJob) {
      throw new Error('Import job not found for queued statement upload');
    }

    if (normalizeImportStatus(importJob.status) === 'completed') {
      return {
        success: true,
        importJobId: importJob._id,
        results: {
          importedCount: importJob.importedCount,
          duplicateCount: importJob.duplicateCount,
          skippedCount: importJob.skippedCount,
          errorCount: importJob.errorCount,
        },
      };
    }

    importJob.queueJobId = String(job.id);
    importJob.fileId = importJob.fileId || fileId;
    importJob.fileName = importJob.fileName || fileName;
    await updateImportJob(importJob, 'download');

    fileBuffer = await downloadFromGridFS(fileId);

    await updateImportJob(importJob, 'parse');
    const parsed = await parseStatementFile(fileBuffer, fileType, {
      fileName: importJob.fileName || fileName,
      bankHint: importJob.bankHint || null,
      accountNumberHint: importJob.accountNumberHint || null,
    });

    await updateImportJob(importJob, parsed.ocrProvider ? 'ocr' : 'parse', {
      detectedBank: parsed.detectedBank || importJob.detectedBank || 'unknown',
      detectedBankDisplayName:
        parsed.detectedBankDisplayName || importJob.detectedBankDisplayName || 'Unknown bank',
      bankDetectionConfidence:
        parsed.bankDetectionConfidence || importJob.bankDetectionConfidence || 'unknown',
      bankDetectionSource:
        parsed.bankDetectionSource || importJob.bankDetectionSource || 'unknown',
      parser: parsed.parser || importJob.parser,
      ocrProvider: parsed.ocrProvider || null,
      sourceRecordCount: parsed.sourceRecordCount || 0,
      validRecordCount: parsed.validRecordCount || 0,
      totalTransactions: parsed.sourceRecordCount || parsed.transactions.length || 0,
      statementDateRange: parsed.statementDateRange || parsed.dateRange || null,
      dateRange: parsed.statementDateRange || parsed.dateRange || null,
      qualityFlags: parsed.qualityFlags || [],
      needsReview: Boolean(parsed.needsReview),
      warnings: parsed.warnings || [],
    });

    if (!parsed.transactions.length) {
      throw new Error(
        'No usable transactions were found. Upload a clearer statement with Date, Description, Amount, and Debit/Credit information.',
      );
    }

    const ingestResult = await ingestTransactions(
      parsed.transactions,
      {
        userId,
        sourceType: 'import_job',
        sourceRefId: importJob._id,
        importJobId: importJob._id,
        provider: fileType === 'pdf' ? 'statement_pdf' : 'statement_csv',
        externalIdScope: 'statement',
      },
      {
        onStage: async (stage) => updateImportJob(importJob, stage),
      },
    );

    const ingestWarnings = ingestResult.issues
      .filter((issue) => issue.stage !== 'save')
      .map(summarizeIssue)
      .filter(Boolean);
    const ingestErrors = ingestResult.issues
      .filter((issue) => issue.stage === 'save')
      .map(summarizeIssue)
      .filter(Boolean);

    importJob.importedCount = ingestResult.importedCount;
    importJob.duplicateCount = ingestResult.duplicateCount;
    importJob.skippedCount = parsed.skippedCount + ingestResult.skippedCount;
    importJob.errorCount = ingestResult.failedCount;
    importJob.errorMessages = ingestErrors;
    importJob.warnings = [...(parsed.warnings || []), ...ingestWarnings].slice(0, 50);
    importJob.qualityFlags = parsed.qualityFlags || importJob.qualityFlags || [];
    importJob.needsReview = Boolean(parsed.needsReview);

    if (ingestResult.importedCount === 0 && ingestResult.duplicateCount === 0) {
      throw new Error(
        importJob.warnings[0] ||
          'The file was read successfully, but SEFA could not extract any safe transactions to import.',
      );
    }

    await updateImportJob(importJob, 'completed');

    if (importJob.importedCount > 0) {
      const { addNotificationJob } = require('../config/queue');

      await addNotificationJob({
        userId,
        type: 'import_complete',
        urgency: 'instant',
        data: {
          importJobId: importJob._id.toString(),
          fileName: importJob.fileName,
          importedCount: importJob.importedCount,
          duplicateCount: importJob.duplicateCount,
        },
      });
    }

    shouldDeleteFile = true;

    return {
      success: true,
      importJobId: importJob._id,
      results: {
        totalTransactions: importJob.totalTransactions,
        importedCount: importJob.importedCount,
        duplicateCount: importJob.duplicateCount,
        skippedCount: importJob.skippedCount,
        errorCount: importJob.errorCount,
      },
    };
  } catch (error) {
    console.error('❌ Import processing failed:', error);

    if (importJob) {
      const maxAttempts = job?.opts?.attempts || 1;
      const isFinalAttempt = job.attemptsMade >= maxAttempts - 1;

      importJob.errorCount = Math.max(importJob.errorCount || 0, 1);
      importJob.errorMessages = [error.message];
      importJob.warnings = importJob.warnings || [];

      if (isFinalAttempt) {
        await updateImportJob(importJob, 'failed');
      } else {
        importJob.status = 'queued';
        importJob.stage = 'queued';
        importJob.progress = 0;
        await importJob.save();
      }

      shouldDeleteFile = isFinalAttempt;
    }

    throw error;
  } finally {
    if (fileId && shouldDeleteFile) {
      try {
        await deleteFromGridFS(fileId);
        console.log('🗑️  File deleted from GridFS');
      } catch (deleteError) {
        console.warn('⚠️  Failed to delete file:', deleteError.message);
      }
    }
  }
};

module.exports = {
  processImportJob,
};
