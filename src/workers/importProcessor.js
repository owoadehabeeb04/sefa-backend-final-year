const ImportJob = require('../models/ImportJob');

const { deleteFromGridFS, downloadFromGridFS } = require('../config/gridfs');
const { resolveBankProfile } = require('../services/bankProfiles');
const {
  getDraftRows,
  replaceImportDraftRows,
} = require('../services/importDraft.service');
const { parseStatementFile } = require('../services/parsing.service');
const { ingestTransactions } = require('../services/transactionIngest.service');
const { normalizeImportStatus } = require('../utils/importJobState');

const STAGE_PROGRESS = {
  queued: 0,
  download: 10,
  parse: 35,
  ocr: 45,
  needs_bank_selection: 55,
  needs_review: 68,
  importing: 80,
  normalize: 84,
  deduplicate: 88,
  categorize: 92,
  save: 96,
  completed: 100,
  failed: 100,
};

const updateImportJob = async (importJob, stage, extra = {}) => {
  importJob.stage = stage;
  importJob.progress = STAGE_PROGRESS[stage] ?? importJob.progress ?? 0;

  if (stage === 'queued') {
    importJob.status = 'queued';
  } else if (stage === 'needs_bank_selection') {
    importJob.status = 'needs_bank_selection';
  } else if (stage === 'needs_review') {
    importJob.status = 'needs_review';
  } else if (stage === 'importing' || importJob.status === 'importing') {
    importJob.status = 'importing';
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

const hasExplicitBankSelection = (importJob) => {
  if (importJob.bankSelection?.selectedBankSlug) {
    return true;
  }

  return Boolean(resolveBankProfile(importJob.bankHint));
};

const getEffectiveBankHint = (importJob) => {
  const selectedBankSlug = importJob.bankSelection?.selectedBankSlug;

  if (!selectedBankSlug || selectedBankSlug === 'generic') {
    return importJob.bankHint || null;
  }

  return importJob.bankSelection?.selectedBankDisplayName || importJob.bankHint || null;
};

const shouldPauseForBankSelection = (importJob, parsed) => {
  if (hasExplicitBankSelection(importJob)) {
    return false;
  }

  return ['low', 'unknown'].includes(parsed.bankDetectionConfidence);
};

const isScannedPdfWithoutOcr = (fileType, parsed) =>
  fileType === 'pdf'
  && parsed?.parserDiagnostics?.ocr?.attempted
  && !parsed?.parserDiagnostics?.ocr?.selected
  && Array.isArray(parsed?.qualityFlags)
  && parsed.qualityFlags.includes('ocr_unavailable');

const buildImportContext = (importJob, fileType) => ({
  userId: importJob.userId,
  provider: fileType === 'pdf' ? 'statement_pdf' : 'statement_csv',
  externalIdScope: 'statement',
});

const summarizeIssue = (issue) => {
  if (!issue) return null;
  if (typeof issue === 'string') return issue;
  if (issue.externalId) return `${issue.stage || 'processing'}: ${issue.message} (${issue.externalId})`;
  return `${issue.stage || 'processing'}: ${issue.message}`;
};

const prepareDraftForImportJob = async ({ importJob, fileId, fileName, fileType }) => {
  await updateImportJob(importJob, 'download');
  const fileBuffer = await downloadFromGridFS(fileId);

  await updateImportJob(importJob, 'parse');
  const parsed = await parseStatementFile(fileBuffer, fileType, {
    fileName: importJob.fileName || fileName,
    bankHint: getEffectiveBankHint(importJob),
    accountNumberHint: importJob.accountNumberHint || null,
  });

  if (isScannedPdfWithoutOcr(fileType, parsed)) {
    throw new Error(
      'This scanned PDF could not be processed because OCR is unavailable. Upload a CSV or digital text PDF instead.',
    );
  }

  if (shouldPauseForBankSelection(importJob, parsed)) {
    importJob.detectedBank = parsed.detectedBank || 'unknown';
    importJob.detectedBankDisplayName = parsed.detectedBankDisplayName || 'Unknown bank';
    importJob.bankDetectionConfidence = parsed.bankDetectionConfidence || 'unknown';
    importJob.bankDetectionSource = parsed.bankDetectionSource || 'unknown';
    importJob.parser = parsed.parser || null;
    importJob.ocrProvider = parsed.ocrProvider || null;
    importJob.sourceRecordCount = parsed.sourceRecordCount || 0;
    importJob.validRecordCount = parsed.validRecordCount || 0;
    importJob.totalTransactions = parsed.transactions.length || 0;
    importJob.statementDateRange = parsed.statementDateRange || parsed.dateRange || null;
    importJob.dateRange = parsed.statementDateRange || parsed.dateRange || null;
    importJob.documentIdentityReasons = parsed.documentIdentityReasons || [];
    importJob.qualityFlags = Array.from(new Set([...(parsed.qualityFlags || []), 'bank_selection_required']));
    importJob.warnings = Array.from(
      new Set([
        ...(parsed.warnings || []),
        'We could not confidently identify this bank. Select your bank to continue parsing with the best available template.',
      ]),
    ).slice(0, 50);
    importJob.errorMessages = [];
    importJob.needsReview = false;
    importJob.importedCount = 0;
    importJob.duplicateCount = 0;
    importJob.errorCount = 0;
    importJob.bankSelection = {
      required: true,
      reason: parsed.bankDetectionConfidence || 'unknown',
      requestedAt: new Date(),
      selectedBankSlug: null,
      selectedBankDisplayName: null,
      selectedAt: null,
    };
    importJob.draftSummary = {
      totalRows: 0,
      includedRows: 0,
      excludedRows: 0,
      debitTotal: 0,
      creditTotal: 0,
      lowConfidenceRows: 0,
      flaggedRows: 0,
    };

    await updateImportJob(importJob, 'needs_bank_selection');

    return {
      awaitingUser: true,
      importJobId: importJob._id,
    };
  }

  if (!Array.isArray(parsed.transactions) || parsed.transactions.length === 0) {
    throw new Error(
      'No usable transactions were found in this statement. Upload a cleaner CSV or a digital text PDF and try again.',
    );
  }

  const draft = await replaceImportDraftRows({
    importJob,
    parsed,
    context: buildImportContext(importJob, fileType),
  });

  importJob.detectedBank = parsed.detectedBank || importJob.detectedBank || 'unknown';
  importJob.detectedBankDisplayName =
    parsed.detectedBankDisplayName || importJob.detectedBankDisplayName || 'Unknown bank';
  importJob.bankDetectionConfidence =
    parsed.bankDetectionConfidence || importJob.bankDetectionConfidence || 'unknown';
  importJob.bankDetectionSource =
    parsed.bankDetectionSource || importJob.bankDetectionSource || 'unknown';
  importJob.parser = parsed.parser || importJob.parser || null;
  importJob.ocrProvider = parsed.ocrProvider || null;
  importJob.sourceRecordCount = parsed.sourceRecordCount || 0;
  importJob.validRecordCount = draft.summary.totalRows;
  importJob.totalTransactions = draft.summary.totalRows;
  importJob.importedCount = 0;
  importJob.duplicateCount = 0;
  importJob.errorCount = 0;
  importJob.skippedCount = parsed.skippedCount || 0;
  importJob.statementDateRange = parsed.statementDateRange || parsed.dateRange || null;
  importJob.dateRange = parsed.statementDateRange || parsed.dateRange || null;
  importJob.documentIdentityReasons = parsed.documentIdentityReasons || [];
  importJob.qualityFlags = parsed.qualityFlags || [];
  importJob.needsReview = true;
  importJob.bankSelection = {
    required: false,
    reason: null,
    requestedAt: importJob.bankSelection?.requestedAt || null,
    selectedBankSlug: importJob.bankSelection?.selectedBankSlug || null,
    selectedBankDisplayName: importJob.bankSelection?.selectedBankDisplayName || null,
    selectedAt: importJob.bankSelection?.selectedAt || null,
  };
  importJob.warnings = Array.from(
    new Set([
      ...(parsed.warnings || []),
      ...(draft.issues || []).map(summarizeIssue).filter(Boolean),
    ]),
  ).slice(0, 50);
  importJob.errorMessages = [];

  await updateImportJob(importJob, 'needs_review');

  return {
    success: true,
    importJobId: importJob._id,
    results: {
      totalTransactions: importJob.totalTransactions,
      validRecordCount: importJob.validRecordCount,
      skippedCount: importJob.skippedCount,
      stage: importJob.stage,
      status: importJob.status,
    },
  };
};

const confirmImportDraft = async ({ importJob, fileId }) => {
  const draftRows = await getDraftRows(importJob._id, importJob.userId);
  const includedRows = draftRows.filter((row) => !row.excluded);

  if (!includedRows.length) {
    throw new Error('No draft rows are selected for import. Add or unexclude at least one row.');
  }

  await updateImportJob(importJob, 'importing', {
    needsReview: false,
    errorMessages: [],
  });

  const ingestResult = await ingestTransactions(
    includedRows.map((row) => ({
      date: row.date,
      amount: row.amount,
      description: row.description,
      direction: row.direction,
      reference: row.reference,
      balance: row.balance,
      categoryId: row.categoryId || row.suggestedCategoryId || null,
      rawData: {
        ...(row.rawData || {}),
        draftRowId: row._id,
        sourceText: row.sourceText,
      },
      externalId: row.mappingExternalId,
      scopedExternalId: row.scopedExternalId,
    })),
    {
      userId: importJob.userId,
      sourceType: 'import_job',
      sourceRefId: importJob._id,
      importJobId: importJob._id,
      provider: importJob.fileType === 'application/pdf' ? 'statement_pdf' : 'statement_csv',
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
  importJob.skippedCount = (draftRows.length - includedRows.length) + ingestResult.skippedCount;
  importJob.errorCount = ingestResult.failedCount;
  importJob.validRecordCount = includedRows.length;
  importJob.totalTransactions = draftRows.length;
  importJob.errorMessages = ingestErrors;
  importJob.warnings = [...(importJob.warnings || []), ...ingestWarnings].slice(0, 50);
  importJob.needsReview = false;

  if (ingestResult.importedCount === 0 && ingestResult.duplicateCount === 0) {
    throw new Error(
      importJob.warnings[0]
        || 'SEFA could not safely import any transactions from this review draft.',
    );
  }

  await updateImportJob(importJob, 'completed');

  if (fileId) {
    try {
      await deleteFromGridFS(fileId);
    } catch (_error) {
      // Best effort cleanup only.
    }
  }

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
};

const processImportJob = async (job) => {
  const {
    action = 'prepare-draft',
    importJobId,
    userId,
    fileId,
    fileName,
    fileType,
  } = job.data;

  console.log(`\n🔵 Processing import job ${job.id} (${action}) for import ${importJobId}`);

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

    if (normalizeImportStatus(importJob.status) === 'completed' && action !== 'prepare-draft') {
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
    await importJob.save();

    const result =
      action === 'confirm-import'
        ? await confirmImportDraft({ importJob, fileId: importJob.fileId || fileId })
        : await prepareDraftForImportJob({
            importJob,
            fileId: importJob.fileId || fileId,
            fileName,
            fileType,
          });

    if (action === 'confirm-import' && importJob.importedCount > 0) {
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

    shouldDeleteFile = false;

    return result;
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

      shouldDeleteFile = isFinalAttempt && normalizeImportStatus(importJob.status) !== 'needs_review';
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
