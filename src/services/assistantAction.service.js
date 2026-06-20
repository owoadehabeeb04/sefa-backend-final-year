const { tool } = require('@langchain/core/tools');
const { Annotation, END, START, StateGraph } = require('@langchain/langgraph');
const { z } = require('zod');
const AssistantAction = require('../models/AssistantAction');
const AssistantMessage = require('../models/AssistantMessage');
const { completeJson, isConfigured: isAzureConfigured } = require('./llm/azureOpenAI.service');
const financeTools = require('./assistantFinanceTools.service');

const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

const ACTION_LABELS = {
  create_expense: 'expense',
  create_income: 'income',
  create_category: 'category',
};

const WRITE_ACTIONS = new Set(['create_expense', 'create_income', 'create_category']);
const READ_ACTIONS = new Set([
  'query_financial_summary',
  'query_category_spending',
  'analyze_spending',
  'explain_budget_position',
]);
const EXECUTABLE_ACTIONS = new Set([...WRITE_ACTIONS, ...READ_ACTIONS]);

const assistantToolDefinitions = [
  tool(async () => 'prepared', {
    name: 'create_expense',
    description: 'Prepare an expense transaction for user confirmation. Does not write until confirmed.',
    schema: z.object({
      amount: z.number().positive().optional(),
      categoryName: z.string().min(1).optional(),
      date: z.string().optional(),
      description: z.string().optional(),
    }),
  }),
  tool(async () => 'prepared', {
    name: 'create_income',
    description: 'Prepare an income transaction for user confirmation. Does not write until confirmed.',
    schema: z.object({
      amount: z.number().positive().optional(),
      source: z.string().min(1).optional(),
      categoryName: z.string().min(1).optional(),
      date: z.string().optional(),
      description: z.string().optional(),
    }),
  }),
  tool(async () => 'prepared', {
    name: 'create_category',
    description: 'Prepare a new income or expense category for user confirmation.',
    schema: z.object({
      name: z.string().min(1).optional(),
      type: z.enum(['income', 'expense']).optional(),
    }),
  }),
  tool(async () => 'queried', {
    name: 'query_financial_summary',
    description: 'Read totals for income, expenses, and net position over a period.',
    schema: z.object({
      period: z.enum(['today', 'week', 'month', 'year']).optional(),
    }),
  }),
  tool(async () => 'queried', {
    name: 'query_category_spending',
    description: 'Read spending total for one expense category over a period.',
    schema: z.object({
      categoryName: z.string().min(1).optional(),
      period: z.enum(['today', 'week', 'month', 'year']).optional(),
    }),
  }),
  tool(async () => 'queried', {
    name: 'analyze_spending',
    description: 'Find the biggest spending drivers over a period.',
    schema: z.object({
      period: z.enum(['today', 'week', 'month', 'year']).optional(),
    }),
  }),
  tool(async () => 'queried', {
    name: 'explain_budget_position',
    description: 'Explain whether the user is within budget for a period.',
    schema: z.object({
      period: z.enum(['today', 'week', 'month', 'year']).optional(),
    }),
  }),
];

const normalizeText = (value = '') => String(value || '').trim().replace(/\s+/g, ' ');
const formatCurrency = financeTools.formatCurrency;

const readPositiveInt = (value, fallback) => {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizePeriod = (period = 'month') => (
  ['today', 'week', 'month', 'year'].includes(period) ? period : 'month'
);

const normalizeDate = (value) => {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  const now = new Date();
  if (text === 'today') return now.toISOString();
  if (text === 'yesterday') {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    return date.toISOString();
  }
  if (text === 'tomorrow') {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    return date.toISOString();
  }
  const monthDayMatch = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+([0-3]?\d)\b/i);
  if (monthDayMatch) {
    const parsed = new Date(`${monthDayMatch[1]} ${monthDayMatch[2]}, ${now.getFullYear()}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const dateLabelFor = (value) => {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  if (['today', 'yesterday', 'tomorrow'].includes(text)) return text;
  const monthDayMatch = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+([0-3]?\d)\b/i);
  if (monthDayMatch) return `${monthDayMatch[1]} ${monthDayMatch[2]}`;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
};

const cleanString = (value) => {
  const text = normalizeText(value);
  return text || null;
};

const summarizePlannerHistory = (history = [], latestText = '') => {
  const latest = String(latestText || '');
  return (Array.isArray(history) ? history : [])
    .filter((message) => ['user', 'assistant'].includes(message.role))
    .filter((message) => String(message.content || '').trim())
    .filter((message) => String(message.content || '') !== latest)
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${String(message.content || '').slice(0, 900)}`)
    .join('\n');
};

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
};

