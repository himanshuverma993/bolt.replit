import { beforeEach, describe, expect, it, vi } from 'vitest';

const managerEnv: Record<string, string> = {};

vi.mock('./manager', () => ({
  LLMManager: {
    getInstance: () => ({ env: managerEnv }),
  },
}));

import { BaseProvider } from './base-provider';
import type { ModelInfo } from './types';
import type { LanguageModelV1 } from 'ai';

class TokenProvider extends BaseProvider {
  name = 'TokenProbe';
  config = { apiTokenKey: 'PROBE_API_KEY', baseUrlKey: 'PROBE_BASE_URL' };
  staticModels: ModelInfo[] = [];

  getModelInstance(): LanguageModelV1 {
    throw new Error('not used');
  }
}

describe('BaseProvider.getProviderBaseUrlAndKey', () => {
  beforeEach(() => {
    for (const key of Object.keys(managerEnv)) {
      delete managerEnv[key];
    }
  });

  it('reads the API token from manager.env[apiTokenKey], not from the base-URL key', () => {
    managerEnv.PROBE_API_KEY = 'from-manager-env';
    managerEnv.PROBE_BASE_URL = 'https://should-not-be-used-as-a-key.example';

    const provider = new TokenProvider();
    const { apiKey, baseUrl } = provider.getProviderBaseUrlAndKey({
      apiKeys: {},
      serverEnv: {},
      defaultBaseUrlKey: 'PROBE_BASE_URL',
      defaultApiTokenKey: 'PROBE_API_KEY',
    });

    expect(apiKey).toBe('from-manager-env');
    expect(baseUrl).toBe('https://should-not-be-used-as-a-key.example');
  });
});
