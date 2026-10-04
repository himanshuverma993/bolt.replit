/**
 * OAuth support for remote MCP servers (Streamable HTTP).
 *
 * Uses the official MCP TypeScript SDK OAuth client (`auth()` +
 * `OAuthClientProvider`), which implements RFC 9728 protected-resource
 * discovery, RFC 8414 authorization-server discovery, dynamic client
 * registration (RFC 7591) / SEP-991 URL client IDs, PKCE (S256) and refresh
 * token rotation. This module only supplies the missing half: a
 * Worker-compatible, tamper-proof credential store and the two HTTP flows
 * (`beginAuthorization`, `completeAuthorization`).
 *
 * Storage: every server's tokens, client registration, PKCE verifier, state and
 * discovery cache live in one AES-256-GCM sealed, HttpOnly, Secure,
 * SameSite=Lax cookie. The browser cannot read or modify it, and nothing is ever
 * written to a JavaScript-readable cookie, a URL, a log or a chat message.
 */

import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  clearCookie,
  missingSecretMessage,
  openJsonPayload,
  readRequestCookies,
  resolveAppSecret,
  redactSecrets,
  sealJsonPayload,
  serializeCookie,
  signaturesMatch,
  type SecretEnvironment,
} from '~/lib/.server/secrets';

export const MCP_OAUTH_COOKIE = 'mcp_oauth';
export const MCP_OAUTH_MAX_AGE = 60 * 60 * 24 * 30;
export const MCP_OAUTH_STATE_COOKIE = 'mcp_oauth_state';
export const MCP_OAUTH_STATE_MAX_AGE = 60 * 10;
export const MCP_OAUTH_COOKIE_LIMIT_BYTES = 3500;

export type McpOAuthEntry = {
  serverId: string;
  serverUrl: string;
  state?: string;
  codeVerifier?: string;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  updatedAt: string;
};

export type McpOAuthStore = Record<string, McpOAuthEntry>;

export class McpOAuthError extends Error {
  readonly code:
    | 'not_configured'
    | 'state_mismatch'
    | 'missing_verifier'
    | 'storage_limit'
    | 'unsupported'
    | 'oauth_failed';

  constructor(code: McpOAuthError['code'], message: string) {
    super(message);
    this.name = 'McpOAuthError';
    this.code = code;
  }
}

export function requireOAuthSecret(env: SecretEnvironment): string {
  const secret = resolveAppSecret(env);

  if (!secret) {
    throw new McpOAuthError('not_configured', missingSecretMessage('MCP OAuth token'));
  }

  return secret.value;
}

export function isMcpOAuthConfigured(env: SecretEnvironment): boolean {
  return resolveAppSecret(env) !== undefined;
}

export async function readOAuthStore(request: Request, env: SecretEnvironment): Promise<McpOAuthStore> {
  const secret = resolveAppSecret(env);
  const raw = readRequestCookies(request)[MCP_OAUTH_COOKIE];

  if (!raw || !secret) {
    return {};
  }

  const store = await openJsonPayload<McpOAuthStore>(raw, secret.value);

  return store && typeof store === 'object' ? store : {};
}

/** Clears the pending-flow pointer cookie (never holds tokens). */
export function clearOAuthStateCookie(): string {
  return clearCookie(MCP_OAUTH_STATE_COOKIE, { httpOnly: true });
}

export function oauthStateCookie(serverId: string): string {
  return serializeCookie(MCP_OAUTH_STATE_COOKIE, serverId, {
    httpOnly: true,
    maxAge: MCP_OAUTH_STATE_MAX_AGE,
    sameSite: 'Lax',
  });
}

function pruneStore(store: McpOAuthStore): void {
  for (const [serverId, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== 'object' || entry.serverId !== serverId) {
      delete store[serverId];
    }
  }
}

