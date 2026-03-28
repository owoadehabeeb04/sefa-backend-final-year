const mongoose = require('mongoose');
const BankConnection = require('../models/BankConnection');
const ImportDraftRow = require('../models/ImportDraftRow');
const ImportJob = require('../models/ImportJob');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const SyncLog = require('../models/SyncLog');
const Expense = require('../models/Expense');
const Income = require('../models/Income');

const monoService = require('../services/mono.service');
const parsingService = require('../services/parsing.service');
const ocrService = require('../services/ocr.service');
const deduplicationService = require('../services/deduplication.service');
const transferService = require('../services/transfer.service');
const syncScheduler = require('../services/syncScheduler.service');
const {
  getDraftRows,
  getImportBankOptions,
  normalizeDraftDirection,
  refreshImportJobDraftSummary,
  suggestDraftCategory,
  validateCategoryForDraft,
} = require('../services/importDraft.service');
const { findBankProfile, resolveBankProfile } = require('../services/bankProfiles');
const { normalizeImportStage, normalizeImportStatus } = require('../utils/importJobState');

const { addImportJob, getJobStatus } = require('../config/queue');
const { downloadFromGridFS } = require('../config/gridfs');

const normalizeOptionalText = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const normalizeAccountNumberHint = (value) => {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) {
    return null;
  }

  return digits.slice(-4);
};

const serializeImportJob = (job) => {
  const serialized = job?.toJSON ? job.toJSON() : job;

  if (!serialized) {
    return serialized;
  }

  if (serialized.status === 'needs_bank_selection') {
    return {
      ...serialized,
      availableBanks: getImportBankOptions(),
    };
  }

  return serialized;
};

const queueImportAction = async ({ importJob, fileType, action }) => {
  const queueJob = await addImportJob({
    action,
    importJobId: String(importJob._id),
    userId: String(importJob.userId),
    source: importJob.source,
    fileId: importJob.fileId?.toString(),
    fileName: importJob.fileName,
    fileType,
    fileSize: importJob.fileSize,
  });

  importJob.queueJobId = String(queueJob.id);
  await importJob.save();

  return queueJob;
};

const getOwnedImportJob = async (jobId, userId) => {
  if (!mongoose.isValidObjectId(jobId)) {
    return null;
  }

  return ImportJob.findOne({
    _id: jobId,
    userId,
  });
};

/**
 * Connect bank account via Mono
 * POST /api/bank/connect
 */
const connectBankAccount = async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.user.userId;
    
    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Authorization code is required'
      });
    }
    
    // Exchange code for account ID
    const accountId = await monoService.exchangeToken(code);
    
    // Get account details
    const accountDetails = await monoService.getAccountDetails(accountId);
    
    // Check if account already connected
    const existing = await BankConnection.findOne({
      accountId,
      isActive: true
    });
    
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'This bank account is already connected'
      });
    }
    
    // Create bank connection
    const connection = await BankConnection.create({
      userId,
      provider: 'mono',
      accountId,
      institutionName: accountDetails.institution?.name || 'Unknown Bank',
      institutionCode: accountDetails.institution?.bankCode || '',
      accountName: accountDetails.account?.name || '',
      accountNumber: accountDetails.account?.accountNumber || '',
      accountType: accountDetails.account?.type || 'savings',
      currency: accountDetails.account?.currency || 'NGN',
      balance: Number(accountDetails.account?.balance || 0),
      authCode: code, // Will be encrypted by pre-save hook
      accessToken: accountId,
      syncStatus: 'queued'
    });

    const queuedSync = await syncScheduler.queueConnectionSync(connection, userId, {
      isInitialSync: true,
      syncType: 'initial_connect',
      triggeredBy: 'user',
      forceSync: true,
      requestMeta: {
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      },
    });

    connection.currentSyncLogId = queuedSync.syncLogId;
    connection.syncStatus = queuedSync.status;
    await connection.save();

    res.status(201).json({
      success: true,
      message: 'Bank account connected and initial sync queued',
      data: {
        _id: connection._id,
        connectionId: connection._id,
        institutionName: connection.institutionName,
        accountName: connection.accountName,
        accountNumber: connection.accountNumber,
        syncStatus: connection.syncStatus,
        currentSyncLogId: queuedSync.syncLogId,
        initialSyncLogId: queuedSync.syncLogId,
        lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
        pendingResync: connection.pendingResync,
        lastSyncErrorSummary: connection.lastSyncErrorSummary,
      }
    });
  } catch (error) {
    console.error('❌ Connect bank account error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to connect bank account',
      error: error.message
    });
  }
};

