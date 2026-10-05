/**
 * MCP (Model Context Protocol) client for bolt-replit.
 *
 * Transport: Streamable HTTP only (the current official transport). Nothing is
 * ever upgraded to SSE by force.
 *
 * Security model
 * --------------
 *  - Server *configuration* (names, URLs, enabled flag, compact tool catalog)
 *    is stored in the `mcpServers` cookie. When a Worker secret is configured
 *    that cookie is HMAC signed, so a client cannot rewrite a stored server URL
 *    and make Bolt send an existing credential to an attacker-controlled host.
 *    Full JSON Schemas are not persisted (they exceed the browser's ~4 KiB
 *    cookie limit for GitHub-sized catalogs); chat rediscovers them live.
 *    Oversized cookies are sharded (`mcpServers_2`, …).
 *  - Credentials (bearer tokens, OAuth tokens, PKCE verifiers, client
 *    registrations) live in separate AES-256-GCM sealed, HttpOnly, Secure
 *    cookies (also sharded). Page JavaScript can neither read nor forge them.
 *  - Cookies written by the previous implementation (unsigned config, opaque
 *    secrets cookie without a signature) are dropped and reported to the UI
 *    instead of being trusted.
 *  - Destructive/write tools require an explicit per-server opt-in; the
 *    decision is enforced on the server, not in the model prompt.
 *
 * Limits: 10 s per request, 16 KiB tool output, 3 tool-loop steps, and no
 * cookie larger than ~3.5 KiB (browser limit).
 */

import { Client, type ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { jsonSchema, tool, type CoreTool } from 'ai';
import {
  clearShardedCookies,
  cookieShardCount,
  decodeSignedCookieValue,
  encodeSignedCookieValue,
  getRequestOrigin,
  isSecureOrigin,
  joinShardedCookie,
  MAX_COOKIE_SHARDS,
  openJsonPayload,
  readRequestCookies,
  redactSecrets,
  resolveAppSecret,
  sealJsonPayload,
  serializeShardedCookies,
  type SecretEnvironment,
} from '~/lib/.server/secrets';
import {
  isMcpOAuthConfigured,
  oauthStoreHeaders,
  readOAuthStore,
  requireOAuthSecret,
  transportAuthProvider,
  type McpOAuthStore,
} from '~/lib/.server/mcp-oauth';
import { catalogAuthForUrl } from '~/lib/mcp/catalog';

export const MCP_PUBLIC_COOKIE = 'mcpServers';
export const MCP_SECRET_COOKIE = 'mcpSecrets';
export const MCP_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const MCP_REQUEST_TIMEOUT_MS = 10_000;
export const MCP_MAX_TOOL_OUTPUT = 16 * 1024;
export const MCP_MAX_STEPS = 3;

/** @deprecated Per-cookie limit is COOKIE_VALUE_LIMIT_BYTES; total budget is shards × that. */
export const MCP_MAX_PUBLIC_COOKIE_BYTES = 3500 * 8;
export const MCP_TOOL_DESCRIPTION_LIMIT = 500;
export const MCP_STORED_DESCRIPTION_LIMIT = 160;

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  risk: McpToolRisk;
};

export type McpToolRisk = 'read' | 'write' | 'destructive';

export type McpAuthMode = 'authless' | 'bearer' | 'oauth';

export type McpServerStatus = 'connected' | 'error' | 'auth_required';

export type McpErrorCode =
  | 'dns'
  | 'network'
  | 'tls'
  | 'http_401'
  | 'http_403'
  | 'oauth_required'
  | 'invalid_bearer_token'
  | 'unsupported_transport'
  | 'protocol_negotiation_failed'
  | 'tools_list_failed'
  | 'tools_call_failed'
  | 'timeout'
  | 'invalid_request'
  | 'not_configured'
  | 'malformed_response'
  | 'unknown';

export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authMode: McpAuthMode;
  status: McpServerStatus;
  statusMessage?: string;
  statusCode?: McpErrorCode;
  statusHint?: string;

  /** Explicit opt-in for write/destructive tools. Defaults to false. */
  allowRiskyTools?: boolean;
  tools: McpToolInfo[];
  addedAt?: string;
  lastCheckedAt?: string;
};

export type McpSecretState = Record<string, string>;

