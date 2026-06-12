const Category = require('../models/Category');
const { completeJson } = require('./llm/azureOpenAI.service');
const { buildCategorizationPrompts } = require('./prompts/financePrompts');
const { normalizeDescription } = require('../utils/stringMatch');

const DEFAULT_UNCATEGORIZED = {
  expense: { name: 'Uncategorized Expense', color: '#95A5A6', icon: 'folder' },
  income: { name: 'Uncategorized Income', color: '#95A5A6', icon: 'folder' },
};

const KEYWORD_GROUPS = {
  expense: [
    { keywords: ['food', 'restaurant', 'cafeteria', 'cafe', 'foodco', 'eatery', 'kitchen', 'chicken', 'meal'], names: ['food', 'dining'] },
    { keywords: ['mtn', 'airtime', 'mobiledata', 'datamtn', 'data', 'internet', 'subscription'], names: ['bill', 'utilit'] },
    { keywords: ['hospital', 'pharmacy', 'clinic', 'drug', 'health', 'medical'], names: ['health'] },
    { keywords: ['salon', 'barber', 'spa', 'skincare', 'beauty', 'cosmetics'], names: ['personal care', 'beauty'] },
    { keywords: ['rent', 'landlord', 'house', 'apartment', 'accommodation'], names: ['rent', 'housing'] },
    { keywords: ['savings', 'save', 'vault', 'investment', 'fixed deposit'], names: ['savings', 'invest'] },
    { keywords: ['uber', 'bolt', 'fuel', 'petrol', 'transport', 'bus', 'ride', 'taxi'], names: ['transport'] },
    { keywords: ['market', 'store', 'mall', 'shop', 'footwear', 'clothes', 'fashion'], names: ['shop'] },
    { keywords: ['charge', 'fee', 'stamp duty', 'maintenance fee'], names: ['charge', 'fee', 'bank'] },
  ],
  income: [
    { keywords: ['salary', 'payroll', 'wages'], names: ['salary', 'income'] },
    { keywords: ['interest'], names: ['interest', 'income'] },
    { keywords: ['business'], names: ['business'] },
    { keywords: ['freelance'], names: ['freelance'] },
  ],
};

const buildCategoryCacheKey = (type, name) => `${type}:${name.toLowerCase()}`;

const getOrCreateUncategorizedCategory = async (userId, type, cache = new Map()) => {
  const config = DEFAULT_UNCATEGORIZED[type];
  const cacheKey = buildCategoryCacheKey(type, config.name);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  let category = await Category.findOne({
    userId,
    type,
    name: config.name,
    isActive: true,
  });

  if (!category) {
    try {
      category = await Category.create({
        userId,
        type,
        name: config.name,
        icon: config.icon,
        color: config.color,
        source: 'system',
        isActive: true,
      });
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
      category = await Category.findOne({
        userId,
        type,
        name: config.name,
        isActive: true,
      });
    }
  }

  cache.set(cacheKey, category);
  return category;
};

const findKeywordCategory = (categories, type, text) => {
  const normalizedText = normalizeDescription(text);
  const groups = KEYWORD_GROUPS[type] || [];

  for (const group of groups) {
    if (!group.keywords.some((keyword) => normalizedText.includes(keyword))) {
      continue;
    }

    const match = categories.find((category) =>
      group.names.some((name) => normalizeDescription(category.name).includes(name)),
    );

    if (match) {
      return match;
    }
  }

  return null;
};

const suggestCategoryForRow = async ({ userId, classification, description, transactionType }, cache = new Map()) => {
  if (!['income', 'expense'].includes(classification)) {
    return {
      categoryId: null,
      suggestedCategoryName: null,
      confidence: 0.2,
      usedFallback: false,
    };
  }

  const categories = await Category.find({
    userId,
    type: classification,
    isActive: true,
  }).select('_id name icon color type');

  const combinedText = `${description || ''} ${transactionType || ''}`.trim();

  const keywordCategory = findKeywordCategory(categories, classification, combinedText);
  if (keywordCategory) {
    return {
      categoryId: keywordCategory._id,
      suggestedCategoryName: keywordCategory.name,
      confidence: 0.92,
      usedFallback: false,
    };
  }

  const exactNameMatch = categories.find((category) =>
    normalizeDescription(combinedText).includes(normalizeDescription(category.name)),
  );
  if (exactNameMatch) {
    return {
      categoryId: exactNameMatch._id,
      suggestedCategoryName: exactNameMatch.name,
      confidence: 0.75,
      usedFallback: false,
    };
  }

  const uncategorized = await getOrCreateUncategorizedCategory(userId, classification, cache);
  return {
    categoryId: uncategorized._id,
    suggestedCategoryName: uncategorized.name,
    confidence: 0.3,
    usedFallback: true,
  };
};

const mapConfidenceLabel = (value) => {
  const normalized = normalizeDescription(value || '');
  if (normalized === 'high') return 0.92;
  if (normalized === 'medium') return 0.72;
  if (normalized === 'low') return 0.45;
  return 0.35;
};

const matchCategoryByName = (categories, requestedName) => {
  const normalizedRequested = normalizeDescription(requestedName || '');
  if (!normalizedRequested) {
    return null;
  }

  return categories.find((category) => normalizeDescription(category.name) === normalizedRequested)
    || categories.find(
      (category) =>
        normalizeDescription(category.name).includes(normalizedRequested)
        || normalizedRequested.includes(normalizeDescription(category.name)),
    )
    || null;
};

const suggestCategoryForRowWithAI = async (
  {
    userId,
    classification,
    description,
    transactionType,
    amount = 0,
  },
  cache = new Map(),
) => {
  if (!['income', 'expense'].includes(classification)) {
    return suggestCategoryForRow({ userId, classification, description, transactionType }, cache);
  }

  const categories = await Category.find({
    userId,
    type: classification,
    isActive: true,
  }).select('_id name icon color type');

  if (!categories.length || process.env.NODE_ENV === 'test') {
    return suggestCategoryForRow({ userId, classification, description, transactionType }, cache);
  }

  try {
    const promptConfig = buildCategorizationPrompts({
      description: `${description || ''} ${transactionType || ''}`.trim(),
      amount,
      type: classification,
      categoryNames: categories.map((category) => category.name),
    });

    const completion = await completeJson({
      feature: 'statement-row-category-suggestion',
      ...promptConfig,
      maxTokens: 160,
      temperature: 0.1,
    });

    const matchedCategory = matchCategoryByName(categories, completion?.json?.category);
    if (!matchedCategory) {
      return suggestCategoryForRow({ userId, classification, description, transactionType }, cache);
    }

    return {
      categoryId: matchedCategory._id,
      suggestedCategoryName: matchedCategory.name,
      confidence: mapConfidenceLabel(completion?.json?.confidence),
      usedFallback: false,
    };
  } catch (_error) {
    return suggestCategoryForRow({ userId, classification, description, transactionType }, cache);
  }
};

module.exports = {
  getOrCreateUncategorizedCategory,
  suggestCategoryForRow,
  suggestCategoryForRowWithAI,
};
