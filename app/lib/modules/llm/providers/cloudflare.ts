import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';
import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';

type WorkersRole = 'system' | 'user' | 'assistant' | 'tool';
type WorkersMessage = { role: WorkersRole; content: string };

type WorkersAiTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

type WorkersAiResult = {
  response?: string;
  tool_calls?: Array<{
    name?: string;
    arguments?: unknown;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
};

const STREAM_BUFFER_LIMIT = 1024 * 1024;

function getTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return content == null ? '' : JSON.stringify(content);
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      const value = part as Record<string, unknown>;

      if (value.type === 'text' && typeof value.text === 'string') {
        return value.text;
      }

      if (value.type === 'tool-call') {
        return `[Tool call: ${String(value.toolName)} ${JSON.stringify(value.args)}]`;
      }

      if (value.type === 'tool-result') {
        return `[Tool result: ${JSON.stringify(value.result)}]`;
      }

      if (value.type === 'image') {
        return '[Image content omitted]';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toWorkersMessages(prompt: LanguageModelV1CallOptions['prompt']): WorkersMessage[] {
  return prompt.map((message) => ({
    role: message.role,
    content: getTextContent(message.content),
  }));
}

function toWorkersTools(options: LanguageModelV1CallOptions): WorkersAiTool[] | undefined {
  if (options.mode.type !== 'regular' || !options.mode.tools || options.mode.tools.length === 0) {
    return undefined;
  }

  if (options.mode.toolChoice?.type === 'none') {
    return undefined;
  }

  const tools: WorkersAiTool[] = [];

  for (const tool of options.mode.tools) {
    if (tool.type === 'provider-defined') {
      continue;
    }

    tools.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    });
  }

  return tools;
}

function makeToolCall(toolCall: { name?: string; arguments?: unknown }, index: number) {
  const toolName = toolCall.name;

  if (!toolName) {
    return undefined;
  }

  return {
    toolCallType: 'function' as const,
    toolCallId: `cloudflare-tool-${index}`,
    toolName,
    args: typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments ?? {}),
  };
}

function getUsage(result: WorkersAiResult) {
  return {
    promptTokens: result.usage?.prompt_tokens ?? 0,
    completionTokens: result.usage?.completion_tokens ?? 0,
  };
}

function parseJsonLine(line: string): WorkersAiResult | undefined {
  const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();

  if (!data || data === '[DONE]') {
    return undefined;
  }

  try {
    return JSON.parse(data) as WorkersAiResult;
  } catch {
    return data.length > 0 ? { response: data } : undefined;
  }
}

function streamWorkersResponse(response: ReadableStream<Uint8Array>): ReadableStream<LanguageModelV1StreamPart> {
  return new ReadableStream<LanguageModelV1StreamPart>({
    async start(controller) {
      const reader = response.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let bytesRead = 0;
      let toolCallIndex = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      const emittedToolCalls = new Set<string>();

      const emit = (result: WorkersAiResult) => {
        if (result.response) {
          controller.enqueue({ type: 'text-delta', textDelta: result.response });
        }

        promptTokens = result.usage?.prompt_tokens ?? promptTokens;
        completionTokens = result.usage?.completion_tokens ?? completionTokens;

        for (const toolCall of result.tool_calls ?? []) {
          const parsed = makeToolCall(toolCall, toolCallIndex);

          if (parsed && !emittedToolCalls.has(parsed.toolCallId)) {
            emittedToolCalls.add(parsed.toolCallId);
            toolCallIndex += 1;
            controller.enqueue({ type: 'tool-call', ...parsed });
          }
        }
      };

      const consumeLine = (line: string) => {
        const result = parseJsonLine(line);

        if (result) {
          emit(result);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          bytesRead += value.byteLength;

          if (bytesRead > STREAM_BUFFER_LIMIT) {
            throw new Error('Cloudflare Workers AI stream exceeded the 1 MiB safety limit');
          }

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          lines.forEach(consumeLine);
        }

        buffer += decoder.decode();

        if (buffer.trim()) {
          buffer.split(/\r?\n/).forEach(consumeLine);
        }

        controller.enqueue({
          type: 'finish',
          finishReason: toolCallIndex > 0 ? 'tool-calls' : 'stop',
          usage: { promptTokens, completionTokens },
        });
        controller.close();
      } catch (error) {
        controller.enqueue({ type: 'error', error });
        controller.close();
      }
    },
  });
}

