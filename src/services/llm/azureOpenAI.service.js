const { AzureOpenAI, OpenAI } = require('openai');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TEMPERATURE = 0.3;

let cachedClient = null;
let cachedClientCacheKey = null;

const readEnv = (key) => String(process.env[key] || '').trim();

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const isOpenAIV1Endpoint = (endpoint) => /\/openai\/v1\/?$/i.test(String(endpoint || '').trim());

const resolveClientConfig = () => {
  const endpoint = trimTrailingSlash(readEnv('AZURE_OPENAI_ENDPOINT'));
  const apiKey = readEnv('AZURE_OPENAI_API_KEY');
  const deployment = readEnv('AZURE_OPENAI_DEPLOYMENT_NAME');
  const model = readEnv('AZURE_OPENAI_MODEL_NAME') || deployment;
  const apiVersion = readEnv('AZURE_OPENAI_API_VERSION');

  if (!endpoint || !apiKey || !deployment || !model || !apiVersion) {
    return null;
  }

  if (isOpenAIV1Endpoint(endpoint)) {
    return {
      mode: 'openai-v1',
      cacheKey: JSON.stringify({ mode: 'openai-v1', endpoint, model }),
      model,
      client: new OpenAI({
        apiKey,
        baseURL: endpoint,
        timeout: DEFAULT_TIMEOUT_MS,
        maxRetries: 1,
      }),
    };
  }

  return {
    mode: 'azure-deployment',
    cacheKey: JSON.stringify({ mode: 'azure-deployment', endpoint, deployment, model, apiVersion }),
    model,
    client: new AzureOpenAI({
      endpoint,
      apiKey,
      apiVersion,
      deployment,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 1,
    }),
  };
};

const getMaxTokens = (override) => {
  const raw = override ?? process.env.AZURE_OPENAI_MAX_TOKENS ?? '800';
  const parsed = parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 800;
};

const buildTokenLimitParams = (maxTokens) => {
  return {
    max_completion_tokens: getMaxTokens(maxTokens),
  };
};

const modelRequiresDefaultSampling = (model) => /^gpt-5(\.|-|$)/i.test(String(model || '').trim());

const buildSamplingParams = ({ model, temperature, topP }) => {
  if (modelRequiresDefaultSampling(model)) {
    return {};
  }

  const params = {};

  if (typeof temperature === 'number') {
    params.temperature = temperature;
  }

  if (typeof topP === 'number') {
    params.top_p = topP;
  }

  return params;
};

const isConfigured = () => {
  return Boolean(resolveClientConfig());
};

const getClient = () => {
  const resolved = resolveClientConfig();
  if (!resolved) {
    return null;
  }

  if (!cachedClient || cachedClientCacheKey !== resolved.cacheKey) {
    cachedClient = resolved.client;
    cachedClientCacheKey = resolved.cacheKey;
  }

  return {
    client: cachedClient,
    mode: resolved.mode,
    model: resolved.model,
  };
};

const logLlmEvent = ({ feature, mode, startedAt, usage = null, error = null }) => {
  const latencyMs = Date.now() - startedAt;
  const summary = {
    provider: 'azure-openai',
    feature,
    mode,
    latencyMs,
  };

  if (usage) {
    summary.usage = usage;
  }

  if (error) {
    summary.error = error.message;
    console.error('LLM request failed', summary);
    return;
  }

  console.log('LLM request completed', summary);
};

const normalizeMessages = ({ system, prompt, messages }) => {
  if (Array.isArray(messages) && messages.length > 0) {
    return messages;
  }

  const normalized = [];
  if (system) {
    normalized.push({ role: 'system', content: system });
  }
  if (prompt) {
    normalized.push({ role: 'user', content: prompt });
  }
  return normalized;
};

const completeText = async ({
  feature,
  system,
  prompt,
  messages,
  maxTokens,
  temperature = DEFAULT_TEMPERATURE,
  topP = 1,
}) => {
  const resolvedClient = getClient();
  if (!resolvedClient || process.env.NODE_ENV === 'test') {
    return null;
  }
  const { client, model } = resolvedClient;

  const startedAt = Date.now();

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: normalizeMessages({ system, prompt, messages }),
      ...buildTokenLimitParams(maxTokens),
      ...buildSamplingParams({ model, temperature, topP }),
      stream: false,
    });

    const text = completion.choices?.[0]?.message?.content?.trim() || '';
    logLlmEvent({ feature, mode: 'text', startedAt, usage: completion.usage || null });
    return {
      text,
      usage: completion.usage || null,
    };
  } catch (error) {
    logLlmEvent({ feature, mode: 'text', startedAt, error });
    throw error;
  }
};

