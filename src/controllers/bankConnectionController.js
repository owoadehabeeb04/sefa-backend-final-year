const BankConnection = require('../models/BankConnection');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const SyncLog = require('../models/SyncLog');
const Expense = require('../models/Expense');
const Income = require('../models/Income');

const monoService = require('../services/mono.service');
const syncScheduler = require('../services/syncScheduler.service');
const {
  appendBankAccessAuditLog,
  getRecentBankAccessAuditEvents,
  validateBankAccessAuditChain,
} = require('../services/bankAccessAudit.service');
const {
  applyReadOnlyContract,
  buildConnectionSecuritySummary,
  normalizeReadOnlyConnection,
} = require('../services/bankReadOnly.service');

const toClientConnection = (connection) => normalizeReadOnlyConnection(connection);

/**
 * Connect bank account via Mono
 * POST /api/bank/connect
 */
const connectBankAccount = async (req, res) => {
  const userId = req.user.userId;
  const requestMeta = {
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  };

  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Authorization code is required',
      });
    }

    await appendBankAccessAuditLog({
      userId,
      eventType: 'connect_requested',
      actorType: 'user',
      requestMeta,
      metadata: {
        source: 'mono',
      },
    });

    const accountId = await monoService.exchangeToken(code);
    const accountDetails = await monoService.getAccountDetails(accountId);

    const existing = await BankConnection.findOne({
      accountId,
      isActive: true,
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'This bank account is already connected',
      });
    }

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
      authCode: code,
      accessToken: accountId,
      syncStatus: 'queued',
    });
    applyReadOnlyContract(connection, { touchSecurityVerifiedAt: true });
    await connection.save();

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'connect_completed',
      actorType: 'user',
      requestMeta,
      metadata: {
        provider: connection.provider,
        institutionName: connection.institutionName,
        accountId: connection.accountId,
      },
    });

    const queuedSync = await syncScheduler.queueConnectionSync(connection, userId, {
      isInitialSync: true,
      syncType: 'initial_connect',
      triggeredBy: 'user',
      forceSync: true,
      requestMeta,
    });

    connection.currentSyncLogId = queuedSync.syncLogId;
    connection.syncStatus = queuedSync.status;
    await connection.save();

    return res.status(201).json({
      success: true,
      message: 'Bank account connected and initial sync queued',
      data: toClientConnection({
        ...connection.toObject({ virtuals: true }),
        connectionId: connection._id,
        currentSyncLogId: queuedSync.syncLogId,
        initialSyncLogId: queuedSync.syncLogId,
      }),
    });
  } catch (error) {
    console.error('❌ Connect bank account error:', error);
    await appendBankAccessAuditLog({
      userId,
      eventType: 'connect_failed',
      actorType: 'user',
      requestMeta,
      metadata: {
        error: error.message,
      },
    }).catch(() => undefined);
    return res.status(500).json({
      success: false,
      message: 'Failed to connect bank account',
      error: error.message,
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
      isActive: true,
    })
      .select('-authCode -accessToken')
      .sort({ createdAt: -1 });

    await Promise.all(
      connections.map(async (connection) => {
        const needsRefresh =
          !connection.institutionName ||
          connection.institutionName === 'Unknown Bank' ||
          !connection.accountNumber ||
          connection.accountNumber === 'N/A';

        if (!needsRefresh || !connection.accountId) {
          return;
        }

        try {
          const details = await monoService.getAccountDetails(connection.accountId);
          connection.institutionName =
            details.institution?.name || connection.institutionName || 'Unknown Bank';
          connection.institutionCode =
            details.institution?.bankCode || connection.institutionCode || '';
          connection.accountName = details.account?.name || connection.accountName || '';
          connection.accountNumber =
            details.account?.accountNumber || connection.accountNumber || '';
          connection.accountType = details.account?.type || connection.accountType || 'savings';
          connection.currency = details.account?.currency || connection.currency || 'NGN';

          if (typeof details.account?.balance === 'number') {
            connection.balance = details.account.balance;
          }

          applyReadOnlyContract(connection, { touchSecurityVerifiedAt: true });
          await connection.save();
        } catch (refreshError) {
          console.warn(
            '⚠️ Failed to refresh bank connection details:',
            refreshError.message,
          );
        }
      }),
    );

    return res.json({
      success: true,
      data: connections.map(toClientConnection),
      count: connections.length,
    });
  } catch (error) {
    console.error('❌ Get connections error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bank connections',
      error: error.message,
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
      isActive: true,
    }).select('-authCode -accessToken');

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Bank connection not found',
      });
    }

    if (connection.syncStatus === 'queued' || connection.syncStatus === 'syncing') {
      return res.status(409).json({
        success: false,
        message: 'Cancel the active sync before disconnecting this bank account',
      });
    }

    return res.json({
      success: true,
      data: toClientConnection(connection),
    });
  } catch (error) {
    console.error('❌ Get connection error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bank connection',
      error: error.message,
    });
  }
};

