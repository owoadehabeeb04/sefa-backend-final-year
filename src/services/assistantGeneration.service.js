const { buildDashboardForPeriod } = require('./insights/financialDashboard.service');
const { listNormalizedTransactions, createDateRange } = require('./insights/insightHelpers');
const { completeText, streamText } = require('./llm/azureOpenAI.service');
const { buildAssistantSystemPrompt, buildAssistantTitlePrompts } = require('./prompts/financePrompts');
const { resolveAssistantLiveWebContext } = require('./retrieval/liveWebSearch.service');

const truncate = (value, max = 280) => {
  const safe = String(value || '').trim();
  if (safe.length <= max) return safe;
  return `${safe.slice(0, max - 1).trimEnd()}…`;
};

const formatCurrency = (value) => `₦${Number(value || 0).toLocaleString('en-NG')}`;

const summarizeTransactions = (transactions = []) =>
  transactions.slice(0, 10).map((transaction) => ({
    kind: transaction.kind,
    amount: Number(transaction.amount || 0),
    categoryName: transaction.categoryName,
    description: truncate(transaction.description || transaction.sourceLabel || '', 80),
    date: new Date(transaction.date).toISOString().slice(0, 10),
  }));

const buildFinanceSummary = ({ dashboard, recentTransactions }) => {
  const summaryLines = [
    `Period: ${dashboard.periodLabel}`,
    `Income: ${formatCurrency(dashboard.totalIncome)}`,
    `Expenses: ${formatCurrency(dashboard.totalExpenses)}`,
    `Balance: ${formatCurrency(dashboard.balance)}`,
    `Spending rate: ${Math.round(Number(dashboard.spendingRate || 0) * 100)}% of income`,
    `Overall budget used: ${Math.round(Number(dashboard.budgetUsage || 0))}%`,
    `Estimated savings opportunity: ${formatCurrency(dashboard.savingsPotential)}`,
  ];

  const topCategories = (dashboard.categoryBreakdown || [])
    .slice(0, 4)
    .map((entry) => `${entry.categoryName}: ${formatCurrency(entry.amount)}`);

  if (topCategories.length) {
    summaryLines.push(`Top spending categories: ${topCategories.join(', ')}`);
  }

  const spendingDrivers = dashboard.spendingDrivers || {};
  const drivers = [
    spendingDrivers.topSpendingCategory?.categoryName,
    spendingDrivers.fastestGrowingCategory?.categoryName || spendingDrivers.mostFrequentCategory?.categoryName,
  ].filter(Boolean).slice(0, 2);
  if (drivers.length) {
    summaryLines.push(`Main spending drivers: ${drivers.join(' | ')}`);
  }

  if (recentTransactions.length) {
    summaryLines.push(
      `Recent transactions: ${recentTransactions
        .map((entry) => `${entry.date} ${entry.kind} ${formatCurrency(entry.amount)} ${entry.categoryName || ''} ${entry.description}`.trim())
        .join(' | ')}`,
    );
  }

  return summaryLines.join('\n');
};

const buildConversationMessages = ({ systemPrompt, history }) => {
  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ];

  history.forEach((message) => {
    if (!['user', 'assistant'].includes(message.role)) {
      return;
    }

    messages.push({
      role: message.role,
      content: String(message.content || ''),
    });
  });

  return messages;
};

const summarizePriceRange = (priceRangeSummary = null) => {
  if (!priceRangeSummary?.sourceCount) {
    return 'No verified price range was found.';
  }

  return [
    `Observed price range: ${formatCurrency(priceRangeSummary.low)} to ${formatCurrency(priceRangeSummary.high)}`,
    `Median observed price: ${formatCurrency(priceRangeSummary.median)}`,
    `Priced sources counted: ${priceRangeSummary.sourceCount}`,
  ].join('\n');
};

