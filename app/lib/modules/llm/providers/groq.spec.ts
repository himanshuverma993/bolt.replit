import { describe, expect, it, vi } from 'vitest';

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

import GroqProvider, { GROQ_DEFAULT_BASE_URL } from './groq';

/**
 * Groq static catalog must track the official docs, not the 2024-era preview
 * IDs that Groq has already shut down.
 */
describe('Groq provider', () => {
  const provider = new GroqProvider();

  it('lists current Groq chat models and omits decommissioned Llama 3.2 previews', () => {
    const names = provider.staticModels.map((model) => model.name);

    expect(names).toContain('openai/gpt-oss-20b');
    expect(names).toContain('openai/gpt-oss-120b');
    expect(names).toContain('qwen/qwen3.8-27b');
    expect(names).not.toContain('llama-3.2-11b-vision-preview');
    expect(names).not.toContain('llama-3.2-90b-vision-preview');
    expect(names).not.toContain('llama-3.2-3b-preview');
    expect(names).not.toContain('llama-3.2-1b-preview');

    const gptOss = provider.staticModels.find((model) => model.name === 'openai/gpt-oss-20b');
    expect(gptOss?.maxTokenAllowed).toBe(65536);
  });

  it('honours a configured baseUrl instead of the hardcoded Groq host', () => {
    const { apiKey, baseUrl } = provider.getProviderBaseUrlAndKey({
      apiKeys: { Groq: 'gsk_test_key' },
      providerSettings: { baseUrl: 'http://127.0.0.1:41888/openai/v1' },
      defaultBaseUrlKey: 'GROQ_API_BASE_URL',
      defaultApiTokenKey: 'GROQ_API_KEY',
    });

    expect(apiKey).toBe('gsk_test_key');
    expect(baseUrl).toBe('http://127.0.0.1:41888/openai/v1');
    expect(GROQ_DEFAULT_BASE_URL).toBe('https://api.groq.com/openai/v1');
  });
});
