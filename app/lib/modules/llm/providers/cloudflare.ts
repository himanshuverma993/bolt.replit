import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';
import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';

type WorkersRole = 'system' | 'user' | 'assistant' | 'tool';
type WorkersMessage = { role: WorkersRole; content: string; tool_call_id?: string };

type WorkersAiTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

type WorkersAiToolCall = {
  name?: string;
  arguments?: unknown;
};

/**
 * Workers AI streams tool calls in two shapes, and a chunk can carry both:
 *
 *  - the native binding shape: `{ response, tool_calls: [{ name, arguments }] }`
 *  - the OpenAI-compatible shape: `{ choices: [{ delta: { content, tool_calls } }] }`
 *    where a single call arrives as fragments - the name and the id in one
 *    chunk, the JSON arguments spread over the following ones.
 *
 * Reading only the native field loses the arguments (the call is emitted with
 * `{}`), which is exactly what production showed against a remote MCP tool, so
 * both shapes are merged here.
 */
type WorkersAiDeltaToolCall = {
  index?: number;
  name?: string;
  arguments?: unknown;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type WorkersAiChoice = {
  message?: { content?: string; tool_calls?: WorkersAiToolCall[] };
  delta?: { content?: string; tool_calls?: WorkersAiDeltaToolCall[] };
};

type WorkersAiResult = {
  response?: string;
  tool_calls?: WorkersAiToolCall[];
  choices?: WorkersAiChoice[];
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

/**
 * Workers AI (like the OpenAI chat schema) expects tool results to reference the
 * call they answer. Without `tool_call_id` a multi-step tool loop has no way to
 * associate a result with its call, which models reject or ignore.
 */
function getToolCallId(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    const value = part as Record<string, unknown>;

    if (value.type === 'tool-result' && typeof value.toolCallId === 'string' && value.toolCallId.length > 0) {
      return value.toolCallId;
    }
  }

  return undefined;
}

function toWorkersMessages(prompt: LanguageModelV1CallOptions['prompt']): WorkersMessage[] {
  return prompt.map((message) => {
    const toolCallId = getToolCallId(message.content);

    return {
      role: message.role,
      content: getTextContent(message.content),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    };
  });
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

function toArgumentText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fully accumulated tool call becomes an AI SDK v1 part. Valid JSON is passed
 * through untouched so the SDK parses exactly what the model produced; an
 * interrupted or empty fragment falls back to `{}` rather than handing the SDK
 * JSON it cannot parse (the tool then reports the missing arguments itself).
 */
function makeToolCall(call: { id: string; name: string; argumentText: string }) {
  const trimmed = call.argumentText.trim();

  return {
    toolCallType: 'function' as const,
    toolCallId: call.id,
    toolName: call.name,
    args: trimmed.length > 0 && isCompleteJson(trimmed) ? trimmed : '{}',
  };
}

/**
 * Workers AI sends a streamed token in both `response` and
 * `choices[].delta.content` on the same chunk, so the native field wins and the
 * token is not rendered twice.
 */
function getChunkText(result: WorkersAiResult): string | undefined {
  if (typeof result.response === 'string' && result.response.length > 0) {
    return result.response;
  }

  const parts = (result.choices ?? [])
    .map((choice) => choice.delta?.content)
    .filter((content): content is string => typeof content === 'string' && content.length > 0);

  return parts.length > 0 ? parts.join('') : undefined;
}

function getResultText(result: WorkersAiResult): string {
  if (typeof result.response === 'string' && result.response.length > 0) {
    return result.response;
  }

  return (result.choices ?? [])
    .map((choice) => choice.message?.content)
    .filter((content): content is string => typeof content === 'string')
    .join('');
}

function getResultToolCalls(result: WorkersAiResult): WorkersAiToolCall[] {
  const calls = [...(result.tool_calls ?? [])];

  for (const choice of result.choices ?? []) {
    calls.push(...(choice.message?.tool_calls ?? []));
  }

  return calls;
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
      let nativeToolCallIndex = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: 'stop' | 'tool-calls' = 'stop';
      const emittedToolCalls = new Set<string>();
      const streamedToolCalls = new Map<number, { id: string; name: string; argumentText: string }>();

      const emitToolCall = (call: { id: string; name: string; argumentText: string }) => {
        if (emittedToolCalls.has(call.id)) {
          return;
        }

        emittedToolCalls.add(call.id);
        finishReason = 'tool-calls';
        controller.enqueue({ type: 'tool-call', ...makeToolCall(call) });
      };

      /**
       * Accumulates OpenAI-style fragments until the arguments form complete
       * JSON, then emits the call. Fragments that never complete are flushed
       * when the stream ends so a truncated call is still surfaced.
       */
      const accumulateToolCall = (fragment: WorkersAiDeltaToolCall) => {
        const index = typeof fragment.index === 'number' ? fragment.index : streamedToolCalls.size;
        const call = streamedToolCalls.get(index) ?? { id: `cloudflare-tool-${index}`, name: '', argumentText: '' };
        const name = fragment.function?.name ?? fragment.name;

        if (typeof name === 'string' && name.length > 0) {
          call.name = name;
        }

        const args = fragment.function?.arguments ?? fragment.arguments;

        if (typeof args === 'string') {
          call.argumentText += args;
        } else if (args !== undefined && args !== null) {
          // A non-string value can only be a fully materialised argument object.
          call.argumentText = toArgumentText(args);
        }

        streamedToolCalls.set(index, call);

        if (call.name.length > 0 && isCompleteJson(call.argumentText)) {
          emitToolCall(call);
        }
      };

      const emit = (result: WorkersAiResult) => {
        const text = getChunkText(result);

        if (text) {
          controller.enqueue({ type: 'text-delta', textDelta: text });
        }

        promptTokens = result.usage?.prompt_tokens ?? promptTokens;
        completionTokens = result.usage?.completion_tokens ?? completionTokens;

        for (const toolCall of result.tool_calls ?? []) {
          if (!toolCall.name) {
            continue;
          }

          emitToolCall({
            id: `cloudflare-tool-${nativeToolCallIndex}`,
            name: toolCall.name,
            argumentText: toArgumentText(toolCall.arguments),
          });
          nativeToolCallIndex += 1;
        }

        for (const choice of result.choices ?? []) {
          for (const fragment of choice.delta?.tool_calls ?? []) {
            accumulateToolCall(fragment);
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

        for (const call of streamedToolCalls.values()) {
          if (call.name.length > 0) {
            emitToolCall(call);
          }
        }

        controller.enqueue({
          type: 'finish',
          finishReason,
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
      const toolCalls = getResultToolCalls(result)
        .map((toolCall, index) =>
          toolCall.name
            ? makeToolCall({
                id: `cloudflare-tool-${index}`,
                name: toolCall.name,
                argumentText: toArgumentText(toolCall.arguments),
              })
            : undefined,
        )
        .filter((toolCall): toolCall is NonNullable<typeof toolCall> => !!toolCall);

      return {
        text: getResultText(result),
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