const buildAssistantLiveWebContext = ({ question, retrieval }) => {
  if (!retrieval || retrieval.mode === 'none') {
    return 'No live web lookup was used for this question.';
  }

  if (retrieval.status !== 'used') {
    return [
      `The latest user question may require live web verification: "${truncate(question, 180)}"`,
      `Live web lookup mode: ${retrieval.mode}`,
      `Status: unavailable`,
      `Reason: ${retrieval.reason || 'No live results were available.'}`,
      'If the user asked for current prices or current facts, say you could not verify online results right now and do not invent exact figures.',
    ].join('\n');
  }

  const sourceLines = (retrieval.sources || [])
    .slice(0, 5)
    .map((source, index) => {
      const pricePart = source.priceText ? ` | Price: ${source.priceText}` : '';
      const snippetPart = source.snippet ? ` | Note: ${source.snippet}` : '';
      return `${index + 1}. ${source.sourceName}: ${source.title}${pricePart}${snippetPart} | URL: ${source.url}`;
    });

  const lines = [
    `The latest user question may require live web verification: "${truncate(question, 180)}"`,
    `Live web lookup mode: ${retrieval.mode}`,
    `Status: used`,
    `Search market: ${retrieval.market || 'NG'}`,
    `Search query used: ${retrieval.query || truncate(question, 120)}`,
  ];

  if (retrieval.mode === 'shopping' && retrieval.priceRangeSummary) {
    lines.push(summarizePriceRange(retrieval.priceRangeSummary));
  }

  lines.push('Verified live web sources:');
  lines.push(...sourceLines);
  lines.push('Use only these live web details for external claims. If results vary, say so plainly.');

  return lines.join('\n');
};

const buildFallbackAnswer = ({ dashboard, question }) => {
  const answerParts = [
    `For ${dashboard.periodLabel}, you received ${formatCurrency(dashboard.totalIncome)} and spent ${formatCurrency(dashboard.totalExpenses)}.`,
    `Your balance for the period is ${formatCurrency(dashboard.balance)}.`,
  ];

  if (/save|cut|reduce|budget/i.test(question)) {
    const opportunity = dashboard.savingsOpportunities?.[0];
    answerParts.push(opportunity?.action || opportunity?.title || 'Start with your largest spending category.');
  }

  return answerParts.filter(Boolean).join(' ');
};

const toTitleCase = (value = '') => value
  .split(' ')
  .filter(Boolean)
  .map((word, index) => {
    if (index > 0 && ['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with'].includes(word)) {
      return word;
    }
    return word.charAt(0).toUpperCase() + word.slice(1);
  })
  .join(' ');

const generateAssistantTitle = (content = '') => {
  const cleaned = String(content || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\W_]+|[\W_]+$/g, '')
    .trim();

  if (!cleaned) {
    return 'New chat';
  }

  const normalized = cleaned
    .replace(/^(please|hi|hello|hey|can you|could you|help me|i want to know|i want to|is it possible to)\s+/i, '')
    .replace(/[?.!]+$/g, '')
    .trim();

  const words = (normalized || cleaned).split(/\s+/).slice(0, 8).map((word) => word.toLowerCase());
  const title = toTitleCase(words.join(' ')).trim();
  return title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title;
};

