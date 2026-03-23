const Groq = require('groq-sdk');
const Category = require('../models/Category');

// Initialize Groq client
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const BATCH_SIZE = 20;

/**
 * AI Categorization Service
 * Uses Groq AI to automatically categorize transactions based on description and context
 */

async function categorizeTransaction(transaction, userId) {
  try {
    const { description, amount, type = 'expense' } = transaction;

    // Get user's categories
    const userCategories = await Category.find({
      userId,
      type,
      isActive: true
    }).select('name');

    // Fallback to default categories if user has none
    const categoryNames = userCategories.length > 0
      ? userCategories.map(c => c.name)
      : getDefaultCategoryNames(type);

    if (!groq || process.env.NODE_ENV === 'test') {
      return getFallbackCategory(description, type, userCategories);
    }

    // Build AI prompt
    const prompt = buildCategorizationPrompt(description, amount, type, categoryNames);

    // Call Groq AI
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a financial transaction categorization expert. You analyze transaction descriptions and assign them to the most appropriate category.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: GROQ_MODEL,
      temperature: 0.3, // Low temperature for consistent categorization
      max_tokens: 50
    });

    const response = completion.choices[0]?.message?.content?.trim();

    if (!response) {
      return getFallbackCategory(description, type, userCategories);
    }

    // Parse AI response
    const category = parseCategorizationResponse(response, userCategories, type);

    return category;

  } catch (error) {
    console.error('AI Categorization Error:', error);
    // Fallback to rule-based categorization
    return getFallbackCategory(transaction.description, transaction.type, await getUserCategories(userId, transaction.type));
  }
}

/**
 * Batch categorize multiple transactions
 * @param {Array} transactions - Array of transactions
 * @param {String} userId - User ID
 * @returns {Promise<Array>} Array of categorization results
 */
async function batchCategorizeTransactions(transactions, userId) {
  if (!transactions || transactions.length === 0) {
    return [];
  }

  // Get user's categories once
  const expenseCategories = await Category.find({
    userId,
    type: 'expense',
    isActive: true
  }).select('name');

  const incomeCategories = await Category.find({
    userId,
    type: 'income',
    isActive: true
  }).select('name');

  // Process in larger true-AI batches to reduce per-transaction latency
  const batchSize = BATCH_SIZE;
  const results = [];

  for (let i = 0; i < transactions.length; i += batchSize) {
    const batch = transactions.slice(i, i + batchSize);
    const fallbackResults = batch.map((transaction) => {
      const categories = transaction.type === 'expense' ? expenseCategories : incomeCategories;
      const fallback = getFallbackCategory(transaction.description, transaction.type, categories);

      return {
        transactionId: transaction._id || transaction.id,
        categoryId: fallback.categoryId,
        categoryName: fallback.categoryName,
        confidence: fallback.confidence,
        description: transaction.description
      };
    });

    if (!groq || process.env.NODE_ENV === 'test') {
      results.push(...fallbackResults);
      continue;
    }

    try {
      const serializedBatch = batch.map((transaction) => {
        const categories = transaction.type === 'expense' ? expenseCategories : incomeCategories;
        return {
          id: String(transaction._id || transaction.id),
          description: transaction.description,
          amount: transaction.amount,
          type: transaction.type,
          availableCategories:
            categories.length > 0 ? categories.map((category) => category.name) : getDefaultCategoryNames(transaction.type),
        };
      });

      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are a financial transaction categorization expert. Return ONLY valid JSON in the shape {"results":[{"id":"...", "category":"...", "confidence":"high|medium|low"}]}. Use only categories provided for each transaction. If unsure, pick the best available category and mark confidence as low.'
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: 'batch_categorize_transactions',
              transactions: serializedBatch,
            })
          }
        ],
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: Math.max(300, batch.length * 40)
      });

      const rawResponse = completion.choices[0]?.message?.content?.trim();
      const parsedResponse = parseBatchCategorizationResponse(rawResponse);
      const byId = new Map(parsedResponse.map((entry) => [String(entry.id), entry]));

      const batchResults = batch.map((transaction, index) => {
        const transactionId = String(transaction._id || transaction.id);
        const categories = transaction.type === 'expense' ? expenseCategories : incomeCategories;
        const parsed = byId.get(transactionId);

        if (!parsed?.category) {
          return fallbackResults[index];
        }

        const category = parseCategorizationResponse(parsed.category, categories, transaction.type);

        return {
          transactionId,
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          confidence: parsed.confidence || category.confidence,
          description: transaction.description
        };
      });

      results.push(...batchResults);
    } catch (error) {
      console.error('Batch categorization error:', error);
      results.push(...fallbackResults);
    }
  }

  return results;
}

