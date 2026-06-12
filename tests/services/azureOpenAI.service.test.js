describe('azureOpenAI.service config resolution', () => {
  const modulePath = '../../src/services/llm/azureOpenAI.service';

  const loadModule = () => {
    jest.resetModules();
    return require(modulePath);
  };

  const withEnv = (overrides) => {
    const previous = {
      AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
      AZURE_OPENAI_DEPLOYMENT_NAME: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
      AZURE_OPENAI_MODEL_NAME: process.env.AZURE_OPENAI_MODEL_NAME,
      AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION,
    };

    Object.assign(process.env, overrides);

    return () => {
      Object.entries(previous).forEach(([key, value]) => {
        if (typeof value === 'undefined') {
          delete process.env[key];
          return;
        }
        process.env[key] = value;
      });
    };
  };

  it('treats /openai/v1 endpoints as OpenAI-compatible Azure endpoints', () => {
    const restoreEnv = withEnv({
      AZURE_OPENAI_ENDPOINT: 'https://biodundev.services.ai.azure.com/openai/v1',
      AZURE_OPENAI_API_KEY: 'test-key',
      AZURE_OPENAI_DEPLOYMENT_NAME: 'gpt-5.3-chat',
      AZURE_OPENAI_MODEL_NAME: 'gpt-5.3-chat',
      AZURE_OPENAI_API_VERSION: '2026-03-03',
    });

    const service = loadModule();
    const config = service.resolveClientConfig();

    expect(service.isOpenAIV1Endpoint(process.env.AZURE_OPENAI_ENDPOINT)).toBe(true);
    expect(config).toBeTruthy();
    expect(config.mode).toBe('openai-v1');
    expect(config.model).toBe('gpt-5.3-chat');
    expect(config.client.baseURL).toBe('https://biodundev.services.ai.azure.com/openai/v1');

    restoreEnv();
  });

  it('treats classic Azure resource endpoints as deployment-based Azure endpoints', () => {
    const restoreEnv = withEnv({
      AZURE_OPENAI_ENDPOINT: 'https://example-resource.openai.azure.com/',
      AZURE_OPENAI_API_KEY: 'test-key',
      AZURE_OPENAI_DEPLOYMENT_NAME: 'finance-assistant',
      AZURE_OPENAI_MODEL_NAME: 'gpt-4.1',
      AZURE_OPENAI_API_VERSION: '2024-10-21',
    });

    const service = loadModule();
    const config = service.resolveClientConfig();

    expect(service.isOpenAIV1Endpoint(process.env.AZURE_OPENAI_ENDPOINT)).toBe(false);
    expect(config).toBeTruthy();
    expect(config.mode).toBe('azure-deployment');
    expect(config.model).toBe('gpt-4.1');
    expect(config.client.baseURL).toBe('https://example-resource.openai.azure.com/openai');

    restoreEnv();
  });

  it('builds token limits using max_completion_tokens', () => {
    const service = loadModule();
    expect(service.buildTokenLimitParams(420)).toEqual({
      max_completion_tokens: 420,
    });
  });

  it('omits custom sampling params for gpt-5 style models', () => {
    const service = loadModule();
    expect(service.modelRequiresDefaultSampling('gpt-5.3-chat')).toBe(true);
    expect(
      service.buildSamplingParams({
        model: 'gpt-5.3-chat',
        temperature: 0.2,
        topP: 0.9,
      }),
    ).toEqual({});
  });

  it('keeps sampling params for non gpt-5 models', () => {
    const service = loadModule();
    expect(service.modelRequiresDefaultSampling('gpt-4.1')).toBe(false);
    expect(
      service.buildSamplingParams({
        model: 'gpt-4.1',
        temperature: 0.2,
        topP: 0.9,
      }),
    ).toEqual({
      temperature: 0.2,
      top_p: 0.9,
    });
  });
});