const extractAmountFromText = (text = '') => {
  const match = String(text || '').match(/(?:₦|ngn|n)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  return match ? toNumber(match[1]) : null;
};

const extractDateFromText = (text = '') => {
  const lower = String(text || '').toLowerCase();
  if (/\byesterday\b/.test(lower)) return 'yesterday';
  if (/\btomorrow\b/.test(lower)) return 'tomorrow';
  const isoMatch = lower.match(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/);
  if (isoMatch) return isoMatch[1];
  const monthDayMatch = lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+([0-3]?\d)\b/i);
  if (monthDayMatch) return `${monthDayMatch[1]} ${monthDayMatch[2]}`;
  if (/\btoday\b|\byes\b|\byeah\b|\byep\b|\bsure\b|\bokay\b|\bok\b/.test(lower)) return 'today';
  return null;
};

const extractLooseName = (text = '') => {
  const cleaned = normalizeText(text)
    .replace(/\b(if it does(?:n't| not) exist|if it doesn't exist|you can create|create it|please|thanks|thank you)\b/gi, ' ')
    .replace(/\b(as|called|named|category|source|for|it|is|should be)\b/gi, ' ')
    .replace(/[.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
};

const extractPendingArguments = (action, text = '') => {
  const missing = new Set(action.missingFields || []);
  const args = {};
  const amount = missing.has('amount') ? extractAmountFromText(text) : null;
  const date = extractDateFromText(text);
  const looseName = extractLooseName(text);

  if (missing.has('amount') && amount) args.amount = amount;
  if (missing.has('date') && date) args.date = date;
  if (missing.has('source') && looseName) {
    args.source = looseName;
    args.categoryName = looseName;
    args.description = looseName;
  }
  if (missing.has('categoryName') && looseName) {
    args.categoryName = looseName;
    args.description = looseName;
  }
  if (missing.has('name') && looseName) args.name = looseName;
  if (missing.has('type')) {
    if (/\bincome\b/i.test(text)) args.type = 'income';
    if (/\bexpense\b/i.test(text)) args.type = 'expense';
  }

  return args;
};

const getRequiredFields = (toolName) => {
  if (toolName === 'create_expense') return ['amount', 'categoryName', 'date'];
  if (toolName === 'create_income') return ['amount', 'source', 'date'];
  if (toolName === 'create_category') return ['name', 'type'];
  if (toolName === 'query_category_spending') return ['categoryName'];
  return [];
};

const normalizeToolArguments = (toolName, args = {}) => {
  const normalized = { ...(args || {}) };

  if (toolName === 'create_expense') {
    normalized.amount = toNumber(normalized.amount);
    normalized.categoryName = cleanString(normalized.categoryName || normalized.category);
    normalized.description = cleanString(normalized.description) || normalized.categoryName || null;
    normalized.dateLabel = dateLabelFor(normalized.date);
    normalized.date = normalizeDate(normalized.date);
  }

  if (toolName === 'create_income') {
    normalized.amount = toNumber(normalized.amount);
    normalized.source = cleanString(normalized.source || normalized.categoryName || normalized.category);
    normalized.categoryName = cleanString(normalized.categoryName) || normalized.source || null;
    normalized.description = cleanString(normalized.description) || normalized.source || null;
    normalized.dateLabel = dateLabelFor(normalized.date);
    normalized.date = normalizeDate(normalized.date);
  }

  if (toolName === 'create_category') {
    normalized.name = cleanString(normalized.name || normalized.categoryName);
    normalized.type = ['income', 'expense'].includes(normalized.type) ? normalized.type : null;
  }

  if (READ_ACTIONS.has(toolName)) {
    normalized.period = normalizePeriod(normalized.period);
    if (toolName === 'query_category_spending') {
      normalized.categoryName = cleanString(normalized.categoryName || normalized.category);
    }
  }

  Object.keys(normalized).forEach((key) => {
    if (normalized[key] === null || normalized[key] === undefined || normalized[key] === '') {
      delete normalized[key];
    }
  });

  return normalized;
};

const getMissingFields = (toolName, payload = {}) =>
  getRequiredFields(toolName).filter((field) => !payload[field]);

const buildMissingQuestion = (intent, missingFields, payload = {}) => {
  const first = missingFields[0];
  if (intent === 'create_expense') {
    if (first === 'amount') return `Sure, how much did you spend${payload.categoryName ? ` on ${payload.categoryName}` : ''}?`;
    if (first === 'categoryName') return 'What category or description should I use for this expense?';
    if (first === 'date') return `Should I record this expense for today?`;
  }
  if (intent === 'create_income') {
    if (first === 'amount') return `Nice. How much did you receive${payload.source ? ` from ${payload.source}` : ''}?`;
    if (first === 'source') return 'What should I use as the income source or category?';
    if (first === 'date') return `Should I record this income for today?`;
  }
  if (intent === 'create_category') {
    if (first === 'name') return `Sure, what should I call the ${payload.type || ''} category?`.replace(/\s+/g, ' ').trim();
    if (first === 'type') return 'Should this be an income category or an expense category?';
  }
  if (intent === 'query_category_spending') {
    return 'Which expense category should I check?';
  }
  return 'I need one more detail before I can prepare that.';
};

const buildConfirmationMessage = (actionType, payload) => {
  if (actionType === 'create_expense') {
    return `I can add ${formatCurrency(payload.amount)} as a ${payload.categoryName} expense for ${payload.dateLabel || 'today'}. Is that okay?`;
  }
  if (actionType === 'create_income') {
    return `I can add ${formatCurrency(payload.amount)} as ${payload.source || payload.categoryName} income for ${payload.dateLabel || 'today'}. Is that okay?`;
  }
  return `I can create an ${payload.type} category called "${payload.name}". Is that okay?`;
};

const buildActionSummary = (action) => ({
  actionId: action._id,
  actionType: action.actionType,
  status: action.status,
  confirmationMessage: action.confirmationMessage,
  payload: action.extractedPayload || {},
  missingFields: action.missingFields || [],
});

const attachActionToMessage = async (assistantMessageId, action) => {
  await AssistantMessage.findByIdAndUpdate(assistantMessageId, {
    $set: {
      actions: [buildActionSummary(action)],
    },
  });
};

const findPendingFieldsAction = async (userId, chatId) => {
  return AssistantAction.findOne({
    userId,
    chatId,
    status: 'pending_fields',
    expiresAt: { $gt: new Date() },
  }).sort({ updatedAt: -1, createdAt: -1 });
};

const findPendingConfirmationAction = async (userId, chatId) => {
  return AssistantAction.findOne({
    userId,
    chatId,
    status: 'pending_confirmation',
    expiresAt: { $gt: new Date() },
  }).sort({ updatedAt: -1, createdAt: -1 });
};

const isTextConfirmation = (text = '') =>
  /\b(yes|yeah|yep|sure|ok|okay|confirm|confirmed|go ahead|record it|add it|save it|do it)\b/i.test(text);

const isTextCancellation = (text = '') =>
  /\b(no|nope|cancel|stop|don't|do not|never mind|nevermind)\b/i.test(text);

const buildPlannerSystemPrompt = () => {
  const toolsText = assistantToolDefinitions.map((entry) => `- ${entry.name}: ${entry.description}`).join('\n');
  return `You are SEFA's fast financial assistant planner. Decide whether the user's latest message is a financial task that should use one of the available tools.

Available tools:
${toolsText}

Return only JSON with this shape:
{
  "isTask": boolean,
  "toolName": "create_expense" | "create_income" | "create_category" | "query_financial_summary" | "query_category_spending" | "analyze_spending" | "explain_budget_position" | null,
  "arguments": object,
  "confidence": number,
  "reason": string
}

Rules:
- Use create_income only for recording money received. Use create_category when the user asks to create a category.
- If the user says "income category", that means create_category with type "income", not create_income.
- If the user says "expense category", that means create_category with type "expense", not create_expense.
- If the latest message is a short approval or follow-up like "record it", "you can add it", "go ahead", or "yes", use the recent conversation to infer the intended tool and arguments.
- SEFA can prepare expense, income, and category writes. Never answer that SEFA cannot write records; instead prepare the tool action for confirmation.
- Writes are not final until the user confirms. Your job is to prepare the correct tool arguments, not to claim execution.
- Extract only fields the user gave or clearly implied. Do not invent category names.
- For transaction dates, use "today", "yesterday", "tomorrow", or an ISO date if the user gave one. If not provided, omit date.
- For casual chat, budgeting advice without a direct data/action request, or unclear messages, set isTask false.
- Prefer one tool only. Missing fields are okay; backend will ask follow-up questions.`;
};

const buildPlannerMessages = ({ text, pendingAction = null, history = [] }) => {
  const context = pendingAction
    ? `There is a pending ${pendingAction.actionType} action with missing fields: ${(pendingAction.missingFields || []).join(', ')}. Existing arguments: ${JSON.stringify(pendingAction.extractedPayload || {})}. Interpret the user message as a follow-up for this pending action unless they clearly changed topic.`
    : 'There is no pending action.';
  const historyText = summarizePlannerHistory(history, text) || 'No previous conversation context.';

  return [
    { role: 'system', content: buildPlannerSystemPrompt() },
    {
      role: 'user',
      content: `${context}\n\nRecent conversation:\n${historyText}\n\nLatest user message: ${text}`,
    },
  ];
};

const fallbackPlanner = ({ text, pendingAction = null, history = [] }) => {
  const lower = String(text || '').toLowerCase();
  const historyText = summarizePlannerHistory(history, text);
  if (pendingAction) {
    return {
      isTask: true,
      toolName: pendingAction.actionType,
      arguments: extractPendingArguments(pendingAction, text),
      confidence: 0.5,
      reason: 'Fallback pending action planner used because Azure planning is unavailable.',
    };
  }

  if (/\b(category|categories)\b/.test(lower) && /\b(create|add|make)\b/.test(lower)) {
    return {
      isTask: true,
      toolName: 'create_category',
      arguments: {
        type: /\bincome\b/.test(lower) ? 'income' : /\bexpense\b/.test(lower) ? 'expense' : undefined,
      },
      confidence: 0.5,
      reason: 'Fallback category planner used because Azure planning is unavailable.',
    };
  }

  if (/\b(record it|add it|go ahead|you can record|you can add|yes|okay|ok)\b/.test(lower) && historyText) {
    const context = historyText.toLowerCase();
    const amountMatch = historyText.match(/(?:₦|ngn|n)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
    if (/\bincome\b|\bsalary\b|\bpayment\b|\breceived\b/.test(context) && amountMatch) {
      const sourceMatch = historyText.match(/\b(?:category|source|as)\s*[:\-]?\s*([a-z][a-z\s-]{1,40})/i);
      return {
        isTask: true,
        toolName: 'create_income',
        arguments: {
          amount: Number(amountMatch[1].replace(/,/g, '')),
          source: sourceMatch?.[1] || undefined,
          date: /\btoday\b/i.test(historyText) ? 'today' : undefined,
        },
        confidence: 0.45,
        reason: 'Fallback follow-up planner inferred income from recent context.',
      };
    }
  }

  return {
    isTask: false,
    toolName: null,
    arguments: {},
    confidence: 0,
    reason: 'Fallback planner only handles pending actions and category creation.',
  };
};

const callPlannerModel = async ({ text, pendingAction = null, history = [] }) => {
  if (!isAzureConfigured() || process.env.NODE_ENV === 'test') {
    return fallbackPlanner({ text, pendingAction, history });
  }

  let result = null;
  try {
    result = await completeJson({
      feature: 'assistant-action-planner',
      messages: buildPlannerMessages({ text, pendingAction, history }),
      maxTokens: process.env.ASSISTANT_PLANNER_MAX_TOKENS || 260,
      temperature: 0,
      timeoutMs: readPositiveInt(process.env.ASSISTANT_PLANNER_TIMEOUT_MS, 7000),
      maxRetries: 0,
    });
  } catch (error) {
    console.warn('Assistant action planner skipped:', error.message);
    return {
      isTask: false,
      toolName: null,
      arguments: {},
      confidence: 0,
      reason: 'Planner request failed; falling back to normal assistant response.',
    };
  }

  const json = result?.json || {};
  const toolName = EXECUTABLE_ACTIONS.has(json.toolName) ? json.toolName : null;
  return {
    isTask: Boolean(json.isTask && toolName),
    toolName,
    arguments: json.arguments && typeof json.arguments === 'object' ? json.arguments : {},
    confidence: Number.isFinite(Number(json.confidence)) ? Number(json.confidence) : 0,
    reason: cleanString(json.reason) || '',
  };
};

const looksLikeWriteAction = (text = '') => {
  const normalized = String(text || '').toLowerCase();
  return /\b(add|record|log|create|track|enter)\b.{0,80}\b(expense|income|transaction|category|salary|payment)\b/.test(normalized)
    || /\b(add|record|log|enter)\b.{0,80}\d/.test(normalized)
    || /\b(i\s+)?(spent|paid|received|earned|got paid)\b.{0,80}\d/.test(normalized);
};

const PlannerState = Annotation.Root({
  userId: Annotation(),
  chatId: Annotation(),
  assistantMessageId: Annotation(),
  text: Annotation(),
  history: Annotation(),
  pendingAction: Annotation(),
  planner: Annotation(),
  payload: Annotation(),
  missingFields: Annotation(),
  actionPlan: Annotation(),
});

const checkPendingNode = async (state) => ({
  pendingAction: await findPendingFieldsAction(state.userId, state.chatId),
});

const plannerNode = async (state) => ({
  planner: await callPlannerModel({
    text: state.text,
    pendingAction: state.pendingAction,
    history: state.history,
  }),
});

const validateNode = async (state) => {
  const planner = state.planner || {};
  if (!planner.isTask && !state.pendingAction) {
    return { actionPlan: null };
  }

  const toolName = state.pendingAction?.actionType || planner.toolName;
  if (!EXECUTABLE_ACTIONS.has(toolName)) {
    return { actionPlan: null };
  }

  const previousPayload = state.pendingAction?.extractedPayload || {};
  const pendingArgs = state.pendingAction ? extractPendingArguments(state.pendingAction, state.text) : {};
  const payload = normalizeToolArguments(toolName, {
    ...previousPayload,
    ...(planner.arguments || {}),
    ...pendingArgs,
  });
  const missingFields = getMissingFields(toolName, payload);

  return {
    payload,
    missingFields,
  };
};

const buildGraph = () => new StateGraph(PlannerState)
  .addNode('check_pending', checkPendingNode)
  .addNode('plan', plannerNode)
  .addNode('validate', validateNode)
  .addEdge(START, 'check_pending')
  .addEdge('check_pending', 'plan')
  .addEdge('plan', 'validate')
  .addEdge('validate', END)
  .compile();

let compiledPlannerGraph = null;

const getPlannerGraph = () => {
  if (!compiledPlannerGraph) {
    compiledPlannerGraph = buildGraph();
  }
  return compiledPlannerGraph;
};

const createOrUpdateActionPlan = async ({
  userId,
  chatId,
  assistantMessageId,
  pendingAction,
  toolName,
  payload,
  missingFields,
}) => {
  if (!WRITE_ACTIONS.has(toolName)) {
    return {
      kind: 'read_task',
      intent: toolName,
      payload,
    };
  }

  const action = pendingAction || new AssistantAction({
    userId,
    chatId,
    actionType: toolName,
    expiresAt: new Date(Date.now() + ACTION_TTL_MS),
  });

  action.assistantMessageId = assistantMessageId;
  action.extractedPayload = payload;
  action.missingFields = missingFields;
  action.status = missingFields.length ? 'pending_fields' : 'pending_confirmation';
  action.confirmationMessage = missingFields.length
    ? buildMissingQuestion(toolName, missingFields, payload)
    : buildConfirmationMessage(toolName, payload);
  action.expiresAt = action.expiresAt || new Date(Date.now() + ACTION_TTL_MS);
  await action.save();

  return {
    kind: missingFields.length ? 'missing_fields' : 'confirmation_required',
    intent: toolName,
    action,
    missingFields,
    payload,
    text: action.confirmationMessage,
  };
};

const answerReadIntent = async ({ userId, intent, payload = {} }) => {
  const period = normalizePeriod(payload.period);

  if (intent === 'query_financial_summary') {
    const summary = await financeTools.getFinancialSummary(userId, period);
    return {
      intent,
      text: `For ${summary.label}, you spent ${formatCurrency(summary.expenseTotal)} across ${summary.expenseCount} expense${summary.expenseCount === 1 ? '' : 's'} and received ${formatCurrency(summary.incomeTotal)} across ${summary.incomeCount} income entr${summary.incomeCount === 1 ? 'y' : 'ies'}. Net position: ${formatCurrency(summary.net)}.`,
    };
  }

  if (intent === 'query_category_spending') {
    const missingFields = getMissingFields(intent, payload);
    if (missingFields.length) {
      return {
        kind: 'missing_fields',
        intent,
        missingFields,
        payload,
        text: buildMissingQuestion(intent, missingFields, payload),
      };
    }
    const result = await financeTools.getCategorySpending(userId, payload.categoryName, period);
    return {
      intent,
      text: result.categoryFound
        ? `You spent ${formatCurrency(result.total)} on ${result.categoryName} for ${result.label} across ${result.count} transaction${result.count === 1 ? '' : 's'}.`
        : `I could not find an active expense category called ${result.categoryName}.`,
    };
  }

  if (intent === 'analyze_spending') {
    const result = await financeTools.getSpendingDrivers(userId, period);
    if (!result.topCategories.length) {
      return { intent, text: `I do not see expenses for ${result.label} yet.` };
    }
    const lines = result.topCategories.map((entry, index) => `${index + 1}. ${entry.categoryName}: ${formatCurrency(entry.amount)}`);
    return {
      intent,
      text: `Your biggest spending drivers for ${result.label} are:\n${lines.join('\n')}`,
    };
  }

  if (intent === 'explain_budget_position') {
    const result = await financeTools.getBudgetHealth(userId, period);
    if (!result.budgetLimit) {
      return { intent, text: `I do not see a monthly budget set yet, but you have spent ${formatCurrency(result.expenseTotal)} for ${result.label}.` };
    }
    const remainingText = result.remaining >= 0
      ? `${formatCurrency(result.remaining)} remaining`
      : `${formatCurrency(Math.abs(result.remaining))} over budget`;
    return {
      intent,
      text: `For ${result.label}, you have used ${result.percentageUsed}% of your budget: ${formatCurrency(result.expenseTotal)} spent out of ${formatCurrency(result.budgetLimit)}, with ${remainingText}.`,
    };
  }

  return null;
};

const planAssistantAction = async ({ userId, chatId, assistantMessageId, text, history = [] }) => {
  const [pendingConfirmation, pendingFields] = await Promise.all([
    findPendingConfirmationAction(userId, chatId),
    findPendingFieldsAction(userId, chatId),
  ]);
  if (pendingConfirmation && isTextCancellation(text)) {
    const action = await cancelAction(userId, pendingConfirmation._id);
    action.assistantMessageId = assistantMessageId;
    await action.save();
    await attachActionToMessage(assistantMessageId, action);
    return {
      kind: 'action_cancelled',
      intent: action.actionType,
      action,
      text: `No problem, I cancelled that pending ${ACTION_LABELS[action.actionType] || 'action'}.`,
    };
  }

  if (pendingConfirmation && isTextConfirmation(text)) {
    const action = await executeAction(userId, pendingConfirmation._id);
    action.assistantMessageId = assistantMessageId;
    await action.save();
    await attachActionToMessage(assistantMessageId, action);
    return {
      kind: 'action_completed',
      intent: action.actionType,
      action,
      text: `Done, I recorded that ${ACTION_LABELS[action.actionType] || 'action'} in SEFA.`,
    };
  }

  // Ordinary questions go straight to the streaming answer. Calling a second
  // model just to decide that they are not write commands adds several seconds.
  if (!pendingFields && !looksLikeWriteAction(text)) {
    return null;
  }

  const graph = getPlannerGraph();
  const state = await graph.invoke({
    userId,
    chatId,
    assistantMessageId,
    text,
    history,
    pendingAction: null,
    planner: null,
    payload: {},
    missingFields: [],
    actionPlan: null,
  });

  const planner = state.planner || {};
  if (!planner.isTask || !planner.toolName) return null;

  const toolName = state.pendingAction?.actionType || planner.toolName;
  const payload = state.payload || normalizeToolArguments(toolName, planner.arguments || {});
  const missingFields = state.missingFields || getMissingFields(toolName, payload);
  const actionPlan = await createOrUpdateActionPlan({
    userId,
    chatId,
    assistantMessageId,
    pendingAction: state.pendingAction,
    toolName,
    payload,
    missingFields,
  });

  if (actionPlan.kind === 'read_task') {
    return answerReadIntent({
      userId,
      intent: actionPlan.intent,
      payload: actionPlan.payload,
    });
  }

  return actionPlan;
};

const executeAction = async (userId, actionId) => {
  const action = await AssistantAction.findOne({ _id: actionId, userId });
  if (!action) throw new Error('Assistant action not found');
  if (action.status !== 'pending_confirmation') {
    throw new Error(`This ${ACTION_LABELS[action.actionType] || 'action'} is already ${action.status}`);
  }
  if (action.expiresAt && action.expiresAt < new Date()) {
    action.status = 'cancelled';
    action.errorMessage = 'Action expired';
    await action.save();
    throw new Error('This action has expired');
  }

  action.status = 'confirmed';
  await action.save();

  try {
    let result = null;
    if (action.actionType === 'create_expense') {
      result = await financeTools.createExpense(userId, action.extractedPayload);
    } else if (action.actionType === 'create_income') {
      result = await financeTools.createIncome(userId, action.extractedPayload);
    } else if (action.actionType === 'create_category') {
      result = await financeTools.createCategory(userId, action.extractedPayload);
    } else {
      throw new Error('Unsupported assistant action');
    }

    action.status = 'executed';
    action.result = result;
    action.errorMessage = null;
    await action.save();

    if (action.assistantMessageId) {
      await attachActionToMessage(action.assistantMessageId, action);
    }

    return action;
  } catch (error) {
    action.status = 'failed';
    action.errorMessage = error.message || 'Action failed';
    await action.save();
    if (action.assistantMessageId) {
      await attachActionToMessage(action.assistantMessageId, action);
    }
    throw error;
  }
};

const cancelAction = async (userId, actionId) => {
  const action = await AssistantAction.findOne({ _id: actionId, userId });
  if (!action) throw new Error('Assistant action not found');
  if (!['pending_confirmation', 'pending_fields', 'failed'].includes(action.status)) {
    throw new Error(`This action is already ${action.status}`);
  }

  action.status = 'cancelled';
  await action.save();
  if (action.assistantMessageId) {
    await attachActionToMessage(action.assistantMessageId, action);
  }
  return action;
};

const editAction = async (userId, actionId, updates = {}) => {
  const action = await AssistantAction.findOne({ _id: actionId, userId });
  if (!action) throw new Error('Assistant action not found');
  if (action.status !== 'pending_confirmation') {
    throw new Error(`This action is already ${action.status}`);
  }

  const payload = normalizeToolArguments(action.actionType, {
    ...(action.extractedPayload || {}),
    ...(updates || {}),
  });
  const missingFields = getMissingFields(action.actionType, payload);
  action.extractedPayload = payload;
  action.missingFields = missingFields;
  action.status = missingFields.length ? 'pending_fields' : 'pending_confirmation';
  action.confirmationMessage = missingFields.length
    ? buildMissingQuestion(action.actionType, missingFields, payload)
    : buildConfirmationMessage(action.actionType, payload);
  await action.save();
  if (action.assistantMessageId) {
    await attachActionToMessage(action.assistantMessageId, action);
  }
  return action;
};

module.exports = {
  attachActionToMessage,
  buildActionSummary,
  cancelAction,
  editAction,
  executeAction,
  planAssistantAction,
};