const extractJson = (value) => {
  try {
    return JSON.parse(value);
  } catch (_error) {
    const match = String(value || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_innerError) {
      return null;
    }
  }
};

const completeJson = async ({
  feature,
  system,
  prompt,
  messages,
  maxTokens,
  temperature = 0.1,
}) => {
  const resolvedClient = getClient();
  if (!resolvedClient || process.env.NODE_ENV === 'test') {
    return null;
  }
  const { client, model } = resolvedClient;

  const startedAt = Date.now();

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: normalizeMessages({ system, prompt, messages }),
      ...buildTokenLimitParams(maxTokens),
      ...buildSamplingParams({ model, temperature }),
      response_format: { type: 'json_object' },
      stream: false,
    });

    const text = completion.choices?.[0]?.message?.content?.trim() || '';
    const json = extractJson(text);
    logLlmEvent({ feature, mode: 'json', startedAt, usage: completion.usage || null });
    return {
      text,
      json,
      usage: completion.usage || null,
    };
  } catch (error) {
    logLlmEvent({ feature, mode: 'json', startedAt, error });
    throw error;
  }
};

const streamText = async ({
  feature,
  messages,
  system,
  prompt,
  maxTokens,
  temperature = DEFAULT_TEMPERATURE,
  topP = 1,
  onDelta,
}) => {
  const resolvedClient = getClient();
  if (!resolvedClient || process.env.NODE_ENV === 'test') {
    return null;
  }
  const { client, model } = resolvedClient;

  const startedAt = Date.now();
  let fullText = '';

  try {
    const stream = await client.chat.completions.create({
      model,
      messages: normalizeMessages({ system, prompt, messages }),
      ...buildTokenLimitParams(maxTokens),
      ...buildSamplingParams({ model, temperature, topP }),
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || '';
      if (!delta) continue;
      fullText += delta;
      if (onDelta) {
        await onDelta({
          delta,
          fullText,
          isFinal: false,
        });
      }
    }

    if (onDelta) {
      await onDelta({
        delta: '',
        fullText,
        isFinal: true,
      });
    }

    logLlmEvent({ feature, mode: 'stream', startedAt });
    return {
      text: fullText.trim(),
      usage: null,
    };
  } catch (error) {
    logLlmEvent({ feature, mode: 'stream', startedAt, error });
    throw error;
  }
};

const completeJsonResponses = async ({
  feature,
  instructions,
  input,
  jsonSchema,
  timeoutMs = 120000,
  maxRetries = 0,
}) => {
  const resolvedClient = getClient();
  if (!resolvedClient || process.env.NODE_ENV === 'test') {
    return null;
  }

  const { client, model } = resolvedClient;
  const startedAt = Date.now();

  try {
    const response = await client.responses.create(
      {
        model,
        instructions,
        input,
        text: jsonSchema
          ? {
              format: {
                type: 'json_schema',
                name: jsonSchema.name,
                schema: jsonSchema.schema,
                strict: true,
              },
            }
          : {
              format: { type: 'json_object' },
            },
      },
      {
        timeout: timeoutMs,
        maxRetries,
      },
    );

    const text = String(response?.output_text || '').trim();
    const json = extractJson(text);
    logLlmEvent({ feature, mode: 'json', startedAt, usage: response?.usage || null });
    return {
      text,
      json,
      usage: response?.usage || null,
    };
  } catch (error) {
    logLlmEvent({ feature, mode: 'json', startedAt, error });
    throw error;
  }
};

module.exports = {
  completeJsonResponses,
  completeJson,
  buildTokenLimitParams,
  buildSamplingParams,
  completeText,
  extractJson,
  getMaxTokens,
  getClient,
  isConfigured,
  isOpenAIV1Endpoint,
  modelRequiresDefaultSampling,
  resolveClientConfig,
  streamText,
};
