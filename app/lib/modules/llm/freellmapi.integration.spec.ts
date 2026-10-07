import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Import order matters: pulling in the manager first resolves the
 * registry -> base-provider -> manager -> registry cycle with the REAL
 * (unmocked) BaseProvider, which this integration test needs.
 */
import { LLMManager } from './manager';
import FreeLLMAPIProvider, { FREELLM_API_DEFAULT_BASE_URL } from './providers/freellmapi';
import { streamText, tool, jsonSchema } from 'ai';

/**
 * End-to-end audit of the FreeLLMAPI path against a faithful mock of the
 * FreeLLMAPI router (OpenAI-compatible Chat Completions, SSE streaming,
 * GLM-style tool_calls deltas). This exercises the exact runtime stack the
 * app uses in production (ai SDK v4 + @ai-sdk/openai + the provider class),
 * including the MCP-style tool loop (tools + toolChoice:'auto' + maxSteps)
 * that bolt applies when an MCP server such as Cloudflare is connected.
 *
 * The response stream is consumed through `fullStream`, mirroring how the
 * chat route consumes `result.toDataStream()` in production.
 */

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

const captured: CapturedRequest[] = [];

function chunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-audit',
    object: 'chat.completion.chunk',
    created: 1770000000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** GLM 5.3 style streaming response that asks for an MCP tool call. */
function toolCallEvents(model: string, toolName: string, callId: string, argChunks: string[]) {
  const events: unknown[] = [
    chunk(model, {
      role: 'assistant',
      content: null,
      tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: '' } }],
    }),
  ];

  for (const argChunk of argChunks) {
    events.push(chunk(model, { tool_calls: [{ index: 0, function: { arguments: argChunk } }] }));
  }

  events.push(chunk(model, {}, 'tool_calls'));

  return events;
}

function textEvents(model: string, textChunks: string[]) {
  const events: unknown[] = textChunks.map((text, index) =>
    chunk(model, index === 0 ? { role: 'assistant', content: text } : { content: text }),
  );

  events.push(chunk(model, {}, 'stop'));

  return events;
}

function sendSse(res: http.ServerResponse, events: unknown[]) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';

    req.on('data', (part) => {
      raw += part;
    });
    req.on('end', () => {
      const entry: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };

      captured.push(entry);

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'glm-5.3:free' },
              { id: 'moonshotai/Kimi-K3' },
              { id: 'glm-5.3-flash:free' },
              { id: 'qwen/qwen3.8-max:free' },
              { id: 'auto' },
              { id: '@cf/black-forest-labs/flux-2-dev' },
              { id: 'Lightricks/LTX-Video-0.9.7-distilled' },
            ],
          }),
        );

        return;
      }

      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body = entry.body;
        const model = typeof body?.model === 'string' ? body.model : 'glm-5.3:free';
        const hasToolResult = Array.isArray(body?.messages) && body.messages.some((m: any) => m.role === 'tool');

        if (hasToolResult) {
          sendSse(res, textEvents(model, ['Deployed ', 'hello-worker to production.']));
        } else {
          sendSse(
            res,
            toolCallEvents(model, 'mcp_cloudflare_workers_deploy', 'call_deploy_1', [
              '{"workerName":"hello-worker"',
              ',"env":"production"}',
            ]),
          );
        }

        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('FreeLLMAPI integration (mock router)', () => {
  const provider = new FreeLLMAPIProvider();

  it('serves the live router catalog: new chat models merged, statics deduped, media models dropped', async () => {
    const models = await provider.getDynamicModels(undefined, { baseUrl });
    const names = models.map((model) => model.name);

    // New catalog entries surface with the provider label.
    expect(names).toContain('qwen/qwen3.8-max:free');

    // The router's `auto` pseudo-model (best free model routing) is usable chat input.
    expect(names).toContain('auto');

    // Static models are deduped so the dropdown never lists them twice.
    expect(names).not.toContain('glm-5.3:free');
    expect(names).not.toContain('moonshotai/Kimi-K3');
    expect(names).not.toContain('glm-5.3-flash:free');

    // Image/video models cannot be chatted with.
    expect(names).not.toContain('@cf/black-forest-labs/flux-2-dev');
    expect(names).not.toContain('Lightricks/LTX-Video-0.9.7-distilled');

    for (const model of models) {
      expect(model.provider).toBe('FreeLLMAPI');
    }
  });

  it('runs the full GLM tool loop over HTTP exactly like the MCP chat path', async () => {
    expect(LLMManager.getInstance({}).getProvider('FreeLLMAPI')).toBeDefined();

    const model = provider.getModelInstance({
      model: 'glm-5.3:free',
      serverEnv: {} as unknown as Env,
      providerSettings: { FreeLLMAPI: { enabled: true, baseUrl } },
    });

    const deployCalls: Array<Record<string, unknown>> = [];

    const result = streamText({
      model,
      maxTokens: 32768,
      messages: [{ role: 'user', content: 'Edit my Cloudflare worker and deploy it.' }],
      tools: {
        mcp_cloudflare_workers_deploy: tool({
          description: '[MCP server: Cloudflare | risk: write] Deploy a Cloudflare Worker.',
          parameters: jsonSchema({
            type: 'object',
            properties: { workerName: { type: 'string' }, env: { type: 'string' } },
            required: ['workerName'],
          }),
          execute: async (rawArgs) => {
            const args = rawArgs as { workerName: string; env?: string };

            deployCalls.push(args);

            return { deployed: true, url: `https://${args.workerName}.example.workers.dev` };
          },
        }),
      },
      toolChoice: 'auto',
      maxSteps: 3,
    });

    const streamDone = (async () => {
      let finalText = '';

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          finalText += part.textDelta;
        }

        if (part.type === 'error') {
          throw part.error;
        }
      }

      return finalText;
    })();

    const text = await Promise.race([
      streamDone,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not complete')), 15000)),
    ]);

    // The tool loop executed and the final answer streamed back intact.
    expect(text).toBe('Deployed hello-worker to production.');
    expect(deployCalls).toEqual([{ workerName: 'hello-worker', env: 'production' }]);

    const chatRequests = captured.filter((entry) => entry.url === '/v1/chat/completions');
    expect(chatRequests).toHaveLength(2);

    const [first, second] = chatRequests;

    // Direct-connect keyless auth: placeholder bearer, correct model id and budget.
    expect(first.headers.authorization).toBe('Bearer freellmapi-no-key');
    expect(first.body.model).toBe('glm-5.3:free');
    expect(first.body.max_tokens).toBe(32768);
    expect(first.body.stream).toBe(true);
    expect(first.body.tool_choice).toBe('auto');
    expect(Array.isArray(first.body.tools)).toBe(true);
    expect(first.body.tools[0].function.name).toBe('mcp_cloudflare_workers_deploy');
    expect(first.body.messages.at(-1)).toMatchObject({ role: 'user' });

    // Step two carries the tool result back to the model (OpenAI format).
    const toolMessage = second.body.messages.find((message: any) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage.tool_call_id).toBe('call_deploy_1');
    expect(JSON.parse(toolMessage.content)).toMatchObject({ deployed: true });

    // The router endpoint shape matches FreeLLMAPI's OpenAI surface.
    expect(baseUrl.endsWith('/v1')).toBe(true);
    expect(FREELLM_API_DEFAULT_BASE_URL).toBe('http://localhost:3001/v1');
  }, 20000);
});
