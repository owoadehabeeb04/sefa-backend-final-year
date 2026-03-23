const mongoose = require('mongoose');
const BankConnection = require('../models/BankConnection');
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
    });

    try {
      const queueJob = await addImportJob({
        importJobId: String(importJob._id),
        userId,
        source: importJob.source,
        fileId: fileId.toString(),
        fileName: fileMetadata.originalName,
        fileType,
        fileSize: fileMetadata.size,
      });

      importJob.queueJobId = String(queueJob.id);
      await importJob.save();

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
        data: job
      });
    }

    const legacyImportJob = await ImportJob.findOne({
      userId,
      queueJobId: String(jobId)
    });

    if (legacyImportJob) {
      return res.json({
        success: true,
        data: legacyImportJob
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
        data: importJob,
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
      data: jobs,
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
  getImportHistory,
  undoImport,
  handleMonoWebhook
};