export type McpState = {
  servers: McpServerConfig[];
  secrets: McpSecretState;
  oauth: McpOAuthStore;

  /** Non-fatal problems the UI must show (reset config, dropped cookies, ...). */
  warnings: string[];
};

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly hint?: string;

  constructor(code: McpErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.hint = hint;
  }
}

const RISKY_NAME_PATTERN =
  /(delete|destroy|drop|purge|revoke|truncate|uninstall|reset|overwrite|remove|kill|wipe|erase)/i;
const READ_NAME_PATTERN =
  /^(get|list|search|read|fetch|describe|show|inspect|query|lookup|find|retrieve|preview|analyze|analyse|check|status|info|export|download|render|screenshot|view|count|resolve|validate)/i;
const WRITE_NAME_PATTERN =
  /(create|update|write|set|put|post|patch|add|insert|push|send|deploy|publish|execute|run|exec|apply|merge|commit|upload|move|rename|copy|transfer|pay|approve|reject|cancel|close|open|start|stop|restart|enable|disable|assign|invite|comment|edit|modify|link|attach|tag|schedule|trigger)/i;

/**
 * Classifies a tool by risk. Conservative by design: a tool that is not clearly
 * a read-only operation needs the user's per-server opt-in before it runs.
 */
export function classifyToolRisk(name: string, description?: string): McpToolRisk {
  const haystack = `${name} ${description ?? ''}`;

  if (RISKY_NAME_PATTERN.test(name) || RISKY_NAME_PATTERN.test(haystack)) {
    return 'destructive';
  }

  if (READ_NAME_PATTERN.test(name)) {
    return 'read';
  }

  if (WRITE_NAME_PATTERN.test(name) || WRITE_NAME_PATTERN.test(haystack)) {
    return 'write';
  }

  return 'write';
}

export function toolRequiresApproval(tool: Pick<McpToolInfo, 'risk'>): boolean {
  return tool.risk !== 'read';
}

function classifyRawMessage(message: string, hasBearerToken: boolean): McpError | undefined {
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(message)) {
    return new McpError('dns', 'MCP server host could not be resolved (DNS failure).', 'Check the server URL.');
  }

  if (/certificate|self-signed|TLS|SSL|ERR_SSL/i.test(message)) {
    return new McpError('tls', 'TLS handshake with the MCP server failed.', 'The server certificate is not trusted.');
  }

  if (/401|unauthori[sz]ed/i.test(message)) {
    return hasBearerToken
      ? new McpError(
          'invalid_bearer_token',
          'The MCP server rejected the bearer token (HTTP 401).',
          'Check that the token is valid and not expired, then reconnect the server.',
        )
      : new McpError(
          'oauth_required',
          'This MCP server requires OAuth authorization before it can be used.',
          'Use "Connect with OAuth" in Settings → Connection.',
        );
  }

  if (/403|forbidden/i.test(message)) {
    return new McpError(
      'http_403',
      'The MCP server refused the request (HTTP 403).',
      'The credential is valid but lacks the required scope or permission.',
    );
  }

  if (/405|not acceptable|unsupported media|content-type/i.test(message)) {
    return new McpError(
      'unsupported_transport',
      'The MCP server does not accept Streamable HTTP at this URL.',
      'Verify the endpoint URL; the official endpoints end in `/mcp`.',
    );
  }

  if (/abort|timed out|timeout/i.test(message)) {
    return new McpError(
      'timeout',
      `MCP request timed out after ${MCP_REQUEST_TIMEOUT_MS / 1000}s.`,
      'Retry, or check the server status.',
    );
  }

  if (/unsupported protocol version|protocol version|initialize/i.test(message)) {
    return new McpError(
      'protocol_negotiation_failed',
      'MCP protocol negotiation failed during initialize.',
      'The server may implement an incompatible MCP revision.',
    );
  }

  if (/fetch failed|network|socket|ECONN/i.test(message)) {
    return new McpError(
      'network',
      'Could not reach the MCP server from the Worker.',
      'Check network egress and the server URL.',
    );
  }

  if (/JSON|parse|Unexpected token|malformed/i.test(message)) {
    return new McpError(
      'malformed_response',
      'The MCP server returned a malformed response.',
      'The endpoint may not be an MCP server.',
    );
  }

  return undefined;
}

