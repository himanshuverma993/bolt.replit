/* Mock MCP server: early returns are normal, the listener value is unused by Node. */
/* eslint-disable consistent-return */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

// Route-level tests live outside app/routes so Remix does not treat them as routes.
import { action, loader } from '~/routes/api.mcp';
import { MCP_OAUTH_COOKIE, MCP_OAUTH_STATE_COOKIE } from '~/lib/.server/mcp-oauth';
import { MCP_PUBLIC_COOKIE, MCP_SECRET_COOKIE } from '~/lib/.server/mcp';

/**
 * Route-level tests for MCP connection management: cookie handling, credential
 * sealing, OAuth guard rails and the OAuth-required state.
 */

const SECRET = 'unit-test-secret-value-32-chars!!';
const servers: Server[] = [];
let lastAuthorization: string | undefined;

type MockBehaviour = { mode?: 'normal' | 'unauthorized' | 'malformed' };

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

async function startMcpMock(behaviour: MockBehaviour = {}): Promise<string> {
  const mode = behaviour.mode ?? 'normal';
  const server = createServer(async (request, response) => {
    lastAuthorization = request.headers.authorization;

    if (mode === 'unauthorized') {
      response.statusCode = 401;
      response.setHeader('WWW-Authenticate', 'Bearer');
      response.end('unauthorized');

      return;
    }

    const body = await readBody(request);

    if (mode === 'malformed') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.end('{not-json');

      return;
    }

    let message: { id?: number; method?: string };

    try {
      message = JSON.parse(body) as { id?: number; method?: string };
    } catch {
      json(response, 400, { error: 'malformed json' });

      return;
    }

    if (message.method === 'notifications/initialized') {
      response.statusCode = 202;
      response.end();

      return;
    }

    if (message.method === 'initialize') {
      return json(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'route-mock', version: '1' },
        },
      });
    }

    if (message.method === 'tools/list') {
      json(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'get_widget', description: 'Read a widget', inputSchema: { type: 'object', properties: {} } },
            { name: 'delete_widget', description: 'Delete a widget', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      });

      return;
    }

    json(response, 404, { error: 'not found' });
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('MCP route mock did not receive a TCP address');
  }

  return `http://127.0.0.1:${address.port}/mcp`;
}

function contextFor(env: Record<string, unknown>) {
  return { cloudflare: { env } } as unknown as Parameters<typeof action>[0]['context'];
}

