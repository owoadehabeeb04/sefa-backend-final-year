const { containsTransferKeywords, extractAccountNumbers } = require('../utils/stringMatch');

/**
 * Transfer Detection Service
 * Identifies transfer pairs (expense + income) within imported transactions
 */

/**
 * Detect transfers in a list of transactions
 * @param {Array} transactions - List of transactions with type field
 * @returns {Object} Detection result with pairs and singles
 */
const detectTransfers = (transactions) => {
  const debits = transactions.filter(t => t.type === 'debit');
  const credits = transactions.filter(t => t.type === 'credit');
  
  const pairs = [];
  const matchedDebitIndices = new Set();
  const matchedCreditIndices = new Set();
  
  // Find matching pairs
  for (let i = 0; i < debits.length; i++) {
    if (matchedDebitIndices.has(i)) continue;
    
    const debit = debits[i];
    
    // Check if description contains transfer keywords
    if (!containsTransferKeywords(debit.description)) {
      continue;
    }
    
    // Look for matching credit
    for (let j = 0; j < credits.length; j++) {
      if (matchedCreditIndices.has(j)) continue;
      
      const credit = credits[j];
      
      if (!containsTransferKeywords(credit.description)) {
        continue;
      }
      
      // Check if it's a potential pair
      if (isPotentialTransferPair(debit, credit)) {
        pairs.push({
          debit: { ...debit, originalIndex: i },
          credit: { ...credit, originalIndex: j },
          confidence: calculatePairConfidence(debit, credit)
        });
        
        matchedDebitIndices.add(i);
        matchedCreditIndices.add(j);
        break; // Move to next debit
      }
    }
  }
  
  // Collect unmatched transactions
  const unmatchedDebits = debits.filter((_, i) => !matchedDebitIndices.has(i));
  const unmatchedCredits = credits.filter((_, i) => !matchedCreditIndices.has(i));
  
  return {
    pairs,
    unmatchedDebits,
    unmatchedCredits,
    pairCount: pairs.length,
    totalDebits: debits.length,
    totalCredits: credits.length,
    matchRate: debits.length > 0 
      ? (matchedDebitIndices.size / debits.length * 100).toFixed(2)
      : 0
  };
};

/**
 * Check if two transactions are a potential transfer pair
 * @param {Object} debit - Debit transaction
 * @param {Object} credit - Credit transaction
 * @returns {boolean} True if potential pair
 */
const isPotentialTransferPair = (debit, credit) => {
  // Rule 1: Same amount
  if (Math.abs(debit.amount - credit.amount) > 0.01) {
    return false;
  }
  
  // Rule 2: Same date or within 1 day
  const timeDiff = Math.abs(credit.date.getTime() - debit.date.getTime());
  const dayDiff = timeDiff / (1000 * 60 * 60 * 24);
  
  if (dayDiff > 1) {
    return false;
  }
  
  // Rule 3: Both have transfer keywords
  if (!containsTransferKeywords(debit.description) || 
      !containsTransferKeywords(credit.description)) {
    return false;
  }
  
  return true;
};

/**
 * Calculate confidence score for a transfer pair
 * @param {Object} debit - Debit transaction
 * @param {Object} credit - Credit transaction
 * @returns {number} Confidence percentage (0-100)
 */
const calculatePairConfidence = (debit, credit) => {
  let confidence = 0;
  
  // Exact amount match: +40
  if (debit.amount === credit.amount) {
    confidence += 40;
  }
  
  // Same date: +30, next day: +20, within 1 day: +10
  const timeDiff = Math.abs(credit.date.getTime() - debit.date.getTime());
  const dayDiff = timeDiff / (1000 * 60 * 60 * 24);
  
  if (dayDiff === 0) {
    confidence += 30;
  } else if (dayDiff <= 0.5) {
    confidence += 20;
  } else {
    confidence += 10;
  }
  
  // Transfer keywords in both: +20
  const debitHasKeyword = containsTransferKeywords(debit.description);
  const creditHasKeyword = containsTransferKeywords(credit.description);
  
  if (debitHasKeyword && creditHasKeyword) {
    confidence += 20;
  }
  
  // Account numbers match: +10
  const debitAccounts = extractAccountNumbers(debit.description);
  const creditAccounts = extractAccountNumbers(credit.description);
  
  const hasMatchingAccount = debitAccounts.some(da => 
    creditAccounts.some(ca => da === ca)
  );
  
  if (hasMatchingAccount) {
    confidence += 10;
  }
  
  return confidence;
};

