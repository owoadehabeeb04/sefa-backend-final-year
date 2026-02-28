const BankConnection = require('../models/BankConnection');
const ImportJob = require('../models/ImportJob');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Expense = require('../models/Expense');
const Income = require('../models/Income');

const monoService = require('../services/mono.service');
const { batchCheckDuplicates } = require('../services/deduplication.service');
const { detectTransfers } = require('../services/transfer.service');
const { addNotificationJob } = require('../config/queue');

/**
 * Sync Queue Processor
 * Syncs bank transactions from Mono API
 */

/**
 * Process sync job
 * @param {Object} job - Bull job object
 * @returns {Promise<Object>} Processing result
 */
const processSyncJob = async (job) => {
  const { connectionId, userId, accountId, isInitialSync } = job.data;
  
  console.log(`\n🔵 Processing sync job ${job.id}`);
  console.log(`   Connection: ${connectionId}`);
  console.log(`   Initial sync: ${isInitialSync}`);
  
  let importJob = null;
  
  try {
    // Get bank connection
    const connection = await BankConnection.findById(connectionId);
    
    if (!connection) {
      throw new Error('Bank connection not found');
    }
    
    if (!connection.isActive) {
      throw new Error('Bank connection is inactive');
    }
    
    // Update sync status
    connection.syncStatus = 'syncing';
    connection.lastSyncAttempt = new Date();
    await connection.save();
    
    job.progress(5);
    
    // Create import job record
    importJob = await ImportJob.create({
      userId,
      source: 'mono_sync',
      bankConnectionId: connectionId,
      status: 'processing',
      progress: 0
    });
    
    // Step 1: Fetch transactions from Mono
    console.log('📥 Step 1: Fetching transactions from Mono...');
    
    const options = {};
    
    if (isInitialSync) {
      // Initial sync: last 3 months
      const endDate = new Date();
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 3);
      
      options.start = startDate;
      options.end = endDate;
      
      console.log(`   Fetching from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
    } else {
      // Regular sync: since last sync
      if (connection.lastSyncAt) {
        options.start = connection.lastSyncAt;
        console.log(`   Fetching since ${connection.lastSyncAt.toISOString().split('T')[0]}`);
      } else {
        // Fallback: last 30 days
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        options.start = startDate;
        console.log(`   Fetching last 30 days`);
      }
    }
    
    const monoTransactions = await monoService.fetchAllTransactions(accountId, options);
    
    console.log(`   ✅ Fetched ${monoTransactions.length} transactions from Mono`);
    await importJob.updateProgress('fetch', 30);
    job.progress(30);
    
    if (monoTransactions.length === 0) {
      console.log('   No new transactions to sync');
      
      connection.syncStatus = 'active';
      connection.lastSyncAt = new Date();
      connection.nextSyncAt = connection.calculateNextSync();
      await connection.save();
      
      importJob.status = 'completed';
      importJob.progress = 100;
      importJob.stage = 'completed';
      importJob.completedAt = new Date();
      importJob.totalTransactions = 0;
      importJob.importedCount = 0;
      importJob.duplicateCount = 0;
      importJob.errorCount = 0;
      importJob.errors = [];
      await importJob.save();
      
      return {
        success: true,
        importJobId: importJob._id,
        results: {
          totalTransactions: importJob.totalTransactions,
          importedCount: importJob.importedCount,
          duplicateCount: importJob.duplicateCount,
          errorCount: importJob.errorCount
        }
      };
    }
    
    // Step 2: Normalize transactions
    console.log('🔄 Step 2: Normalizing transactions...');
    const normalized = monoTransactions.map(tx => {
      const norm = monoService.normalizeTransaction(tx, userId);
      return {
        ...norm,
        reference: tx._id // Mono transaction ID
      };
    });
    
    await importJob.updateProgress('normalize', 40);
    job.progress(40);
    
    // Step 3: Check duplicates
    console.log('🔍 Step 3: Checking duplicates...');
    const duplicationCheck = await batchCheckDuplicates(normalized, userId);
    
    console.log(`   ✅ Unique: ${duplicationCheck.uniqueCount}, Duplicates: ${duplicationCheck.duplicateCount}`);
    await importJob.updateProgress('deduplicate', 60);
    job.progress(60);
    
    if (duplicationCheck.uniqueCount === 0) {
      console.log('   All transactions are duplicates');
      
      connection.syncStatus = 'active';
      connection.lastSyncAt = new Date();
      connection.nextSyncAt = connection.calculateNextSync();
      await connection.save();
      
      importJob.status = 'completed';
      importJob.progress = 100;
      importJob.stage = 'completed';
      importJob.completedAt = new Date();
      importJob.totalTransactions = monoTransactions.length;
      importJob.importedCount = 0;
      importJob.duplicateCount = duplicationCheck.duplicateCount;
      importJob.errorCount = 0;
      importJob.errors = [];
      await importJob.save();
      
      return {
        success: true,
        importJobId: importJob._id,
        results: {
          totalTransactions: importJob.totalTransactions,
          importedCount: importJob.importedCount,
          duplicateCount: importJob.duplicateCount,
          errorCount: importJob.errorCount
        }
      };
    }
    
    // Step 4: Detect transfers
    console.log('🔄 Step 4: Detecting transfers...');
    const transferDetection = detectTransfers(duplicationCheck.unique);
    
    console.log(`   ✅ Found ${transferDetection.pairCount} transfer pairs`);
    await importJob.updateProgress('detect_transfers', 70);
    job.progress(70);
    
    // Step 5: Save transactions
    console.log('💾 Step 5: Saving transactions...');
    const saveResult = await saveTransactions(
      transferDetection,
      userId,
      importJob._id
    );
    
    console.log(`   ✅ Saved ${saveResult.expenseCount} expenses, ${saveResult.incomeCount} incomes`);
    await importJob.updateProgress('save', 90);
    job.progress(90);
    
    // Step 6: Update connection status
    connection.syncStatus = 'active';
    connection.lastSyncAt = new Date();
    connection.nextSyncAt = connection.calculateNextSync();
    connection.consecutiveFailures = 0;
    await connection.save();
    
    // Step 7: Update job status
    importJob.status = 'completed';
    importJob.progress = 100;
    importJob.stage = 'completed';
    importJob.completedAt = new Date();
    importJob.totalTransactions = monoTransactions.length;
    importJob.importedCount = saveResult.totalCount;
    importJob.duplicateCount = duplicationCheck.duplicateCount;
    importJob.errorCount = 0;
    importJob.errors = [];
    await importJob.save();
    job.progress(100);
    
    console.log('✅ Sync completed successfully');
    
    // Send notification for any imported transactions
    if (saveResult.totalCount > 0) {
      await addNotificationJob({
        userId,
        type: 'import_complete',
        urgency: 'instant',
        data: {
          importJobId: importJob._id.toString(),
          source: 'Bank Sync',
          importedCount: importJob.importedCount,
          duplicateCount: importJob.duplicateCount
        }
      });
    }
    
    return {
      success: true,
      importJobId: importJob._id,
      results: {
        totalTransactions: importJob.totalTransactions,
        importedCount: importJob.importedCount,
        duplicateCount: importJob.duplicateCount,
        errorCount: importJob.errorCount
      }
    };
    
  } catch (error) {
    console.error('❌ Sync processing failed:', error);
    
    // Update connection status
    try {
      const connection = await BankConnection.findById(connectionId);
      if (connection) {
        connection.syncStatus = 'error';
        connection.lastSyncError = error.message;
        connection.consecutiveFailures = (connection.consecutiveFailures || 0) + 1;
        
        // Pause auto-sync after 3 consecutive failures
        if (connection.consecutiveFailures >= 3) {
          connection.autoSync = false;
          connection.syncStatus = 'paused';
          console.warn('⚠️  Auto-sync paused after 3 consecutive failures');
        }
        
        await connection.save();
      }
    } catch (updateError) {
      console.error('Failed to update connection status:', updateError);
    }
    
    // Update job status
    if (importJob) {
      importJob.status = 'failed';
      importJob.stage = 'completed';
      importJob.completedAt = new Date();
      importJob.totalTransactions = 0;
      importJob.importedCount = 0;
      importJob.duplicateCount = 0;
      importJob.errorCount = 1;
      importJob.errors = [error.message];
      await importJob.save();
    }
    
    throw error;
  }
};

/**
 * Save transactions to database
 * @param {Object} transferDetection - Transfer detection result
 * @param {string} userId - User ID
 * @param {string} importJobId - Import job ID
 * @returns {Promise<Object>} Save result
 */
const saveTransactions = async (transferDetection, userId, importJobId) => {
  const { pairs, unmatchedDebits, unmatchedCredits } = transferDetection;
  
  const savedExpenses = [];
  const savedIncomes = [];
  const mappings = [];
  
  // Save transfer pairs
  for (const pair of pairs) {
    // Save expense (debit)
    const expense = await Expense.create({
      userId,
      amount: pair.debit.amount,
      description: pair.debit.description,
      date: pair.debit.date,
      category: 'Transfer',
      paymentMethod: 'bank_transfer',
      isImported: true,
      importJobId,
      externalId: pair.debit.reference,
      isTransfer: true
    });
    
    // Save income (credit)
    const income = await Income.create({
      userId,
      amount: pair.credit.amount,
      description: pair.credit.description,
      date: pair.credit.date,
      source: 'Transfer',
      paymentMethod: 'bank_transfer',
      isImported: true,
      importJobId,
      externalId: pair.credit.reference,
      isTransfer: true,
      transferPairId: expense._id
    });
    
    // Update expense with transferPairId
    expense.transferPairId = income._id;
    await expense.save();
    
    savedExpenses.push(expense);
    savedIncomes.push(income);
    
    // Create mappings
    mappings.push(
      {
        importJobId,
        userId,
        expenseId: expense._id,
        externalId: expense.externalId,
        rawData: pair.debit.rawData
      },
      {
        importJobId,
        userId,
        incomeId: income._id,
        externalId: income.externalId,
        rawData: pair.credit.rawData
      }
    );
  }
  
  // Save unmatched debits (expenses)
  for (const debit of unmatchedDebits) {
    const expense = await Expense.create({
      userId,
      amount: debit.amount,
      description: debit.description,
      date: debit.date,
      category: 'Uncategorized',
      paymentMethod: 'bank_transfer',
      isImported: true,
      importJobId,
      externalId: debit.reference,
      isTransfer: false
    });
    
    savedExpenses.push(expense);
    
    mappings.push({
      importJobId,
      userId,
      expenseId: expense._id,
      externalId: expense.externalId,
      rawData: debit.rawData
    });
  }
  
  // Save unmatched credits (incomes)
  for (const credit of unmatchedCredits) {
    const income = await Income.create({
      userId,
      amount: credit.amount,
      description: credit.description,
      date: credit.date,
      source: 'Bank Transfer',
      paymentMethod: 'bank_transfer',
      isImported: true,
      importJobId,
      externalId: credit.reference,
      isTransfer: false
    });
    
    savedIncomes.push(income);
    
    mappings.push({
      importJobId,
      userId,
      incomeId: income._id,
      externalId: income.externalId,
      rawData: credit.rawData
    });
  }
  
  // Batch insert mappings
  if (mappings.length > 0) {
    await ImportedTransactionMap.insertMany(mappings);
  }
  
  return {
    expenseCount: savedExpenses.length,
    incomeCount: savedIncomes.length,
    totalCount: savedExpenses.length + savedIncomes.length,
    transferPairCount: pairs.length
  };
};

module.exports = {
  processSyncJob,
  saveTransactions
};