/**
 * Get all bank connections
 * GET /api/bank/connections
 */
const getBankConnections = async (req, res) => {
  try {
    const userId = req.user.userId;

    const connections = await BankConnection.find({
      userId,
      isActive: true
    }).select('-authCode -accessToken').sort({ createdAt: -1 });

    await Promise.all(
      connections.map(async (connection) => {
        const needsRefresh =
          !connection.institutionName ||
          connection.institutionName === 'Unknown Bank' ||
          !connection.accountNumber ||
          connection.accountNumber === 'N/A';

        if (!needsRefresh || !connection.accountId) return;

        try {
          const details = await monoService.getAccountDetails(connection.accountId);
          connection.institutionName = details.institution?.name || connection.institutionName || 'Unknown Bank';
          connection.institutionCode = details.institution?.bankCode || connection.institutionCode || '';
          connection.accountName = details.account?.name || connection.accountName || '';
          connection.accountNumber = details.account?.accountNumber || connection.accountNumber || '';
          connection.accountType = details.account?.type || connection.accountType || 'savings';
          connection.currency = details.account?.currency || connection.currency || 'NGN';
          if (typeof details.account?.balance === 'number') {
            connection.balance = details.account.balance;
          }
          await connection.save();
        } catch (refreshError) {
          console.warn('⚠️ Failed to refresh bank connection details:', refreshError.message);
        }
      })
    );
    
    res.json({
      success: true,
      data: connections,
      count: connections.length
    });
  } catch (error) {
    console.error('❌ Get connections error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bank connections',
      error: error.message
    });
  }
};

/**
 * Get single bank connection
 * GET /api/bank/connections/:id
 */
const getBankConnection = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    
    const connection = await BankConnection.findOne({
      _id: id,
      userId,
      isActive: true
    }).select('-authCode -accessToken');
    
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Bank connection not found'
      });
    }

    if (connection.syncStatus === 'queued' || connection.syncStatus === 'syncing') {
      return res.status(409).json({
        success: false,
        message: 'Cancel the active sync before disconnecting this bank account'
      });
    }
    
    res.json({
      success: true,
      data: connection
    });
  } catch (error) {
    console.error('❌ Get connection error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bank connection',
      error: error.message
    });
  }
};

/**
 * Sync bank transactions
 * POST /api/bank/connections/:id/sync
 */
const syncBankTransactions = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    
    const connection = await BankConnection.findOne({
      _id: id,
      userId,
      isActive: true
    });
    
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Bank connection not found'
      });
    }
    
    const queuedSync = await syncScheduler.queueConnectionSync(connection, userId, {
      syncType: 'manual',
      triggeredBy: 'user',
      forceSync: true,
      requestMeta: {
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      },
    });

    res.status(202).json({
      success: true,
      message: queuedSync.existing ? 'Sync already queued or in progress' : 'Sync queued successfully',
      data: {
        connectionId: connection._id,
        syncLogId: queuedSync.syncLogId,
        status: queuedSync.status
      }
    });
  } catch (error) {
    console.error('❌ Sync transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync transactions',
      error: error.message
    });
  }
};

/**
 * Disconnect bank account
 * DELETE /api/bank/connections/:id
 */
const disconnectBankAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    
    const connection = await BankConnection.findOne({
      _id: id,
      userId,
      isActive: true
    });
    
    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Bank connection not found'
      });
    }
    
    // Unlink from Mono
    try {
      await monoService.unlinkAccount(connection.accountId);
    } catch (error) {
      console.warn('⚠️  Failed to unlink from Mono:', error.message);
    }

    // Delete transactions imported via this bank connection
    const syncLogs = await SyncLog.find({
      userId,
      connectionId: connection._id,
    }).select('_id').lean();
    const syncLogIds = syncLogs.map((log) => log._id);

    const mappings = await ImportedTransactionMap.find({
      userId,
      $or: [
        { sourceType: 'bank_connection', sourceRefId: connection._id },
        { syncLogId: { $in: syncLogIds } },
        { 'rawData.connectionId': connection._id },
        { 'rawData.connectionId': String(connection._id) },
        ...(syncLogIds.length ? [{ importJobId: { $in: syncLogIds } }] : []),
      ],
    });

    const expenseIds = mappings.filter((m) => m.expenseId).map((m) => m.expenseId);
    const incomeIds = mappings.filter((m) => m.incomeId).map((m) => m.incomeId);
    const mappedExternalIds = mappings
      .map((m) => m.externalId)
      .filter((value) => typeof value === 'string' && value.trim().length > 0);

    await Promise.all([
      expenseIds.length ? Expense.deleteMany({ _id: { $in: expenseIds }, userId }) : Promise.resolve(),
      incomeIds.length ? Income.deleteMany({ _id: { $in: incomeIds }, userId }) : Promise.resolve(),
      syncLogIds.length ? Expense.deleteMany({ importJobId: { $in: syncLogIds }, userId }) : Promise.resolve(),
      syncLogIds.length ? Income.deleteMany({ importJobId: { $in: syncLogIds }, userId }) : Promise.resolve(),
      mappedExternalIds.length ? Expense.deleteMany({ externalId: { $in: mappedExternalIds }, userId }) : Promise.resolve(),
      mappedExternalIds.length ? Income.deleteMany({ externalId: { $in: mappedExternalIds }, userId }) : Promise.resolve(),
      mappings.length ? ImportedTransactionMap.deleteMany({ _id: { $in: mappings.map((m) => m._id) } }) : Promise.resolve(),
    ]);
    
    // Soft delete
    connection.isActive = false;
    connection.syncStatus = 'disconnected';
    connection.currentSyncLogId = null;
    connection.cancelRequested = false;
    connection.pendingResync = false;
    await connection.save();
    
    res.json({
      success: true,
      message: 'Bank account disconnected and synced transactions removed successfully',
      data: {
        deletedExpenses: expenseIds.length,
        deletedIncomes: incomeIds.length,
        totalDeleted: expenseIds.length + incomeIds.length,
      }
    });
  } catch (error) {
    console.error('❌ Disconnect bank account error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to disconnect bank account',
      error: error.message
    });
  }
};

/**
 * Upload bank statement (CSV/PDF)
 * POST /api/bank/upload
 */
const uploadBankStatement = async (req, res) => {
  try {
    const userId = req.user.userId;
    const fileId = req.fileId;
    const fileMetadata = req.fileMetadata;
    const bankHint = normalizeOptionalText(req.body?.bankHint || req.body?.bankName);
    const accountNumberHint = normalizeAccountNumberHint(
      req.body?.accountNumberHint || req.body?.accountNumber,
    );
    
    if (!fileId) {
      return res.status(400).json({
        success: false,
        message: 'File upload failed'
      });
    }
    
    // Determine file type
    const fileType = fileMetadata.mimeType === 'application/pdf' ? 'pdf' : 'csv';
    const hintedProfile = bankHint ? resolveBankProfile(bankHint) || null : null;

    const importJob = await ImportJob.create({
      userId,
      source: `${fileType}_upload`,
      fileId,
      fileName: fileMetadata.originalName,
      fileSize: fileMetadata.size,
      fileType: fileType === 'pdf' ? 'application/pdf' : 'text/csv',
      status: 'queued',
      stage: 'queued',
      progress: 0,
      bankHint,
      accountNumberHint,
      warnings: [],
      errorMessages: [],
      bankSelection: hintedProfile
        ? {
            required: false,
            reason: null,
            requestedAt: null,
            selectedBankSlug: hintedProfile.slug,
            selectedBankDisplayName: hintedProfile.displayName,
            selectedAt: new Date(),
          }
        : undefined,
    });

    try {
      const queueJob = await queueImportAction({
        importJob,
        fileType,
        action: 'prepare-draft',
      });

      return res.status(202).json({
        success: true,
        message: 'File uploaded successfully. Processing started.',
        data: {
          importJobId: importJob._id,
          queueJobId: String(queueJob.id),
          fileName: fileMetadata.originalName,
          fileSize: fileMetadata.size,
          fileType: importJob.fileType,
          status: 'queued',
          bankHint,
          accountNumberHint,
          reviewRequired: true,
        }
      });
    } catch (queueError) {
      importJob.status = 'failed';
      importJob.stage = 'failed';
      importJob.progress = 100;
      importJob.errorCount = 1;
      importJob.errorMessages = [queueError.message];
      importJob.completedAt = new Date();
      await importJob.save();
      throw queueError;
    }
  } catch (error) {
    console.error('❌ Upload statement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process uploaded file',
      error: error.message
    });
  }
};