/** Maps transport/SDK failures onto stable codes the UI can act on. */
export function getMcpErrorMessage(error: unknown, phase: 'connect' | 'list' | 'call' = 'connect'): string {
  return classifyMcpError(error, phase).message;
}

export function classifyMcpError(
  error: unknown,
  phase: 'connect' | 'list' | 'call' = 'connect',
  hasBearerToken = false,
): McpError {
  if (error instanceof McpError) {
    if (
      hasBearerToken &&
      (error.code === 'http_401' || error.code === 'oauth_required' || error.code === 'invalid_bearer_token')
    ) {
      return error.code === 'invalid_bearer_token'
        ? error
        : new McpError(
            'invalid_bearer_token',
            'The MCP server rejected the bearer token (HTTP 401).',
            'Check that the token is valid and not expired, then reconnect the server.',
          );
    }

    return error;
  }

  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const status =
    typeof record?.code === 'number' ? record.code : typeof record?.status === 'number' ? record.status : undefined;
  const rawMessage = redactSecrets(
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : record?.message
          ? String(record.message)
          : 'Unknown MCP error',
  ).slice(0, 400);

  if (status === 401) {
    return hasBearerToken
      ? new McpError(
          'invalid_bearer_token',
          'The MCP server rejected the bearer token (HTTP 401).',
          'Check that the token is valid and not expired, then reconnect the server.',
        )
      : new McpError(
          'http_401',
          'The MCP server answered HTTP 401 (authentication required).',
          'Connect the server with OAuth or provide a valid bearer token.',
        );
  }

  if (status === 403) {
    return new McpError(
      'http_403',
      'The MCP server answered HTTP 403 (forbidden).',
      'The credential lacks the required scope.',
    );
  }

  const fromMessage = classifyRawMessage(rawMessage, hasBearerToken);

  if (fromMessage) {
    return fromMessage;
  }

  if (phase === 'list') {
    return new McpError(
      'tools_list_failed',
      `MCP tools/list failed: ${rawMessage}`,
      'Refresh the connection from Settings → Connection.',
    );
  }

  if (phase === 'call') {
    return new McpError('tools_call_failed', `MCP tools/call failed: ${rawMessage}`);
  }

  return new McpError('unknown', `MCP connection failed: ${rawMessage}`);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const PRIVATE_IPV4 =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/;

/*
 * Plain http is a local-development convenience (self-hosted servers on the same
 * machine or LAN). A public host over http would send a bearer token in
 * cleartext, so those must use https.
 */
function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (LOOPBACK_HOSTS.has(host) || host === '::1') {
    return true;
  }

  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }

  if (PRIVATE_IPV4.test(host)) {
    return true;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) ranges.
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

export function validateServerUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new McpError('invalid_request', 'MCP server URL must be a valid http:// or https:// URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new McpError('invalid_request', 'MCP server URL must use http:// or https://');
  }

  if (url.protocol === 'http:' && !isLocalOrPrivateHost(url.hostname)) {
    throw new McpError(
      'invalid_request',
      'MCP server URLs must use https:// for remote hosts; http:// is only accepted for localhost or private-network addresses',
    );
  }

  if (url.username || url.password) {
    throw new McpError('invalid_request', 'MCP server URL must not contain credentials; use the bearer token field');
  }

  if (/[?&](token|key|secret|auth|access_token)=/i.test(url.search)) {
    throw new McpError('invalid_request', 'MCP credentials must not be placed in the URL query string');
  }

  return url.toString();
}

/**
 * Validates the authorization URL a remote server (or its `WWW-Authenticate`
 * header) asks the browser to visit.
 *
 * The URL is handed to `window.location`, so a hostile server could otherwise
 * redirect the browser to `javascript:` (script execution in Bolt's origin) or
 * to a plain-http page. RFC 8414 requires https for authorization endpoints;
 * loopback http is allowed so local development and the test suite work.
 */
export function assertSafeAuthorizationUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new McpError('invalid_request', 'The MCP authorization server returned an invalid authorization URL.');
  }

  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

  if (url.protocol !== 'https:' && !loopback) {
    throw new McpError(
      'invalid_request',
      'The MCP authorization server returned a non-https authorization URL; refusing to redirect the browser there.',
      'Use an MCP server whose authorization endpoint is served over https.',
    );
  }

  return url.toString();
}

