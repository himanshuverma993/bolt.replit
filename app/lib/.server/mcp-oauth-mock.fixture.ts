/*
 * Mock MCP servers for the OAuth tests: one HTTP server that plays both the MCP
 * resource server (Streamable HTTP, bearer protected) and the authorization
 * server (metadata, dynamic client registration, PKCE code exchange, refresh).
 *
 * The mock binds to 127.0.0.1 on an ephemeral port; no network access and no
 * real credentials are involved. It is shared by app/lib/.server/mcp-oauth.spec.ts
 * (client level) and app/lib/.server/mcp-oauth-callback-route.spec.ts (route level).
 */
/* eslint-disable consistent-return */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServerConfig } from './mcp';

export type OAuthMockState = {
  tokenRequests: number;
  refreshRequests: number;
  authorizationCodeRequests: number;
  revokedAccessTokens: Set<string>;
  revokedRefreshTokens: Set<string>;
  lastCodeVerifier: string | undefined;
  lastCodeChallenge: string | undefined;
};

const servers: Server[] = [];
export const mockState: OAuthMockState = {
  tokenRequests: 0,
  refreshRequests: 0,
  authorizationCodeRequests: 0,
  revokedAccessTokens: new Set(),
  revokedRefreshTokens: new Set(),
  lastCodeVerifier: undefined,
  lastCodeChallenge: undefined,
};

export function resetMockState(): void {
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

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function startOAuthMock(): Promise<{ origin: string; mcpUrl: string }> {
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

export function serverConfig(url: string): McpServerConfig {
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

export async function closeOAuthMockServers(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
}