/**
 * Get import job status
 * GET /api/bank/import/:jobId
 */
const getImportJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.userId;

    // If it's a Mongo ObjectId, fetch import document directly
    if (mongoose.isValidObjectId(jobId)) {
      const job = await ImportJob.findOne({
        _id: jobId,
        userId
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          message: 'Import job not found'
        });
      }

      return res.json({
        success: true,
        data: serializeImportJob(job)
      });
    }

    const legacyImportJob = await ImportJob.findOne({
      userId,
      queueJobId: String(jobId)
    });

    if (legacyImportJob) {
      return res.json({
        success: true,
        data: serializeImportJob(legacyImportJob)
      });
    }

    // Otherwise treat as queue job id (Bull uses numeric/string ids like "4")
    const queueJob = await getJobStatus('import', jobId);

    if (!queueJob) {
      console.log(`Import job with queue ID ${jobId} not found`);
      return res.status(404).json({

        success: false,
        message: 'Import job not found'
      });
    }

    if (String(queueJob.data?.userId) !== String(userId)) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found'
      });
    }

    let importJob = null;
    const importJobId = queueJob.data?.importJobId || queueJob.returnvalue?.importJobId;

    if (importJobId && mongoose.isValidObjectId(importJobId)) {
      importJob = await ImportJob.findOne({ _id: importJobId, userId });
    }

    if (!importJob && queueJob.data?.fileId) {
      importJob = await ImportJob.findOne({
        userId,
        fileId: queueJob.data.fileId
      }).sort({ createdAt: -1 });
    }

    if (importJob) {
      return res.json({
        success: true,
        data: serializeImportJob(importJob),
        queue: {
          id: queueJob.id,
          state: queueJob.state,
          progress: queueJob.progress,
          attemptsMade: queueJob.attemptsMade,
          failedReason: queueJob.failedReason
        }
      });
    }

    const statusFromQueue = {
      waiting: 'queued',
      active: 'processing',
      completed: 'completed',
      failed: 'failed',
      delayed: 'queued'
    };

    return res.json({
      success: true,
      data: {
        status: normalizeImportStatus(statusFromQueue[queueJob.state] || 'queued'),
        stage: normalizeImportStage(queueJob.state, statusFromQueue[queueJob.state] || 'queued'),
        progress: Number(queueJob.progress || 0),
        queueJobId: String(queueJob.id),
        fileName: queueJob.data?.fileName || null,
        detectedBank: 'unknown',
        detectedBankDisplayName: 'Unknown bank',
        bankDetectionConfidence: 'unknown',
        bankDetectionSource: 'queue_fallback',
        errorCount: queueJob.failedReason ? 1 : 0,
        skippedCount: 0,
        errors: queueJob.failedReason ? [queueJob.failedReason] : [],
        errorMessages: queueJob.failedReason ? [queueJob.failedReason] : [],
        qualityFlags: [],
        needsReview: false,
        warnings: []
      },
      queue: {
        id: queueJob.id,
        state: queueJob.state,
        progress: queueJob.progress,
        attemptsMade: queueJob.attemptsMade,
        failedReason: queueJob.failedReason
      }
    });
  } catch (error) {
    console.error('❌ Get job status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch job status',
      error: error.message
    });
  }
};

/**
 * Select bank for a paused import job
 * POST /api/bank/import/:jobId/select-bank
 */
