const Expense = require('../models/Expense');
const Income = require('../models/Income');
const { isSimilar, normalizeDescription } = require('../utils/stringMatch');

/**
 * Deduplication Service
 * Detects and prevents duplicate transactions using multiple strategies
 */

/**
 * Check if transaction is a duplicate
 * @param {Object} transaction - Transaction to check
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Deduplication result
 */
const checkDuplicate = async (transaction, userId) => {
  const { date, amount, description, externalId, type } = transaction;
  
  // Strategy 1: Exact match by externalId (for imported transactions)
  if (externalId) {
    const exactMatch = await findByExternalId(externalId, userId, type);
    
    if (exactMatch) {
      return {
        isDuplicate: true,
        matchType: 'exact_external_id',
        existingTransaction: exactMatch,
        confidence: 100
      };
    }
  }
  
  // Strategy 2: Exact match by amount + date + description
  const strictMatch = await findStrictMatch(date, amount, description, userId, type);
  
  if (strictMatch) {
    return {
      isDuplicate: true,
      matchType: 'strict_match',
      existingTransaction: strictMatch,
      confidence: 95
    };
  }
  
  // Strategy 3: Fuzzy match by amount + date + similar description
  const fuzzyMatch = await findFuzzyMatch(date, amount, description, userId, type);
  
  if (fuzzyMatch) {
    return {
      isDuplicate: true,
      matchType: 'fuzzy_match',
      existingTransaction: fuzzyMatch.transaction,
      similarity: fuzzyMatch.similarity,
      confidence: fuzzyMatch.confidence
    };
  }
  
  return {
    isDuplicate: false,
    matchType: null,
    existingTransaction: null,
    confidence: 0
  };
};

/**
 * Find transaction by external ID
 * @param {string} externalId - External transaction ID
 * @param {string} userId - User ID
 * @param {string} type - Transaction type ('expense' or 'income')
 * @returns {Promise<Object|null>} Existing transaction
 */
const findByExternalId = async (externalId, userId, type) => {
  const Model = type === 'income' ? Income : Expense;
  
  return await Model.findOne({
    userId,
    externalId,
    isImported: true
  });
};

/**
 * Find exact match by amount, date, and description
 * @param {Date} date - Transaction date
 * @param {number} amount - Transaction amount
 * @param {string} description - Transaction description
 * @param {string} userId - User ID
 * @param {string} type - Transaction type
 * @returns {Promise<Object|null>} Existing transaction
 */
const findStrictMatch = async (date, amount, description, userId, type) => {
  const Model = type === 'income' ? Income : Expense;
  
  // Match within same day
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  return await Model.findOne({
    userId,
    amount,
    description: description.trim(),
    date: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  });
};

/**
 * Find fuzzy match by amount, date, and similar description
 * @param {Date} date - Transaction date
 * @param {number} amount - Transaction amount
 * @param {string} description - Transaction description
 * @param {string} userId - User ID
 * @param {string} type - Transaction type
 * @returns {Promise<Object|null>} Fuzzy match result
 */
const findFuzzyMatch = async (date, amount, description, userId, type) => {
  const Model = type === 'income' ? Income : Expense;
  
  // Match within same day and same amount
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  // Find transactions with same amount on same day
  const candidates = await Model.find({
    userId,
    amount,
    date: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  }).limit(10); // Limit to avoid performance issues
  
  if (candidates.length === 0) {
    return null;
  }
  
  // Check description similarity
  const normalizedInput = normalizeDescription(description);
  
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeDescription(candidate.description);
    
    // Use string matching utility with 85% threshold
    if (isSimilar(normalizedInput, normalizedCandidate, 85)) {
      const similarity = calculateSimilarityScore(normalizedInput, normalizedCandidate);
      
      return {
        transaction: candidate,
        similarity,
        confidence: Math.min(85 + (similarity - 85) / 2, 95) // 85-95 confidence
      };
    }
  }
  
  return null;
};

/**
 * Calculate similarity score between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity percentage (0-100)
 */
const calculateSimilarityScore = (str1, str2) => {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 100;
  
  const distance = levenshteinDistance(longer, shorter);
  return ((longer.length - distance) / longer.length) * 100;
};

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Edit distance
 */
const levenshteinDistance = (str1, str2) => {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
};

/**
 * Batch check duplicates for multiple transactions
 * @param {Array} transactions - Transactions to check
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Batch deduplication result
 */
const batchCheckDuplicates = async (transactions, userId) => {
  const results = {
    unique: [],
    duplicates: [],
    checked: 0,
    uniqueCount: 0,
    duplicateCount: 0
  };
  
  for (const transaction of transactions) {
    results.checked++;
    
    const check = await checkDuplicate(transaction, userId);
    
    if (check.isDuplicate) {
      results.duplicates.push({
        transaction,
        ...check
      });
      results.duplicateCount++;
    } else {
      results.unique.push(transaction);
      results.uniqueCount++;
    }
  }
  
  return results;
};

/**
 * Find potential duplicates within a transaction list (internal duplicates)
 * @param {Array} transactions - List of transactions
 * @returns {Array} Groups of potential duplicates
 */
const findInternalDuplicates = (transactions) => {
  const duplicateGroups = [];
  const processed = new Set();
  
  for (let i = 0; i < transactions.length; i++) {
    if (processed.has(i)) continue;
    
    const current = transactions[i];
    const group = [{ index: i, transaction: current }];
    
    for (let j = i + 1; j < transactions.length; j++) {
      if (processed.has(j)) continue;
      
      const candidate = transactions[j];
      
      // Check if same day and same amount
      const sameDay = 
        current.date.getDate() === candidate.date.getDate() &&
        current.date.getMonth() === candidate.date.getMonth() &&
        current.date.getFullYear() === candidate.date.getFullYear();
      
      if (sameDay && current.amount === candidate.amount) {
        // Check description similarity
        const similarity = calculateSimilarityScore(
          normalizeDescription(current.description),
          normalizeDescription(candidate.description)
        );
        
        if (similarity >= 85) {
          group.push({ index: j, transaction: candidate, similarity });
          processed.add(j);
        }
      }
    }
    
    if (group.length > 1) {
      duplicateGroups.push(group);
      processed.add(i);
    }
  }
  
  return duplicateGroups;
};

/**
 * Deduplicate transaction list (keep first occurrence)
 * @param {Array} transactions - Transactions to deduplicate
 * @returns {Object} Deduplicated result
 */
const deduplicateTransactionList = (transactions) => {
  const duplicateGroups = findInternalDuplicates(transactions);
  const removedIndices = new Set();
  
  // Mark all but first in each group for removal
  for (const group of duplicateGroups) {
    for (let i = 1; i < group.length; i++) {
      removedIndices.add(group[i].index);
    }
  }
  
  const unique = transactions.filter((_, index) => !removedIndices.has(index));
  
  return {
    original: transactions,
    unique,
    removed: transactions.filter((_, index) => removedIndices.has(index)),
    duplicateGroups,
    originalCount: transactions.length,
    uniqueCount: unique.length,
    removedCount: removedIndices.size
  };
};

module.exports = {
  checkDuplicate,
  findByExternalId,
  findStrictMatch,
  findFuzzyMatch,
  batchCheckDuplicates,
  findInternalDuplicates,
  deduplicateTransactionList
};