function getWorkersInput(options: LanguageModelV1CallOptions, stream: boolean): Record<string, unknown> {
  const input: Record<string, unknown> = {
    messages: toWorkersMessages(options.prompt),
    stream,
  };

  if (options.maxTokens !== undefined) {
    input.max_tokens = options.maxTokens;
  }

  if (options.temperature !== undefined) {
    input.temperature = options.temperature;
  }

  if (options.topP !== undefined) {
    input.top_p = options.topP;
  }

  const tools = toWorkersTools(options);

  if (tools) {
    input.tools = tools;
  }

  return input;
}

function getResult(value: unknown): WorkersAiResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloudflare Workers AI returned an invalid non-streaming response');
  }

  return value as WorkersAiResult;
}

function createModel(serverEnv: Env, model: string): LanguageModelV1 {
  const binding = serverEnv?.AI as unknown as WorkersAiBinding | undefined;

  const getBinding = () => {
    if (!binding || typeof binding.run !== 'function') {
      throw new Error(
        'Cloudflare Workers AI binding is unavailable. Add [ai] binding = "AI" to wrangler.toml and deploy the Worker with Workers AI enabled.',
      );
    }

    return binding;
  };

  return {
    specificationVersion: 'v1',
    provider: 'Cloudflare',
    modelId: model,
    defaultObjectGenerationMode: undefined,
    supportsImageUrls: false,

    async doGenerate(options) {
      const result = getResult(await getBinding().run(model, getWorkersInput(options, false)));
      const toolCalls = (result.tool_calls ?? [])
        .map((toolCall, index) => makeToolCall(toolCall, index))
        .filter((toolCall): toolCall is NonNullable<typeof toolCall> => !!toolCall);

      return {
        text: result.response,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
        usage: getUsage(result),
        rawCall: {
          rawPrompt: options.prompt,
          rawSettings: getWorkersInput(options, false),
        },
      };
    },

    async doStream(options) {
      const result = await getBinding().run(model, getWorkersInput(options, true));

      if (
        !result ||
        typeof result !== 'object' ||
        typeof (result as ReadableStream<Uint8Array>).getReader !== 'function'
      ) {
        const parsed = getResult(result);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(parsed)));
            controller.close();
          },
        });

        return {
          stream: streamWorkersResponse(stream),
          rawCall: {
            rawPrompt: options.prompt,
            rawSettings: getWorkersInput(options, true),
          },
        };
      }

      return {
        stream: streamWorkersResponse(result as ReadableStream<Uint8Array>),
        rawCall: {
          rawPrompt: options.prompt,
          rawSettings: getWorkersInput(options, true),
        },
      };
    },
  };
}

export default class CloudflareProvider extends BaseProvider {
  name = 'Cloudflare';
  labelForGetApiKey = 'No API key needed';
  icon = 'i-ph:cloud';
  requiresApiKey = false;

  config = {};

  staticModels: ModelInfo[] = [
    {
      name: '@cf/meta/llama-3.1-8b-instruct-fp8',
      label: 'Llama 3.1 8B FP8 (Workers AI)',
      provider: 'Cloudflare',
      maxTokenAllowed: 4096,
    },
    {
      name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      label: 'Llama 3.3 70B Fast (Workers AI)',
      provider: 'Cloudflare',
      maxTokenAllowed: 4096,
    },
  ];

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    return createModel(options.serverEnv, options.model);
  }
}
