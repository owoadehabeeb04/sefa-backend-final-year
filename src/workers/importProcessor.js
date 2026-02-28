const ImportJob = require('../models/ImportJob');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Category = require('../models/Category');

const { downloadFromGridFS, deleteFromGridFS } = require('../config/gridfs');
const { parseCSV, parsePDF, extractTransactionsFromPDFText } = require('../services/parsing.service');
const { extractTransactionsFromScannedPDF, validateExtractedTransactions } = require('../services/ocr.service');
const { batchCheckDuplicates, deduplicateTransactionList } = require('../services/deduplication.service');
const { detectTransfers } = require('../services/transfer.service');

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
  let shouldDeleteFile = false;
  
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
    importJob.stage = 'completed';
    importJob.completedAt = new Date();
    importJob.totalTransactions = transactions.length + deduped.removedCount;
    importJob.importedCount = saveResult.expenseCount + saveResult.incomeCount;
    importJob.duplicateCount = duplicationCheck.duplicateCount + deduped.removedCount;
    importJob.errorCount = 0;
    importJob.errors = [];
    await importJob.save();
    job.progress(100);
    
    console.log('✅ Import completed successfully');
    
    // Send completion notification
    const { addNotificationJob } = require('../config/queue');
    await addNotificationJob({
      userId,
      type: 'import_complete',
      urgency: 'instant',
      data: {
        importJobId: importJob._id.toString(),
        fileName,
        importedCount: importJob.importedCount,
        duplicateCount: importJob.duplicateCount
      }
    });

    shouldDeleteFile = true;
    
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
    console.error('❌ Import processing failed:', error);

    const maxAttempts = job?.opts?.attempts || 1;
    const isFinalAttempt = job.attemptsMade >= (maxAttempts - 1);
    shouldDeleteFile = isFinalAttempt;
    
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
  } finally {
    // Cleanup: Delete file from GridFS after success or final failed attempt
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

/**
 * Save transactions to database
 * @param {Object} transferDetection - Transfer detection result
 * @param {string} userId - User ID
 * @param {string} importJobId - Import job ID
 * @returns {Promise<Object>} Save result
 */
const saveTransactions = async (transferDetection, userId, importJobId) => {
  const { pairs, unmatchedDebits, unmatchedCredits } = transferDetection;

  const fallbackCategoryCache = {
    expense: null,
    income: null,
  };

  const getOrCreateFallbackCategoryId = async (type) => {
    if (fallbackCategoryCache[type]) return fallbackCategoryCache[type];

    let category = await Category.findOne({ userId, type, isActive: true })
      .sort({ source: 1, createdAt: 1 })
      .select('_id')
      .lean();

    if (!category) {
      const name = type === 'expense' ? 'Uncategorized Expense' : 'Uncategorized Income';
      const created = await Category.create({
        userId,
        name,
        type,
        icon: 'folder',
        color: '#95A5A6',
        source: 'system',
        isActive: true,
      });
      category = { _id: created._id };
    }

    fallbackCategoryCache[type] = category._id;
    return category._id;
  };

  const expenseCategoryId = await getOrCreateFallbackCategoryId('expense');
  const incomeCategoryId = await getOrCreateFallbackCategoryId('income');
  
  const savedExpenses = [];
  const savedIncomes = [];
  const mappings = [];
  
  // Save transfer pairs
  for (const pair of pairs) {
    // Save expense (debit)
    const expense = await Expense.create({
      userId,
      categoryId: expenseCategoryId,
      amount: pair.debit.amount,
      description: pair.debit.description,
      date: pair.debit.date,
      paymentMethod: 'bank_transfer',
      isImported: true,
      importJobId,
      externalId: pair.debit.reference || `${pair.debit.date.getTime()}-${pair.debit.amount}`,
      isTransfer: true
    });
    
    // Save income (credit)
    const income = await Income.create({
      userId,
      categoryId: incomeCategoryId,
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
      categoryId: expenseCategoryId,
      amount: debit.amount,
      description: debit.description,
      date: debit.date,
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
      categoryId: incomeCategoryId,
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
  
  // Batch upsert mappings (idempotent, avoids duplicate key failures on retries)
  if (mappings.length > 0) {
    const operations = [];

    for (const mapping of mappings) {
      if (mapping.externalId) {
        operations.push({
          updateOne: {
            filter: {
              userId: mapping.userId,
              externalId: mapping.externalId,
            },
            update: {
              $set: {
                importJobId: mapping.importJobId,
                rawData: mapping.rawData,
                ...(mapping.expenseId ? { expenseId: mapping.expenseId, incomeId: null } : {}),
                ...(mapping.incomeId ? { incomeId: mapping.incomeId, expenseId: null } : {}),
              },
              $setOnInsert: {
                userId: mapping.userId,
                externalId: mapping.externalId,
              },
            },
            upsert: true,
          },
        });
      } else {
        operations.push({
          insertOne: {
            document: mapping,
          },
        });
      }
    }

    if (operations.length > 0) {
      await ImportedTransactionMap.bulkWrite(operations, { ordered: false });
    }
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
