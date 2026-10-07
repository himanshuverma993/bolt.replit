import { describe, expect, it } from 'vitest';

/*
 * Import order matters here: registry pulls in base-provider (via the
 * provider files) before manager is touched, keeping the
 * registry -> base-provider -> manager -> registry cycle resolvable.
 */
import { FreeLLMAPIProvider } from './registry';
import { BaseProvider } from './base-provider';
import { LLMManager } from './manager';

/**
 * Guards the wiring that makes a provider actually reachable in the UI:
 * the registry export must be discovered by the LLMManager, and the
 * manager's model list must carry the provider's static models.
 */
describe('provider registry', () => {
  it('exports FreeLLMAPI as a BaseProvider implementation', () => {
    const provider = new FreeLLMAPIProvider();

    expect(provider).toBeInstanceOf(BaseProvider);
    expect(provider.name).toBe('FreeLLMAPI');
    expect(provider.requiresApiKey).toBe(false);
  });

  it('registers FreeLLMAPI and its free coding models in the LLMManager', () => {
    const manager = LLMManager.getInstance({});
    const registered = manager.getProvider('FreeLLMAPI');

    expect(registered).toBeDefined();
    expect(registered?.staticModels.map((model) => model.name)).toEqual(
      expect.arrayContaining(['glm-5.3:free', 'moonshotai/Kimi-K3', 'glm-5.3-flash:free']),
    );

    const modelList = manager.getModelList();

    for (const id of ['glm-5.3:free', 'moonshotai/Kimi-K3']) {
      const entry = modelList.find((model) => model.name === id);
      expect(entry).toBeDefined();
      expect(entry?.provider).toBe('FreeLLMAPI');
    }
  });
});
