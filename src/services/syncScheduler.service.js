const BankConnection = require('../models/BankConnection');
const monoService = require('./mono.service');
const deduplicationService = require('./deduplication.service');
const transferDetectionService = require('./transfer.service');
const aiCategorizationService = require('./aiCategorization.service');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Category = require('../models/Category');
const { addNotificationJob } = require('../config/queue');
const AppError = require('../utils/AppError');

/**
 * Sync Scheduler Service
 * 
 * Handles background synchronization of bank connections:
 * - Fetches new transactions from Mono API
 * - Deduplicates transactions
 * - Detects and links transfers
 * - Schedules notifications for new imports
 * - Updates sync timestamps and status
 */

/**
 * Sync all active connections due for sync
 * Called by cron job or manual trigger
 * 
 * @param {Object} options - Sync options
 * @param {boolean} options.forceSync - Force sync even if not due
 * @returns {Promise<Object>} Sync results summary
 */
const syncAllConnections = async (options = {}) => {
  const { forceSync = false } = options;

  try {
    // Get connections due for sync
    const connections = forceSync 
      ? await BankConnection.find({ isActive: true, autoSync: true })
      : await BankConnection.getConnectionsForSync();

    if (connections.length === 0) {
      return {
        success: true,
        message: 'No connections due for sync',
        synced: 0,
        failed: 0,
        skipped: 0
      };
    }

    const results = {
      synced: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    // Sync each connection
    for (const connection of connections) {
      try {
        const syncResult = await syncBankConnection(connection._id, connection.userId);
        
        if (syncResult.success) {
          results.synced++;
        } else {
          results.skipped++;
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          connectionId: connection._id,
          accountId: connection.accountId,
          institutionName: connection.institutionName,
          error: error.message
        });
        
        // Update connection status to error
        connection.syncStatus = 'error';
        connection.lastSyncError = error.message;
        await connection.save();
      }
    }

    return {
      success: true,
      message: `Synced ${results.synced} of ${connections.length} connections`,
      ...results,
      totalConnections: connections.length
    };
  } catch (error) {
    console.error('Error in syncAllConnections:', error);
    throw new AppError('Failed to sync connections', 500);
  }
};

/**
 * Sync a specific bank connection
 * Fetches new transactions since last sync
 * 
 * @param {String} connectionId - Bank connection ID
 * @param {String} userId - User ID
 * @param {Object} options - Sync options
 * @param {boolean} options.isInitialSync - Is this the first sync?
 * @param {Date} options.startDate - Override start date for sync
 * @param {Date} options.endDate - Override end date for sync
 * @returns {Promise<Object>} Sync result
 */
