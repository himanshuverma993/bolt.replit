import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelV1, LanguageModelV1CallOptions } from 'ai';

vi.mock('~/lib/modules/llm/base-provider', () => ({
  BaseProvider: class {},
}));

import CloudflareProvider from './cloudflare';

function makeOptions(overrides: Partial<LanguageModelV1CallOptions> = {}): LanguageModelV1CallOptions {
  return {
    inputFormat: 'messages',
    prompt: [
      { role: 'system', content: 'You are a test assistant.' },
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
    ],
    mode: { type: 'regular' },
    ...overrides,
  };
}

async function readStream(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  const parts: unknown[] = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return parts;
    }

    parts.push(value);
  }
}

describe('CloudflareProvider', () => {
  it('reports an actionable error when the AI binding is absent', async () => {
    const provider = new CloudflareProvider();
    const model = provider.getModelInstance({ model: provider.staticModels[0].name, serverEnv: {} as Env });

    await expect(model.doStream(makeOptions())).rejects.toThrow('Cloudflare Workers AI binding is unavailable');
  });

  it('streams a stubbed Workers AI response through the LanguageModelV1 adapter', async () => {
    const provider = new CloudflareProvider();
    const response = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":"Hello"}\n'));
        controller.enqueue(new TextEncoder().encode('data: {"response":" from Workers AI"}\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
        controller.close();
      },
    });
    const run = async () => response;
    const model = provider.getModelInstance({
      model: provider.staticModels[0].name,
      serverEnv: { AI: { run } } as unknown as Env,
    });

    const result = await model.doStream(makeOptions());
    const parts = await readStream(result.stream);

    expect(parts).toEqual([
      { type: 'text-delta', textDelta: 'Hello' },
      { type: 'text-delta', textDelta: ' from Workers AI' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
      },
    ]);
  });

  it('maps Workers AI tool calls to AI SDK v4 tool calls', async () => {
    const provider = new CloudflareProvider();
    let capturedInput: Record<string, unknown> | undefined;
    const run = async (_model: string, input: Record<string, unknown>) => {
      capturedInput = input;
      return {
        response: '',
        tool_calls: [{ name: 'lookup', arguments: { query: 'status' } }],
      };
    };
    const model = provider.getModelInstance({
      model: provider.staticModels[1].name,
      serverEnv: { AI: { run } } as unknown as Env,
    });

    const result = await model.doGenerate(
      makeOptions({
        mode: {
          type: 'regular',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Look up a status.',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
          toolChoice: { type: 'tool', toolName: 'lookup' },
        },
      }),
    );

    expect(capturedInput?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a status.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ]);
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls?.[0]).toMatchObject({ toolName: 'lookup', args: '{"query":"status"}' });
  });

  it('exposes the v1 model contract', () => {
    const provider = new CloudflareProvider();
    const model: LanguageModelV1 = provider.getModelInstance({
      model: provider.staticModels[0].name,
      serverEnv: { AI: { run: async () => ({ response: 'ok' }) } } as unknown as Env,
    });

    expect(model.specificationVersion).toBe('v1');
    expect(model.provider).toBe('Cloudflare');
  });
});
