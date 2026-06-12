const axios = require('axios');

const { decideAssistantWebLookup } = require('./liveWebRouter.service');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESULTS = 5;

const readEnv = (key) => String(process.env[key] || '').trim();

const clampString = (value = '', max = 320) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const ensureHttpsUrl = (value = '') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return '';
};

const extractDomainLabel = (value = '') => {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, '');
    return hostname || 'Source';
  } catch (_error) {
    return 'Source';
  }
};

const parseNumericPrice = (value = '') => {
  const safe = String(value || '').replace(/,/g, '');
  const match = safe.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

const detectCurrency = (value = '') => {
  const safe = String(value || '');
  if (/₦|NGN/i.test(safe)) return 'NGN';
  if (/\$/i.test(safe)) return 'USD';
  if (/£/i.test(safe)) return 'GBP';
  if (/€/i.test(safe)) return 'EUR';
  return null;
};

const scoreSource = (source = {}) => {
  const domain = String(source.url || '');
  const snippet = String(source.snippet || '');
  const sourceName = String(source.sourceName || '');
  let score = 0;

  if (source.currency === 'NGN' || /₦|NGN/i.test(source.priceText || '') || /₦|NGN/i.test(snippet)) {
    score += 5;
  }

  if (/\.ng\b/i.test(domain) || /nigeria/i.test(domain) || /nigeria/i.test(sourceName) || /nigeria/i.test(snippet)) {
    score += 4;
  }

  if (source.numericPrice) {
    score += 2;
  }

  if (/jumia|jiji|slot|kara|zit/i.test(domain) || /jumia|jiji|slot|kara|zit/i.test(sourceName)) {
    score += 3;
  }

  if (/youtube|walmart|amazon/i.test(domain)) {
    score -= 2;
  }

  return score;
};

const rankSources = (sources = []) => {
  return [...sources].sort((left, right) => scoreSource(right) - scoreSource(left));
};

const hasLocalNairaCoverage = (sources = []) => {
  return sources.some((source) => {
    return source.currency === 'NGN'
      || /\.ng\b/i.test(String(source.url || ''))
      || /nigeria/i.test(String(source.sourceName || ''))
      || /₦|NGN/i.test(String(source.snippet || ''))
      || /₦|NGN/i.test(String(source.priceText || ''));
  });
};

const extractPriceText = (value = '') => {
  const safe = String(value || '').replace(/\s+/g, ' ').trim();
  const match = safe.match(/(₦\s?[\d,]+(?:\.\d+)?|NGN\s?[\d,]+(?:\.\d+)?|\$\s?[\d,]+(?:\.\d+)?|£\s?[\d,]+(?:\.\d+)?|€\s?[\d,]+(?:\.\d+)?)/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
};

const normalizeSource = ({
  title,
  url,
  sourceName,
  priceText = null,
  numericPrice = null,
  currency = null,
  snippet = null,
}) => {
  const safeUrl = ensureHttpsUrl(url);
  if (!safeUrl) {
    return null;
  }

  return {
    title: clampString(title, 180),
    url: safeUrl,
    sourceName: clampString(sourceName || extractDomainLabel(safeUrl), 80),
    priceText: priceText ? clampString(priceText, 80) : null,
    numericPrice: numericPrice === null || numericPrice === undefined || numericPrice === ''
      ? null
      : (Number.isFinite(Number(numericPrice)) ? Number(numericPrice) : null),
    currency: currency || (priceText ? detectCurrency(priceText) : null),
    snippet: snippet ? clampString(snippet, 240) : null,
  };
};

const marketToSerpLocation = (market = 'NG') => {
  const normalized = String(market || '').trim().toUpperCase();
  if (normalized === 'NG') {
    return 'Nigeria';
  }
  return normalized;
};

const buildPriceRangeSummary = (sources = []) => {
  const priced = sources
    .map((entry) => ({
      value: Number(entry.numericPrice),
      currency: entry.currency || 'NGN',
    }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0);

  if (!priced.length) {
    return null;
  }

  const ngnPriced = priced.filter((entry) => entry.currency === 'NGN');
  const scoped = ngnPriced.length ? ngnPriced : priced.filter((entry) => entry.currency === priced[0].currency);

  const values = scoped.map((entry) => entry.value).sort((left, right) => left - right);
  const midpoint = Math.floor(values.length / 2);
  const median = values.length % 2 === 0
    ? (values[midpoint - 1] + values[midpoint]) / 2
    : values[midpoint];

  return {
    low: values[0],
    high: values[values.length - 1],
    median,
    currency: scoped[0].currency || 'NGN',
    sourceCount: scoped.length,
  };
};

const createRetrievalResult = ({
  mode = 'none',
  market = 'NG',
  query = '',
  status = 'not_needed',
  providers = [],
  sources = [],
  reason = null,
}) => ({
  mode,
  market,
  query,
  status,
  providers,
  sources,
  sourceCount: sources.length,
  priceRangeSummary: mode === 'shopping' ? buildPriceRangeSummary(sources) : null,
  reason,
});

const logRetrievalEvent = ({ mode, query, provider, startedAt, resultCount = 0, error = null }) => {
  const payload = {
    feature: 'assistant-live-web',
    mode,
    provider,
    latencyMs: Date.now() - startedAt,
    resultCount,
  };

  if (query) {
    payload.query = query;
  }

  if (error) {
    payload.error = error.message;
    console.error('Assistant web retrieval failed', payload);
    return;
  }

  console.log('Assistant web retrieval completed', payload);
};

const searchGeneralWeb = async ({ query, market = 'NG' }) => {
  const apiKey = readEnv('TAVILY_API_KEY');
  if (!apiKey) {
    return createRetrievalResult({
      mode: 'general_web',
      market,
      query,
      status: 'unavailable',
      providers: ['tavily'],
      reason: 'missing_tavily_api_key',
    });
  }

  const startedAt = Date.now();

  try {
    const response = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key: apiKey,
        query,
        topic: 'general',
        search_depth: 'advanced',
        max_results: MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
      },
      {
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );

    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    const sources = rankSources(results
      .slice(0, MAX_RESULTS)
      .map((entry) =>
        normalizeSource({
          title: entry.title,
          url: entry.url,
          sourceName: entry.source || entry.title,
          snippet: entry.content,
        }))
      .filter(Boolean));

    logRetrievalEvent({
      mode: 'general_web',
      query,
      provider: 'tavily',
      startedAt,
      resultCount: sources.length,
    });

    return createRetrievalResult({
      mode: 'general_web',
      market,
      query,
      status: sources.length ? 'used' : 'unavailable',
      providers: ['tavily'],
      sources,
      reason: sources.length ? null : 'no_results',
    });
  } catch (error) {
    logRetrievalEvent({
      mode: 'general_web',
      query,
      provider: 'tavily',
      startedAt,
      error,
    });

    return createRetrievalResult({
      mode: 'general_web',
      market,
      query,
      status: 'unavailable',
      providers: ['tavily'],
      reason: error.message || 'request_failed',
    });
  }
};

const searchSerpApi = async ({ engine, query, market = 'NG' }) => {
  const apiKey = readEnv('SERPAPI_API_KEY');
  if (!apiKey) {
    return null;
  }

  const params = {
    api_key: apiKey,
    engine,
    q: query,
    hl: 'en',
    location: marketToSerpLocation(market),
  };

  if (engine === 'google') {
    params.num = 10;
  }

  const response = await axios.get('https://serpapi.com/search.json', {
    params,
    timeout: DEFAULT_TIMEOUT_MS,
  });

  return response.data || {};
};

const normalizeShoppingResults = (payload = {}) => {
  const shoppingResults = Array.isArray(payload.shopping_results) ? payload.shopping_results : [];

  return rankSources(
    shoppingResults
      .slice(0, MAX_RESULTS)
      .map((entry) =>
        normalizeSource({
          title: entry.title,
          url: entry.link || entry.product_link,
          sourceName: entry.source || entry.merchant?.name || entry.store || entry.seller,
          priceText: entry.price,
          numericPrice: entry.extracted_price || parseNumericPrice(entry.price),
          currency: entry.currency || detectCurrency(entry.price),
          snippet: entry.snippet || entry.extensions?.join?.(' • '),
        }))
      .filter(Boolean),
  );
};

const normalizeSearchFallbackResults = (payload = {}) => {
  const organicResults = Array.isArray(payload.organic_results) ? payload.organic_results : [];

  return rankSources(
    organicResults
      .slice(0, MAX_RESULTS)
      .map((entry) => {
        const priceText = Array.isArray(entry.rich_snippet?.top?.detected_extensions)
          ? entry.rich_snippet.top.detected_extensions.find((value) => /₦|NGN|\$|£|€/.test(String(value || '')))
          : (extractPriceText(entry.snippet) || null);

        return normalizeSource({
          title: entry.title,
          url: entry.link,
          sourceName: entry.source || extractDomainLabel(entry.link),
          priceText,
          numericPrice: parseNumericPrice(priceText || entry.snippet),
          currency: detectCurrency(priceText || entry.snippet),
          snippet: entry.snippet,
        });
      })
      .filter(Boolean),
  );
};

const searchShoppingWeb = async ({ query, market = 'NG' }) => {
  const apiKey = readEnv('SERPAPI_API_KEY');
  if (!apiKey) {
    return createRetrievalResult({
      mode: 'shopping',
      market,
      query,
      status: 'unavailable',
      providers: ['serpapi-google-shopping'],
      reason: 'missing_serpapi_api_key',
    });
  }

  const startedAt = Date.now();
  const providers = [];
  let sources = [];
  let lastError = null;

  try {
    providers.push('serpapi-google-shopping');
    const shoppingPayload = await searchSerpApi({ engine: 'google_shopping', query, market });
    sources = normalizeShoppingResults(shoppingPayload);
  } catch (error) {
    lastError = error;
  }

  if (sources.length < 3 || !hasLocalNairaCoverage(sources)) {
    try {
      providers.push('serpapi-google-search');
      const fallbackPayload = await searchSerpApi({ engine: 'google', query, market });
      const fallbackSources = normalizeSearchFallbackResults(fallbackPayload);
      const merged = [...sources];
      fallbackSources.forEach((entry) => {
        if (!merged.find((existing) => existing.url === entry.url)) {
          merged.push(entry);
        }
      });
      sources = rankSources(merged).slice(0, MAX_RESULTS);
    } catch (error) {
      lastError = lastError || error;
    }
  }

  if (!sources.length && lastError) {
    logRetrievalEvent({
      mode: 'shopping',
      query,
      provider: providers.join(',') || 'serpapi-google-shopping',
      startedAt,
      error: lastError,
    });

    return createRetrievalResult({
      mode: 'shopping',
      market,
      query,
      status: 'unavailable',
      providers: providers.length ? providers : ['serpapi-google-shopping'],
      reason: lastError.message || 'request_failed',
    });
  }

  logRetrievalEvent({
    mode: 'shopping',
    query,
    provider: providers.join(','),
    startedAt,
    resultCount: sources.length,
  });

  return createRetrievalResult({
    mode: 'shopping',
    market,
    query,
    status: sources.length ? 'used' : 'unavailable',
    providers,
    sources,
    reason: sources.length ? null : (lastError?.message || 'no_results'),
  });
};

const resolveAssistantLiveWebContext = async (question = '') => {
  const decision = decideAssistantWebLookup(question);
  if (!decision.shouldSearch) {
    return createRetrievalResult({
      mode: 'none',
      market: decision.market,
      query: '',
      status: 'not_needed',
      providers: [],
      reason: decision.reason,
    });
  }

  if (decision.mode === 'shopping') {
    return searchShoppingWeb({
      query: decision.query,
      market: decision.market,
    });
  }

  return searchGeneralWeb({
    query: decision.query,
    market: decision.market,
  });
};

module.exports = {
  buildPriceRangeSummary,
  createRetrievalResult,
  normalizeSearchFallbackResults,
  normalizeShoppingResults,
  normalizeSource,
  parseNumericPrice,
  resolveAssistantLiveWebContext,
  searchGeneralWeb,
  searchShoppingWeb,
};
