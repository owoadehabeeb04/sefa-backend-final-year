const natural = require('natural');

/**
 * String matching utilities for duplicate detection
 * Uses Levenshtein distance for fuzzy matching
 */

/**
 * Calculate Levenshtein distance between two strings
 * Returns the minimum number of single-character edits needed
 * to change one string into another
 * 
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Levenshtein distance
 */
const levenshteinDistance = (str1, str2) => {
  if (!str1 || !str2) return Math.max(str1?.length || 0, str2?.length || 0);
  
  // Use natural library for efficient calculation
  return natural.LevenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
};

/**
 * Calculate similarity percentage between two strings
 * Returns a value between 0 (completely different) and 100 (identical)
 * 
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity percentage (0-100)
 */
const calculateSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  // Normalize strings
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  // Exact match
  if (s1 === s2) return 100;

  // Calculate distance
  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);

  // Convert to similarity percentage
  const similarity = ((maxLength - distance) / maxLength) * 100;

  return Math.round(similarity * 100) / 100; // Round to 2 decimal places
};

/**
 * Check if two strings are similar based on threshold
 * 
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @param {number} threshold - Similarity threshold (0-100), default 85
 * @returns {boolean} True if similarity >= threshold
 */
const isSimilar = (str1, str2, threshold = 85) => {
  const similarity = calculateSimilarity(str1, str2);
  return similarity >= threshold;
};

/**
 * Normalize transaction description for better matching
 * Removes common variations and standardizes format
 * 
 * @param {string} description - Transaction description
 * @returns {string} Normalized description
 */
const normalizeDescription = (description) => {
  if (!description) return '';

  return description
    .toLowerCase()
    .trim()
    // Remove extra whitespace
    .replace(/\s+/g, ' ')
    // Remove common prefixes/suffixes
    .replace(/^(purchase|payment|transfer|debit|credit)\s*/i, '')
    .replace(/\s*(transaction|txn|ref)$/i, '')
    // Remove reference numbers (common pattern: REF123456)
    .replace(/ref[\s:]*\d+/gi, '')
    // Remove transaction IDs (common pattern: TXN123456)
    .replace(/txn[\s:]*\d+/gi, '')
    // Remove dates (DD/MM/YYYY or DD-MM-YYYY)
    .replace(/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/g, '')
    // Remove times (HH:MM or HH:MM:SS)
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')
    // Normalize multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Compare transaction descriptions with fuzzy matching
 * Takes into account normalization and similarity threshold
 * 
 * @param {string} desc1 - First description
 * @param {string} desc2 - Second description
 * @param {number} threshold - Similarity threshold (default 85)
 * @returns {object} { isMatch: boolean, similarity: number, normalized1: string, normalized2: string }
 */
const compareDescriptions = (desc1, desc2, threshold = 85) => {
  // Normalize both descriptions
  const normalized1 = normalizeDescription(desc1);
  const normalized2 = normalizeDescription(desc2);

  // Calculate similarity
  const similarity = calculateSimilarity(normalized1, normalized2);

  return {
    isMatch: similarity >= threshold,
    similarity,
    normalized1,
    normalized2
  };
};

/**
 * Find best match for a string in an array of strings
 * Returns the most similar string and its similarity score
 * 
 * @param {string} target - Target string to match
 * @param {string[]} candidates - Array of candidate strings
 * @param {number} minThreshold - Minimum similarity threshold (default 70)
 * @returns {object|null} { match: string, similarity: number, index: number } or null if no match
 */
const findBestMatch = (target, candidates, minThreshold = 70) => {
  if (!target || !candidates || candidates.length === 0) return null;

  let bestMatch = null;
  let highestSimilarity = 0;
  let bestIndex = -1;

  candidates.forEach((candidate, index) => {
    const similarity = calculateSimilarity(target, candidate);

    if (similarity > highestSimilarity && similarity >= minThreshold) {
      highestSimilarity = similarity;
      bestMatch = candidate;
      bestIndex = index;
    }
  });

  return bestMatch
    ? { match: bestMatch, similarity: highestSimilarity, index: bestIndex }
    : null;
};

/**
 * Extract account number patterns from text
 * Common Nigerian bank account patterns: 10 digits
 * 
 * @param {string} text - Text to search
 * @returns {string[]} Array of account numbers found
 */
const extractAccountNumbers = (text) => {
  if (!text) return [];

  // Match 10-digit Nigerian account numbers
  const matches = text.match(/\b\d{10}\b/g);
  
  return matches ? [...new Set(matches)] : []; // Remove duplicates
};

/**
 * Check if text contains transfer keywords
 * Used for transfer detection
 * 
 * @param {string} text - Text to check
 * @returns {boolean} True if transfer keywords found
 */
const containsTransferKeywords = (text) => {
  if (!text) return false;

  const keywords = [
    'transfer to',
    'transfer from',
    'sent to',
    'received from',
    'fund transfer',
    'tfr to',
    'tfr from',
    'trf to',
    'trf from',
    'p2p transfer',
    'bank transfer',
    'wallet transfer'
  ];

  const normalized = text.toLowerCase();
  return keywords.some(keyword => normalized.includes(keyword));
};

module.exports = {
  levenshteinDistance,
  calculateSimilarity,
  isSimilar,
  normalizeDescription,
  compareDescriptions,
  findBestMatch,
  extractAccountNumbers,
  containsTransferKeywords
};