function postRequest(body: unknown, cookie?: string): Request {
  return new Request('https://bolt.example.test/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes('Max-Age=0'))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
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

describe('GET /api/mcp', () => {
  it('returns the server list, warnings and configuration flags', async () => {
    const response = await loader({
      request: new Request('https://bolt.example.test/api/mcp'),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ servers: [], oauthConfigured: true, credentialStorageConfigured: true });
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });

  it('reports missing credential storage', async () => {
    const response = await loader({
      request: new Request('https://bolt.example.test/api/mcp'),
      context: contextFor({}),
    } as unknown as Parameters<typeof loader>[0]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.oauthConfigured).toBe(false);
  });
});

describe('POST /api/mcp', () => {
  it('adds an authless server, discovers tools with risk levels and seals the state', async () => {
    const url = await startMcpMock();
    const response = await action({
      request: postRequest({ action: 'add', name: 'Route mock', url }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await response.json()) as unknown as { server: { status: string; tools: Array<{ risk: string }> } };
    const cookies = response.headers.getSetCookie();

    expect(body.server.status).toBe('connected');
    expect(body.server.tools.map((tool) => tool.risk)).toEqual(['read', 'destructive']);

    const publicCookie = cookies.find((cookie) => cookie.startsWith(`${MCP_PUBLIC_COOKIE}=`))!;

    expect(publicCookie).toBeDefined();
    expect(publicCookie).not.toContain('HttpOnly');
    expect(cookies.some((cookie) => cookie.startsWith(`${MCP_SECRET_COOKIE}=`) && cookie.includes('Max-Age=0'))).toBe(
      true,
    );
  });

  it('stores a bearer token sealed, HttpOnly and out of the response body', async () => {
    const url = await startMcpMock();
    const response = await action({
      request: postRequest({ action: 'add', name: 'Bearer mock', url, token: 'super-secret-bearer-value' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const rawBody = await response.text();
    const cookies = response.headers.getSetCookie();
    const secretCookie = cookies.find((cookie) => cookie.startsWith(`${MCP_SECRET_COOKIE}=`))!;

    expect(secretCookie).toContain('HttpOnly');
    expect(secretCookie).toContain('Secure');
    expect(secretCookie).not.toContain('super-secret-bearer-value');
    expect(rawBody).not.toContain('super-secret-bearer-value');
    expect(lastAuthorization).toBe('Bearer super-secret-bearer-value');
  });

  it('refuses to store a bearer token without a Worker secret', async () => {
    const url = await startMcpMock();
    const response = await action({
      request: postRequest({ action: 'add', name: 'Bearer mock', url, token: 'should-not-be-stored' }),
      context: contextFor({}),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(501);
    expect(((await response.json()) as unknown as { error: string }).error).toMatch(/APP_ENCRYPTION_SECRET/);
  });

  it('marks an OAuth-protected server as requiring authentication instead of erroring generically', async () => {
    const url = await startMcpMock({ mode: 'unauthorized' });
    const response = await action({
      request: postRequest({ action: 'add', name: 'OAuth server', url }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await response.json()) as unknown as {
      server: { status: string; authMode: string; statusCode: string; statusMessage: string };
      warnings: string[];
    };

    expect(body.server.status).toBe('auth_required');
    expect(body.server.authMode).toBe('oauth');

    // No bearer token was supplied, so the precise classification is "OAuth required".
    expect(body.server.statusCode).toBe('oauth_required');
    expect(body.warnings.join(' ')).toMatch(/OAuth/);
  });

  it('requires https before starting an OAuth authorization flow', async () => {
    const url = await startMcpMock({ mode: 'unauthorized' });
    const addResponse = await action({
      request: postRequest({ action: 'add', name: 'OAuth server', url }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const addBody = (await addResponse.json()) as unknown as { server: { id: string } };
    const cookie = cookieHeaderFrom(addResponse);
    const response = await action({
      request: new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ action: 'authorize', id: addBody.server.id }),
      }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(400);
    expect(((await response.json()) as unknown as { error: string }).error).toMatch(/https/);
  });

  it('toggles, opts into risky tools and removes servers without exposing secrets', async () => {
    const url = await startMcpMock();
    const addResponse = await action({
      request: postRequest({ action: 'add', name: 'Toggle mock', url, token: 'bearer-token-value' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const addBody = (await addResponse.json()) as unknown as { server: { id: string } };
    let cookie = cookieHeaderFrom(addResponse);

    const allowResponse = await action({
      request: postRequest({ action: 'set-allow-risky', id: addBody.server.id, allowRiskyTools: true }, cookie),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const allowBody = (await allowResponse.json()) as unknown as { servers: Array<{ allowRiskyTools?: boolean }> };

    expect(allowBody.servers[0].allowRiskyTools).toBe(true);
    cookie = cookieHeaderFrom(allowResponse);

    const removeResponse = await action({
      request: postRequest({ action: 'remove', id: addBody.server.id }, cookie),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const removeBody = (await removeResponse.json()) as unknown as { servers: unknown[] };
    const removeCookies = removeResponse.headers.getSetCookie();

    expect(removeBody.servers).toEqual([]);
    expect(
      removeCookies.some((entry) => entry.startsWith(`${MCP_SECRET_COOKIE}=`) && entry.includes('Max-Age=0')),
    ).toBe(true);
    expect(removeCookies.some((entry) => entry.startsWith(MCP_OAUTH_COOKIE))).toBe(true);
  });

  it('rejects unknown actions and unknown servers', async () => {
    const unknownAction = await action({
      request: postRequest({ action: 'launch-missiles' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(unknownAction.status).toBe(400);

    const unknownServer = await action({
      request: postRequest({ action: 'refresh', id: 'missing' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(unknownServer.status).toBe(404);
  });

  it('clears the OAuth pointer cookie when OAuth is revoked', async () => {
    const url = await startMcpMock();
    const addResponse = await action({
      request: postRequest({ action: 'add', name: 'Revoke mock', url }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const addBody = (await addResponse.json()) as unknown as { server: { id: string } };
    const response = await action({
      request: postRequest({ action: 'disconnect-auth', id: addBody.server.id }, cookieHeaderFrom(addResponse)),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const cookies = response.headers.getSetCookie();

    expect(cookies.some((entry) => entry.startsWith(`${MCP_OAUTH_STATE_COOKIE}=`) && entry.includes('Max-Age=0'))).toBe(
      true,
    );
  });
});

describe('CSRF protection', () => {
  it('rejects a cross-origin MCP state change', async () => {
    const response = await action({
      request: new Request('https://bolt.example.test/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.test' },
        body: JSON.stringify({ action: 'add', name: 'x', url: 'https://mcp.example.com/mcp' }),
      }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(403);
  });
});