export async function oauthStoreHeaders(store: McpOAuthStore, env: SecretEnvironment): Promise<string[]> {
  const secret = resolveAppSecret(env);

  if (!secret) {
    return [clearCookie(MCP_OAUTH_COOKIE, { httpOnly: true })];
  }

  pruneStore(store);

  if (Object.keys(store).length === 0) {
    return [clearCookie(MCP_OAUTH_COOKIE, { httpOnly: true })];
  }

  const fits = (value: string) => new TextEncoder().encode(value).byteLength <= MCP_OAUTH_COOKIE_LIMIT_BYTES;
  let sealed = await sealJsonPayload(store, secret.value);

  if (!fits(sealed)) {
    /*
     * Discovery metadata is a cache: the SDK re-runs RFC 9728/8414 discovery on
     * the next request, so dropping it costs one round trip and is always
     * preferable to losing the tokens (or failing the flow). Access tokens are
     * often long JWTs, and the practical cookie limit is about 4 KiB.
     */
    for (const entry of Object.values(store)) {
      entry.discovery = undefined;
    }

    sealed = await sealJsonPayload(store, secret.value);
  }

  if (!fits(sealed)) {
    throw new McpOAuthError(
      'storage_limit',
      'MCP OAuth state is too large for secure cookie storage. Disconnect MCP servers you no longer use and reconnect the ones you need.',
    );
  }

  return [serializeCookie(MCP_OAUTH_COOKIE, sealed, { httpOnly: true, maxAge: MCP_OAUTH_MAX_AGE, sameSite: 'Lax' })];
}

export function emptyEntry(serverId: string, serverUrl: string): McpOAuthEntry {
  return { serverId, serverUrl, updatedAt: new Date().toISOString() };
}

function stateFor(entry: McpOAuthEntry): string {
  if (!entry.state) {
    entry.state = crypto.randomUUID().replace(/-/g, '');
  }

  return entry.state;
}

/**
 * Validates the `state` parameter of the OAuth redirect.
 *
 * The SDK does not verify state when exchanging an authorization code, so the
 * callback route must do it (CSRF protection, RFC 6749 §10.12). The pending
 * comparison is constant over the stored per-server value.
 */
export function validateOAuthState(store: McpOAuthStore, serverId: string, receivedState: string | null): void {
  const entry = store[serverId];
  const expected = entry?.state;

  if (!expected || !receivedState || !signaturesMatch(expected, receivedState)) {
    throw new McpOAuthError(
      'state_mismatch',
      'MCP OAuth callback rejected: the state parameter did not match the pending authorization request.',
    );
  }
}

export type OAuthProviderContext = {
  store: McpOAuthStore;
  entry: McpOAuthEntry;
  redirectUrl: string;
  clientMetadataUrl?: string;
  scope?: string;
  capturedAuthorizationUrl?: { value?: URL };
};

/**
 * Builds the `OAuthClientProvider` the SDK calls into. Every mutation is
 * written into the in-memory store, which the caller seals into the cookie after
 * the flow step completes.
 */
export function createOAuthClientProvider(context: OAuthProviderContext): OAuthClientProvider {
  const { store, entry, redirectUrl } = context;

  const persist = () => {
    entry.updatedAt = new Date().toISOString();
    store[entry.serverId] = entry;
  };

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      const metadata: OAuthClientMetadata = {
        client_name: 'Bolt (bolt-replit)',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };

      if (context.scope) {
        metadata.scope = context.scope;
      }

      return metadata;
    },
    state() {
      return stateFor(entry);
    },
    clientInformation() {
      return entry.clientInformation;
    },
    saveClientInformation(clientInformation) {
      entry.clientInformation = clientInformation;
      persist();
    },
    tokens() {
      return entry.tokens;
    },
    saveTokens(tokens) {
      entry.tokens = tokens;
      persist();
    },
    redirectToAuthorization(authorizationUrl) {
      if (context.capturedAuthorizationUrl) {
        context.capturedAuthorizationUrl.value = authorizationUrl;
        return;
      }

      throw new McpOAuthError(
        'oauth_failed',
        'The MCP authorization server asked for a browser redirect, but no redirect handler is attached to this flow.',
      );
    },
    saveCodeVerifier(codeVerifier) {
      entry.codeVerifier = codeVerifier;
      persist();
    },
    codeVerifier() {
      if (!entry.codeVerifier) {
        throw new McpOAuthError(
          'missing_verifier',
          'MCP OAuth code verifier is missing. Start the connection flow again from Settings → Connection.',
        );
      }

      return entry.codeVerifier;
    },
    invalidateCredentials(scope) {
      if (scope === 'all') {
        entry.tokens = undefined;
        entry.clientInformation = undefined;
        entry.codeVerifier = undefined;
        entry.discovery = undefined;
        entry.state = undefined;
      } else if (scope === 'tokens') {
        entry.tokens = undefined;
      } else if (scope === 'client') {
        entry.clientInformation = undefined;
      } else if (scope === 'verifier') {
        entry.codeVerifier = undefined;
      } else if (scope === 'discovery') {
        entry.discovery = undefined;
      }

      persist();
    },
    discoveryState() {
      return entry.discovery;
    },
    saveDiscoveryState(discovery) {
      entry.discovery = discovery;
      persist();
    },
  };

  if (context.clientMetadataUrl) {
    provider.clientMetadataUrl = context.clientMetadataUrl;
  }

  return provider;
}

