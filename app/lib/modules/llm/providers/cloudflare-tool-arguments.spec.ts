import { describe, expect, it, vi } from 'vitest';
import { jsonSchema, streamText, tool } from 'ai';
import type { LanguageModelV1CallOptions } from 'ai';

vi.mock('~/lib/modules/llm/base-provider', () => ({
  BaseProvider: class {},
}));

import CloudflareProvider from './cloudflare';

/**
 * Workers AI streams a tool call as fragments: the name in one chunk and the
 * JSON arguments split over the following ones (`choices[].delta.tool_calls`).
 *
 * Live evidence from the production deployment showed what happens when only
 * the native `tool_calls` field is read: the model produced a structured call,
 * the adapter emitted it with `args: {}`, and the remote MCP tool rejected the
 * invocation. These tests pin the accumulation behaviour for both the fragment
 * shape and the plain native shape.
 */

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(`data: ${frame}\n`));
      }

      controller.close();
    },
  });
}

function makeOptions(overrides: Partial<LanguageModelV1CallOptions> = {}): LanguageModelV1CallOptions {
  return {
    inputFormat: 'messages',
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Search the Cloudflare docs.' }] }],
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

function modelWithStream(frames: string[]) {
  const provider = new CloudflareProvider();
  const run = async () => sseStream(frames);

  return provider.getModelInstance({
    model: provider.staticModels[1].name,
    serverEnv: { AI: { run } } as unknown as Env,
  });
}

function deltaFrame(fragment: Record<string, unknown>) {
  return JSON.stringify({ choices: [{ delta: { tool_calls: [fragment] } }] });
}

const fragmentedCall = [
  JSON.stringify({
    response: '',
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_abc', function: { name: 'search_cloudflare_documentation', arguments: '' } },
          ],
        },
      },
    ],
  }),
  deltaFrame({ index: 0, function: { arguments: '{"query"' } }),
  deltaFrame({ index: 0, function: { arguments: ':"Workers AI"}' } }),
];

describe('CloudflareProvider streamed tool-call fragments', () => {
  it('accumulates fragmented arguments into one complete AI SDK tool call', async () => {
    const model = modelWithStream(fragmentedCall);

    const parts = (await readStream((await model.doStream(makeOptions())).stream)) as Array<Record<string, unknown>>;
    const toolCalls = parts.filter((part) => part.type === 'tool-call');

    expect(toolCalls).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'cloudflare-tool-0',
        toolName: 'search_cloudflare_documentation',
        args: '{"query":"Workers AI"}',
      },
    ]);
    expect(parts[parts.length - 1]).toMatchObject({ type: 'finish', finishReason: 'tool-calls' });
  });

  it('emits the call as soon as the arguments are complete, not only at the end', async () => {
    const model = modelWithStream([
      ...fragmentedCall,

      // A later text chunk must arrive after the call, proving it was not deferred.
      JSON.stringify({ response: 'Done.', usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    ]);

    const parts = (await readStream((await model.doStream(makeOptions())).stream)) as Array<Record<string, unknown>>;

    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
    expect(parts.findIndex((part) => part.type === 'tool-call')).toBeLessThan(
      parts.findIndex((part) => part.type === 'text-delta'),
    );
    expect(parts[parts.length - 1]).toMatchObject({ usage: { promptTokens: 11, completionTokens: 7 } });
  });

  it('does not render a token twice when the chunk carries it in both shapes', async () => {
    const model = modelWithStream([
      JSON.stringify({ response: 'Hi', choices: [{ delta: { content: 'Hi' } }] }),
      JSON.stringify({ response: ' there', choices: [{ delta: { content: ' there' } }] }),
    ]);

    const parts = (await readStream((await model.doStream(makeOptions())).stream)) as Array<Record<string, unknown>>;

    expect(parts.filter((part) => part.type === 'text-delta')).toEqual([
      { type: 'text-delta', textDelta: 'Hi' },
      { type: 'text-delta', textDelta: ' there' },
    ]);
  });

  it('streams text that only arrives in the OpenAI-compatible shape', async () => {
    const model = modelWithStream([
      JSON.stringify({ choices: [{ delta: { content: 'OpenAI' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '-style' } }] }),
    ]);

    const parts = (await readStream((await model.doStream(makeOptions())).stream)) as Array<Record<string, unknown>>;

    expect(parts.filter((part) => part.type === 'text-delta')).toEqual([
      { type: 'text-delta', textDelta: 'OpenAI' },
      { type: 'text-delta', textDelta: '-style' },
    ]);
  });

  it('still surfaces a truncated call when the stream ends mid-argument', async () => {
    const model = modelWithStream([
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"query":"Wor' } }] } }],
      }),
    ]);

    const parts = (await readStream((await model.doStream(makeOptions())).stream)) as Array<Record<string, unknown>>;

    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'cloudflare-tool-0',
        toolName: 'search',
        args: '{}',
      },
    ]);
    expect(parts[parts.length - 1]).toMatchObject({ type: 'finish', finishReason: 'tool-calls' });
  });

  it('keeps the native complete-call shape working', async () => {
    const model = modelWithStream([
      JSON.stringify({ response: '', tool_calls: [{ name: 'get_status', arguments: { id: 'abc' } }] }),
    ]);

    const parts = (await readStream((await model.doStream(makeOptions())).stream)) as Array<Record<string, unknown>>;

    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'cloudflare-tool-0',
        toolName: 'get_status',
        args: '{"id":"abc"}',
      },
    ]);
  });

  it('drives a full tool loop with fragmented arguments and feeds the result back', async () => {
    const provider = new CloudflareProvider();
    const bindingCalls: Array<Record<string, unknown>> = [];
    const executions: Array<Record<string, unknown>> = [];

    const run = async (_model: string, input: Record<string, unknown>) => {
      bindingCalls.push(input);

      if (bindingCalls.length === 1) {
        return sseStream(fragmentedCall);
      }

      return sseStream([JSON.stringify({ response: 'Found it.' })]);
    };

    const model = provider.getModelInstance({
      model: provider.staticModels[1].name,
      serverEnv: { AI: { run } } as unknown as Env,
    });

    const result = streamText({
      model,
      maxSteps: 3,
      prompt: 'Search the Cloudflare docs for Workers AI.',
      tools: {
        search_cloudflare_documentation: tool({
          description: 'Search the Cloudflare developer documentation.',
          parameters: jsonSchema<{ query: string }>({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          }),
          execute: async (args) => {
            executions.push(args as Record<string, unknown>);

            return { results: ['Workers AI documentation'] };
          },
        }),
      },
    });

    for await (const part of result.fullStream) {
      void part;
    }

    const text = await result.text;

    expect(text).toBe('Found it.');
    expect(executions).toEqual([{ query: 'Workers AI' }]);

    const followUpMessages = bindingCalls[1].messages as Array<Record<string, unknown>>;
    const toolMessage = followUpMessages.find((message) => message.role === 'tool');

    expect(toolMessage).toBeDefined();
    expect(toolMessage?.tool_call_id).toBe('cloudflare-tool-0');
  });
});