const selectImportBank = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { bankSlug } = req.body;
    const userId = req.user.userId;

    const job = await getOwnedImportJob(jobId, userId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
      });
    }

    if (normalizeImportStatus(job.status) !== 'needs_bank_selection') {
      return res.status(409).json({
        success: false,
        message: 'This import does not need bank selection right now',
      });
    }

    const normalizedBankSlug = String(bankSlug || '').trim().toLowerCase();

    if (!normalizedBankSlug) {
      return res.status(400).json({
        success: false,
        message: 'bankSlug is required',
      });
    }

    const selectedProfile =
      normalizedBankSlug === 'generic'
        ? { slug: 'generic', displayName: 'Other / Unsupported bank' }
        : findBankProfile(normalizedBankSlug);

    if (!selectedProfile) {
      return res.status(400).json({
        success: false,
        message: 'Selected bank is not supported',
      });
    }

    job.bankHint = selectedProfile.slug === 'generic' ? null : selectedProfile.displayName;
    job.bankSelection = {
      required: false,
      reason: null,
      requestedAt: job.bankSelection?.requestedAt || new Date(),
      selectedBankSlug: selectedProfile.slug,
      selectedBankDisplayName: selectedProfile.displayName,
      selectedAt: new Date(),
    };
    job.status = 'queued';
    job.stage = 'queued';
    job.progress = 0;
    job.needsReview = false;
    job.errorMessages = [];
    job.qualityFlags = (job.qualityFlags || []).filter((flag) => flag !== 'bank_selection_required');

    const queueJob = await queueImportAction({
      importJob: job,
      fileType: job.fileType === 'application/pdf' ? 'pdf' : 'csv',
      action: 'prepare-draft',
    });

    return res.status(202).json({
      success: true,
      message: 'Bank selected. Parsing will continue now.',
      data: {
        ...serializeImportJob(job),
        queueJobId: String(queueJob.id),
      },
    });
  } catch (error) {
    console.error('❌ Select import bank error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to continue import after bank selection',
      error: error.message,
    });
  }
};

/**
 * Get review draft rows for an import job
 * GET /api/bank/import/:jobId/draft
 */
const getImportDraft = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.userId;

    const job = await getOwnedImportJob(jobId, userId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
      });
    }

    const rows = await getDraftRows(job._id, userId);

    if ((job.draftSummary?.totalRows || 0) !== rows.length) {
      await refreshImportJobDraftSummary(job);
      await job.save();
    }

    return res.json({
      success: true,
      data: {
        importJobId: job._id,
        status: normalizeImportStatus(job.status),
        summary: job.draftSummary,
        rows,
      },
    });
  } catch (error) {
    console.error('❌ Get import draft error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch import draft',
      error: error.message,
    });
  }
};

/**
 * Update a review draft row
 * PATCH /api/bank/import/:jobId/draft/:rowId
 */
