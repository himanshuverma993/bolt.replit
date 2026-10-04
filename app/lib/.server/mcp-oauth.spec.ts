/*
 * Mock MCP resource servers and authorization servers return early on many
 * branches; the HTTP listener return value is irrelevant to Node.
 */
/* eslint-disable consistent-return */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginMcpAuthorization,
  completeMcpAuthorization,
  hasStoredTokens,
  MCP_OAUTH_COOKIE_LIMIT_BYTES,
  oauthStateCookie,
  oauthStoreHeaders,
  readOAuthStore,
  removeOAuthEntry,
  requireOAuthSecret,
  validateOAuthState,
  McpOAuthError,
  type McpOAuthStore,
} from './mcp-oauth';
import { createMcpClientContext, discoverMcpTools, mcpStateHeaders, readMcpState, type McpServerConfig } from './mcp';

/**
 * Full local OAuth mock: one HTTP server that plays both the MCP resource server
 * (Streamable HTTP, bearer protected) and the authorization server (metadata,
 * dynamic client registration, PKCE code exchange, refresh). No network access,
 * no real credentials - but the real SDK OAuth client code path is exercised.
 */

type OAuthMockState = {
  tokenRequests: number;
  refreshRequests: number;
  authorizationCodeRequests: number;
  revokedAccessTokens: Set<string>;
  revokedRefreshTokens: Set<string>;
  lastCodeVerifier: string | undefined;
  lastCodeChallenge: string | undefined;
};

const servers: Server[] = [];
const mockState: OAuthMockState = {
  tokenRequests: 0,
  refreshRequests: 0,
  authorizationCodeRequests: 0,
  revokedAccessTokens: new Set(),
  revokedRefreshTokens: new Set(),
  lastCodeVerifier: undefined,
  lastCodeChallenge: undefined,
};

const SECRET = 'unit-test-secret-value-32-chars!!';