function normalizeToolInfo(toolInfo: { name: string; description?: string; inputSchema?: unknown }): McpToolInfo {
  const inputSchema =
    toolInfo.inputSchema && typeof toolInfo.inputSchema === 'object' && !Array.isArray(toolInfo.inputSchema)
      ? (toolInfo.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
  const description = toolInfo.description?.slice(0, MCP_TOOL_DESCRIPTION_LIMIT);

  return {
    name: toolInfo.name.slice(0, 160),
    description,
    inputSchema,
    risk: classifyToolRisk(toolInfo.name, description),
  };
}

const EMPTY_INPUT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export type ToolCatalogCompactness = 'schema-stripped' | 'names-only' | 'metadata-only';

/**
 * Cookie-safe tool catalog. Full JSON Schemas (GitHub MCP: 40–90 tools × 9-field
 * schemas) cannot fit in a browser cookie even when sharded. Chat rediscovers
 * live schemas via {@link getMcpTools}.
 */
export function compactToolsForStorage(
  tools: McpToolInfo[],
  mode: Exclude<ToolCatalogCompactness, 'metadata-only'> = 'schema-stripped',
): McpToolInfo[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: mode === 'names-only' ? undefined : tool.description?.slice(0, MCP_STORED_DESCRIPTION_LIMIT),
    inputSchema: EMPTY_INPUT_SCHEMA,
    risk: tool.risk,
  }));
}

function serversForCookie(servers: McpServerConfig[], compactness: ToolCatalogCompactness): McpServerConfig[] {
  return servers.map((server) => ({
    ...server,
    tools: compactness === 'metadata-only' ? [] : compactToolsForStorage(server.tools, compactness),
  }));
}

function parseStoredServers(raw: string, trusted: boolean): McpServerConfig[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const servers: McpServerConfig[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;

    if (typeof record.id !== 'string' || typeof record.url !== 'string') {
      continue;
    }

    if (!trusted && !/^https?:\/\//i.test(record.url)) {
      continue;
    }

    servers.push({
      id: record.id,
      name: typeof record.name === 'string' ? record.name.slice(0, 100) : record.id,
      url: record.url,
      enabled: record.enabled !== false,
      authMode: record.authMode === 'bearer' || record.authMode === 'oauth' ? record.authMode : 'authless',
      status: record.status === 'connected' || record.status === 'auth_required' ? record.status : 'error',
      statusMessage: typeof record.statusMessage === 'string' ? record.statusMessage.slice(0, 400) : undefined,
      statusCode: typeof record.statusCode === 'string' ? (record.statusCode as McpErrorCode) : undefined,
      statusHint: typeof record.statusHint === 'string' ? record.statusHint.slice(0, 400) : undefined,
      allowRiskyTools: record.allowRiskyTools === true,
      tools: Array.isArray(record.tools) ? (record.tools as McpToolInfo[]).map(normalizeToolInfo).slice(0, 100) : [],
      addedAt: typeof record.addedAt === 'string' ? record.addedAt : undefined,
      lastCheckedAt: typeof record.lastCheckedAt === 'string' ? record.lastCheckedAt : undefined,
    });
  }

  return servers;
}

/**
 * Reads the full MCP state.
 *
 * The public cookie must carry a valid signature when a secret exists; unsigned
 * cookies (written by the previous implementation) are ignored and reported as
 * a warning so the user re-adds servers instead of inheriting untrusted state.
 */
