import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callMcpTool,
  classifyMcpError,
  classifyToolRisk,
  compactToolsForStorage,
  createMcpClientContext,
  discoverMcpTools,
  getMcpTools,
  mcpStateHeaders,
  readMcpState,
  resolveDiscoveryFailure,
  McpError,
  type McpServerConfig,
  type McpToolInfo,
  MCP_MAX_TOOL_OUTPUT,
} from './mcp';
import { cookiePairByteLength } from './secrets';

type MockMode = 'normal' | 'malformed' | 'error' | 'hang' | 'large' | 'unauthorized' | 'oauth-required';

const servers: Server[] = [];
let lastAuthorization: string | undefined;
let lastToolsCallArguments: unknown;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function jsonStatus(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
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

    if (mode === 'unauthorized') {
      response.statusCode = 401;
      response.setHeader(
        'WWW-Authenticate',
        'Bearer resource_metadata="http://example.test/.well-known/oauth-protected-resource"',
      );
      response.end('unauthorized');

      return;
    }

    if (mode === 'oauth-required') {
      response.statusCode = 401;
      response.setHeader('WWW-Authenticate', 'Bearer');
      response.end('auth required');

      return;
    }

    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.end();

      return;
    }

    const body = await readBody(request);

    if (body.trim().length === 0) {
      response.statusCode = 202;
      response.end();

      return;
    }

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

    let message: { id?: number; method?: string; params?: Record<string, unknown> };

    try {
      message = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };
    } catch {
      jsonStatus(response, 400, { error: 'malformed json' });

      return;
    }

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
              name: 'get_status',
              description: 'Read the current status.',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
            {
              name: 'delete_repository',
              description: 'Delete a repository permanently.',
              inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
            },
          ],
        },
      });
      return;
    }

    if (message.method === 'tools/call') {
      const args = (message.params?.arguments ?? {}) as { value?: string };
      lastToolsCallArguments = args;

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

function config(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'local-server',
    name: 'Local mock',
    url,
    enabled: true,
    authMode: 'authless',
    status: 'connected',
    tools: [
      {
        name: 'get_status',
        description: 'Read the current status.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        risk: 'read',
      },
      {
        name: 'delete_repository',
        description: 'Delete a repository permanently.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        risk: 'destructive',
      },
    ],
    ...overrides,
  };
}

function contextFor(env: Record<string, unknown> = {}, request?: Request) {
  return createMcpClientContext({
    request: request ?? new Request('http://localhost/api/chat'),
    env: { MCP_COOKIE_SECRET: 'unit-test-secret-value-32-chars!!', ...env },
    serverId: 'local-server',
  });
}