const syncBankConnection = async (connectionId, userId, options = {}) => {
  const { isInitialSync = false, startDate, endDate, syncLogId = null } = options;

  try {
    // Fetch connection
    const connection = await BankConnection.findOne({
      _id: connectionId,
      userId,
      isActive: true
    });

    if (!connection) {
      throw new AppError('Bank connection not found or inactive', 404);
    }

    // Update sync status
    connection.syncStatus = 'syncing';
    connection.syncAttempts = (connection.syncAttempts || 0) + 1;
    await connection.save();

    // Determine sync date range
    const now = new Date();
    let syncStartDate = startDate;
    let syncEndDate = endDate || now;

    if (!syncStartDate) {
      if (isInitialSync || !connection.lastSyncAt) {
        // Initial sync: fetch last 3 months
        syncStartDate = new Date();
        syncStartDate.setMonth(syncStartDate.getMonth() - 3);
      } else {
        // Regular sync: fetch since last sync
        syncStartDate = connection.lastSyncAt;
      }
    }

    // Fetch transactions from Mono
    const transactions = await monoService.getTransactions(
      connection.accountId,
      {
        start: syncStartDate.toISOString().split('T')[0],
        end: syncEndDate.toISOString().split('T')[0]
      }
    );

    if (!transactions || transactions.length === 0) {
      // No new transactions
      connection.syncStatus = 'active';
      connection.lastSyncAt = now;
      connection.nextSyncAt = calculateNextSync(connection.syncInterval);
      connection.lastSyncError = null;
      connection.syncAttempts = 0;
      await connection.save();

      return {
        success: true,
        message: 'No new transactions',
        totalFetched: transactions.length,
        newTransactions: 0,
        duplicates: 0,
        transfers: 0
      };
    }

    // Deduplicate transactions
    const { newTransactions, duplicates } = await deduplicateTransactions(
      transactions,
      userId,
      connection._id
    );

    if (newTransactions.length === 0) {
      // All transactions were duplicates
      connection.syncStatus = 'active';
      connection.lastSyncAt = now;
      connection.nextSyncAt = calculateNextSync(connection.syncInterval);
      connection.lastSyncError = null;
      connection.syncAttempts = 0;
      await connection.save();

      return {
        success: true,
        message: 'All transactions already imported',
        totalFetched: transactions.length,
        newTransactions: 0,
        duplicates: duplicates.length,
        transfers: 0
      };
    }

    // Detect transfers
    const transferDetection = await transferDetectionService.detectTransfers(newTransactions);

    // Save transactions
    const savedCount = await saveTransactions(
      transferDetection,
      userId,
      connection._id,
      connection.accountId,
      syncLogId
    );

    // Update connection sync status
    connection.syncStatus = 'active';
    connection.lastSyncAt = now;
    connection.nextSyncAt = calculateNextSync(connection.syncInterval);
    connection.lastSyncError = null;
    connection.syncAttempts = 0;
    await connection.save();

    // Queue notification for any imported transactions
    if (savedCount > 0) {
      await addNotificationJob({
        userId,
        type: 'import_complete',
        urgency: 'instant',
        data: {
          institutionName: connection.institutionName,
          accountNumber: connection.accountNumber,
          importedCount: savedCount,
          duplicateCount: duplicates.length,
          source: connection.institutionName || 'Bank Sync',
          syncDate: now
        }
      });
    }

    return {
      success: true,
      message: 'Sync completed successfully',
      totalFetched: transactions.length,
      newTransactions: savedCount,
      duplicates: duplicates.length,
      transfers: Array.isArray(transferDetection?.transfers)
        ? transferDetection.transfers.length
        : (transferDetection?.pairCount || transferDetection?.pairs?.length || 0),
      connection: {
        institutionName: connection.institutionName,
        accountNumber: connection.accountNumber,
        lastSyncAt: connection.lastSyncAt,
        nextSyncAt: connection.nextSyncAt
      }
    };
  } catch (error) {
    console.error('Error in syncBankConnection:', error);

    // Update connection with error status
    try {
      const connection = await BankConnection.findById(connectionId);
      if (connection) {
        connection.syncStatus = 'error';
        connection.lastSyncError = error.message;
        
        // Implement exponential backoff for retry
        const baseInterval = connection.syncInterval || 12; // hours
        const backoffMultiplier = Math.min(connection.syncAttempts || 1, 5); // Max 5x backoff
        const retryHours = baseInterval * backoffMultiplier;
        
        connection.nextSyncAt = new Date(Date.now() + retryHours * 60 * 60 * 1000);
        await connection.save();
      }
    } catch (updateError) {
      console.error('Failed to update connection status:', updateError);
    }

    throw error;
  }
};

/**
 * Deduplicate transactions against existing database records
 * 
 * @param {Array} transactions - Transactions from Mono
 * @param {String} userId - User ID
 * @param {String} connectionId - Bank connection ID
 * @returns {Promise<Object>} New transactions and duplicates
 */
const deduplicateTransactions = async (transactions, userId, connectionId) => {
  const newTransactions = [];
  const duplicates = [];

  for (const transaction of transactions) {
    const externalId = String(transaction?._id || transaction?.id || transaction?.reference || '').trim();
    if (!externalId) {
      duplicates.push(transaction);
      continue;
    }

    // Check if transaction already imported
    const existingMap = await ImportedTransactionMap.findOne({
      userId,
      externalId
    });

    if (existingMap) {
      duplicates.push(transaction);
      continue;
    }

    const [existingExpense, existingIncome] = await Promise.all([
      Expense.exists({ userId, externalId }),
      Income.exists({ userId, externalId }),
    ]);

    if (existingExpense || existingIncome) {
      duplicates.push(transaction);
      continue;
    }

    // Check for duplicate by amount, date, description
    const duplicateCheck = await deduplicationService.checkDuplicate({
      amount: Math.abs(transaction.amount),
      date: new Date(transaction.date),
      description: transaction.narration,
      userId,
      type: transaction.type === 'debit' ? 'expense' : 'income',
      externalId,
    });

    if (duplicateCheck?.isDuplicate) {
      duplicates.push(transaction);
      continue;
    }

    newTransactions.push(transaction);
  }

  return { newTransactions, duplicates };
};

