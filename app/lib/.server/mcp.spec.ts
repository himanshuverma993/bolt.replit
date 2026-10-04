import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callMcpTool,
  discoverMcpTools,
  getMcpTools,
  mcpStateHeaders,
  readMcpState,
  type McpServerConfig,
  MCP_MAX_TOOL_OUTPUT,
} from './mcp';

type MockMode = 'normal' | 'malformed' | 'error' | 'hang' | 'large';

const servers: Server[] = [];
let lastAuthorization: string | undefined;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function writeJson(response: ServerResponse, body: unknown, session = true) {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');

  if (session) {
    response.setHeader('Mcp-Session-Id', 'mock-session');
  }

  response.end(JSON.stringify(body));
}

async function startMock(mode: MockMode = 'normal'): Promise<string> {
  const server = createServer(async (request, response) => {
    lastAuthorization = request.headers.authorization;

    if (mode === 'hang') {
      return;
    }

    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.end();

      return;
    }

    const body = await readBody(request);

    if (mode === 'malformed') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.end('{not-json');

      return;
    }

    if (mode === 'error') {
      response.statusCode = 500;
      response.end('mock failure');

      return;
    }

    const message = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };

    if (message.method === 'notifications/initialized') {
      response.statusCode = 202;
      response.end();

      return;
    }

    if (message.method === 'initialize') {
      writeJson(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'local-mock', version: '1.0.0' },
        },
      });
      return;
    }

    if (message.method === 'tools/list') {
      writeJson(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo a value for MCP integration tests.',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          ],
        },
      });
      return;
    }

    if (message.method === 'tools/call') {
      const args = (message.params?.arguments ?? {}) as { value?: string };
      const value = mode === 'large' ? 'x'.repeat(MCP_MAX_TOOL_OUTPUT + 100) : args.value;
      writeJson(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: value ?? '' }] },
      });

      return;
    }

    writeJson(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } });
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Mock MCP server did not receive a TCP address');
  }

  return `http://127.0.0.1:${address.port}/mcp`;
}

function config(url: string): McpServerConfig {
  return {
    id: 'local-server',
    name: 'Local mock',
    url,
    enabled: true,
    status: 'connected',
    tools: [
      {
        name: 'echo',
        description: 'Echo a value for MCP integration tests.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ],
  };
}

afterEach(async () => {
  lastAuthorization = undefined;

  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('MCP Streamable HTTP integration', () => {
  it('discovers tools and executes a tool end-to-end against a local mock server', async () => {
    const url = await startMock();
    const server = config(url);
    const tools = await discoverMcpTools(server);
    const result = await callMcpTool(server, undefined, 'echo', { value: 'hello from bolt' });
    const stateHeaders = await mcpStateHeaders([server], {}, {} as Env);
    const stateRequest = new Request('http://localhost/api/chat', {
      headers: {
        Cookie: stateHeaders
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      },
    });
    const chatTools = await getMcpTools(stateRequest, {} as Env);
    const execute = chatTools.mcp_Local_mock_echo.execute;
    const chatToolResult = await execute?.(
      { value: 'hello from chat tool loop' },
      {
        toolCallId: 'local-tool-call',
        messages: [],
      },
    );

    expect(tools).toEqual([expect.objectContaining({ name: 'echo' })]);
    expect(result).toContain('hello from bolt');
    expect(chatToolResult).toEqual({
      server: 'Local mock',
      tool: 'echo',
      result: expect.stringContaining('hello from chat tool loop'),
    });
  });

  it('sends bearer credentials as a server-side header', async () => {
    const url = await startMock();
    const result = await callMcpTool(config(url), 'unit-test-bearer', 'echo', { value: 'authenticated' });

    expect(result).toContain('authenticated');
    expect(lastAuthorization).toBe('Bearer unit-test-bearer');
    expect(url).not.toContain('unit-test-bearer');
  });

  it('returns a bounded result when a tool exceeds the output cap', async () => {
    const url = await startMock('large');
    const result = await callMcpTool(config(url), undefined, 'echo', { value: 'ignored' });

    expect(result).toContain(`exceeded the ${MCP_MAX_TOOL_OUTPUT}-byte limit`);
    expect(result.length).toBeLessThan(200);
  });

  it('turns malformed and HTTP failures into clear tool errors', async () => {
    const malformedUrl = await startMock('malformed');
    const httpErrorUrl = await startMock('error');
    const malformed = await callMcpTool(config(malformedUrl), undefined, 'echo', { value: 'ignored' });
    const httpError = await callMcpTool(config(httpErrorUrl), undefined, 'echo', { value: 'ignored' });

    expect(malformed).toMatch(/failed|error/i);
    expect(httpError).toMatch(/failed|error/i);
  });

  it('stores bearer credentials encrypted and does not expose them in public state', async () => {
    const url = await startMock();
    const server = config(url);
    const secret = 'test-cookie-secret';
    const headers = await mcpStateHeaders([server], { [server.id]: 'bearer-test-value' }, {
      MCP_COOKIE_SECRET: secret,
    } as Env);
    const cookies = headers.getSetCookie();
    const publicCookie = cookies.find((cookie) => cookie.startsWith('mcpServers='));
    const secretCookie = cookies.find((cookie) => cookie.startsWith('mcpSecrets='));

    expect(publicCookie).toBeDefined();
    expect(publicCookie).not.toContain('bearer-test-value');
    expect(secretCookie).toBeDefined();
    expect(secretCookie).not.toContain('bearer-test-value');

    const request = new Request('http://localhost/api/mcp', {
      headers: { Cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') },
    });
    const state = await readMcpState(request, { MCP_COOKIE_SECRET: secret } as Env);

    expect(state.secrets[server.id]).toBe('bearer-test-value');
  });

  it('does not create tools when MCP state has no enabled server', async () => {
    const request = new Request('http://localhost/api/chat');
    const disabledRequest = new Request('http://localhost/api/chat', {
      headers: { Cookie: 'mcpServers=%5B%5D; mcpSecrets=stale-cookie' },
    });

    expect(await getMcpTools(request, {} as Env)).toEqual({});
    expect(await getMcpTools(disabledRequest, {} as Env)).toEqual({});
  });
});
