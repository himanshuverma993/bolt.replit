import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

/**
 * FreeLLMAPI (https://freellmapi.co/) is a self-hosted, OpenAI-compatible
 * router that fronts every major free model tier (UnoRouter, HuggingFace
 * Router, Cloudflare Workers AI, NVIDIA NIM, ...) behind a single endpoint.
 *
 * The router listens on `http://localhost:3001/v1` by default and serves
 * `/v1/chat/completions` plus tool calling, so bolt's agentic flow works
 * against it directly — no hosted middleman and no mandatory API key
 * (the unified key from the router dashboard is optional and only needed
 * if the router is configured to require one).
 */
export const FREELLM_API_DEFAULT_BASE_URL = 'http://localhost:3001/v1';

/**
 * Static catalog taken from the FreeLLMAPI free-model catalog on 2026-10-07
 * (https://freellmapi.co/models). These are the flagship free *agentic
 * coding* models: tool-calling support is what makes them usable by bolt's
 * action/tool pipeline.
 *
 * - `glm-5.3:free`        Zhipu GLM 5.3 via UnoRouter — 1M context, tools.
 * - `moonshotai/Kimi-K3`  Moonshot Kimi K3 — 262K context, tools, one of
 *                         the strongest free agentic coding models.
 * - `glm-5.3-flash:free`  Fast GLM 5.3 variant via UnoRouter — 1M context.
 *
 * maxTokenAllowed is the completion-token budget passed to the model; the
 * values stay conservative because free tiers meter output tokens and bolt
 * transparently continues long generations via its continuation flow.
 */
const FREELLM_STATIC_MODELS: ModelInfo[] = [
  {
    name: 'glm-5.3:free',
    label: 'GLM 5.3 (FreeLLMAPI · free)',
    provider: 'FreeLLMAPI',
    maxTokenAllowed: 16384,
  },
  {
    name: 'moonshotai/Kimi-K3',
    label: 'Kimi K3 (FreeLLMAPI · free)',
    provider: 'FreeLLMAPI',
    maxTokenAllowed: 16384,
  },
  {
    name: 'glm-5.3-flash:free',
    label: 'GLM 5.3 Flash (FreeLLMAPI · free)',
    provider: 'FreeLLMAPI',
    maxTokenAllowed: 8192,
  },
];

const FREELLM_STATIC_MODEL_NAMES = new Set(FREELLM_STATIC_MODELS.map((model) => model.name));

/** Media/modality models the router also lists but bolt cannot chat with. */
const NON_CHAT_MODEL = /flux|ltx|image|video|tts|whisper|speech|embed|audio|music|sdxl|stable-diffusion|dall|robotics/i;

/** Keep the dropdown usable even if a router exposes hundreds of models. */
const MAX_DYNAMIC_MODELS = 50;

export default class FreeLLMAPIProvider extends BaseProvider {
  name = 'FreeLLMAPI';
  getApiKeyLink = 'https://freellmapi.co/';
  labelForGetApiKey = 'About FreeLLMAPI';
  icon = 'i-ph:info';
  requiresApiKey = false;
  noApiKeyNote =
    'no API key needed — free agentic coding models (GLM 5.3, Kimi K3) run through the FreeLLMAPI router. ' +
    'If your router is not at the default URL, set its base URL under Settings → Providers.';

  config = {
    baseUrlKey: 'FREELLM_API_BASE_URL',
    apiTokenKey: 'FREELLM_API_KEY',
  };

  staticModels: ModelInfo[] = FREELLM_STATIC_MODELS;

  /**
   * Pulls the live model list off a configured router. The fetch only runs
   * when the user has actually pointed us at a router (settings or env), so
   * the default experience stays instant and never blocks on a missing
   * local router.
   */
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
        defaultBaseUrlKey: 'FREELLM_API_BASE_URL',
        defaultApiTokenKey: 'FREELLM_API_KEY',
      });

      if (!baseUrl) {
        return [];
      }

      const headers: Record<string, string> = {};

      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl}/models`, { headers });

      if (!response.ok) {
        return [];
      }

      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = Array.isArray(body.data) ? body.data : [];

      return models
        .map((model) => (typeof model.id === 'string' ? model.id : ''))
        .filter((id) => id && !FREELLM_STATIC_MODEL_NAMES.has(id) && !NON_CHAT_MODEL.test(id))
        .slice(0, MAX_DYNAMIC_MODELS)
        .map((id) => ({
          name: id,
          label: `${id} (FreeLLMAPI)`,
          provider: this.name,
          maxTokenAllowed: 8192,
        }));
    } catch {
      return [];
    }
  }

  /**
   * FreeLLMAPI is keyless by design: the request goes straight to the
   * router, optionally authenticated with the unified key when one is set.
   * This must never throw for a missing key — that is what makes the
   * provider "direct connect".
   */
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
      defaultBaseUrlKey: 'FREELLM_API_BASE_URL',
      defaultApiTokenKey: 'FREELLM_API_KEY',
    });

    const openai = createOpenAI({
      baseURL: baseUrl || FREELLM_API_DEFAULT_BASE_URL,
      apiKey: apiKey || 'freellmapi-no-key',
    });

    return openai(model);
  }
}