function resetMockState(): void {
  mockState.tokenRequests = 0;
  mockState.refreshRequests = 0;
  mockState.authorizationCodeRequests = 0;
  mockState.revokedAccessTokens.clear();
  mockState.revokedRefreshTokens.clear();
  mockState.lastCodeVerifier = undefined;
  mockState.lastCodeChallenge = undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');

  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }

  response.end(JSON.stringify(body));
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function startOAuthMock(): Promise<{ origin: string; mcpUrl: string }> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const path = url.pathname;

    if (request.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      return json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['mcp.read'],
      });
    }

    if (request.method === 'GET' && path.startsWith('/.well-known/oauth-authorization-server')) {
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }

    if (path === '/register' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as { redirect_uris: string[] };

      return json(response, 201, {
        client_id: 'mock-client-id',
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }

    if (path === '/authorize' && request.method === 'GET') {
      /*
       * The client never calls this endpoint itself; the user agent would. We
       * record the challenge so the token exchange can verify PKCE.
       */
      mockState.lastCodeChallenge = url.searchParams.get('code_challenge') ?? undefined;

      const redirect = new URL(url.searchParams.get('redirect_uri') ?? `${origin}/api/mcp/oauth/callback`);
      redirect.searchParams.set('code', 'mock-authorization-code');
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');

      return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
    }

    if (path === '/token' && request.method === 'POST') {
      const body = new URLSearchParams(await readBody(request));
      mockState.tokenRequests += 1;

      const grantType = body.get('grant_type');

      if (grantType === 'refresh_token') {
        mockState.refreshRequests += 1;

        const refreshToken = body.get('refresh_token') ?? '';

        if (mockState.revokedRefreshTokens.has(refreshToken)) {
          return json(response, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        }

        const accessToken = `access-${randomUUID()}`;

        return json(response, 200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp.read',
        });
      }

      mockState.authorizationCodeRequests += 1;

      const codeVerifier = body.get('code_verifier') ?? '';
      mockState.lastCodeVerifier = codeVerifier;

      if (body.get('code') !== 'mock-authorization-code') {
        return json(response, 400, { error: 'invalid_grant', error_description: 'unknown code' });
      }

      if (mockState.lastCodeChallenge && pkceChallenge(codeVerifier) !== mockState.lastCodeChallenge) {
        return json(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      const accessToken = `access-${randomUUID()}`;

      return json(response, 200, {
        access_token: accessToken,
        refresh_token: `refresh-${randomUUID()}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp.read',
      });
    }

    if (path === '/mcp' && request.method === 'POST') {
      const authorization = request.headers.authorization ?? '';
      const token = authorization.replace(/^Bearer\s+/i, '');
      const bodyText = await readBody(request);

      if (!token || mockState.revokedAccessTokens.has(token)) {
        return json(
          response,
          401,
          { error: 'unauthorized' },
          { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
        );
      }

      let message: { id?: number; method?: string };

      try {
        message = JSON.parse(bodyText) as { id?: number; method?: string };
      } catch {
        return json(response, 400, { error: 'malformed json' });
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
            serverInfo: { name: 'oauth-mock', version: '1.0.0' },
          },
        });
      }

      if (message.method === 'tools/list') {
        return json(response, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [{ name: 'get_page', description: 'Read a page', inputSchema: { type: 'object', properties: {} } }],
          },
        });
      }

      return json(response, 200, { jsonrpc: '2.0', id: message.id, result: { content: [] } });
    }

    return json(response, 404, { error: 'not_found' });
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('OAuth mock did not receive a TCP address');
  }

  const origin = `http://127.0.0.1:${address.port}`;

  return { origin, mcpUrl: `${origin}/mcp` };
}

function serverConfig(url: string): McpServerConfig {
  return {
    id: 'oauth-server',
    name: 'OAuth mock',
    url,
    enabled: true,
    authMode: 'oauth',
    status: 'auth_required',
    tools: [],
  };
}

afterEach(async () => {
  resetMockState();

  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('MCP OAuth client', () => {
  it('discovers the authorization server, registers a client and returns a PKCE authorization URL', async () => {
    const { mcpUrl, origin } = await startOAuthMock();
    const store: McpOAuthStore = {};
    const result = await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
      scope: 'mcp.read',
    });

    expect(result.status).toBe('redirect');

    const authorizationUrl = new URL((result as { authorizationUrl: string }).authorizationUrl);

    expect(authorizationUrl.pathname).toBe('/authorize');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('mock-client-id');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(`${origin}/api/mcp/oauth/callback`);
    expect(authorizationUrl.searchParams.get('state')).toBe(store['oauth-server'].state);
    expect(store['oauth-server'].codeVerifier).toBeTruthy();
    expect(store['oauth-server'].clientInformation?.client_id).toBe('mock-client-id');
  });

  it('exchanges the authorization code with PKCE and lists tools with the stored token', async () => {
    const { mcpUrl, origin } = await startOAuthMock();
    let store: McpOAuthStore = {};
    const begin = await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });
    const authorizationUrl = new URL((begin as { authorizationUrl: string }).authorizationUrl);
    const state = authorizationUrl.searchParams.get('state');
    const codeChallenge = authorizationUrl.searchParams.get('code_challenge');

    validateOAuthState(store, 'oauth-server', state);

    store = await completeMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      authorizationCode: 'mock-authorization-code',
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });

    expect(hasStoredTokens(store, 'oauth-server')).toBe(true);
    expect(codeChallenge).toBeTruthy();

    /*
     * PKCE: the verifier persisted for the callback hashes to the challenge the
     * authorization request advertised (the mock token endpoint enforces it too).
     */
    expect(pkceChallenge(store['oauth-server'].codeVerifier ?? '')).toBe(codeChallenge);
    expect(mockState.authorizationCodeRequests).toBe(1);

    const context = createMcpClientContext({
      env: { APP_ENCRYPTION_SECRET: SECRET },
      serverId: 'oauth-server',
      oauthStore: store,
    });
    const tools = await discoverMcpTools(serverConfig(mcpUrl), context);

    expect(tools.map((tool) => tool.name)).toEqual(['get_page']);
  });

  it('refreshes an expired access token automatically and recovers', async () => {
    const { mcpUrl, origin } = await startOAuthMock();
    let store: McpOAuthStore = {};
    await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });
    store = await completeMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      authorizationCode: 'mock-authorization-code',
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });

    const context = createMcpClientContext({
      env: { APP_ENCRYPTION_SECRET: SECRET },
      serverId: 'oauth-server',
      oauthStore: store,
    });

    expect((await discoverMcpTools(serverConfig(mcpUrl), context)).length).toBe(1);

    /*
     * The access token is revoked server-side: the next call must go through the
     * SDK's 401 -> refresh path.
     */
    mockState.revokedAccessTokens.add(store['oauth-server'].tokens!.access_token!);

    const toolsAfterRefresh = await discoverMcpTools(serverConfig(mcpUrl), context);

    expect(mockState.refreshRequests).toBe(1);
    expect(toolsAfterRefresh.map((tool) => tool.name)).toEqual(['get_page']);
  });

  it('treats a revoked refresh token as requiring a new authorization', async () => {
    const { mcpUrl, origin } = await startOAuthMock();
    let store: McpOAuthStore = {};
    await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });
    store = await completeMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      authorizationCode: 'mock-authorization-code',
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });

    const context = createMcpClientContext({
      env: { APP_ENCRYPTION_SECRET: SECRET },
      serverId: 'oauth-server',
      oauthStore: store,
    });

    mockState.revokedAccessTokens.add(store['oauth-server'].tokens!.access_token!);
    mockState.revokedRefreshTokens.add(store['oauth-server'].tokens!.refresh_token!);

    const failure = await discoverMcpTools(serverConfig(mcpUrl), context).catch((error: unknown) => error);

    expect(failure).toBeTruthy();

    /*
     * The user gets a clear "authorize again" state instead of a silent failure
     * or a hard crash: the refresh token is gone, so a new OAuth flow is needed.
     */
    expect(String((failure as Error).message)).toMatch(/OAuth authorization/i);
  });

  it('rejects a callback whose state does not match the pending request', async () => {
    const { mcpUrl, origin } = await startOAuthMock();
    const store: McpOAuthStore = {};
    await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });

    expect(() => validateOAuthState(store, 'oauth-server', 'attacker-controlled-state')).toThrow(McpOAuthError);
    expect(() => validateOAuthState(store, 'oauth-server', null)).toThrow(/state parameter/);
    expect(() => validateOAuthState({}, 'oauth-server', 'anything')).toThrow(/state parameter/);
  });

  it('stores tokens in an HttpOnly sealed cookie that never contains the raw token', async () => {
    const { mcpUrl, origin } = await startOAuthMock();
    let store: McpOAuthStore = {};
    await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });
    store = await completeMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      authorizationCode: 'mock-authorization-code',
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });

    const cookies = await oauthStoreHeaders(store, { APP_ENCRYPTION_SECRET: SECRET });
    const oauthCookie = cookies.find((cookie) => cookie.startsWith('mcp_oauth='))!;
    const accessToken = store['oauth-server'].tokens!.access_token!;

    expect(oauthCookie).toContain('HttpOnly');
    expect(oauthCookie).toContain('Secure');
    expect(oauthCookie).not.toContain(accessToken);

    const request = new Request('http://localhost/api/mcp', {
      headers: { Cookie: oauthCookie.split(';')[0] },
    });
    const restored = await readOAuthStore(request, { APP_ENCRYPTION_SECRET: SECRET });

    expect(restored['oauth-server'].tokens?.access_token).toBe(accessToken);
  });

  it('rejects oversized OAuth state instead of silently dropping credentials', async () => {
    const store: McpOAuthStore = {
      'oauth-server': {
        serverId: 'oauth-server',
        serverUrl: 'https://mcp.example.com/mcp',
        tokens: {
          access_token: 'x'.repeat(MCP_OAUTH_COOKIE_LIMIT_BYTES + 500),
          token_type: 'Bearer',
        },
        updatedAt: new Date().toISOString(),
      },
    };

    await expect(oauthStoreHeaders(store, { APP_ENCRYPTION_SECRET: SECRET })).rejects.toMatchObject({
      code: 'storage_limit',
    });
  });

  it('drops the discovery cache instead of failing when the sealed store is too large', async () => {
    /*
     * Discovery metadata is re-fetched automatically, tokens are not. Access
     * tokens are often long JWTs, so the cache is evicted before the flow fails.
     */
    const store = {
      'oauth-server': {
        serverId: 'oauth-server',
        serverUrl: 'https://mcp.example.com/mcp',
        tokens: { access_token: 'access-token-value', token_type: 'Bearer', refresh_token: 'refresh-token-value' },
        discovery: { authorizationServerMetadata: { issuer: 'y'.repeat(MCP_OAUTH_COOKIE_LIMIT_BYTES - 800) } },
        updatedAt: new Date().toISOString(),
      },
    } as unknown as McpOAuthStore;

    const headers = await oauthStoreHeaders(store, { APP_ENCRYPTION_SECRET: SECRET });
    const cookie = headers[0];

    expect(cookie).toContain('HttpOnly');
    expect(store['oauth-server'].discovery).toBeUndefined();

    const request = new Request('https://bolt.example.test/api/mcp', {
      headers: { Cookie: cookie.split(';')[0] },
    });
    const restored = await readOAuthStore(request, { APP_ENCRYPTION_SECRET: SECRET });

    expect(restored['oauth-server'].tokens?.refresh_token).toBe('refresh-token-value');
  });

  it('requires a Worker secret before storing OAuth material and clears the cookie otherwise', async () => {
    expect(() => requireOAuthSecret({})).toThrow(/APP_ENCRYPTION_SECRET/);

    const store: McpOAuthStore = {
      'oauth-server': { serverId: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', updatedAt: '' },
    };
    const cookies = await oauthStoreHeaders(store, {});

    expect(cookies[0]).toContain('mcp_oauth=');
    expect(cookies[0]).toContain('Max-Age=0');
  });

  it('drops OAuth material when the server is removed or disconnected', async () => {
    const store: McpOAuthStore = {
      'oauth-server': { serverId: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', updatedAt: '' },
    };
    const next = removeOAuthEntry(store, 'oauth-server');

    expect(next['oauth-server']).toBeUndefined();
    expect(await oauthStoreHeaders(next, { APP_ENCRYPTION_SECRET: SECRET })).toEqual([
      expect.stringContaining('Max-Age=0'),
    ]);
  });
});

describe('MCP OAuth state integration with the MCP store', () => {
  it('persists OAuth material alongside signed server state', async () => {
    const { mcpUrl } = await startOAuthMock();
    const store: McpOAuthStore = {};
    await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: 'https://bolt.example.test/api/mcp/oauth/callback',
    });

    const cookies = await mcpStateHeaders([serverConfig(mcpUrl)], {}, { APP_ENCRYPTION_SECRET: SECRET }, store);
    const request = new Request('http://localhost/api/mcp', {
      headers: { Cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') },
    });
    const state = await readMcpState(request, { APP_ENCRYPTION_SECRET: SECRET });

    expect(state.servers).toHaveLength(1);
    expect(Object.keys(state.oauth)).toEqual(['oauth-server']);
    expect(state.oauth['oauth-server'].codeVerifier).toBeTruthy();

    const stateCookie = cookies.find((cookie) => cookie.startsWith('mcp_oauth_state=')) === undefined;

    // The pending-flow pointer cookie is set explicitly by the route, not by the store.
    expect(stateCookie).toBe(true);
    expect(oauthStateCookie('oauth-server')).toContain('HttpOnly');
  });
});