export async function readMcpState(request: Request, env: SecretEnvironment): Promise<McpState> {
  const cookies = readRequestCookies(request);
  const secret = resolveAppSecret(env);
  const warnings: string[] = [];
  let servers: McpServerConfig[] = [];
  const publicRaw = joinShardedCookie(cookies, MCP_PUBLIC_COOKIE);

  if (publicRaw) {
    if (secret) {
      const unsigned = await decodeSignedCookieValue(publicRaw, secret.value);

      if (unsigned) {
        servers = parseStoredServers(unsigned, true);
      } else {
        const legacy = parseStoredServers(publicRaw, false);

        if (legacy.length > 0) {
          warnings.push(
            'MCP servers were reset because their configuration could not be verified. Please add them again.',
          );
        }
      }
    } else {
      const unsignedServers = parseStoredServers(publicRaw, false);

      if (unsignedServers.length > 0) {
        warnings.push(
          'MCP server configuration is unsigned because no Worker secret is configured. Set APP_ENCRYPTION_SECRET and re-add servers to store credentials securely.',
        );
        servers = unsignedServers;
      }
    }
  }

  let secrets: McpSecretState = {};
  const secretRaw = joinShardedCookie(cookies, MCP_SECRET_COOKIE);

  if (secretRaw) {
    if (!secret) {
      if (servers.some((server) => server.enabled)) {
        warnings.push(
          'Stored MCP credentials cannot be read: set APP_ENCRYPTION_SECRET (or MCP_COOKIE_SECRET) as a Worker secret.',
        );
      }
    } else {
      const decrypted = await openJsonPayload<McpSecretState>(secretRaw, secret.value);

      if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
        secrets = decrypted;
      } else {
        warnings.push(
          'Stored MCP credentials could not be decrypted and were dropped. Reconnect the affected servers.',
        );
      }
    }
  }

  const oauth = await readOAuthStore(request, env);

  return { servers, secrets, oauth, warnings };
}

async function encodePublicCookieValue(servers: McpServerConfig[], secretValue?: string): Promise<string> {
  const publicValue = JSON.stringify(servers);

  return secretValue ? encodeSignedCookieValue(publicValue, secretValue) : publicValue;
}

/**
 * Persist MCP state. Tool catalogs are compacted (no JSON Schemas) and cookies
 * are sharded so each Set-Cookie value stays under the browser's ~4 KiB limit.
 */
export async function mcpStateHeaders(
  servers: McpServerConfig[],
  secrets: McpSecretState,
  env: SecretEnvironment,
  oauth?: McpOAuthStore,
): Promise<string[]> {
  const secret = resolveAppSecret(env);
  const compactnessLevels: ToolCatalogCompactness[] = ['schema-stripped', 'names-only', 'metadata-only'];
  let encodedPublic: string | undefined;

  for (const compactness of compactnessLevels) {
    const candidate = await encodePublicCookieValue(serversForCookie(servers, compactness), secret?.value);

    if (cookieShardCount(candidate) <= MAX_COOKIE_SHARDS) {
      encodedPublic = candidate;
      break;
    }
  }

  if (!encodedPublic) {
    throw new McpError(
      'invalid_request',
      'MCP configuration is too large for cookie storage; remove unused servers or refresh their tool lists.',
    );
  }

  const headers: string[] = [
    ...serializeShardedCookies(MCP_PUBLIC_COOKIE, encodedPublic, { maxAge: MCP_COOKIE_MAX_AGE }),
  ];

  if (Object.keys(secrets).length > 0) {
    const sealed = await sealJsonPayload(secrets, requireOAuthSecret(env));

    if (cookieShardCount(sealed) > MAX_COOKIE_SHARDS) {
      throw new McpError(
        'invalid_request',
        'MCP credentials are too large for secure cookie storage; remove unused servers.',
      );
    }

    headers.push(
      ...serializeShardedCookies(MCP_SECRET_COOKIE, sealed, {
        httpOnly: true,
        maxAge: MCP_COOKIE_MAX_AGE,
        sameSite: 'Lax',
      }),
    );
  } else {
    headers.push(...clearShardedCookies(MCP_SECRET_COOKIE, { httpOnly: true }));
  }

  if (oauth) {
    headers.push(...(await oauthStoreHeaders(oauth, env)));
  }

  return headers;
}

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, message: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(message), MCP_REQUEST_TIMEOUT_MS);

  return operation(controller.signal).finally(() => clearTimeout(timeout));
}

export type McpClientContext = {
  serverId: string;
  env: SecretEnvironment;
  bearerToken?: string;
  oauth?: {
    store: McpOAuthStore;
    redirectUrl: string;
    clientMetadataUrl?: string;
  };
};

function transportRedirectUrl(request?: Request): string {
  return `${request ? getRequestOrigin(request) : 'http://localhost'}/api/mcp/oauth/callback`;
}