/**
 * Filter transactions to exclude transfers (for analytics)
 * @param {Array} expenses - Expense transactions
 * @param {Array} incomes - Income transactions
 * @returns {Object} Filtered transactions
 */
const excludeTransfers = (expenses, incomes) => {
  return {
    expenses: expenses.filter(e => !e.isTransfer),
    incomes: incomes.filter(i => !i.isTransfer),
    excludedExpenses: expenses.filter(e => e.isTransfer),
    excludedIncomes: incomes.filter(i => i.isTransfer)
  };
};

/**
 * Mark transactions as transfers
 * @param {Array} pairs - Transfer pairs
 * @returns {Array} Transactions marked with isTransfer flag
 */
const markAsTransfers = (pairs) => {
  const markedTransactions = [];
  
  for (const pair of pairs) {
    markedTransactions.push({
      ...pair.debit,
      isTransfer: true,
      transferPairId: null // Will be set after income is saved
    });
    
    markedTransactions.push({
      ...pair.credit,
      isTransfer: true,
      transferPairId: null // Will be set after expense is saved
    });
  }
  
  return markedTransactions;
};

/**
 * Create transfer pair summary
 * @param {Object} debit - Debit transaction
 * @param {Object} credit - Credit transaction
 * @returns {Object} Transfer summary
 */
const createTransferSummary = (debit, credit) => {
  return {
    amount: debit.amount,
    date: debit.date,
    fromAccount: extractAccountNumbers(debit.description)[0] || 'Unknown',
    toAccount: extractAccountNumbers(credit.description)[0] || 'Unknown',
    debitDescription: debit.description,
    creditDescription: credit.description,
    confidence: calculatePairConfidence(debit, credit)
  };
};

/**
 * Validate transfer pair
 * @param {Object} debit - Debit transaction
 * @param {Object} credit - Credit transaction
 * @returns {Object} Validation result
 */
const validateTransferPair = (debit, credit) => {
  const errors = [];
  const warnings = [];
  
  // Check amount
  if (Math.abs(debit.amount - credit.amount) > 0.01) {
    errors.push('Amounts do not match');
  }
  
  // Check dates
  const timeDiff = Math.abs(credit.date.getTime() - debit.date.getTime());
  const dayDiff = timeDiff / (1000 * 60 * 60 * 24);
  
  if (dayDiff > 1) {
    errors.push('Dates are more than 1 day apart');
  } else if (dayDiff > 0) {
    warnings.push('Dates are not on the same day');
  }
  
  // Check keywords
  if (!containsTransferKeywords(debit.description)) {
    warnings.push('Debit description does not contain transfer keywords');
  }
  
  if (!containsTransferKeywords(credit.description)) {
    warnings.push('Credit description does not contain transfer keywords');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    confidence: calculatePairConfidence(debit, credit)
  };
};

/**
 * Get transfer statistics
 * @param {Array} transactions - All transactions
 * @returns {Object} Transfer statistics
 */
const getTransferStats = (transactions) => {
  const transferCount = transactions.filter(t => t.isTransfer).length;
  const transferAmount = transactions
    .filter(t => t.isTransfer && t.type === 'debit')
    .reduce((sum, t) => sum + t.amount, 0);
  
  return {
    totalTransactions: transactions.length,
    transferCount,
    transferPercentage: transactions.length > 0 
      ? (transferCount / transactions.length * 100).toFixed(2)
      : 0,
    totalTransferAmount: transferAmount,
    pairCount: transferCount / 2
  };
};

module.exports = {
  detectTransfers,
  isPotentialTransferPair,
  calculatePairConfidence,
  excludeTransfers,
  markAsTransfers,
  createTransferSummary,
  validateTransferPair,
  getTransferStats
};
