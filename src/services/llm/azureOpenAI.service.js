const { AzureOpenAI, OpenAI } = require('openai');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TEMPERATURE = 0.3;

// Clients are cached per resolved config (one per distinct deployment) so the
// default, statement-vision, and fast deployments can coexist without rebuilding.
const clientCache = new Map();

const readEnv = (key) => String(process.env[key] || '').trim();

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const isOpenAIV1Endpoint = (endpoint) => /\/openai\/v1\/?$/i.test(String(endpoint || '').trim());

/**
 * Resolve the deployment used for bank-statement image extraction. Falls back to
 * the default deployment when the dedicated one is not configured. Never hardcoded.
 */
const getStatementDeployment = () =>
  readEnv('AZURE_OPENAI_STATEMENT_DEPLOYMENT') || readEnv('AZURE_OPENAI_DEPLOYMENT_NAME');

/**
 * Resolve the lighter/faster deployment used for the audit pass and category
 * cleanup. Falls back to the default deployment.
 */
const getFastDeployment = () =>
  readEnv('AZURE_OPENAI_FAST_DEPLOYMENT') || readEnv('AZURE_OPENAI_DEPLOYMENT_NAME');

/**
 * The statement-vision profile may live on its own Azure resource. Honor the
 * dedicated AZURE_OPENAI_STATEMENT_* vars when present, falling back to the
 * default endpoint/key/deployment. Returns an override object for resolveClientConfig.
 */
const getStatementProfile = () => ({
  endpoint: readEnv('AZURE_OPENAI_STATEMENT_ENDPOINT') || undefined,
  apiKey: readEnv('AZURE_OPENAI_STATEMENT_API_KEY') || undefined,
  deployment: getStatementDeployment() || undefined,
  model: readEnv('AZURE_OPENAI_STATEMENT_MODEL_NAME') || undefined,
});

/**
 * Resolve the Azure/OpenAI client config.
 * @param {string|Object} [override] - either a deployment name string, or an
 *   options object { endpoint, apiKey, deployment, model, apiVersion } to target
 *   a specific deployment (and optionally its own Azure resource) for this call.
 */
const resolveClientConfig = (override) => {
  const overrides = typeof override === 'string' ? { deployment: override } : override || {};

  const endpoint = trimTrailingSlash(overrides.endpoint || readEnv('AZURE_OPENAI_ENDPOINT'));
  const apiKey = overrides.apiKey || readEnv('AZURE_OPENAI_API_KEY');
  const defaultDeployment = readEnv('AZURE_OPENAI_DEPLOYMENT_NAME');
  const apiVersion = overrides.apiVersion || readEnv('AZURE_OPENAI_API_VERSION');

  const deployment = String(overrides.deployment || '').trim() || defaultDeployment;
  // In openai-v1 mode the request `model` IS the deployment name, so an override
  // changes the model. In azure-deployment mode the override drives the client's
  // deployment binding. When no MODEL_NAME is set, the deployment doubles as model.
  const model =
    overrides.model || (overrides.deployment ? deployment : readEnv('AZURE_OPENAI_MODEL_NAME') || defaultDeployment);

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

/**
 * Build per-request options for the SDK, omitting undefined values. The OpenAI
 * SDK rejects `{ timeout: undefined }` ("timeout must be an integer"), so we only
 * include keys that are actually set.
 */
const buildRequestOptions = ({ timeoutMs, maxRetries } = {}) => {
  const options = {};
  if (Number.isFinite(Number(timeoutMs))) options.timeout = Number(timeoutMs);
  if (Number.isFinite(Number(maxRetries))) options.maxRetries = Number(maxRetries);
  return options;
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

/**
 * gpt-5.x are reasoning models that reason heavily by default, which is slow for
 * structured tasks like statement extraction. Allow callers to dial it down via
 * `reasoning_effort` ('minimal' | 'low' | 'medium' | 'high'). Only applied to
 * gpt-5 style models (the param is rejected by non-reasoning models).
 */
const buildReasoningParams = ({ model, reasoningEffort }) => {
  if (!reasoningEffort || !modelRequiresDefaultSampling(model)) {
    return {};
  }
  return { reasoning_effort: reasoningEffort };
};

const isConfigured = () => {
  return Boolean(resolveClientConfig());
};

const getClient = (deploymentOverride) => {
  const resolved = resolveClientConfig(deploymentOverride);
  if (!resolved) {
    return null;
  }

  let client = clientCache.get(resolved.cacheKey);
  if (!client) {
    client = resolved.client;
    clientCache.set(resolved.cacheKey, client);
  }

  return {
    client,
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
  deployment,
}) => {
  const resolvedClient = getClient(deployment);
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
  timeoutMs,
  maxRetries,
  deployment,
  reasoningEffort,
}) => {
  const resolvedClient = getClient(deployment);
  if (!resolvedClient || process.env.NODE_ENV === 'test') {
    return null;
  }
  const { client, model } = resolvedClient;

  const startedAt = Date.now();

  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: normalizeMessages({ system, prompt, messages }),
        ...buildTokenLimitParams(maxTokens),
        ...buildSamplingParams({ model, temperature }),
        ...buildReasoningParams({ model, reasoningEffort }),
        response_format: { type: 'json_object' },
        stream: false,
      },
      buildRequestOptions({ timeoutMs, maxRetries }),
    );

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
  deployment,
}) => {
  const resolvedClient = getClient(deployment);
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
  getStatementDeployment,
  getStatementProfile,
  getFastDeployment,
  isConfigured,
  isOpenAIV1Endpoint,
  modelRequiresDefaultSampling,
  resolveClientConfig,
  streamText,
};
