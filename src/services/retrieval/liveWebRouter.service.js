const PRODUCT_HINT_PATTERN = /\b(tv|television|oled|qled|uhd|smart tv|iphone|ipad|phone|smartphone|android|samsung|lg|sony|hisense|infinix|tecno|laptop|macbook|printer|fridge|refrigerator|freezer|microwave|air conditioner|ac\b|generator|inverter|solar|ps5|playstation|xbox|console|headphones|earbuds|speaker|camera|tablet|watch|car|toyota|honda|nissan)\b/i;
const SHOPPING_INTENT_PATTERN = /\b(price|cost|how much|buy|purchase|get|shop|shopping|where can i buy|available|afford|budget for|worth it)\b/i;
const CURRENT_FACT_PATTERN = /\b(latest|today|currently|current|now|this week|recent|update|news|headline|trend|price)\b/i;
const INTERNAL_FINANCE_PATTERN = /\b(budget|budgeting|expense|expenses|spending|savings|save|income|salary|balance|month end|transaction|transactions|category|categories|cashflow|cash flow|overspend|overspending)\b/i;
const EXTERNAL_FACT_PATTERN = /\b(price|inflation|fuel|petrol|diesel|tariff|interest rate|exchange rate|tv|iphone|samsung|lg|ps5|playstation|laptop|car)\b/i;
const LOCATION_PATTERN = /\b(nigeria|lagos|abuja|port harcourt|ghana|kenya|uk|united kingdom|usa|united states|canada)\b/i;
const SHOPPING_PREFIX_PATTERN = /^(can i get|can i buy|can i afford|should i buy|what is the current price of|what is the price of|how much is|how much are|price of|current price of)\s+/i;
const SHOPPING_SUFFIX_PATTERN = /\b(this month|right now|now|currently|today|this week)\b/gi;

const normalizeSpaces = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();

const appendNigeriaIfNeeded = (query = '', { force = false } = {}) => {
  const normalized = normalizeSpaces(query);
  if (!normalized) {
    return normalized;
  }

  if (!force && LOCATION_PATTERN.test(normalized)) {
    return normalized;
  }

  if (/\bin nigeria\b/i.test(normalized)) {
    return normalized;
  }

  return `${normalized} in Nigeria`;
};

const buildShoppingQuery = (question = '') => {
  const normalized = normalizeSpaces(question)
    .replace(SHOPPING_PREFIX_PATTERN, '')
    .replace(SHOPPING_SUFFIX_PATTERN, '')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/[?.!]+$/g, '')
    .trim();
  if (!normalized) {
    return '';
  }

  if (/\b(price|cost|how much)\b/i.test(normalized)) {
    return appendNigeriaIfNeeded(normalized, { force: true });
  }

  return appendNigeriaIfNeeded(`${normalized} price`, { force: true });
};

const buildGeneralWebQuery = (question = '') => {
  const normalized = normalizeSpaces(question);
  if (!normalized) {
    return '';
  }

  const needsLocalContext = /\b(price|fuel|petrol|diesel|tariff|inflation|interest rate|exchange rate)\b/i.test(normalized);
  return needsLocalContext ? appendNigeriaIfNeeded(normalized, { force: true }) : normalized;
};

const decideAssistantWebLookup = (question = '') => {
  const normalized = normalizeSpaces(question);
  if (!normalized) {
    return {
      shouldSearch: false,
      mode: 'none',
      query: '',
      market: 'NG',
      reason: 'empty_question',
    };
  }

  const hasProductHint = PRODUCT_HINT_PATTERN.test(normalized);
  const hasShoppingIntent = SHOPPING_INTENT_PATTERN.test(normalized);
  const hasCurrentFactIntent = CURRENT_FACT_PATTERN.test(normalized);
  const hasInternalFinanceIntent = INTERNAL_FINANCE_PATTERN.test(normalized);
  const hasExternalFactHint = EXTERNAL_FACT_PATTERN.test(normalized);

  if (hasProductHint && (hasShoppingIntent || /\bcan i get\b/i.test(normalized))) {
    return {
      shouldSearch: true,
      mode: 'shopping',
      query: buildShoppingQuery(normalized),
      market: 'NG',
      reason: 'product_or_affordability_question',
    };
  }

  if (hasCurrentFactIntent && (hasExternalFactHint || !hasInternalFinanceIntent)) {
    return {
      shouldSearch: true,
      mode: 'general_web',
      query: buildGeneralWebQuery(normalized),
      market: 'NG',
      reason: 'current_fact_question',
    };
  }

  if (hasShoppingIntent && hasProductHint) {
    return {
      shouldSearch: true,
      mode: 'shopping',
      query: buildShoppingQuery(normalized),
      market: 'NG',
      reason: 'shopping_question',
    };
  }

  return {
    shouldSearch: false,
    mode: 'none',
    query: '',
    market: 'NG',
    reason: hasInternalFinanceIntent ? 'internal_finance_question' : 'no_live_lookup_needed',
  };
};

module.exports = {
  buildGeneralWebQuery,
  buildShoppingQuery,
  decideAssistantWebLookup,
};