export type BeginAuthorizationResult =
  | { status: 'authorized'; store: McpOAuthStore }
  | { status: 'redirect'; authorizationUrl: string; store: McpOAuthStore };

/** Runs discovery + (if needed) starts the authorization-code flow. */
export async function beginMcpAuthorization(options: {
  store: McpOAuthStore;
  serverId: string;
  serverUrl: string;
  redirectUrl: string;
  clientMetadataUrl?: string;
  scope?: string;
}): Promise<BeginAuthorizationResult> {
  const entry = options.store[options.serverId] ?? emptyEntry(options.serverId, options.serverUrl);
  const captured: { value?: URL } = {};
  const provider = createOAuthClientProvider({
    store: options.store,
    entry,
    redirectUrl: options.redirectUrl,
    clientMetadataUrl: options.clientMetadataUrl,
    scope: options.scope,
    capturedAuthorizationUrl: captured,
  });

  options.store[options.serverId] = entry;

  let result: Awaited<ReturnType<typeof auth>>;

  try {
    result = await auth(provider, { serverUrl: options.serverUrl, scope: options.scope });
  } catch (error) {
    /*
     * The SDK's discovery errors can quote response headers, so redact before the
     * message reaches the UI or the Worker log.
     */
    const detail = error instanceof Error ? error.message.slice(0, 300) : 'unknown error';

    throw new McpOAuthError('oauth_failed', `MCP OAuth discovery failed: ${redactSecrets(detail)}`);
  }

  if (result === 'AUTHORIZED') {
    return { status: 'authorized', store: options.store };
  }

  if (!captured.value) {
    throw new McpOAuthError('oauth_failed', 'The MCP authorization server did not provide an authorization URL.');
  }

  return { status: 'redirect', authorizationUrl: captured.value.toString(), store: options.store };
}

/** Exchanges the authorization code and stores the resulting tokens. */
export async function completeMcpAuthorization(options: {
  store: McpOAuthStore;
  serverId: string;
  serverUrl: string;
  authorizationCode: string;
  redirectUrl: string;
  clientMetadataUrl?: string;
  scope?: string;
}): Promise<McpOAuthStore> {
  const entry = options.store[options.serverId];

  if (!entry) {
    throw new McpOAuthError(
      'state_mismatch',
      'MCP OAuth callback rejected: no pending authorization was found for this server.',
    );
  }

  const provider = createOAuthClientProvider({
    store: options.store,
    entry,
    redirectUrl: options.redirectUrl,
    clientMetadataUrl: options.clientMetadataUrl,
    scope: options.scope,
  });

  const result = await auth(provider, {
    serverUrl: options.serverUrl,
    authorizationCode: options.authorizationCode,
    scope: options.scope,
  });

  if (result !== 'AUTHORIZED') {
    throw new McpOAuthError('oauth_failed', 'MCP OAuth token exchange did not complete.');
  }

  return options.store;
}

/** Drops all OAuth material for a server (disconnect). */
export function removeOAuthEntry(store: McpOAuthStore, serverId: string): McpOAuthStore {
  delete store[serverId];

  return store;
}

/** True when a server has usable (possibly refreshable) tokens. */
export function hasStoredTokens(store: McpOAuthStore, serverId: string): boolean {
  const entry = store[serverId];

  if (!entry?.tokens) {
    return false;
  }

  if (entry.tokens.access_token) {
    return true;
  }

  return Boolean(entry.tokens.refresh_token);
}

/**
 * Auth provider for transport-level use (tool discovery and tool calls), so an
 * expired access token is refreshed automatically by the SDK.
 */
export function transportAuthProvider(options: {
  store: McpOAuthStore;
  serverId: string;
  serverUrl: string;
  redirectUrl: string;
  clientMetadataUrl?: string;
}): OAuthClientProvider {
  const entry = options.store[options.serverId] ?? emptyEntry(options.serverId, options.serverUrl);

  options.store[options.serverId] = entry;

  return createOAuthClientProvider({
    store: options.store,
    entry,
    redirectUrl: options.redirectUrl,
    clientMetadataUrl: options.clientMetadataUrl,
    capturedAuthorizationUrl: { value: undefined },
  });
}
