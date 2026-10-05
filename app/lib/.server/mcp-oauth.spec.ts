/*
 * Mock MCP resource servers and authorization servers live in
 * ./mcp-oauth-mock.fixture so both this client-level suite and the route-level
 * suite exercise the same authorization server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginMcpAuthorization,
  completeMcpAuthorization,
  hasStoredTokens,
  oauthStateCookie,
  oauthStoreHeaders,
  readOAuthStore,
  removeOAuthEntry,
  requireOAuthSecret,
  validateOAuthState,
  McpOAuthError,
  type McpOAuthStore,
} from './mcp-oauth';
import { COOKIE_VALUE_LIMIT_BYTES, cookiePairByteLength, MAX_COOKIE_SHARDS } from './secrets';
import { createMcpClientContext, discoverMcpTools, mcpStateHeaders, readMcpState } from './mcp';
import {
  closeOAuthMockServers,
  mockState,
  pkceChallenge,
  serverConfig,
  startOAuthMock,
} from './mcp-oauth-mock.fixture';

const SECRET = 'unit-test-secret-value-32-chars!!';

afterEach(async () => {
  await closeOAuthMockServers();
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
    const live = cookies.filter((cookie) => cookie.startsWith('mcp_oauth') && !cookie.includes('Max-Age=0'));
    const oauthCookie = live.find((cookie) => cookie.startsWith('mcp_oauth='))!;
    const accessToken = store['oauth-server'].tokens!.access_token!;

    expect(oauthCookie).toContain('HttpOnly');
    expect(oauthCookie).toContain('Secure');
    expect(oauthCookie).not.toContain(accessToken);

    const request = new Request('http://localhost/api/mcp', {
      headers: { Cookie: live.map((cookie) => cookie.split(';')[0]).join('; ') },
    });
    const restored = await readOAuthStore(request, { APP_ENCRYPTION_SECRET: SECRET });

    expect(restored['oauth-server'].tokens?.access_token).toBe(accessToken);
  });

  it('round-trips a 1885-character JWT-shaped access token through compressed sharded cookies', async () => {
    const accessToken = `eyJ${'A'.repeat(1882)}`;
    const store: McpOAuthStore = {
      'oauth-server': {
        serverId: 'oauth-server',
        serverUrl: 'https://mcp.cloudflare.com/mcp',
        tokens: {
          access_token: accessToken,
          refresh_token: `refresh-${'r'.repeat(200)}`,
          token_type: 'Bearer',
          expires_in: 3600,
        },
        clientInformation: {
          client_id: 'cloudflare-mcp-client',
          client_id_issued_at: 1_700_000_000,
          token_endpoint_auth_method: 'none',
        },
        updatedAt: new Date().toISOString(),
      },
    };

    const cookies = await oauthStoreHeaders(store, { APP_ENCRYPTION_SECRET: SECRET });
    const live = cookies.filter((cookie) => cookie.startsWith('mcp_oauth') && !cookie.includes('Max-Age=0'));

    expect(live.length).toBeGreaterThanOrEqual(1);

    for (const cookie of live) {
      expect(cookiePairByteLength(cookie)).toBeLessThanOrEqual(4096);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).not.toContain(accessToken);
    }

    const restored = await readOAuthStore(
      new Request('https://bolt.example.test/api/mcp', {
        headers: { Cookie: live.map((cookie) => cookie.split(';')[0]).join('; ') },
      }),
      { APP_ENCRYPTION_SECRET: SECRET },
    );

    expect(restored['oauth-server'].tokens?.access_token).toBe(accessToken);
    expect(restored['oauth-server'].tokens?.access_token).toHaveLength(1885);
  });

  it('rejects oversized OAuth state instead of silently dropping credentials', async () => {
    /*
     * Repeated characters deflate to almost nothing, so the payload has to look
     * like a real JWT (high entropy) to actually overflow the shard budget.
     */
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bytes = crypto.getRandomValues(new Uint8Array(COOKIE_VALUE_LIMIT_BYTES * MAX_COOKIE_SHARDS + 8_000));
    let accessToken = '';

    for (const byte of bytes) {
      accessToken += alphabet[byte % alphabet.length];
    }

    const store: McpOAuthStore = {
      'oauth-server': {
        serverId: 'oauth-server',
        serverUrl: 'https://mcp.example.com/mcp',
        tokens: {
          access_token: accessToken,
          token_type: 'Bearer',
        },
        updatedAt: new Date().toISOString(),
      },
    };

    await expect(oauthStoreHeaders(store, { APP_ENCRYPTION_SECRET: SECRET })).rejects.toMatchObject({
      code: 'storage_limit',
    });
  });

  it('keeps tokens when discovery metadata is large enough that a single cookie would overflow', async () => {
    /*
     * Discovery metadata is re-fetched automatically, tokens are not. The store
     * is compressed and sharded, so a large cache must not drop the tokens.
     */
    const store = {
      'oauth-server': {
        serverId: 'oauth-server',
        serverUrl: 'https://mcp.example.com/mcp',
        tokens: { access_token: 'access-token-value', token_type: 'Bearer', refresh_token: 'refresh-token-value' },
        discovery: { authorizationServerMetadata: { issuer: 'y'.repeat(COOKIE_VALUE_LIMIT_BYTES - 800) } },
        updatedAt: new Date().toISOString(),
      },
    } as unknown as McpOAuthStore;

    const headers = await oauthStoreHeaders(store, { APP_ENCRYPTION_SECRET: SECRET });
    const live = headers.filter((cookie) => cookie.startsWith('mcp_oauth') && !cookie.includes('Max-Age=0'));
    const cookie = live[0];

    expect(cookie).toContain('HttpOnly');

    const request = new Request('https://bolt.example.test/api/mcp', {
      headers: { Cookie: live.map((header) => header.split(';')[0]).join('; ') },
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
    expect(cookies.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('drops OAuth material when the server is removed or disconnected', async () => {
    const store: McpOAuthStore = {
      'oauth-server': { serverId: 'oauth-server', serverUrl: 'https://mcp.example.com/mcp', updatedAt: '' },
    };
    const next = removeOAuthEntry(store, 'oauth-server');

    expect(next['oauth-server']).toBeUndefined();

    const cleared = await oauthStoreHeaders(next, { APP_ENCRYPTION_SECRET: SECRET });

    expect(cleared.length).toBeGreaterThanOrEqual(1);
    expect(cleared.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
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