function parseBatchCategorizationResponse(response) {
  if (!response) {
    return [];
  }

  try {
    const parsed = JSON.parse(response);
    return Array.isArray(parsed?.results) ? parsed.results : [];
  } catch {
    const match = String(response).match(/\{[\s\S]*\}/);
    if (!match) {
      return [];
    }

    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed?.results) ? parsed.results : [];
    } catch {
      return [];
    }
  }
}

/**
 * Build categorization prompt for AI
 * @param {String} description - Transaction description
 * @param {Number} amount - Transaction amount
 * @param {String} type - Transaction type
 * @param {Array} categoryNames - Available category names
 * @returns {String} AI prompt
 */
function buildCategorizationPrompt(description, amount, type, categoryNames) {
  return `Categorize this ${type} transaction:

Description: "${description}"
Amount: ₦${amount?.toLocaleString() || 0}

Available categories:
${categoryNames.join(', ')}

Based on the description, which category best fits this transaction?
Return ONLY the exact category name from the list above, nothing else.`;
}

/**
 * Parse AI categorization response
 * @param {String} response - AI response
 * @param {Array} userCategories - User's category objects
 * @param {String} type - Transaction type
 * @returns {Object} { categoryId, categoryName, confidence }
 */
function parseCategorizationResponse(response, userCategories, type) {
  if (!response) {
    return getFallbackCategory('', type, userCategories);
  }

  // Clean the response
  const cleanedResponse = response.trim().replace(/['"]/g, '');

  // Try to match with user's categories (case-insensitive)
  const matchedCategory = userCategories.find(
    cat => cat.name.toLowerCase() === cleanedResponse.toLowerCase()
  );

  if (matchedCategory) {
    return {
      categoryId: matchedCategory._id,
      categoryName: matchedCategory.name,
      confidence: 'high'
    };
  }

  // Try partial matching
  const partialMatch = userCategories.find(
    cat => cleanedResponse.toLowerCase().includes(cat.name.toLowerCase()) ||
           cat.name.toLowerCase().includes(cleanedResponse.toLowerCase())
  );

  if (partialMatch) {
    return {
      categoryId: partialMatch._id,
      categoryName: partialMatch.name,
      confidence: 'medium'
    };
  }

  // Fallback to default category
  return getFallbackCategory('', type, userCategories);
}

/**
 * Get fallback category using rule-based approach
 * @param {String} description - Transaction description
 * @param {String} type - Transaction type
 * @param {Array} userCategories - User's categories
 * @returns {Object} { categoryId, categoryName, confidence }
 */
function getFallbackCategory(description, type, userCategories) {
  const descLower = (description || '').toLowerCase();

  // Rule-based categorization for expenses
  const expenseRules = {
    'Food & Dining': ['restaurant', 'food', 'cafe', 'mcdonald', 'kfc', 'domino', 'pizza', 'chicken', 'lunch', 'dinner', 'breakfast', 'eatery', 'burger', 'shawarma'],
    'Transportation': ['uber', 'bolt', 'taxi', 'fuel', 'petrol', 'transport', 'parking', 'toll', 'bus', 'keke', 'okada', 'danfo'],
    'Shopping': ['mall', 'shoprite', 'jumia', 'konga', 'amazon', 'store', 'market', 'supermarket', 'shop'],
    'Utilities': ['electricity', 'water', 'nepa', 'phcn', 'dstv', 'gotv', 'internet', 'airtel', 'mtn', 'glo', '9mobile', 'data', 'airtime'],
    'Entertainment': ['cinema', 'movie', 'netflix', 'spotify', 'youtube', 'game', 'club', 'bar', 'concert'],
    'Healthcare': ['hospital', 'pharmacy', 'clinic', 'doctor', 'medical', 'drug', 'medicine'],
    'Education': ['school', 'university', 'tuition', 'course', 'book', 'fees'],
    'Rent': ['rent', 'lease', 'apartment', 'house'],
    'Personal Care': ['salon', 'barber', 'spa', 'gym', 'fitness']
  };

  // Rule-based categorization for income
  const incomeRules = {
    'Salary': ['salary', 'wages', 'payroll', 'payment received'],
    'Business': ['sales', 'revenue', 'business', 'customer payment'],
    'Freelance': ['freelance', 'gig', 'contract', 'consulting'],
    'Investments': ['dividend', 'interest', 'investment', 'returns']
  };

  const rules = type === 'expense' ? expenseRules : incomeRules;

  // Find matching rule
  let matchedCategory = null;
  for (const [categoryName, keywords] of Object.entries(rules)) {
    if (keywords.some(keyword => descLower.includes(keyword))) {
      matchedCategory = userCategories.find(cat => cat.name === categoryName);
      if (matchedCategory) {
        return {
          categoryId: matchedCategory._id,
          categoryName: matchedCategory.name,
          confidence: 'medium'
        };
      }
    }
  }

  // Default to 'Other' or first category
  const otherCategory = userCategories.find(cat => cat.name === 'Other' || cat.name === 'Other Income');
  if (otherCategory) {
    return {
      categoryId: otherCategory._id,
      categoryName: otherCategory.name,
      confidence: 'low'
    };
  }

  // Return first available category
  if (userCategories.length > 0) {
    return {
      categoryId: userCategories[0]._id,
      categoryName: userCategories[0].name,
      confidence: 'low'
    };
  }

  // No categories available
  return {
    categoryId: null,
    categoryName: type === 'expense' ? 'Other' : 'Other Income',
    confidence: 'low'
  };
}

/**
 * Get default category names
 * @param {String} type - Transaction type
 * @returns {Array} Array of category names
 */
function getDefaultCategoryNames(type) {
  if (type === 'expense') {
    return [
      'Food & Dining',
      'Transportation',
      'Rent',
      'Utilities',
      'Entertainment',
      'Shopping',
      'Healthcare',
      'Education',
      'Personal Care',
      'Savings',
      'Other'
    ];
  } else {
    return [
      'Salary',
      'Business',
      'Freelance',
      'Investments',
      'Other Income'
    ];
  }
}

/**
 * Get user categories
 * @param {String} userId - User ID
 * @param {String} type - Transaction type
 * @returns {Promise<Array>} User categories
 */
async function getUserCategories(userId, type) {
  return await Category.find({
    userId,
    type,
    isActive: true
  }).select('name');
}

/**
 * Improve categorization accuracy over time by learning from user corrections
 * @param {String} transactionId - Transaction ID
 * @param {String} originalCategory - AI-suggested category
 * @param {String} correctedCategory - User-corrected category
 * @param {String} description - Transaction description
 */
async function learnFromCorrection(transactionId, originalCategory, correctedCategory, description) {
  // This could be enhanced with a learning database in the future
  // For now, just log the correction for analysis
  console.log('Category correction logged:', {
    transactionId,
    originalCategory,
    correctedCategory,
    description,
    timestamp: new Date()
  });

  // Future enhancement: Store corrections in a learning database
  // and use them to improve future categorizations
}

/**
 * Get categorization statistics
 * @param {String} userId - User ID
 * @returns {Promise<Object>} Categorization statistics
 */
async function getCategorizationStats(userId) {
  // This would track AI categorization accuracy over time
  // For now, return basic structure
  return {
    totalCategorized: 0,
    accuracyRate: 0,
    correctionCount: 0,
    topCategories: []
  };
}

module.exports = {
  categorizeTransaction,
  batchCategorizeTransactions,
  learnFromCorrection,
  getCategorizationStats,
  getFallbackCategory
};