const normalizeAssistantTitle = (value = '', fallback = 'New chat') => {
  const cleaned = String(value || '')
    .replace(/["“”]+/g, '')
    .replace(/^[\s:;,.!?-]+|[\s:;,.!?-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return fallback;
  }

  const words = cleaned.split(/\s+/).slice(0, 8);
  const normalized = toTitleCase(words.join(' ')).trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.length > 60 ? `${normalized.slice(0, 57).trimEnd()}…` : normalized;
};

const buildConversationTitleTranscript = (messages = []) => {
  return messages
    .filter((message) => message.role === 'user' && String(message.content || '').trim())
    .slice(0, 4)
    .map((message, index) => {
      return `${index + 1}. User: ${truncate(message.content, 180)}`;
    })
    .join('\n');
};

const generateAssistantConversationTitle = async ({ messages = [] }) => {
  const visibleMessages = messages.filter((message) => ['user', 'assistant'].includes(message.role));
  const userMessages = visibleMessages.filter((message) => message.role === 'user');
  const firstUserMessage = userMessages[0]?.content || '';
  const conversationTranscript = buildConversationTitleTranscript(userMessages);
  const userIntentSummary = userMessages
    .slice(0, 3)
    .map((message) => truncate(message.content, 120))
    .join(' | ');
  const fallback = generateAssistantTitle(firstUserMessage);

  if (process.env.NODE_ENV === 'test') {
    return fallback;
  }

  try {
    const promptConfig = buildAssistantTitlePrompts({
      conversationTranscript,
      firstUserMessage,
      userIntentSummary,
    });
    const completion = await completeText({
      feature: 'assistant-chat-title',
      ...promptConfig,
      maxTokens: 32,
    });

    return normalizeAssistantTitle(completion?.text, fallback);
  } catch (_error) {
    return fallback;
  }
};

const CONTEXT_CACHE_TTL_MS = 15_000;
const contextCache = new Map();

const buildAssistantContext = async (userId) => {
  if (process.env.NODE_ENV === 'test') {
    return {
      dashboard: {
        periodLabel: 'this month',
        totalIncome: 0,
        totalExpenses: 0,
        balance: 0,
        spendingRate: 0,
        budgetUsage: 0,
        savingsPotential: 0,
        categoryBreakdown: [],
        spendingDrivers: [],
        savingsOpportunities: [],
      },
      recentTransactions: [],
    };
  }

  const cacheKey = String(userId);
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const range = createDateRange({ days: 30 });
  const [dashboard, transactions] = await Promise.all([
    buildDashboardForPeriod(userId),
    listNormalizedTransactions(userId, {
      startDate: range.startDate,
      endDate: range.endDate,
      includeTransfers: false,
    }),
  ]);

  const value = {
    dashboard,
    recentTransactions: summarizeTransactions(transactions),
  };
  contextCache.set(cacheKey, { value, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
  return value;
};

const streamAssistantCompletion = async ({ userId, chatTitle, history, onChunk, onActivity }) => {
  await onActivity?.('checking_db', 'Checking your SEFA records...');
  const context = await buildAssistantContext(userId);
  const financeSummary = buildFinanceSummary(context);
  const latestQuestion = history[history.length - 1]?.content || '';
  await onActivity?.('searching_current_info', 'Checking if current information is needed...');
  const retrieval = await resolveAssistantLiveWebContext(latestQuestion);
  if (retrieval?.mode !== 'none') {
    await onActivity?.(
      retrieval.status === 'used' ? 'searching_web' : 'searching_web_unavailable',
      retrieval.status === 'used'
        ? 'Searching current information...'
        : 'Current information search is unavailable...',
    );
  }
  const liveWebContext = buildAssistantLiveWebContext({
    question: latestQuestion,
    retrieval,
  });
  const systemPrompt = buildAssistantSystemPrompt({ financeSummary, chatTitle, liveWebContext });
  const messages = buildConversationMessages({ systemPrompt, history });
  await onActivity?.('preparing_answer', 'Preparing your answer...');

  if (process.env.NODE_ENV === 'test') {
    const fallback = buildFallbackAnswer({ dashboard: context.dashboard, question: latestQuestion });
    if (onChunk && fallback) {
      await onChunk({
        delta: fallback,
        fullText: fallback,
        isFinal: true,
      });
    }
    return {
      text: fallback,
      sources: retrieval.sources || [],
      retrieval,
    };
  }

  const result = await streamText({
    feature: 'assistant-chat',
    messages,
    temperature: 0.35,
    maxTokens: 900,
    topP: 1,
    onDelta: async (payload) => {
      if (onChunk) {
        await onChunk(payload);
      }
    },
  });

  return {
    text: result?.text?.trim() || '',
    sources: retrieval.sources || [],
    retrieval,
  };
};

module.exports = {
  buildAssistantContext,
  generateAssistantConversationTitle,
  generateAssistantTitle,
  streamAssistantCompletion,
};
