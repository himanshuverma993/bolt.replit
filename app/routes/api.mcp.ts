import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { json } from '@remix-run/cloudflare';
import {
  assertSafeAuthorizationUrl,
  classifyMcpError,
  getMcpErrorMessage,
  mcpClientMetadataUrl,
  mcpStateHeaders,
  readMcpState,
  refreshServerStatus,
  validateServerUrl,
  McpError,
  type McpServerConfig,
  type McpState,
} from '~/lib/.server/mcp';
import {
  beginMcpAuthorization,
  clearOAuthStateCookie,
  isMcpOAuthConfigured,
  McpOAuthError,
  oauthStateCookie,
  oauthStoreHeaders,
  removeOAuthEntry,
  requireOAuthSecret,
  type McpOAuthStore,
} from '~/lib/.server/mcp-oauth';
import { getRequestOrigin, isSameOriginRequest, isSecureOrigin, type SecretEnvironment } from '~/lib/.server/secrets';
import { catalogAuthForUrl } from '~/lib/mcp/catalog';

type McpEnv = SecretEnvironment & {
  ASSETS?: unknown;
  AI?: unknown;
};

function getEnv(context: ActionFunctionArgs['context'] | LoaderFunctionArgs['context']): McpEnv {
  return (context.cloudflare.env ?? {}) as McpEnv;
}

function createId(): string {
  return crypto.randomUUID();
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpError('invalid_request', 'MCP server name is required');
  }

  return value.trim().slice(0, 100);
}

function normalizeToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || value.length > 4096) {
    throw new McpError('invalid_request', 'MCP bearer token must be a string of at most 4096 characters');
  }

  return value;
}

async function appendCookies(headers: Headers, cookies: string[]): Promise<void> {
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
}