/**
 * Get bank connection security summary
 * GET /api/bank/connections/:id/security
 */
const getBankConnectionSecurity = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const connection = await BankConnection.findOne({
      _id: id,
      userId,
      isActive: true,
    }).select('-authCode -accessToken');

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Bank connection not found',
      });
    }

    const [recentEvents, auditValidation] = await Promise.all([
      getRecentBankAccessAuditEvents({
        userId,
        connectionId: connection._id,
        limit: 8,
      }),
      validateBankAccessAuditChain({
        userId,
        connectionId: connection._id,
      }),
    ]);

    return res.json({
      success: true,
      data: buildConnectionSecuritySummary(connection, {
        recentEvents,
        chainValid: auditValidation.valid,
        checkedEntries: auditValidation.checkedEntries,
        checkedAt: auditValidation.checkedAt,
      }),
    });
  } catch (error) {
    console.error('❌ Get connection security error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bank connection security details',
      error: error.message,
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
      isActive: true,
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Bank connection not found',
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

    return res.status(202).json({
      success: true,
      message: queuedSync.existing
        ? 'Sync already queued or in progress'
        : 'Sync queued successfully',
      data: {
        connectionId: connection._id,
        syncLogId: queuedSync.syncLogId,
        status: queuedSync.status,
      },
    });
  } catch (error) {
    console.error('❌ Sync transactions error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync transactions',
      error: error.message,
    });
  }
};

/**
 * Disconnect bank account
 * DELETE /api/bank/connections/:id
 */
const disconnectBankAccount = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const requestMeta = {
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  };

  try {
    const connection = await BankConnection.findOne({
      _id: id,
      userId,
      isActive: true,
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Bank connection not found',
      });
    }

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'disconnect_requested',
      actorType: 'user',
      requestMeta,
      metadata: {
        institutionName: connection.institutionName,
      },
    });

    try {
      await monoService.unlinkAccount(connection.accountId);
    } catch (error) {
      console.warn('⚠️  Failed to unlink from Mono:', error.message);
    }

    const syncLogs = await SyncLog.find({
      userId,
      connectionId: connection._id,
    })
      .select('_id')
      .lean();
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

    const expenseIds = mappings.filter((mapping) => mapping.expenseId).map((mapping) => mapping.expenseId);
    const incomeIds = mappings.filter((mapping) => mapping.incomeId).map((mapping) => mapping.incomeId);
    const mappedExternalIds = mappings
      .map((mapping) => mapping.externalId)
      .filter((value) => typeof value === 'string' && value.trim().length > 0);

    await Promise.all([
      expenseIds.length
        ? Expense.deleteMany({ _id: { $in: expenseIds }, userId })
        : Promise.resolve(),
      incomeIds.length
        ? Income.deleteMany({ _id: { $in: incomeIds }, userId })
        : Promise.resolve(),
      syncLogIds.length
        ? Expense.deleteMany({ importJobId: { $in: syncLogIds }, userId })
        : Promise.resolve(),
      syncLogIds.length
        ? Income.deleteMany({ importJobId: { $in: syncLogIds }, userId })
        : Promise.resolve(),
      mappedExternalIds.length
        ? Expense.deleteMany({ externalId: { $in: mappedExternalIds }, userId })
        : Promise.resolve(),
      mappedExternalIds.length
        ? Income.deleteMany({ externalId: { $in: mappedExternalIds }, userId })
        : Promise.resolve(),
      mappings.length
        ? ImportedTransactionMap.deleteMany({ _id: { $in: mappings.map((mapping) => mapping._id) } })
        : Promise.resolve(),
    ]);

    connection.isActive = false;
    connection.syncStatus = 'disconnected';
    connection.currentSyncLogId = null;
    connection.cancelRequested = false;
    connection.pendingResync = false;
    await connection.save();

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'disconnect_completed',
      actorType: 'user',
      requestMeta,
      metadata: {
        institutionName: connection.institutionName,
        totalDeleted: expenseIds.length + incomeIds.length,
      },
    });

    return res.json({
      success: true,
      message: 'Bank account disconnected and synced transactions removed successfully',
      data: {
        deletedExpenses: expenseIds.length,
        deletedIncomes: incomeIds.length,
        totalDeleted: expenseIds.length + incomeIds.length,
      },
    });
  } catch (error) {
    console.error('❌ Disconnect bank account error:', error);
    if (id) {
      await appendBankAccessAuditLog({
        userId,
        connectionId: id,
        eventType: 'disconnect_failed',
        actorType: 'user',
        requestMeta,
        metadata: {
          error: error.message,
        },
      }).catch(() => undefined);
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to disconnect bank account',
      error: error.message,
    });
  }
};