/**
 * Save transactions to database
 * 
 * @param {Object} transferDetection - Transfer detection result
 * @param {String} userId - User ID
 * @param {String} connectionId - Bank connection ID
 * @param {String} accountId - Mono account ID
 * @returns {Promise<Number>} Count of saved transactions
 */
const saveTransactions = async (transferDetection, userId, connectionId, accountId, syncLogId = null) => {
  let savedCount = 0;
  const fallbackCategoryCache = {
    expense: null,
    income: null,
  };

  const getFallbackCategoryId = async (type) => {
    if (fallbackCategoryCache[type]) return fallbackCategoryCache[type];

    const category = await Category.findOne({ userId, type }).select('_id').lean();
    fallbackCategoryCache[type] = category?._id || null;
    return fallbackCategoryCache[type];
  };

  const transactions = Array.isArray(transferDetection?.transactions)
    ? transferDetection.transactions
    : [
        ...(Array.isArray(transferDetection?.unmatchedDebits) ? transferDetection.unmatchedDebits : []),
        ...(Array.isArray(transferDetection?.unmatchedCredits) ? transferDetection.unmatchedCredits : []),
      ];
  const transfers = Array.isArray(transferDetection?.transfers) ? transferDetection.transfers : [];
  const transferPairs = Array.isArray(transferDetection?.transferPairs)
    ? transferDetection.transferPairs
    : Array.isArray(transferDetection?.pairs)
      ? transferDetection.pairs
      : [];

  for (const transaction of transactions) {
    try {
      // Determine transaction type
      const type = transaction.type === 'debit' ? 'expense' : 'income';
      
      // Use AI to categorize the transaction
      let categoryId = null;
      let categoryName = 'Uncategorized';
      
      try {
        const categorization = await aiCategorizationService.categorizeTransaction(
          {
            description: transaction.narration || 'Bank transaction',
            amount: Math.abs(transaction.amount),
            type: type
          },
          userId
        );
        
        if (categorization && categorization.categoryId) {
          categoryId = categorization.categoryId;
          categoryName = categorization.categoryName;
          
          // Log categorization confidence for monitoring
          console.log(`AI categorized transaction: "${transaction.narration}" → ${categoryName} (confidence: ${categorization.confidence})`);
        }
      } catch (categorizationError) {
        console.error('AI categorization failed, using fallback:', categorizationError);
        // Fall back to default category if AI categorization fails
      }

      if (!categoryId) {
        categoryId = await getFallbackCategoryId(type);
      }

      if (!categoryId) {
        console.warn(`Skipping transaction due to missing ${type} category for user ${userId}`);
        continue;
      }
      
      const transactionData = {
        userId,
        amount: Math.abs(transaction.amount),
        description: transaction.narration || 'Bank transaction',
        date: new Date(transaction.date),
        categoryId: categoryId, // Use AI-suggested category
        importJobId: syncLogId || null,
        isImported: true,
        externalId: transaction._id,
        paymentMethod: 'bank_transfer',
        metadata: {
          balance: transaction.balance,
          reference: transaction.reference,
          monoTransactionId: transaction._id,
          connectionId: connectionId.toString(),
          accountId,
          aiCategorized: categoryId ? true : false,
          aiCategory: categoryName,
          rawData: transaction
        }
      };

      // Check if transaction is a transfer
      const transferInfo = transfers.find(t => t.transactionId === transaction._id);
      if (transferInfo) {
        transactionData.isTransfer = true;
        transactionData.transferConfidence = transferInfo.confidence;
        transactionData.metadata.transferType = transferInfo.type;
      }

      // Save as Expense or Income based on type
      let savedTransaction;
      if (transaction.type === 'debit') {
        savedTransaction = await Expense.create(transactionData);
      } else {
        savedTransaction = await Income.create(transactionData);
      }

      savedCount++;

      // Best-effort map creation for audit/undo tooling compatibility.
      try {
        await ImportedTransactionMap.create({
          importJobId: syncLogId || connectionId,
          userId,
          expenseId: transaction.type === 'debit' ? savedTransaction._id : null,
          incomeId: transaction.type === 'debit' ? null : savedTransaction._id,
          externalId: transaction._id,
          rawData: {
            source: 'mono_sync',
            connectionId,
            syncLogId: syncLogId || null,
            accountId,
            importedAt: new Date(),
            transaction,
          },
        });
      } catch (mappingError) {
        console.warn('ImportedTransactionMap write skipped:', mappingError.message);
      }
    } catch (error) {
      console.error('Error saving transaction:', error);
      // Continue with next transaction
    }
  }

  // Link transfer pairs
  for (const pair of transferPairs) {
    try {
      const sourceExternalId = pair?.sourceId || pair?.debit?._id || pair?.debit?.reference;
      const destinationExternalId = pair?.destinationId || pair?.credit?._id || pair?.credit?.reference;
      if (!sourceExternalId || !destinationExternalId) {
        continue;
      }

      const sourceMap = await ImportedTransactionMap.findOne({
        externalId: sourceExternalId,
        userId
      });
      const destMap = await ImportedTransactionMap.findOne({
        externalId: destinationExternalId,
        userId
      });

      if (sourceMap && destMap) {
        // Link transactions
        const sourceExpenseId = sourceMap.expenseId || null;
        const sourceIncomeId = sourceMap.incomeId || null;
        const destExpenseId = destMap.expenseId || null;
        const destIncomeId = destMap.incomeId || null;

        if (sourceExpenseId) {
          await Expense.findByIdAndUpdate(sourceExpenseId, {
            transferPairId: destIncomeId || destExpenseId
          });
        }
        if (sourceIncomeId) {
          await Income.findByIdAndUpdate(sourceIncomeId, {
            transferPairId: destExpenseId || destIncomeId
          });
        }

        if (destExpenseId) {
          await Expense.findByIdAndUpdate(destExpenseId, {
            transferPairId: sourceIncomeId || sourceExpenseId
          });
        }
        if (destIncomeId) {
          await Income.findByIdAndUpdate(destIncomeId, {
            transferPairId: sourceExpenseId || sourceIncomeId
          });
        }
      }
    } catch (error) {
      console.error('Error linking transfer pair:', error);
    }
  }

  return savedCount;
};

