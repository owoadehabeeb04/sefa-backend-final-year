const BankConnection = require('../models/BankConnection');
const monoService = require('./mono.service');
const deduplicationService = require('./deduplication.service');
const transferDetectionService = require('./transfer.service');
const aiCategorizationService = require('./aiCategorization.service');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
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
        connection.errorMessage = error.message;
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
  const { isInitialSync = false, startDate, endDate } = options;

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
      connection.errorMessage = null;
      connection.syncAttempts = 0;
      await connection.save();

      return {
        success: true,
        message: 'No new transactions',
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
      connection.errorMessage = null;
      connection.syncAttempts = 0;
      await connection.save();

      return {
        success: true,
        message: 'All transactions already imported',
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
      connection.accountId
    );

    // Update connection sync status
    connection.syncStatus = 'active';
    connection.lastSyncAt = now;
    connection.nextSyncAt = calculateNextSync(connection.syncInterval);
    connection.errorMessage = null;
    connection.syncAttempts = 0;
    await connection.save();

    // Queue notification if significant imports (>5 transactions)
    if (savedCount >= 5) {
      await addNotificationJob({
        userId,
        type: 'bank_sync',
        data: {
          institutionName: connection.institutionName,
          accountNumber: connection.accountNumber,
          transactionCount: savedCount,
          syncDate: now
        }
      });
    }

    return {
      success: true,
      message: 'Sync completed successfully',
      newTransactions: savedCount,
      duplicates: duplicates.length,
      transfers: transferDetection.transfers.length,
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
        connection.errorMessage = error.message;
        
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
    // Check if transaction already imported
    const existingMap = await ImportedTransactionMap.findOne({
      userId,
      externalId: transaction._id,
      source: 'mono'
    });

    if (existingMap) {
      duplicates.push(transaction);
      continue;
    }

    // Check for duplicate by amount, date, description
    const isDuplicate = await deduplicationService.findDuplicates({
      amount: Math.abs(transaction.amount),
      date: new Date(transaction.date),
      description: transaction.narration,
      userId
    });

    if (isDuplicate.length > 0) {
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
const saveTransactions = async (transferDetection, userId, connectionId, accountId) => {
  let savedCount = 0;

  const { transactions, transfers, transferPairs } = transferDetection;

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
      
      const transactionData = {
        userId,
        amount: Math.abs(transaction.amount),
        description: transaction.narration || 'Bank transaction',
        date: new Date(transaction.date),
        categoryId: categoryId, // Use AI-suggested category
        source: 'mono',
        sourceId: transaction._id,
        paymentMethod: 'Bank Transfer',
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

      // Create imported transaction map
      await ImportedTransactionMap.create({
        userId,
        transactionId: savedTransaction._id,
        transactionType: transaction.type === 'debit' ? 'expense' : 'income',
        externalId: transaction._id,
        source: 'mono',
        importJobId: null, // No import job for sync
        connectionId,
        importedAt: new Date(),
        metadata: {
          accountId,
          institutionName: 'via sync'
        }
      });

      savedCount++;
    } catch (error) {
      console.error('Error saving transaction:', error);
      // Continue with next transaction
    }
  }

  // Link transfer pairs
  for (const pair of transferPairs) {
    try {
      const sourceMap = await ImportedTransactionMap.findOne({
        externalId: pair.sourceId,
        userId
      });
      const destMap = await ImportedTransactionMap.findOne({
        externalId: pair.destinationId,
        userId
      });

      if (sourceMap && destMap) {
        // Link transactions
        if (sourceMap.transactionType === 'expense') {
          await Expense.findByIdAndUpdate(sourceMap.transactionId, {
            linkedTransactionId: destMap.transactionId
          });
        } else {
          await Income.findByIdAndUpdate(sourceMap.transactionId, {
            linkedTransactionId: destMap.transactionId
          });
        }

        if (destMap.transactionType === 'expense') {
          await Expense.findByIdAndUpdate(destMap.transactionId, {
            linkedTransactionId: sourceMap.transactionId
          });
        } else {
          await Income.findByIdAndUpdate(destMap.transactionId, {
            linkedTransactionId: sourceMap.transactionId
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