const updateImportDraftRow = async (req, res) => {
  try {
    const { jobId, rowId } = req.params;
    const userId = req.user.userId;

    const job = await getOwnedImportJob(jobId, userId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
      });
    }

    if (normalizeImportStatus(job.status) !== 'needs_review') {
      return res.status(409).json({
        success: false,
        message: 'Draft rows can only be edited while review is pending',
      });
    }

    const draftRow = await ImportDraftRow.findOne({
      _id: rowId,
      importJobId: job._id,
      userId,
    });

    if (!draftRow) {
      return res.status(404).json({
        success: false,
        message: 'Draft row not found',
      });
    }

    const updates = req.body || {};
    let shouldResuggest = false;

    if (Object.prototype.hasOwnProperty.call(updates, 'direction')) {
      const normalizedDirection = normalizeDraftDirection(updates.direction);

      if (!normalizedDirection) {
        return res.status(400).json({
          success: false,
          message: 'direction must be debit or credit',
        });
      }

      if (normalizedDirection !== draftRow.direction) {
        shouldResuggest = true;
      }

      draftRow.direction = normalizedDirection;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'date')) {
      const date = new Date(updates.date);

      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'date must be a valid ISO date string',
        });
      }

      draftRow.date = date;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'description')) {
      const description = String(updates.description || '').trim();

      if (!description) {
        return res.status(400).json({
          success: false,
          message: 'description is required',
        });
      }

      draftRow.description = description;
      shouldResuggest = true;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'amount')) {
      const amount = Number(updates.amount);

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'amount must be a positive number',
        });
      }

      draftRow.amount = Math.abs(amount);
      shouldResuggest = true;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'reference')) {
      draftRow.reference = String(updates.reference || '').trim() || null;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'balance')) {
      if (updates.balance === null || updates.balance === '' || updates.balance === undefined) {
        draftRow.balance = null;
      } else {
        const balance = Number(updates.balance);

        if (!Number.isFinite(balance)) {
          return res.status(400).json({
            success: false,
            message: 'balance must be a number when provided',
          });
        }

        draftRow.balance = balance;
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'excluded')) {
      if (typeof updates.excluded !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'excluded must be a boolean',
        });
      }

      draftRow.excluded = updates.excluded;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'categoryId')) {
      if (!updates.categoryId) {
        draftRow.categoryId = null;
        draftRow.categoryName = null;
        draftRow.categoryIcon = null;
        draftRow.categoryColor = null;
        shouldResuggest = true;
      } else {
        const category = await validateCategoryForDraft({
          userId,
          categoryId: updates.categoryId,
          direction: draftRow.direction,
        });

        draftRow.categoryId = category._id;
        draftRow.categoryName = category.name;
        draftRow.categoryIcon = category.icon || 'folder';
        draftRow.categoryColor = category.color || '#95A5A6';
      }
    } else if (shouldResuggest && draftRow.categoryId) {
      try {
        await validateCategoryForDraft({
          userId,
          categoryId: draftRow.categoryId,
          direction: draftRow.direction,
        });
      } catch (_error) {
        draftRow.categoryId = null;
        draftRow.categoryName = null;
        draftRow.categoryIcon = null;
        draftRow.categoryColor = null;
      }
    }

    if (shouldResuggest && !draftRow.categoryId) {
      const suggestion = await suggestDraftCategory({
        userId,
        row: draftRow,
        bankDetectionConfidence: job.bankDetectionConfidence,
        ocrProvider: job.ocrProvider,
      });

      draftRow.suggestedCategoryId = suggestion?.suggestedCategoryId || null;
      draftRow.suggestedCategoryName = suggestion?.suggestedCategoryName || null;
      draftRow.suggestedCategoryIcon = suggestion?.suggestedCategoryIcon || null;
      draftRow.suggestedCategoryColor = suggestion?.suggestedCategoryColor || null;
      draftRow.confidence = suggestion?.confidence || draftRow.confidence;
    }

    await draftRow.save();
    await refreshImportJobDraftSummary(job);
    await job.save();

    return res.json({
      success: true,
      message: 'Draft row updated',
      data: {
        row: draftRow,
        summary: job.draftSummary,
      },
    });
  } catch (error) {
    console.error('❌ Update import draft row error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to update draft row',
      error: error.message,
    });
  }
};

/**
 * Delete a review draft row
 * DELETE /api/bank/import/:jobId/draft/:rowId
 */
const deleteImportDraftRow = async (req, res) => {
  try {
    const { jobId, rowId } = req.params;
    const userId = req.user.userId;

    const job = await getOwnedImportJob(jobId, userId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
      });
    }

    if (normalizeImportStatus(job.status) !== 'needs_review') {
      return res.status(409).json({
        success: false,
        message: 'Draft rows can only be deleted while review is pending',
      });
    }

    const deleted = await ImportDraftRow.findOneAndDelete({
      _id: rowId,
      importJobId: job._id,
      userId,
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Draft row not found',
      });
    }

    await refreshImportJobDraftSummary(job);
    await job.save();

    return res.json({
      success: true,
      message: 'Draft row deleted',
      data: {
        summary: job.draftSummary,
      },
    });
  } catch (error) {
    console.error('❌ Delete import draft row error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete draft row',
      error: error.message,
    });
  }
};

/**
 * Confirm import draft and start final import
 * POST /api/bank/import/:jobId/confirm
 */
const confirmImportDraft = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.userId;

    const job = await getOwnedImportJob(jobId, userId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
      });
    }

    if (normalizeImportStatus(job.status) !== 'needs_review') {
      return res.status(409).json({
        success: false,
        message: 'This import is not ready for confirmation',
      });
    }

    const rows = await getDraftRows(job._id, userId);
    const includedRows = rows.filter((row) => !row.excluded);

    if (!includedRows.length) {
      return res.status(400).json({
        success: false,
        message: 'At least one draft row must be included before confirming import',
      });
    }

    job.status = 'importing';
    job.stage = 'importing';
    job.progress = 80;
    job.needsReview = false;
    job.errorMessages = [];

    const queueJob = await queueImportAction({
      importJob: job,
      fileType: job.fileType === 'application/pdf' ? 'pdf' : 'csv',
      action: 'confirm-import',
    });

    return res.status(202).json({
      success: true,
      message: 'Import confirmed. Final processing has started.',
      data: {
        ...serializeImportJob(job),
        queueJobId: String(queueJob.id),
      },
    });
  } catch (error) {
    console.error('❌ Confirm import draft error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to confirm import',
      error: error.message,
    });
  }
};