/**
 * Calculate next sync time based on interval
 * 
 * @param {Number} intervalHours - Sync interval in hours (default: 12)
 * @returns {Date} Next sync timestamp
 */
const calculateNextSync = (intervalHours = 12) => {
  const now = new Date();
  return new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
};

/**
 * Sync a specific user's connections
 * 
 * @param {String} userId - User ID
 * @param {Object} options - Sync options
 * @returns {Promise<Object>} Sync results
 */
const syncUserConnections = async (userId, options = {}) => {
  try {
    const connections = await BankConnection.find({
      userId,
      isActive: true,
      autoSync: true
    });

    if (connections.length === 0) {
      return {
        success: true,
        message: 'No active connections found',
        synced: 0,
        failed: 0
      };
    }

    const results = {
      synced: 0,
      failed: 0,
      errors: []
    };

    for (const connection of connections) {
      try {
        await syncBankConnection(connection._id, userId, options);
        results.synced++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          connectionId: connection._id,
          institutionName: connection.institutionName,
          error: error.message
        });
      }
    }

    return {
      success: true,
      message: `Synced ${results.synced} of ${connections.length} connections`,
      ...results,
      totalConnections: connections.length
    };
  } catch (error) {
    console.error('Error in syncUserConnections:', error);
    throw new AppError('Failed to sync user connections', 500);
  }
};

/**
 * Get sync statistics
 * 
 * @returns {Promise<Object>} Sync statistics
 */
const getSyncStats = async () => {
  try {
    const totalConnections = await BankConnection.countDocuments({ isActive: true });
    const autoSyncEnabled = await BankConnection.countDocuments({ 
      isActive: true, 
      autoSync: true 
    });
    const syncingNow = await BankConnection.countDocuments({ 
      syncStatus: 'syncing' 
    });
    const errorConnections = await BankConnection.countDocuments({ 
      syncStatus: 'error',
      isActive: true
    });
    const dueForSync = await BankConnection.countDocuments({
      isActive: true,
      autoSync: true,
      nextSyncAt: { $lte: new Date() }
    });

    return {
      totalConnections,
      autoSyncEnabled,
      syncingNow,
      errorConnections,
      dueForSync,
      lastChecked: new Date()
    };
  } catch (error) {
    console.error('Error getting sync stats:', error);
    throw new AppError('Failed to get sync statistics', 500);
  }
};

module.exports = {
  syncAllConnections,
  syncBankConnection,
  syncUserConnections,
  getSyncStats,
  calculateNextSync
};
