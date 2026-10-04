import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import {
  mcpClientMetadataUrl,
  mcpStateHeaders,
  readMcpState,
  refreshServerStatus,
  type McpServerConfig,
  type McpState,
} from '~/lib/.server/mcp';
import {
  clearOAuthStateCookie,
  completeMcpAuthorization,
  MCP_OAUTH_STATE_COOKIE,
  oauthStoreHeaders,
  validateOAuthState,
  McpOAuthError,
} from '~/lib/.server/mcp-oauth';
import { getRequestOrigin, readRequestCookies, type SecretEnvironment } from '~/lib/.server/secrets';

/**
 * MCP OAuth redirect target.
 *
 * The browser only ever sends `code` and `state` here. The pending authorization
 * (server id, PKCE verifier, state) is bound server-side to the HttpOnly state
 * cookie, and the state value itself is compared against the sealed store, so a
 * forged callback cannot attach tokens to the wrong server.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = (context.cloudflare.env ?? {}) as SecretEnvironment;
  const url = new URL(request.url);
  const origin = getRequestOrigin(request);
  const serverId = readRequestCookies(request)[MCP_OAUTH_STATE_COOKIE] ?? '';
  const failure = (reason: string): Response => {
    const target = new URL('/', origin);
    target.searchParams.set('mcp_oauth', 'error');
    target.searchParams.set('reason', reason);

    if (serverId) {
      target.searchParams.set('server', serverId);
    }

    return new Response(null, {
      status: 302,
      headers: { Location: target.toString(), 'Set-Cookie': clearOAuthStateCookie() },
    });
  };

  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return failure(oauthError.slice(0, 60));
  }

  const code = url.searchParams.get('code');

  if (!code) {
    return failure('missing_code');
  }

  if (!serverId) {
    return failure('missing_state_cookie');
  }

  const state = await readMcpState(request, env);
  const oauth = { ...state.oauth };
  const server = state.servers.find((item) => item.id === serverId);

  if (!server) {
    return failure('unknown_server');
  }

  try {
    validateOAuthState(oauth, serverId, url.searchParams.get('state'));
  } catch (error) {
    if (error instanceof McpOAuthError) {
      return failure(error.code);
    }

    throw error;
  }

  let nextState: McpState = { ...state, oauth };

  try {
    const store = await completeMcpAuthorization({
      store: oauth,
      serverId,
      serverUrl: server.url,
      authorizationCode: code,
      redirectUrl: `${origin}/api/mcp/oauth/callback`,
      clientMetadataUrl: mcpClientMetadataUrl(request),
    });

    const refreshed = await refreshServerStatus(
      { ...server, authMode: 'oauth' },
      { ...nextState, oauth: store },
      env,
      request,
    );

    const servers = nextState.servers.map((item: McpServerConfig) => (item.id === serverId ? refreshed : item));

    nextState = { ...nextState, servers, oauth: store };

    const headers = new Headers();

    for (const cookie of await oauthStoreHeaders(store, env)) {
      headers.append('Set-Cookie', cookie);
    }

    for (const cookie of await mcpStateHeaders(servers, nextState.secrets, env, store)) {
      headers.append('Set-Cookie', cookie);
    }

    headers.append('Set-Cookie', clearOAuthStateCookie());

    const target = new URL('/', origin);
    target.searchParams.set('mcp_oauth', refreshed.status === 'connected' ? 'success' : 'error');
    target.searchParams.set('server', serverId);

    if (refreshed.status !== 'connected' && refreshed.statusCode) {
      target.searchParams.set('reason', refreshed.statusCode);
    }

    headers.set('Location', target.toString());

    return new Response(null, { status: 302, headers });
  } catch (error) {
    const reason = error instanceof McpOAuthError ? error.code : 'oauth_failed';

    return failure(reason);
  }
}