afterEach(async () => {
  lastAuthorization = undefined;
  lastToolsCallArguments = undefined;

  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('MCP Streamable HTTP client', () => {
  it('discovers tools and executes a read-only tool end-to-end against a local mock server', async () => {
    const url = await startMock();
    const server = config(url);
    const context = contextFor();

    const tools = await discoverMcpTools(server, context);
    const result = await callMcpTool(server, context, 'get_status', { value: 'hello from bolt' });

    expect(tools.map((tool) => tool.name)).toEqual(['get_status', 'delete_repository']);
    expect(tools[0].risk).toBe('read');
    expect(tools[1].risk).toBe('destructive');
    expect(result).toContain('hello from bolt');
  });

  it('sends bearer credentials as a server-side header only', async () => {
    const url = await startMock();
    const result = await callMcpTool(config(url, { authMode: 'bearer' }), contextFor({}, undefined), 'get_status', {
      value: 'authenticated',
    });

    // Bearer token is passed explicitly for this assertion.
    const bearerContext = createMcpClientContext({
      env: { MCP_COOKIE_SECRET: 'unit-test-secret-value-32-chars!!' },
      serverId: 'local-server',
      bearerToken: 'unit-test-bearer',
    });

    const authenticated = await callMcpTool(config(url, { authMode: 'bearer' }), bearerContext, 'get_status', {
      value: 'authenticated',
    });

    expect(result).toContain('authenticated');
    expect(authenticated).toContain('authenticated');
    expect(lastAuthorization).toBe('Bearer unit-test-bearer');
    expect(url).not.toContain('unit-test-bearer');
  });

  it('refuses destructive tools until the server is explicitly opted in', async () => {
    const url = await startMock();
    const server = config(url);
    const context = contextFor();

    const denied = await callMcpTool(server, context, 'delete_repository', { name: 'main' });

    expect(denied).toContain('was NOT executed');
    expect(denied).toContain('destructive');
    expect(lastToolsCallArguments).toBeUndefined();

    const allowed = await callMcpTool({ ...server, allowRiskyTools: true }, context, 'delete_repository', {
      name: 'main',
    });

    expect(allowed).toContain('"content"');
    expect(lastToolsCallArguments).toEqual({ name: 'main' });
  });

  it('returns a bounded result when a tool exceeds the output cap', async () => {
    const url = await startMock('large');
    const result = await callMcpTool(config(url), contextFor(), 'get_status', { value: 'ignored' });

    expect(result).toContain(`exceeded the ${MCP_MAX_TOOL_OUTPUT}-byte limit`);
    expect(result.length).toBeLessThan(200);
  });

  it('classifies HTTP 401 as an OAuth requirement and bearer failures separately', async () => {
    const url = await startMock('unauthorized');

    await expect(discoverMcpTools(config(url), contextFor())).rejects.toMatchObject({ code: 'http_401' });

    const withBearer = await discoverMcpTools(
      config(url, { authMode: 'bearer' }),
      createMcpClientContext({
        env: { MCP_COOKIE_SECRET: 'unit-test-secret-value-32-chars!!' },
        serverId: 'local-server',
        bearerToken: 'expired-bearer',
      }),
    ).catch((error: unknown) => error);

    expect(classifyMcpError(withBearer, 'connect', true).code).toBe('invalid_bearer_token');
    expect(classifyMcpError(withBearer, 'connect', true).message).toMatch(/401|bearer/i);
  });

  it('does not promote GitHub remote MCP 401s into an OAuth flow', () => {
    const github = { authMode: 'authless' as const, url: 'https://api.githubcopilot.com/mcp/' };
    const challenge = new McpError('http_401', 'The MCP server answered HTTP 401 (authentication required).');
    const withoutPat = resolveDiscoveryFailure(github, challenge, false);

    expect(withoutPat.authMode).toBe('bearer');
    expect(withoutPat.status).toBe('auth_required');
    expect(withoutPat.statusCode).toBe('http_401');
    expect(withoutPat.statusHint).toMatch(/PAT/);

    const rejectedPat = resolveDiscoveryFailure(
      { authMode: 'bearer', url: 'https://api.githubcopilot.com/mcp/x/all' },
      challenge,
      true,
    );

    expect(rejectedPat.authMode).toBe('bearer');
    expect(rejectedPat.status).toBe('error');
    expect(rejectedPat.statusCode).toBe('invalid_bearer_token');

    const generic = resolveDiscoveryFailure(
      { authMode: 'authless', url: 'https://mcp.example.com/mcp' },
      new McpError('oauth_required', 'needs oauth'),
      false,
    );

    expect(generic.authMode).toBe('oauth');
    expect(generic.status).toBe('auth_required');
  });

  it('classifies malformed responses and transport failures', async () => {
    const malformedUrl = await startMock('malformed');
    const failingUrl = await startMock('error');
    const malformed = await discoverMcpTools(config(malformedUrl), contextFor()).catch((error: unknown) => error);
    const failing = await discoverMcpTools(config(failingUrl), contextFor()).catch((error: unknown) => error);

    expect(classifyMcpError(malformed).code).toBe('malformed_response');
    expect(['unknown', 'protocol_negotiation_failed', 'malformed_response', 'network']).toContain(
      classifyMcpError(failing).code,
    );
  });

  it('classifies DNS, TLS and timeout failures with dedicated codes', () => {
    expect(classifyMcpError(new Error('getaddrinfo ENOTFOUND mcp.example.test')).code).toBe('dns');
    expect(classifyMcpError(new Error('self-signed certificate in certificate chain')).code).toBe('tls');
    expect(classifyMcpError(new Error('This operation was aborted due to timeout')).code).toBe('timeout');
    expect(classifyMcpError(new Error('fetch failed')).code).toBe('network');
    expect(classifyMcpError(new Error('Unsupported protocol version'), 'connect').code).toBe(
      'protocol_negotiation_failed',
    );
    expect(
      classifyMcpError(new Error('Incompatible auth server: does not support dynamic client registration')).code,
    ).toBe('oauth_required');
    expect(
      classifyMcpError(
        new Error('Incompatible auth server: does not support dynamic client registration'),
        'connect',
        true,
      ).code,
    ).toBe('invalid_bearer_token');
  });

  it('signs server configuration so a tampered cookie cannot redirect a credential', async () => {
    const url = await startMock();
    const secret = 'unit-test-secret-value-32-chars!!';
    const server = config(url, { authMode: 'bearer' });
    const cookies = await mcpStateHeaders(
      [server],
      { [server.id]: 'super-secret-token' },
      { MCP_COOKIE_SECRET: secret },
    );
    const cookieHeader = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const validRequest = new Request('http://localhost/api/mcp', { headers: { Cookie: cookieHeader } });
    const state = await readMcpState(validRequest, { MCP_COOKIE_SECRET: secret });

    expect(state.servers).toHaveLength(1);
    expect(state.servers[0].url).toBe(url);
    expect(state.secrets[server.id]).toBe('super-secret-token');
    expect(cookieHeader).not.toContain('super-secret-token');

    // Attacker rewrites the public configuration to point at their own host.
    const publicCookie = cookies.find((cookie) => cookie.startsWith('mcpServers='))!;
    const tampered = [
      'mcpServers=' + encodeURIComponent(publicCookie.split(';')[0].split('=').slice(1).join('=').replace(/^/, 'x')),
      cookies
        .filter((cookie) => cookie.startsWith('mcpSecrets='))
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    ].join('; ');
    const tamperedState = await readMcpState(
      new Request('http://localhost/api/mcp', { headers: { Cookie: tampered } }),
      { MCP_COOKIE_SECRET: secret },
    );

    expect(tamperedState.servers).toHaveLength(0);
  });

  it('drops unsigned legacy configuration instead of trusting it', async () => {
    const request = new Request('http://localhost/api/mcp', {
      headers: {
        Cookie: `mcpServers=${encodeURIComponent(JSON.stringify([config('http://legacy.test/mcp')]))}`,
      },
    });
    const state = await readMcpState(request, { MCP_COOKIE_SECRET: 'unit-test-secret-value-32-chars!!' });

    expect(state.servers).toHaveLength(0);
    expect(state.warnings.join(' ')).toMatch(/could not be verified/i);
  });

  it('returns no tools when MCP is disabled or unavailable', async () => {
    const request = new Request('http://localhost/api/chat');
    const disabledRequest = new Request('http://localhost/api/chat', {
      headers: { Cookie: 'mcpServers=%5B%5D' },
    });

    expect(await getMcpTools(request, { MCP_COOKIE_SECRET: 'unit-test-secret-value-32-chars!!' })).toEqual({});
    expect(await getMcpTools(disabledRequest, { MCP_COOKIE_SECRET: 'unit-test-secret-value-32-chars!!' })).toEqual({});
  });

  it('exposes chat tools with risk metadata and honours approval gating', async () => {
    const url = await startMock();
    const secret = 'unit-test-secret-value-32-chars!!';
    const server = config(url);
    const cookies = await mcpStateHeaders([server], {}, { MCP_COOKIE_SECRET: secret });
    const request = new Request('http://localhost/api/chat', {
      headers: { Cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') },
    });
    const tools = await getMcpTools(request, { MCP_COOKIE_SECRET: secret });
    const names = Object.keys(tools);

    expect(names).toContain('mcp_Local_mock_get_status');
    expect(names).toContain('mcp_Local_mock_delete_repository');

    const deleteTool = tools.mcp_Local_mock_delete_repository as unknown as { description?: string };

    expect(deleteTool.description).toContain('requires user approval');

    const execute = tools.mcp_Local_mock_delete_repository.execute!;
    const denied = await execute({ name: 'main' }, { toolCallId: 'call-1', messages: [] });

    expect(denied).toMatchObject({ server: 'Local mock', tool: 'delete_repository', risk: 'destructive' });
    expect(String(denied.result)).toContain('was NOT executed');
  });

  it('classifies tool risk conservatively', () => {
    expect(classifyToolRisk('get_file', 'Read a file')).toBe('read');
    expect(classifyToolRisk('list_issues', 'List issues')).toBe('read');
    expect(classifyToolRisk('create_issue', 'Create an issue')).toBe('write');
    expect(classifyToolRisk('update_user', 'Update the user')).toBe('write');
    expect(classifyToolRisk('delete_branch', 'Delete a branch')).toBe('destructive');
    expect(classifyToolRisk('run_shell', 'Run a command')).toBe('write');
    expect(classifyToolRisk('whatever', undefined)).toBe('write');
  });

  it('rejects unsafe server URLs', async () => {
    const { validateServerUrl } = await import('./mcp');

    expect(() => validateServerUrl('ftp://example.com/mcp')).toThrow(/http/);
    expect(() => validateServerUrl('https://user:pass@example.com/mcp')).toThrow(/credentials/);
    expect(() => validateServerUrl('https://example.com/mcp?token=abc')).toThrow(/query string/);
    expect(validateServerUrl('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp');

    /*
     * http is a local/private-network convenience only; a public host over http
     * would carry the bearer token in cleartext.
     */
    expect(validateServerUrl('http://127.0.0.1:8931/mcp')).toBe('http://127.0.0.1:8931/mcp');
    expect(validateServerUrl('http://localhost:8931/mcp')).toBe('http://localhost:8931/mcp');
    expect(validateServerUrl('http://192.168.1.20:8931/mcp')).toBe('http://192.168.1.20:8931/mcp');
    expect(validateServerUrl('http://10.0.0.5:8931/mcp')).toBe('http://10.0.0.5:8931/mcp');
    expect(validateServerUrl('http://[fd00::1]:8931/mcp')).toBe('http://[fd00::1]:8931/mcp');
    expect(() => validateServerUrl('http://example.com/mcp')).toThrow(/https/);
    expect(() => validateServerUrl('http://8.8.8.8/mcp')).toThrow(/https/);
  });

  it('configures the MCP client with the workerd-safe JSON Schema validator', async () => {
    const { mcpClientOptions } = await import('./mcp');
    const validator = mcpClientOptions().jsonSchemaValidator;

    /*
     * The SDK defaults to Ajv, which compiles schemas with `new Function`.
     * workerd forbids dynamic code generation, so listing tools from a server
     * that publishes an `outputSchema` failed with "Code generation from strings
     * disallowed for this context" until this validator was wired in.
     */
    expect(validator).toBeInstanceOf(CfWorkerJsonSchemaValidator);

    if (!validator) {
      throw new Error('the MCP client has no JSON Schema validator configured');
    }

    const validate = validator.getValidator({
      type: 'object',
      properties: { title: { type: 'string' } },
    } as Parameters<typeof validator.getValidator>[0]);

    expect(validate({ title: 'ok' }).valid).toBe(true);
    expect(validate({ title: 42 }).valid).toBe(false);
  });

  it('only allows https (or loopback http) authorization URLs to reach the browser', async () => {
    const { assertSafeAuthorizationUrl } = await import('./mcp');

    expect(assertSafeAuthorizationUrl('https://auth.example.com/authorize?client_id=x')).toBe(
      'https://auth.example.com/authorize?client_id=x',
    );
    expect(assertSafeAuthorizationUrl('http://127.0.0.1:8080/authorize')).toBe('http://127.0.0.1:8080/authorize');
    expect(assertSafeAuthorizationUrl('http://localhost:9876/authorize')).toBe('http://localhost:9876/authorize');

    // Everything else would be handed to window.location and must be refused.
    for (const unsafe of [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'http://evil.example/authorize',
      'not a url',
      'file:///etc/passwd',
    ]) {
      expect(() => assertSafeAuthorizationUrl(unsafe)).toThrow(/authorization URL/);
    }
  });

  it('persists a 50-tool GitHub-sized catalog without writing a cookie over 4 KiB', async () => {
    const description =
      'A realistic GitHub MCP tool description that explains repository, issue and pull-request operations in enough detail to blow past a 4 KiB cookie when fifty copies sit next to nine-field JSON Schemas. '.repeat(
        2,
      );
    const tools: McpToolInfo[] = Array.from({ length: 50 }, (_, index) => ({
      name: `github_tool_${index}_create_or_update_file`,
      description: description.slice(0, 480),
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          message: { type: 'string' },
          branch: { type: 'string' },
          sha: { type: 'string' },
          committer: { type: 'object' },
          author: { type: 'object' },
        },
        required: ['owner', 'repo', 'path', 'content', 'message'],
      },
      risk: index % 5 === 0 ? 'destructive' : index % 2 === 0 ? 'write' : 'read',
    }));
    const secret = 'unit-test-secret-value-32-chars!!';
    const server = config('https://api.githubcopilot.com/mcp/', { tools, name: 'GitHub', authMode: 'bearer' });
    const cookies = await mcpStateHeaders(
      [server],
      { [server.id]: 'github_pat_not_in_cookie' },
      { MCP_COOKIE_SECRET: secret },
    );
    const live = cookies.filter((cookie) => !cookie.includes('Max-Age=0'));

    for (const cookie of live) {
      expect(cookiePairByteLength(cookie)).toBeLessThanOrEqual(4096);
    }

    const request = new Request('http://localhost/api/mcp', {
      headers: { Cookie: live.map((cookie) => cookie.split(';')[0]).join('; ') },
    });
    const state = await readMcpState(request, { MCP_COOKIE_SECRET: secret });

    expect(state.servers).toHaveLength(1);
    expect(state.servers[0].tools).toHaveLength(50);
    expect(state.servers[0].tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(JSON.stringify(state.servers[0].tools[0].inputSchema)).toBe(
      JSON.stringify(compactToolsForStorage(tools)[0].inputSchema),
    );
    expect(live.join('\n')).not.toContain('github_pat_not_in_cookie');
    expect(state.secrets[server.id]).toBe('github_pat_not_in_cookie');
  });
});