export function createMcpClientContext(options: {
  request?: Request;
  env: SecretEnvironment;
  serverId: string;
  bearerToken?: string;
  oauthStore?: McpOAuthStore;
  clientMetadataUrl?: string;
}): McpClientContext {
  const context: McpClientContext = {
    serverId: options.serverId,
    env: options.env,
    bearerToken: options.bearerToken,
  };

  if (options.oauthStore && isMcpOAuthConfigured(options.env)) {
    context.oauth = {
      store: options.oauthStore,
      redirectUrl: transportRedirectUrl(options.request),
      clientMetadataUrl: options.clientMetadataUrl,
    };
  }

  return context;
}

async function withMcpClient<T>(
  server: McpServerConfig,
  context: McpClientContext,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const headers: Record<string, string> = {};

  if (context.bearerToken) {
    headers.Authorization = `Bearer ${context.bearerToken}`;
  }

  const transportOptions: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
    requestInit: { headers },
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  };

  if (context.oauth) {
    transportOptions.authProvider = transportAuthProvider({
      store: context.oauth.store,
      serverId: context.serverId,
      serverUrl: server.url,
      redirectUrl: context.oauth.redirectUrl,
      clientMetadataUrl: context.oauth.clientMetadataUrl,
    });
  }

  const transport = new StreamableHTTPClientTransport(new URL(server.url), transportOptions);
  const client = new Client({ name: 'bolt-replit', version: '0.0.3' }, mcpClientOptions());

  try {
    await withTimeout(
      (signal) => client.connect(transport, { signal, timeout: MCP_REQUEST_TIMEOUT_MS }),
      'MCP initialize timed out',
    );

    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Client options for the MCP SDK on Cloudflare Workers.
 *
 * The SDK defaults to `AjvJsonSchemaValidator`, which compiles JSON Schemas with
 * `new Function`. workerd forbids dynamic code generation ("Code generation from
 * strings disallowed for this context"), so any remote server that publishes an
 * `outputSchema` made the whole tools/list fail. The SDK ships a
 * `@cfworker/json-schema` provider that validates without code generation, which
 * is what Workers requires.
 */
export function mcpClientOptions(): ClientOptions {
  return { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() };
}

export async function discoverMcpTools(
  server: McpServerConfig,
  context: McpClientContext,
  phase: 'connect' | 'list' = 'connect',
): Promise<McpToolInfo[]> {
  try {
    return await withMcpClient(server, context, async (client) => {
      const result = await withTimeout(
        (signal) => client.listTools(undefined, { signal, timeout: MCP_REQUEST_TIMEOUT_MS }),
        'MCP tools/list timed out',
      );

      return result.tools.map(normalizeToolInfo);
    });
  } catch (error) {
    throw classifyMcpError(error, phase, Boolean(context.bearerToken));
  }
}

function stringifyToolOutput(value: unknown): string {
  let result: string;

  try {
    result = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    result = '[MCP tool returned a value that could not be serialized]';
  }

  if (result === undefined) {
    result = 'undefined';
  }

  if (new TextEncoder().encode(result).byteLength <= MCP_MAX_TOOL_OUTPUT) {
    return result;
  }

  return `[MCP tool output exceeded the ${MCP_MAX_TOOL_OUTPUT}-byte limit and was truncated]`;
}

export type McpToolCallOutcome = {
  server: string;
  tool: string;
  risk: McpToolRisk;
  outcome: 'ok' | 'error' | 'denied';
  durationMs: number;
  result: string;
};

/** Executes a tool with server-side risk gating and audit-safe metadata. */
export async function callMcpTool(
  server: McpServerConfig,
  context: McpClientContext,
  toolName: string,
  args: unknown,
): Promise<string> {
  const toolInfo = server.tools.find((item) => item.name === toolName);

  if (!toolInfo) {
    return `MCP tool ${toolName} is not in the discovered tool list for ${server.name}. Refresh the connection in Settings → Connection.`;
  }

  const risk = toolInfo.risk;

  if (toolRequiresApproval(toolInfo) && server.allowRiskyTools !== true) {
    auditMcpToolCall({ server: server.name, tool: toolName, risk, outcome: 'denied', durationMs: 0 });

    return (
      `MCP tool ${toolName} on ${server.name} was NOT executed: it is classified as "${risk}" and this server has not ` +
      'been granted permission for write/destructive tools. Ask the user to enable "Allow write tools" for this server in Settings → Connection.'
    );
  }

  const startedAt = Date.now();

  try {
    const result = await withMcpClient(server, context, (client) =>
      withTimeout(
        (signal) =>
          client.callTool({ name: toolName, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
            signal,
            timeout: MCP_REQUEST_TIMEOUT_MS,
          }),
        'MCP tools/call timed out',
      ),
    );

    auditMcpToolCall({ server: server.name, tool: toolName, risk, outcome: 'ok', durationMs: Date.now() - startedAt });

    if ('isError' in result && result.isError) {
      return `MCP tool ${toolName} returned an error: ${stringifyToolOutput(result.content)}`;
    }

    return stringifyToolOutput(result);
  } catch (error) {
    const classified = classifyMcpError(error, 'call');

    auditMcpToolCall({
      server: server.name,
      tool: toolName,
      risk,
      outcome: 'error',
      durationMs: Date.now() - startedAt,
    });

    return `MCP tool ${toolName} failed on ${server.name} [${classified.code}]: ${classified.message}`;
  }
}

/**
 * Audit trail for tool execution. Server name, tool name, risk level, outcome
 * and duration only - never arguments, results or credentials.
 */
function auditMcpToolCall(entry: {
  server: string;
  tool: string;
  risk: McpToolRisk;
  outcome: 'ok' | 'error' | 'denied';
  durationMs: number;
}): void {
  console.log(
    `[mcp] tool_call ${JSON.stringify({
      server: entry.server.slice(0, 100),
      tool: entry.tool.slice(0, 100),
      risk: entry.risk,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
    })}`,
  );
}

function toolNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'server';
}

/**
 * Builds the AI SDK tool map for a chat request.
 *
 * When no MCP server is enabled this returns `{}` and `streamText` keeps its
 * previous code path exactly (no tools, no maxSteps).
 */
export async function getMcpTools(
  request: Request,
  env: SecretEnvironment,
  options: { clientMetadataUrl?: string } = {},
): Promise<Record<string, CoreTool>> {
  const clientMetadataUrl = options.clientMetadataUrl ?? mcpClientMetadataUrl(request);
  let state: McpState;

  try {
    state = await readMcpState(request, env);
  } catch (error) {
    console.error(`[mcp] state unavailable: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);

    return {};
  }

  const enabled = state.servers.filter((server) => server.enabled);

  if (enabled.length === 0) {
    return {};
  }

  const tools: Record<string, CoreTool> = {};
  const usedNames = new Set<string>();
  const resolved = await Promise.all(
    enabled.map(async (server) => {
      const context = createMcpClientContext({
        request,
        env,
        serverId: server.id,
        bearerToken: state.secrets[server.id],
        oauthStore: state.oauth,
        clientMetadataUrl,
      });

      /*
       * Cookie storage keeps a compact catalog (names/risk, no JSON Schemas).
       * Rediscover live schemas for the model; fall back to the stored list if
       * the remote server is briefly unreachable so a chat is not stripped of
       * tools mid-session.
       */
      let catalog = server.tools;

      try {
        catalog = await discoverMcpTools(server, context, 'list');
      } catch {
        catalog = server.tools;
      }

      return { server: { ...server, tools: catalog }, context, catalog };
    }),
  );

  for (const { server, context, catalog } of resolved) {
    if (catalog.length === 0) {
      continue;
    }

    for (const toolInfo of catalog) {
      const baseName = `mcp_${toolNamePart(server.name)}_${toolNamePart(toolInfo.name)}`;
      let name = baseName;
      let suffix = 2;

      while (usedNames.has(name)) {
        name = `${baseName}_${suffix}`;
        suffix += 1;
      }

      usedNames.add(name);

      tools[name] = tool({
        description:
          `[MCP server: ${server.name} | risk: ${toolInfo.risk}` +
          `${toolRequiresApproval(toolInfo) && server.allowRiskyTools !== true ? ' | requires user approval' : ''}] ` +
          (toolInfo.description ?? toolInfo.name),
        parameters: jsonSchema(toolInfo.inputSchema),
        execute: async (args) => ({
          server: server.name,
          tool: toolInfo.name,
          risk: toolInfo.risk,
          result: await callMcpTool(server, context, toolInfo.name, args),
        }),
      });
    }
  }

  return tools;
}

/** Absolute URL of the OAuth client-metadata document for this deployment. */
export function mcpClientMetadataUrl(request: Request): string | undefined {
  if (!isSecureOrigin(request)) {
    return undefined;
  }

  return `${getRequestOrigin(request)}/api/mcp/oauth/client-metadata`;
}

/**
 * Discovers tools for one server and records the outcome on the entry.
 * Never throws: failures become a status the UI can explain precisely.
 */
export async function refreshServerStatus(
  server: McpServerConfig,
  state: McpState,
  env: SecretEnvironment,
  request: Request,
): Promise<McpServerConfig> {
  const context = createMcpClientContext({
    request,
    env,
    serverId: server.id,
    bearerToken: state.secrets[server.id],
    oauthStore: state.oauth,
    clientMetadataUrl: mcpClientMetadataUrl(request),
  });

  try {
    const tools = await discoverMcpTools(server, context);

    return {
      ...server,
      tools,
      status: 'connected',
      statusMessage: undefined,
      statusCode: undefined,
      statusHint: undefined,
      lastCheckedAt: new Date().toISOString(),
    };
  } catch (error) {
    const classified = classifyMcpError(error, 'connect', Boolean(state.secrets[server.id]));
    const resolved = resolveDiscoveryFailure(server, classified, Boolean(state.secrets[server.id]));

    return {
      ...server,
      ...resolved,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/**
 * Turns a tools/list failure into the status the UI should show.
 *
 * GitHub's remote MCP answers HTTP 401 until a PAT is sent. That is not an
 * OAuth requirement for this host (OAuth needs a GitHub App). Forcing
 * `authMode: 'oauth'` made the Connection tab offer "Connect with OAuth" and
 * hide the PAT path.
 */
export function resolveDiscoveryFailure(
  server: Pick<McpServerConfig, 'authMode' | 'url'>,
  classified: McpError,
  hadBearer: boolean,
): {
  authMode: McpAuthMode;
  status: McpServerStatus;
  statusMessage: string;
  statusCode: McpErrorCode;
  statusHint?: string;
} {
  const catalogAuth = catalogAuthForUrl(server.url);
  const wantsBearer = server.authMode === 'bearer' || catalogAuth === 'bearer';
  const wantsOAuth = server.authMode === 'oauth' || catalogAuth === 'oauth';
  const authChallenge =
    classified.code === 'http_401' ||
    classified.code === 'oauth_required' ||
    classified.code === 'invalid_bearer_token';

  if (hadBearer && authChallenge) {
    const error =
      classified.code === 'invalid_bearer_token'
        ? classified
        : new McpError(
            'invalid_bearer_token',
            'The MCP server rejected the bearer token (HTTP 401).',
            'Check that the token is valid and not expired, then reconnect the server.',
          );

    return { authMode: 'bearer', status: 'error', ...mcpStatusFields(error) };
  }

  if (wantsBearer && !wantsOAuth && authChallenge) {
    return {
      authMode: 'bearer',
      status: 'auth_required',
      ...mcpStatusFields(
        new McpError(
          'http_401',
          'The MCP server requires a bearer token (HTTP 401).',
          'Paste a PAT as the bearer token. GitHub’s remote MCP server does not complete OAuth unless this host registers a GitHub App.',
        ),
      ),
    };
  }

  const authRequired = classified.code === 'oauth_required' || classified.code === 'http_401';

  return {
    authMode: authRequired || wantsOAuth ? (authRequired ? 'oauth' : server.authMode) : server.authMode,
    status: authRequired ? 'auth_required' : 'error',
    ...mcpStatusFields(classified),
  };
}

export function publicMcpServer(server: McpServerConfig): McpServerConfig {
  return server;
}

/** Status message + hint for a classification, safe for the UI. */
export function mcpStatusFields(error: McpError): {
  statusMessage: string;
  statusCode: McpErrorCode;
  statusHint?: string;
} {
  return {
    statusMessage: error.message,
    statusCode: error.code,
    statusHint: error.hint,
  };
}