async function persistState(state: McpState, env: McpEnv, oauth?: McpOAuthStore): Promise<Headers> {
  const headers = new Headers();

  await appendCookies(headers, await mcpStateHeaders(state.servers, state.secrets, env, oauth));

  return headers;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);

  try {
    const state = await readMcpState(request, env);

    return json({
      servers: state.servers,
      warnings: state.warnings,
      oauthConfigured: isMcpOAuthConfigured(env),
      credentialStorageConfigured: isMcpOAuthConfigured(env),
    });
  } catch (error) {
    return json({ error: getMcpErrorMessage(error), code: 'unknown' }, { status: 400 });
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);

  if (request.method !== 'POST') {
    return json({ error: 'MCP endpoint accepts POST for connection management' }, { status: 405 });
  }

  if (!isSameOriginRequest(request)) {
    return json({ error: 'Cross-origin request rejected', code: 'invalid_request' }, { status: 403 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const operation = body.action;
    const state = await readMcpState(request, env);
    const servers = [...state.servers];
    const secrets = { ...state.secrets };
    const oauth: McpOAuthStore = { ...state.oauth };

    if (operation === 'add') {
      const name = normalizeName(body.name);
      const url = validateServerUrl(typeof body.url === 'string' ? body.url.trim() : '');
      const token = normalizeToken(body.token);
      const id = createId();
      const server: McpServerConfig = {
        id,
        name,
        url,
        enabled: true,
        authMode: token ? 'bearer' : (catalogAuthForUrl(url) ?? 'authless'),
        status: 'error',
        tools: [],
        addedAt: new Date().toISOString(),
      };

      if (token) {
        requireOAuthSecret(env);
        secrets[id] = token;
      }

      const refreshed = await refreshServerStatus(server, { ...state, secrets }, env, request);

      servers.push(refreshed);

      const headers = await persistState({ ...state, servers, secrets }, env, oauth);
      const warnings = [...state.warnings];

      if (refreshed.status === 'auth_required') {
        warnings.push(
          refreshed.authMode === 'bearer'
            ? `${refreshed.name} requires a bearer token (GitHub: a PAT). Paste it in the bearer field and add the server again.`
            : `${refreshed.name} requires OAuth authorization. Use "Connect with OAuth" to finish signing in.`,
        );
      }

      return json({ server: refreshed, servers, warnings }, { headers });
    }

    const idBasedActions = ['toggle', 'set-allow-risky', 'remove', 'refresh', 'authorize', 'disconnect-auth'];

    if (typeof operation !== 'string' || !idBasedActions.includes(operation)) {
      return json({ error: 'Unsupported MCP action', code: 'invalid_request' }, { status: 400 });
    }

    const id = typeof body.id === 'string' ? body.id : '';
    const serverIndex = servers.findIndex((server) => server.id === id);

    if (serverIndex < 0) {
      return json({ error: 'MCP server was not found', code: 'invalid_request' }, { status: 404 });
    }

    if (operation === 'toggle') {
      servers[serverIndex] = { ...servers[serverIndex], enabled: body.enabled === true };
    } else if (operation === 'set-allow-risky') {
      servers[serverIndex] = { ...servers[serverIndex], allowRiskyTools: body.allowRiskyTools === true };
    } else if (operation === 'remove') {
      servers.splice(serverIndex, 1);
      delete secrets[id];
      removeOAuthEntry(oauth, id);
    } else if (operation === 'refresh') {
      servers[serverIndex] = await refreshServerStatus(
        servers[serverIndex],
        { ...state, secrets, oauth },
        env,
        request,
      );
    } else if (operation === 'authorize') {
      const server = servers[serverIndex];

      requireOAuthSecret(env);

      if (!isSecureOrigin(request)) {
        return json(
          {
            error: 'OAuth connections require an https deployment (or the Worker dev proxy).',
            code: 'invalid_request',
          },
          { status: 400 },
        );
      }

      const result = await beginMcpAuthorization({
        store: oauth,
        serverId: server.id,
        serverUrl: server.url,
        redirectUrl: `${getRequestOrigin(request)}/api/mcp/oauth/callback`,
        clientMetadataUrl: mcpClientMetadataUrl(request),
        scope: typeof body.scope === 'string' ? body.scope : undefined,
      });

      const headers = new Headers();

      await appendCookies(headers, await oauthStoreHeaders(result.store, env));
      headers.append('Set-Cookie', oauthStateCookie(server.id));

      if (result.status === 'authorized') {
        servers[serverIndex] = await refreshServerStatus(
          { ...server, authMode: 'oauth' },
          { ...state, servers, secrets, oauth: result.store },
          env,
          request,
        );

        await appendCookies(headers, await mcpStateHeaders(servers, secrets, env, result.store));

        return json({ status: 'authorized', servers }, { headers });
      }

      servers[serverIndex] = { ...server, authMode: 'oauth', status: 'auth_required' };
      await appendCookies(headers, await mcpStateHeaders(servers, secrets, env, result.store));

      return json(
        {
          status: 'redirect',

          // Never hand an unvalidated URL to the browser: it ends up in window.location.
          authorizationUrl: assertSafeAuthorizationUrl(result.authorizationUrl),
          servers,
          serverId: server.id,
        },
        { headers },
      );
    } else if (operation === 'disconnect-auth') {
      const server = servers[serverIndex];

      removeOAuthEntry(oauth, id);
      servers[serverIndex] = {
        ...server,
        status: server.authMode === 'oauth' ? 'auth_required' : server.status,
        statusMessage: server.authMode === 'oauth' ? 'OAuth authorization removed.' : server.statusMessage,
      };

      const headers = new Headers();

      await appendCookies(headers, await oauthStoreHeaders(oauth, env));
      await appendCookies(headers, await mcpStateHeaders(servers, secrets, env, oauth));
      headers.append('Set-Cookie', clearOAuthStateCookie());

      return json({ servers }, { headers });
    }

    const headers = await persistState({ ...state, servers, secrets, oauth }, env, oauth);

    return json({ servers, warnings: state.warnings }, { headers });
  } catch (error) {
    if (error instanceof McpOAuthError) {
      return json({ error: error.message, code: error.code }, { status: error.code === 'not_configured' ? 501 : 400 });
    }

    const classified = classifyMcpError(error);

    return json({ error: classified.message, code: classified.code, hint: classified.hint }, { status: 400 });
  }
}
