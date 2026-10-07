import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/modules/llm/base-provider', () => {
  class BaseProvider {
    config: { apiTokenKey?: string; baseUrlKey?: string } = {};
    name = '';

    getProviderBaseUrlAndKey(options: {
      apiKeys?: Record<string, string>;
      providerSettings?: { baseUrl?: string };
      serverEnv?: Record<string, string>;
      defaultBaseUrlKey: string;
      defaultApiTokenKey: string;
    }) {
      const apiTokenKey = this.config.apiTokenKey || options.defaultApiTokenKey;
      const baseUrlKey = this.config.baseUrlKey || options.defaultBaseUrlKey;
      let baseUrl =
        options.providerSettings?.baseUrl ||
        options.serverEnv?.[baseUrlKey] ||
        (typeof process !== 'undefined' ? process.env?.[baseUrlKey] : undefined);

      if (baseUrl && baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
      }

      const apiKey = options.apiKeys?.[this.name] || options.serverEnv?.[apiTokenKey];

      return { baseUrl, apiKey };
    }
  }

  return { BaseProvider };
});

import FreeLLMAPIProvider, { FREELLM_API_DEFAULT_BASE_URL } from './freellmapi';

/**
 * FreeLLMAPI (https://freellmapi.co) is the keyless route to the free
 * agentic coding tier: GLM 5.3 and Kimi K3 must always be listed, and the
 * provider must build a working model instance without any API key.
 */
describe('FreeLLMAPI provider', () => {
  const provider = new FreeLLMAPIProvider();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the free agentic coding models from the FreeLLMAPI catalog', () => {
    const names = provider.staticModels.map((model) => model.name);

    expect(names).toContain('glm-5.3:free');
    expect(names).toContain('moonshotai/Kimi-K3');
    expect(names).toContain('glm-5.3-flash:free');

    for (const model of provider.staticModels) {
      expect(model.provider).toBe('FreeLLMAPI');
      expect(model.maxTokenAllowed).toBeGreaterThan(0);
    }
  });

  it('is a direct-connect provider that never demands an API key', () => {
    expect(provider.requiresApiKey).toBe(false);
    expect(provider.noApiKeyNote).toMatch(/no API key needed/);
    expect(provider.getApiKeyLink).toBe('https://freellmapi.co/');
  });

  it('builds a model instance without any API key or configuration', () => {
    const model = provider.getModelInstance({
      model: 'glm-5.3:free',
      serverEnv: {} as unknown as Env,
    });

    expect(model.modelId).toBe('glm-5.3:free');
    expect(model.provider).toContain('openai');
  });

  it('honours a configured baseUrl and optional unified key', () => {
    const model = provider.getModelInstance({
      model: 'moonshotai/Kimi-K3',
      serverEnv: {
        FREELLM_API_BASE_URL: 'http://127.0.0.1:3001/v1',
        FREELLM_API_KEY: 'freellmapi-test-key',
      } as unknown as Env,
    });

    expect(model.modelId).toBe('moonshotai/Kimi-K3');
    expect(FREELLM_API_DEFAULT_BASE_URL).toBe('http://localhost:3001/v1');
  });

  it('skips the dynamic catalog probe unless a router base URL is configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(provider.getDynamicModels()).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('merges the live router catalog without duplicating static models or listing media models', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'glm-5.3:free' },
          { id: 'qwen/qwen3.8-max:free' },
          { id: '@cf/black-forest-labs/flux-2-dev' },
          { id: 'Lightricks/LTX-Video-0.9.7-distilled' },
          { id: undefined },
        ],
      }),
    });

    vi.stubGlobal('fetch', fetchSpy);

    const models = await provider.getDynamicModels(undefined, { baseUrl: 'http://127.0.0.1:3001/v1' });

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:3001/v1/models', { headers: {} });
    expect(models.map((model) => model.name)).toEqual(['qwen/qwen3.8-max:free']);
    expect(models[0]?.provider).toBe('FreeLLMAPI');
  });
});
