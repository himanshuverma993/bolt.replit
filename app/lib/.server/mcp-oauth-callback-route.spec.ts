import { describe, expect, it } from 'vitest';

// Route-level tests live outside app/routes so Remix does not treat them as routes.
import { loader } from '~/routes/api.mcp.oauth.callback';
import { mcpStateHeaders, readMcpState, type McpServerConfig } from '~/lib/.server/mcp';
import {
  beginMcpAuthorization,
  MCP_OAUTH_COOKIE,
  MCP_OAUTH_STATE_COOKIE,
  oauthStateCookie,
  type McpOAuthStore,
} from '~/lib/.server/mcp-oauth';
import { closeOAuthMockServers, mockState, serverConfig, startOAuthMock } from '~/lib/.server/mcp-oauth-mock.fixture';
import { afterEach } from 'vitest';

/**
 * Route-level tests for the MCP OAuth redirect target.
 *
 * These drive the real HTTP loader: a forged callback must never perform a
 * token exchange, must land on the app with an explicit reason, and a valid
 * callback must store the tokens in an HttpOnly sealed cookie and report the
 * server as connected with its tools.
 */

const SECRET = 'unit-test-secret-value-32-chars!!';

function contextFor(env: Record<string, unknown>) {
  return { cloudflare: { env } } as unknown as Parameters<typeof loader>[0]['context'];
}

function callbackRequest(params: Record<string, string>, cookie?: string): Request {
  const url = new URL('https://bolt.example.test/api/mcp/oauth/callback');

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return new Request(url.toString(), { headers: cookie ? { Cookie: cookie } : {} });
}

async function cookiesFor(servers: McpServerConfig[], oauth: McpOAuthStore, serverId?: string): Promise<string> {
  const headers = await mcpStateHeaders(servers, {}, { APP_ENCRYPTION_SECRET: SECRET }, oauth);
  const pairs = headers
    .filter((header) => !header.startsWith('mcp_oauth=') || oauth)
    .map((header) => header.split(';')[0]);

  if (serverId) {
    pairs.push(oauthStateCookie(serverId).split(';')[0]);
  }

  return pairs.join('; ');
}

afterEach(async () => {
  await closeOAuthMockServers();
});

describe('GET /api/mcp/oauth/callback', () => {
  it('rejects a callback with no pending state cookie and clears the pointer cookie', async () => {
    const response = await loader({
      request: callbackRequest({ code: 'attacker-code', state: 'attacker-state' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const location = new URL(response.headers.get('Location') ?? '');

    expect(response.status).toBe(302);
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('settings')).toBe('connection');
    expect(location.searchParams.get('mcp_oauth')).toBe('error');
    expect(location.searchParams.get('reason')).toBe('missing_state_cookie');
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${MCP_OAUTH_STATE_COOKIE}=`))).toBe(
      true,
    );
  });

  it('surfaces an authorization server error without attempting an exchange', async () => {
    const response = await loader({
      request: callbackRequest({ error: 'access_denied' }, `${MCP_OAUTH_STATE_COOKIE}=oauth-server`),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const location = new URL(response.headers.get('Location') ?? '');

    expect(location.searchParams.get('reason')).toBe('access_denied');
    expect(location.searchParams.get('server')).toBe('oauth-server');
    expect(mockState.tokenRequests).toBe(0);
  });

  it('rejects a callback for a server that is not in the store', async () => {
    const header = await cookiesFor([], {}, 'missing-server');
    const response = await loader({
      request: callbackRequest({ code: 'attacker-code', state: 'anything' }, header),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const location = new URL(response.headers.get('Location') ?? '');

    expect(location.searchParams.get('reason')).toBe('unknown_server');
    expect(mockState.tokenRequests).toBe(0);
  });

  it('rejects a forged state without contacting the authorization server', async () => {
    const { origin, mcpUrl } = await startOAuthMock();
    const store: McpOAuthStore = {};

    await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
    });

    const header = await cookiesFor([serverConfig(mcpUrl)], store, 'oauth-server');
    const before = mockState.tokenRequests;
    const response = await loader({
      request: callbackRequest({ code: 'mock-authorization-code', state: 'attacker-controlled-state' }, header),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const location = new URL(response.headers.get('Location') ?? '');

    expect(response.status).toBe(302);
    expect(location.searchParams.get('reason')).toBe('state_mismatch');
    expect(location.searchParams.get('settings')).toBe('connection');
    expect(location.searchParams.get('detail')).toMatch(/state parameter/i);
    expect(mockState.tokenRequests).toBe(before);
    expect(location.toString()).not.toMatch(/access-|refresh-/);
  });

  it('completes a real PKCE exchange and stores the tokens out of the redirect URL', async () => {
    const { origin, mcpUrl } = await startOAuthMock();
    const store: McpOAuthStore = {};

    const started = await beginMcpAuthorization({
      store,
      serverId: 'oauth-server',
      serverUrl: mcpUrl,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
      scope: 'mcp.read',
    });
    const header = await cookiesFor([serverConfig(mcpUrl)], store, 'oauth-server');
    const response = await loader({
      request: callbackRequest(
        { code: 'mock-authorization-code', state: started.store['oauth-server'].state ?? '' },
        header,
      ),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const location = new URL(response.headers.get('Location') ?? '');
    const setCookies = response.headers.getSetCookie();
    const oauthCookie = setCookies.find((cookie) => cookie.startsWith(`${MCP_OAUTH_COOKIE}=`));

    expect(response.status).toBe(302);
    expect(location.searchParams.get('settings')).toBe('connection');
    expect(location.searchParams.get('mcp_oauth')).toBe('success');
    expect(oauthCookie).toBeDefined();
    expect(oauthCookie).toContain('HttpOnly');
    expect(mockState.tokenRequests).toBe(1);

    /*
     * The state cookie is cleared once the flow completes.
     */
    expect(
      setCookies.some((cookie) => cookie.startsWith(`${MCP_OAUTH_STATE_COOKIE}=`) && cookie.includes('Max-Age=0')),
    ).toBe(true);

    /*
     * Recover the state exactly as a browser would send it back: the sealed
     * tokens must decrypt while the raw token appears nowhere in the redirect.
     */
    const persisted = await recoverState(response);
    const accessToken = persisted.oauth['oauth-server'].tokens?.access_token ?? '';
    const server = persisted.servers.find((item) => item.id === 'oauth-server');

    expect(accessToken).toMatch(/^access-/);
    expect(oauthCookie).not.toContain(accessToken);
    expect(location.toString()).not.toContain(accessToken);
    expect(server?.status).toBe('connected');
    expect(server?.tools.map((tool) => tool.name)).toContain('get_page');
  });
});

/**
 * Reads the MCP state the route persisted, the way the next request would.
 */
async function recoverState(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  const request = new Request('https://bolt.example.test/api/mcp', { headers: { Cookie: cookie } });

  return readMcpState(request, { APP_ENCRYPTION_SECRET: SECRET });
}