/**
 * Get import history
 * GET /api/bank/imports
 */
const getImportHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20 } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [jobs, total] = await Promise.all([
      ImportJob.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ImportJob.countDocuments({ userId })
    ]);
    
    res.json({
      success: true,
      data: jobs.map((job) => serializeImportJob(job)),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Get import history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch import history',
      error: error.message
    });
  }
};

/**
 * Undo import
 * POST /api/bank/import/:jobId/undo
 */
const undoImport = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.userId;
    
    const job = await ImportJob.findOne({
      _id: jobId,
      userId
    });
    
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found'
      });
    }
    
    if (!job.canBeUndone()) {
      return res.status(400).json({
        success: false,
        message: normalizeImportStatus(job.status) === 'undone' 
          ? 'Import already undone' 
          : 'Import cannot be undone'
      });
    }
    
    // Get all imported transactions
    const mappings = await ImportedTransactionMap.find({
      importJobId: jobId,
      userId
    });
    
    // Delete expenses and incomes
    const expenseIds = mappings.filter(m => m.expenseId).map(m => m.expenseId);
    const incomeIds = mappings.filter(m => m.incomeId).map(m => m.incomeId);
    
    await Promise.all([
      Expense.deleteMany({ _id: { $in: expenseIds } }),
      Income.deleteMany({ _id: { $in: incomeIds } }),
      ImportedTransactionMap.deleteMany({ importJobId: jobId })
    ]);
    
    // Mark job as undone
    await job.markAsUndone();
    
    res.json({
      success: true,
      message: 'Import undone successfully',
      data: {
        deletedExpenses: expenseIds.length,
        deletedIncomes: incomeIds.length,
        totalDeleted: expenseIds.length + incomeIds.length
      }
    });
  } catch (error) {
    console.error('❌ Undo import error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to undo import',
      error: error.message
    });
  }
};

/**
 * Handle Mono webhooks
 * POST /api/bank/webhook
 */
const handleMonoWebhook = async (req, res) => {
  try {
    const { event, data } = req.body;
    const accountId = data?.account;
    
    console.log(`📨 Webhook: ${event} for account ${accountId}`);
    
    // Find connection
    const connection = await BankConnection.findOne({
      accountId,
      isActive: true
    });
    
    if (!connection) {
      console.warn(`⚠️  Connection not found for account ${accountId}`);
      return res.status(200).json({
        success: true,
        message: 'Webhook ignored for unknown connection'
      });
    }
    
    // Handle different events
    switch (req.webhookEvent) {
      case 'transaction_synced':
        await syncScheduler.queueConnectionSync(connection, connection.userId.toString(), {
          syncType: 'webhook',
          triggeredBy: 'webhook',
          forceSync: true,
        });
        break;
        
      case 'reauthorization_required':
        // Update connection status
        connection.syncStatus = 'reauth_required';
        await connection.save();
        break;
        
      case 'account_updated':
        // Refresh account details
        const details = await monoService.getAccountDetails(accountId);
        connection.institutionName = details.institution?.name || connection.institutionName;
        connection.institutionCode = details.institution?.bankCode || connection.institutionCode;
        connection.accountName = details.account?.name || connection.accountName;
        connection.accountNumber = details.account?.accountNumber || connection.accountNumber;
        connection.accountType = details.account?.type || connection.accountType;
        connection.currency = details.account?.currency || connection.currency;
        if (typeof details.account?.balance === 'number') {
          connection.balance = details.account.balance;
        }
        await connection.save();
        break;
    }
    
    // Always return 200 to acknowledge receipt
    res.status(200).json({
      success: true,
      message: 'Webhook processed'
    });
  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({
      success: false,
      message: 'Webhook processing failed'
    });
  }
};

module.exports = {
  connectBankAccount,
  getBankConnections,
  getBankConnection,
  syncBankTransactions,
  disconnectBankAccount,
  uploadBankStatement,
  getImportJobStatus,
  selectImportBank,
  getImportDraft,
  updateImportDraftRow,
  deleteImportDraftRow,
  confirmImportDraft,
  getImportHistory,
  undoImport,
  handleMonoWebhook
};
