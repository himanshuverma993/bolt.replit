import { describe, expect, it, vi } from 'vitest';
import { jsonSchema, streamText, tool } from 'ai';

vi.mock('~/lib/modules/llm/base-provider', () => ({
  BaseProvider: class {},
}));

import CloudflareProvider from './cloudflare';

/**
 * End-to-end tool loop over the Cloudflare Workers AI adapter.
 *
 * `mcp.ts` hands the model tools built with `tool()`/`jsonSchema()`; this suite
 * drives the real AI SDK v4 `streamText` loop against a stubbed `env.AI.run`
 * binding so the whole round trip is exercised: tool definitions sent to
 * Workers AI, the streamed tool call mapped back to the SDK, the tool executed,
 * its result returned to Workers AI with the matching `tool_call_id`, and the
 * final text assembled - plus the step limit that keeps a looping model from
 * running forever.
 */

type BindingCall = { model: string; input: Record<string, unknown> };

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

function modelWith(bindingCalls: BindingCall[]) {
  const provider = new CloudflareProvider();
  const run = async (modelName: string, input: Record<string, unknown>) => {
    bindingCalls.push({ model: modelName, input });

    if (bindingCalls.length === 1) {
      // First Workers AI call: answer with a tool call instead of text.
      return sseStream([
        JSON.stringify({ response: '', tool_calls: [{ name: 'get_status', arguments: { id: 'abc' } }] }),
      ]);
    }

    return sseStream([JSON.stringify({ response: 'All good' }), JSON.stringify({ response: ' for abc' })]);
  };

  return provider.getModelInstance({
    model: provider.staticModels[0].name,
    serverEnv: { AI: { run } } as unknown as Env,
  });
}

function statusTool(executions: Array<Record<string, unknown>>) {
  return {
    get_status: tool({
      description: 'Look up the status of a job.',
      parameters: jsonSchema({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      }),
      execute: async (args: unknown) => {
        const parsed = args as Record<string, unknown>;

        executions.push(parsed);

        return { ok: true, id: parsed.id };
      },
    }),
  };
}

describe('Cloudflare Workers AI tool loop (AI SDK v4 streamText)', () => {
  it('executes a tool, returns its result with the tool_call_id, and streams the final answer', async () => {
    const bindingCalls: BindingCall[] = [];
    const executions: Array<Record<string, unknown>> = [];
    const result = streamText({
      model: modelWith(bindingCalls),
      prompt: 'Check the status of job abc.',
      maxSteps: 3,
      tools: statusTool(executions),
    });

    /*
     * The loop is pull-based: draining the stream drives the tool execution and
     * the follow-up model call, so it must happen before the aggregated
     * text/steps promises resolve.
     */
    for await (const part of result.fullStream) {
      void part;
    }

    const text = await result.text;
    const steps = await result.steps;

    expect(executions).toEqual([{ id: 'abc' }]);
    expect(text).toBe('All good for abc');
    expect(steps).toHaveLength(2);

    // Two Workers AI calls: the tool call and the follow-up answer.
    expect(bindingCalls).toHaveLength(2);
    expect(bindingCalls[0].input.stream).toBe(true);

    // Step one offers the tool schema to Workers AI in the OpenAI shape.
    expect(bindingCalls[0].input.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_status',
          description: 'Look up the status of a job.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    ]);

    // Step two carries the assistant tool call and the tool result, bound by id.
    const messages = bindingCalls[1].input.messages as Array<Record<string, unknown>>;
    const assistant = messages.find(
      (message) => typeof message.content === 'string' && message.content.includes('Tool call'),
    );

    expect(assistant?.role).toBe('assistant');
    expect(String(assistant?.content)).toContain('[Tool call: get_status');

    const toolMessage = messages.at(-1);

    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'cloudflare-tool-0' });
    expect(String(toolMessage?.content)).toContain('"ok":true');
  });

  it('stops at maxSteps instead of looping forever when the model keeps calling tools', async () => {
    const bindingCalls: BindingCall[] = [];
    const provider = new CloudflareProvider();
    const run = async (modelName: string, input: Record<string, unknown>) => {
      bindingCalls.push({ model: modelName, input });

      return sseStream([
        JSON.stringify({ response: '', tool_calls: [{ name: 'get_status', arguments: { id: 'loop' } }] }),
      ]);
    };
    const model = provider.getModelInstance({
      model: provider.staticModels[0].name,
      serverEnv: { AI: { run } } as unknown as Env,
    });
    const executions: Array<Record<string, unknown>> = [];
    const result = streamText({
      model,
      prompt: 'Keep checking.',
      maxSteps: 2,
      tools: statusTool(executions),
    });

    for await (const part of result.fullStream) {
      void part;
    }

    await result.text;
    await result.steps;

    // The SDK ran the tool on both steps and stopped at the configured limit.
    expect(executions).toEqual([{ id: 'loop' }, { id: 'loop' }]);
    expect(bindingCalls).toHaveLength(2);
    expect(await result.finishReason).toBe('tool-calls');
  });
});
