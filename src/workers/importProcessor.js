const ImportJob = require('../models/ImportJob');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Expense = require('../models/Expense');
const Income = require('../models/Income');

const { downloadFromGridFS, deleteFromGridFS } = require('../config/gridfs');
const { parseCSV, parsePDF, extractTransactionsFromPDFText } = require('../services/parsing.service');
const { extractTransactionsFromScannedPDF, validateExtractedTransactions } = require('../services/ocr.service');
const { batchCheckDuplicates, deduplicateTransactionList } = require('../services/deduplication.service');
const { detectTransfers } = require('../services/transfer.service');
const { addNotificationJob } = require('../config/queue');

/**
 * Import Queue Processor
 * Processes uploaded CSV/PDF bank statements
 */

/**
 * Process import job
 * @param {Object} job - Bull job object
 * @returns {Promise<Object>} Processing result
 */
const processImportJob = async (job) => {
  const { userId, source, fileId, fileName, fileType } = job.data;
  
  console.log(`\n🔵 Processing import job ${job.id} for user ${userId}`);
  console.log(`   File: ${fileName} (${fileType})`);
  
  let importJob = null;
  let fileBuffer = null;
  
  try {
    // Create import job record
    importJob = await ImportJob.create({
      userId,
      source,
      fileId,
      fileName,
      status: 'processing',
      progress: 0
    });
    
    job.progress(5); // 5%
    
    // Step 1: Download file from GridFS
    console.log('📥 Step 1: Downloading file from GridFS...');
    fileBuffer = await downloadFromGridFS(fileId);
    await importJob.updateProgress('download', 10);
    job.progress(10);
    
    // Step 2: Parse file
    console.log('📊 Step 2: Parsing file...');
    let transactions = [];
    
    if (fileType === 'csv') {
      transactions = await parseCSV(fileBuffer);
    } else if (fileType === 'pdf') {
      // Try text-based extraction first
      const pdfText = await parsePDF(fileBuffer);
      transactions = extractTransactionsFromPDFText(pdfText);
      
      // If no transactions found, try OCR
      if (transactions.length === 0) {
        console.log('🔍 No text transactions found, trying OCR...');
        transactions = await extractTransactionsFromScannedPDF(fileBuffer);
        
        // Validate OCR results
        const validation = validateExtractedTransactions(transactions);
        transactions = validation.valid;
        
        console.log(`   OCR Success Rate: ${validation.successRate}%`);
        console.log(`   Valid: ${validation.validCount}, Invalid: ${validation.invalidCount}`);
      }
    }
    
    if (transactions.length === 0) {
      throw new Error('No transactions found in file');
    }
    
    console.log(`   ✅ Parsed ${transactions.length} transactions`);
    await importJob.updateProgress('parse', 30);
    job.progress(30);
    
    // Step 3: Deduplicate internal (within file)
    console.log('🔍 Step 3: Deduplicating internal transactions...');
    const deduped = deduplicateTransactionList(transactions);
    transactions = deduped.unique;
    
    console.log(`   ✅ Removed ${deduped.removedCount} internal duplicates`);
    console.log(`   Unique transactions: ${transactions.length}`);
    await importJob.updateProgress('deduplicate_internal', 40);
    job.progress(40);
    
    // Step 4: Check duplicates against database
    console.log('🔍 Step 4: Checking duplicates against database...');
    const duplicationCheck = await batchCheckDuplicates(transactions, userId);
    
    console.log(`   ✅ Unique: ${duplicationCheck.uniqueCount}, Duplicates: ${duplicationCheck.duplicateCount}`);
    await importJob.updateProgress('deduplicate_database', 50);
    job.progress(50);
    
    // Step 5: Detect transfers
    console.log('🔄 Step 5: Detecting transfers...');
    const transferDetection = detectTransfers(duplicationCheck.unique);
    
    console.log(`   ✅ Found ${transferDetection.pairCount} transfer pairs`);
    console.log(`   Match rate: ${transferDetection.matchRate}%`);
    await importJob.updateProgress('detect_transfers', 60);
    job.progress(60);
    
    // Step 6: Save transactions
    console.log('💾 Step 6: Saving transactions...');
    const saveResult = await saveTransactions(
      transferDetection,
      userId,
      importJob._id
    );
    
    console.log(`   ✅ Saved ${saveResult.expenseCount} expenses, ${saveResult.incomeCount} incomes`);
    await importJob.updateProgress('save', 90);
    job.progress(90);
    
    // Step 7: Update job status
    importJob.status = 'completed';
    importJob.progress = 100;
    importJob.results = {
      totalTransactions: transactions.length + deduped.removedCount,
      importedCount: saveResult.expenseCount + saveResult.incomeCount,
      duplicateCount: duplicationCheck.duplicateCount + deduped.removedCount,
      errorCount: 0,
      transferPairCount: transferDetection.pairCount,
      expenseCount: saveResult.expenseCount,
      incomeCount: saveResult.incomeCount
    };
    await importJob.save();
    job.progress(100);
    
    console.log('✅ Import completed successfully');
    
    // Send completion notification
    await addNotificationJob({
      userId,
      type: 'import_complete',
      urgency: 'instant',
      data: {
        importJobId: importJob._id.toString(),
        fileName,
        importedCount: importJob.results.importedCount,
        duplicateCount: importJob.results.duplicateCount
      }
    });
    
    return {
      success: true,
      importJobId: importJob._id,
      results: importJob.results
    };
    
  } catch (error) {
    console.error('❌ Import processing failed:', error);
    
    // Update job status
    if (importJob) {
      importJob.status = 'failed';
      importJob.errorMessage = error.message;
      importJob.results = {
        totalTransactions: 0,
        importedCount: 0,
        duplicateCount: 0,
        errorCount: 1
      };
      await importJob.save();
    }
    
    throw error;
  } finally {
    // Cleanup: Delete file from GridFS after processing
    if (fileId && fileBuffer) {
      try {
        await deleteFromGridFS(fileId);
        console.log('🗑️  File deleted from GridFS');
      } catch (deleteError) {
        console.warn('⚠️  Failed to delete file:', deleteError.message);
      }
    }
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
      externalId: pair.debit.reference || `${pair.debit.date.getTime()}-${pair.debit.amount}`,
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
      externalId: pair.credit.reference || `${pair.credit.date.getTime()}-${pair.credit.amount}`,
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
        rawData: pair.debit
      },
      {
        importJobId,
        userId,
        incomeId: income._id,
        externalId: income.externalId,
        rawData: pair.credit
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
      externalId: debit.reference || `${debit.date.getTime()}-${debit.amount}`,
      isTransfer: false
    });
    
    savedExpenses.push(expense);
    
    mappings.push({
      importJobId,
      userId,
      expenseId: expense._id,
      externalId: expense.externalId,
      rawData: debit
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
      externalId: credit.reference || `${credit.date.getTime()}-${credit.amount}`,
      isTransfer: false
    });
    
    savedIncomes.push(income);
    
    mappings.push({
      importJobId,
      userId,
      incomeId: income._id,
      externalId: income.externalId,
      rawData: credit
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
  processImportJob,
  saveTransactions
};
