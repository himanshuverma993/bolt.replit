import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { jsonSchema, tool, type CoreTool } from 'ai';

export const MCP_PUBLIC_COOKIE = 'mcpServers';
export const MCP_SECRET_COOKIE = 'mcpSecrets';
export const MCP_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const MCP_REQUEST_TIMEOUT_MS = 10_000;
export const MCP_MAX_TOOL_OUTPUT = 16 * 1024;
export const MCP_MAX_STEPS = 3;
export const MCP_MAX_PUBLIC_COOKIE_BYTES = 12 * 1024;

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerStatus = 'connected' | 'error';

export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: McpServerStatus;
  statusMessage?: string;
  tools: McpToolInfo[];
};

type McpSecretState = Record<string, string>;

type CookieOptions = {
  httpOnly?: boolean;
  maxAge?: number;
};

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie') ?? '';
  const cookies: Record<string, string> = {};

  for (const item of header.split(';')) {
    const separator = item.indexOf('=');

    if (separator < 0) {
      continue;
    }

    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();

    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function cookieValue(name: string, value: string, options: CookieOptions = {}): string {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];

  if (options.maxAge !== undefined) {
    attributes.push(`Max-Age=${options.maxAge}`);
  }

  if (options.httpOnly) {
    attributes.push('HttpOnly');
  }

  if (locationProtocolIsSecure()) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

function locationProtocolIsSecure(): boolean {
  return true;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown MCP error';

  if (/unauthorized|401|oauth|authorization required/i.test(message)) {
    return 'MCP server requires OAuth; v1 supports authless servers and bearer tokens only.';
  }

  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, '$1[redacted]')
    .replace(/(token|secret|api[_ -]?key)\s*[:=]\s*[^\s,}]+/gi, '$1=[redacted]')
    .slice(0, 600);
}

function validateServerUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('MCP server URL must be a valid http:// or https:// URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP server URL must use http:// or https://');
  }

  if (url.username || url.password) {
    throw new Error('MCP server URL must not contain credentials; use the bearer token field');
  }

  if (/[?&](token|key|secret|auth)=/i.test(url.search)) {
    throw new Error('MCP bearer credentials must not be placed in the URL query string');
  }

  return url.toString();
}

function normalizeToolInfo(toolInfo: { name: string; description?: string; inputSchema?: unknown }): McpToolInfo {
  const inputSchema =
    toolInfo.inputSchema && typeof toolInfo.inputSchema === 'object' && !Array.isArray(toolInfo.inputSchema)
      ? (toolInfo.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };

  return {
    name: toolInfo.name.slice(0, 160),
    description: toolInfo.description?.slice(0, 1000),
    inputSchema,
  };
}

function getCookieState(request: Request): { servers: McpServerConfig[]; secrets: McpSecretState } {
  const cookies = parseCookies(request);
  let servers: McpServerConfig[] = [];

  if (cookies[MCP_PUBLIC_COOKIE]) {
    try {
      const parsed = JSON.parse(decodeURIComponent(cookies[MCP_PUBLIC_COOKIE])) as unknown;
      servers = Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
    } catch {
      servers = [];
    }
  }

  return { servers, secrets: {} };
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));

  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecrets(secrets: McpSecretState, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.byteLength);

  return base64UrlEncode(packed);
}

async function decryptSecrets(value: string, secret: string): Promise<McpSecretState> {
  try {
    const packed = base64UrlDecode(value);
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const key = await deriveKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as McpSecretState) : {};
  } catch {
    throw new Error('MCP token storage could not be decrypted; set MCP_COOKIE_SECRET and reconnect the server');
  }
}

export async function readMcpState(
  request: Request,
  env: Env,
): Promise<{ servers: McpServerConfig[]; secrets: McpSecretState }> {
  const state = getCookieState(request);
  const cookies = parseCookies(request);

  if (cookies[MCP_SECRET_COOKIE]) {
    if (!env.MCP_COOKIE_SECRET) {
      if (state.servers.some((server) => server.enabled)) {
        throw new Error('MCP_COOKIE_SECRET is required to read stored MCP bearer tokens');
      }

      return state;
    }

    state.secrets = await decryptSecrets(cookies[MCP_SECRET_COOKIE], env.MCP_COOKIE_SECRET);
  }

  return state;
}

