import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

/** Official Groq OpenAI-compatible endpoint. https://console.groq.com/docs/models */
export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Static list taken from Groq's production/preview tables on 2026-10-05
 * (https://console.groq.com/docs/models) plus the deprecations page
 * (https://console.groq.com/docs/deprecations).
 *
 * Removed (shutdown): llama-3.2-11b-vision-preview, llama-3.2-90b-vision-preview,
 * llama-3.2-3b-preview, llama-3.2-1b-preview (April 2025).
 *
 * llama-3.1-8b-instant and llama-3.3-70b-versatile remain on the production
 * table for enterprise committed-spend; free/developer tiers were shut down
 * 2026-08-16 in favour of openai/gpt-oss-20b and openai/gpt-oss-120b.
 *
 * maxTokenAllowed is Groq's documented max completion tokens.
 */
const GROQ_STATIC_MODELS: ModelInfo[] = [
  { name: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Groq)', provider: 'Groq', maxTokenAllowed: 65536 },
  { name: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Groq)', provider: 'Groq', maxTokenAllowed: 65536 },
  { name: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B (Groq, preview)', provider: 'Groq', maxTokenAllowed: 16384 },
  {
    name: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant (Groq, enterprise)',
    provider: 'Groq',
    maxTokenAllowed: 131072,
  },
  {
    name: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B Versatile (Groq, enterprise)',
    provider: 'Groq',
    maxTokenAllowed: 32768,
  },
];

const GROQ_MAX_TOKENS: Record<string, number> = Object.fromEntries(
  GROQ_STATIC_MODELS.map((model) => [model.name, model.maxTokenAllowed]),
);

const NON_CHAT_MODEL = /whisper|tts|orpheus|guard|canopylabs/i;

export default class GroqProvider extends BaseProvider {
  name = 'Groq';
  getApiKeyLink = 'https://console.groq.com/keys';

  config = {
    apiTokenKey: 'GROQ_API_KEY',
    baseUrlKey: 'GROQ_API_BASE_URL',
  };

  staticModels: ModelInfo[] = GROQ_STATIC_MODELS;

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    try {
      const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
        apiKeys,
        providerSettings: settings,
        serverEnv,
        defaultBaseUrlKey: 'GROQ_API_BASE_URL',
        defaultApiTokenKey: 'GROQ_API_KEY',
      });

      if (!apiKey) {
        return [];
      }

      const endpoint = `${(baseUrl || GROQ_DEFAULT_BASE_URL).replace(/\/$/, '')}/models`;
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        return [];
      }

      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = Array.isArray(body.data) ? body.data : [];

      return models
        .map((model) => (typeof model.id === 'string' ? model.id : ''))
        .filter((id) => id && !NON_CHAT_MODEL.test(id))
        .map((id) => ({
          name: id,
          label: `${id} (Groq)`,
          provider: this.name,
          maxTokenAllowed: GROQ_MAX_TOKENS[id] ?? 8192,
        }));
    } catch {
      return [];
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { apiKey, baseUrl } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: 'GROQ_API_BASE_URL',
      defaultApiTokenKey: 'GROQ_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const openai = createOpenAI({
      baseURL: baseUrl || GROQ_DEFAULT_BASE_URL,
      apiKey,
    });

    return openai(model);
  }
}