/**
 * Handle Mono webhooks
 * POST /api/bank/webhook
 */
const handleMonoWebhook = async (req, res) => {
  try {
    const { data } = req.body;
    const accountId = data?.account;

    console.log(`📨 Webhook: ${req.webhookEvent} for account ${accountId}`);

    const connection = await BankConnection.findOne({
      accountId,
      isActive: true,
    });

    if (!connection) {
      console.warn(`⚠️  Connection not found for account ${accountId}`);
      return res.status(200).json({
        success: true,
        message: 'Webhook ignored for unknown connection',
      });
    }

    switch (req.webhookEvent) {
      case 'transaction_synced':
        await syncScheduler.queueConnectionSync(connection, connection.userId.toString(), {
          syncType: 'webhook',
          triggeredBy: 'webhook',
          forceSync: true,
        });
        break;

      case 'reauthorization_required':
        connection.syncStatus = 'reauth_required';
        await connection.save();
        await appendBankAccessAuditLog({
          userId: connection.userId,
          connectionId: connection._id,
          eventType: 'reauthorization_required',
          actorType: 'webhook',
          metadata: {
            provider: connection.provider,
          },
        });
        break;

      case 'account_updated': {
        const details = await monoService.getAccountDetails(accountId);
        connection.institutionName =
          details.institution?.name || connection.institutionName;
        connection.institutionCode =
          details.institution?.bankCode || connection.institutionCode;
        connection.accountName = details.account?.name || connection.accountName;
        connection.accountNumber =
          details.account?.accountNumber || connection.accountNumber;
        connection.accountType = details.account?.type || connection.accountType;
        connection.currency = details.account?.currency || connection.currency;

        if (typeof details.account?.balance === 'number') {
          connection.balance = details.account.balance;
        }

        applyReadOnlyContract(connection, { touchSecurityVerifiedAt: true });
        await connection.save();
        await appendBankAccessAuditLog({
          userId: connection.userId,
          connectionId: connection._id,
          eventType: 'account_updated',
          actorType: 'webhook',
          metadata: {
            institutionName: connection.institutionName,
          },
        });
        break;
      }

      default:
        break;
    }

    return res.status(200).json({
      success: true,
      message: 'Webhook processed',
    });
  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    return res.status(200).json({
      success: false,
      message: 'Webhook processing failed',
    });
  }
};

module.exports = {
  connectBankAccount,
  getBankConnections,
  getBankConnection,
  getBankConnectionSecurity,
  syncBankTransactions,
  disconnectBankAccount,
  handleMonoWebhook,
};