export async function mcpStateHeaders(servers: McpServerConfig[], secrets: McpSecretState, env: Env): Promise<Headers> {
  const publicValue = JSON.stringify(servers);

  if (new TextEncoder().encode(publicValue).byteLength > MCP_MAX_PUBLIC_COOKIE_BYTES) {
    throw new Error('MCP configuration is too large for cookie storage; remove unused servers or tools');
  }

  if (Object.keys(secrets).length > 0 && !env.MCP_COOKIE_SECRET) {
    throw new Error('Set MCP_COOKIE_SECRET in Worker secrets before saving an MCP bearer token');
  }

  const headers = new Headers();
  headers.append('Set-Cookie', cookieValue(MCP_PUBLIC_COOKIE, publicValue, { maxAge: MCP_COOKIE_MAX_AGE }));

  if (Object.keys(secrets).length > 0 && env.MCP_COOKIE_SECRET) {
    const encrypted = await encryptSecrets(secrets, env.MCP_COOKIE_SECRET);
    headers.append(
      'Set-Cookie',
      cookieValue(MCP_SECRET_COOKIE, encrypted, { httpOnly: true, maxAge: MCP_COOKIE_MAX_AGE }),
    );
  } else {
    headers.append('Set-Cookie', cookieValue(MCP_SECRET_COOKIE, '', { httpOnly: true, maxAge: 0 }));
  }

  return headers;
}

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, message: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(message), MCP_REQUEST_TIMEOUT_MS);

  return operation(controller.signal).finally(() => clearTimeout(timeout));
}

async function withMcpClient<T>(
  server: McpServerConfig,
  bearerToken: string | undefined,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const headers: Record<string, string> = {};

  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers },
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: 'bolt-replit', version: '0.0.3' });

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

export async function discoverMcpTools(server: McpServerConfig, bearerToken?: string): Promise<McpToolInfo[]> {
  return withMcpClient(server, bearerToken, async (client) => {
    const result = await withTimeout(
      (signal) => client.listTools(undefined, { signal, timeout: MCP_REQUEST_TIMEOUT_MS }),
      'MCP tools/list timed out',
    );

    return result.tools.map(normalizeToolInfo);
  });
}

function stringifyToolOutput(value: unknown): string {
  const result = typeof value === 'string' ? value : JSON.stringify(value);

  if (new TextEncoder().encode(result).byteLength <= MCP_MAX_TOOL_OUTPUT) {
    return result;
  }

  return `[MCP tool output exceeded the ${MCP_MAX_TOOL_OUTPUT}-byte limit and was truncated]`;
}

export async function callMcpTool(
  server: McpServerConfig,
  bearerToken: string | undefined,
  toolName: string,
  args: unknown,
): Promise<string> {
  if (!server.tools.some((toolInfo) => toolInfo.name === toolName)) {
    return `MCP tool ${toolName} is not in the discovered tool list for ${server.name}`;
  }

  try {
    const result = await withMcpClient(server, bearerToken, (client) =>
      withTimeout(
        (signal) =>
          client.callTool({ name: toolName, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
            signal,
            timeout: MCP_REQUEST_TIMEOUT_MS,
          }),
        'MCP tools/call timed out',
      ),
    );

    if ('isError' in result && result.isError) {
      return `MCP tool ${toolName} returned an error: ${stringifyToolOutput(result.content)}`;
    }

    return stringifyToolOutput(result);
  } catch (error) {
    return `MCP tool ${toolName} failed on ${server.name}: ${safeMessage(error)}`;
  }
}

function toolNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'server';
}

export async function getMcpTools(request: Request, env: Env): Promise<Record<string, CoreTool>> {
  const { servers, secrets } = await readMcpState(request, env);
  const tools: Record<string, CoreTool> = {};
  const usedNames = new Set<string>();

  for (const server of servers.filter((item) => item.enabled && item.tools.length > 0)) {
    for (const toolInfo of server.tools) {
      const baseName = `mcp_${toolNamePart(server.name)}_${toolNamePart(toolInfo.name)}`;
      let name = baseName;
      let suffix = 2;

      while (usedNames.has(name)) {
        name = `${baseName}_${suffix}`;
        suffix += 1;
      }

      usedNames.add(name);
      tools[name] = tool({
        description: `[MCP server: ${server.name}] ${toolInfo.description ?? toolInfo.name}`,
        parameters: jsonSchema(toolInfo.inputSchema),
        execute: async (args) => ({
          server: server.name,
          tool: toolInfo.name,
          result: await callMcpTool(server, secrets[server.id], toolInfo.name, args),
        }),
      });
    }
  }

  return tools;
}

export function publicMcpServer(server: McpServerConfig): Omit<McpServerConfig, never> {
  return server;
}

export { safeMessage as getMcpErrorMessage, validateServerUrl };
