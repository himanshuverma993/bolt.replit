import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioural pin for the MCP tool-loop wiring in `stream-text`.
 *
 * The AI SDK v4 call is mocked, so what is asserted here is exactly the contract
 * that matters to a user:
 *
 *  - without a request (or with no tools configured) the model is called with
 *    **no** `tools`, `maxSteps` or `toolChoice` at all - the pre-MCP behaviour;
 *  - with tools, the tool map is passed together with the bounded step count
 *    (`MCP_MAX_STEPS`, 3) and `toolChoice: 'auto'`.
 */

const mocks = vi.hoisted(() => ({
  streamText: vi.fn((args: Record<string, unknown>) => ({ args })),
  convertToCoreMessages: vi.fn((messages: unknown) => messages),
  getMcpTools: vi.fn(async () => ({}) as Record<string, unknown>),
  getModelList: vi.fn(async () => [] as Array<{ name: string; maxTokenAllowed?: number }>),
}));

vi.mock('ai', () => ({
  streamText: mocks.streamText,
  convertToCoreMessages: mocks.convertToCoreMessages,
}));

vi.mock('~/lib/.server/mcp', () => ({
  getMcpTools: mocks.getMcpTools,
  MCP_MAX_STEPS: 3,
}));

vi.mock('~/utils/constants', () => ({
  DEFAULT_MODEL: 'demo-model',
  DEFAULT_PROVIDER: {
    name: 'Demo',
    staticModels: [{ name: 'demo-model', label: 'Demo', provider: 'Demo', maxTokenAllowed: 4096 }],
    getModelInstance: (options: unknown) => ({ options }),
  },
  getModelList: mocks.getModelList,
  MODEL_REGEX: /^\[Model: (.*?)\]\n\n/,
  PROVIDER_REGEX: /^\[Provider: (.*?)\]\n\n/,
  MODIFICATIONS_TAG_NAME: 'bolt_file_modifications',
  PROVIDER_LIST: [
    {
      name: 'Demo',
      staticModels: [{ name: 'demo-model', label: 'Demo', provider: 'Demo', maxTokenAllowed: 4096 }],
      getModelInstance: (options: unknown) => ({ options }),
    },
  ],
  WORK_DIR: '/home/project',
}));

const { streamText } = await import('./stream-text');

function callArgs(index = 0): Record<string, unknown> {
  return mocks.streamText.mock.calls[index][0] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.streamText.mockClear();
  mocks.convertToCoreMessages.mockClear();
  mocks.getMcpTools.mockClear();
  mocks.getMcpTools.mockResolvedValue({});
});

describe('streamText MCP wiring', () => {
  it('calls the model without any tool options when no request is supplied', async () => {
    await streamText({ messages: [{ role: 'user', content: 'hello' }], env: {} as Env });

    expect(mocks.getMcpTools).not.toHaveBeenCalled();

    const args = callArgs();
    expect(args.tools).toBeUndefined();
    expect(args.maxSteps).toBeUndefined();
    expect(args.toolChoice).toBeUndefined();
    expect(Object.keys(args)).not.toContain('tools');
  });

  it('keeps the no-tool behaviour when the request yields no MCP tools', async () => {
    await streamText({
      messages: [{ role: 'user', content: 'hello' }],
      env: {} as Env,
      request: new Request('https://bolt.example.test/api/chat'),
    });

    expect(mocks.getMcpTools).toHaveBeenCalledTimes(1);

    const args = callArgs();
    expect(args.tools).toBeUndefined();
    expect(args.maxSteps).toBeUndefined();
    expect(args.toolChoice).toBeUndefined();
  });

  it('passes the discovered tools with a bounded step count when tools are configured', async () => {
    mocks.getMcpTools.mockResolvedValue({
      get_page: {
        description: 'read a page',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'ok',
      },
    });

    await streamText({
      messages: [{ role: 'user', content: 'hello' }],
      env: {} as Env,
      request: new Request('https://bolt.example.test/api/chat'),
    });

    const args = callArgs();
    expect(Object.keys(args.tools as object)).toEqual(['get_page']);
    expect(args.maxSteps).toBe(3);
    expect(args.toolChoice).toBe('auto');
  });
});
