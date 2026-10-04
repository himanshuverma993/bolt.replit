/**
 * Shared server-side secret handling.
 *
 * Everything that stores a credential for the user (GitHub tokens, MCP bearer
 * tokens, MCP OAuth tokens) goes through this module so the whole app uses one
 * authenticated-encryption scheme, one cookie policy and one error message when
 * the deployment has no Worker secret configured.
 *
 * Threat model notes:
 *  - Values are sealed with AES-256-GCM (authenticated) using a key derived from
 *    a Worker secret, and are only ever sent to the browser inside HttpOnly
 *    cookies, so page JavaScript can neither read them nor forge them.
 *  - The *shape* of the state (which servers/repositories exist) is stored in a
 *    separate cookie. When a Worker secret is available that cookie is HMAC
 *    signed as well, so a client cannot point an existing credential at an
 *    attacker-controlled URL.
 */

export type SecretEnvironment = {
  APP_ENCRYPTION_SECRET?: string;
  GITHUB_COOKIE_SECRET?: string;
  MCP_COOKIE_SECRET?: string;
};

export type AppSecret = {
  name: string;
  value: string;
};

/** Minimum length accepted for a Worker secret (32 random bytes base64 ~= 43 chars). */
export const MIN_SECRET_LENGTH = 16;

/** Secrets are resolved in this order so existing deployments keep working. */
const SECRET_SOURCES = ['APP_ENCRYPTION_SECRET', 'GITHUB_COOKIE_SECRET', 'MCP_COOKIE_SECRET'] as const;

export function resolveAppSecret(env: SecretEnvironment | undefined | null): AppSecret | undefined {
  if (!env) {
    return undefined;
  }

  for (const name of SECRET_SOURCES) {
    const value = env[name];

    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) {
      return { name, value };
    }
  }

  return undefined;
}

export function missingSecretMessage(purpose: string): string {
  return (
    `Server-side ${purpose} storage is not configured. Set a Worker secret with ` +
    '`wrangler secret put APP_ENCRYPTION_SECRET` (any 32+ character random string). ' +
    'GITHUB_COOKIE_SECRET and MCP_COOKIE_SECRET are accepted as fallbacks for existing deployments. ' +
    'Credentials are never stored in browser-readable state.'
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function encodeBase64UrlText(value: string): string {
  return base64UrlEncode(encoder.encode(value));
}

export function decodeBase64UrlText(value: string): string {
  return decoder.decode(base64UrlDecode(value));
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));

  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function deriveHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

const SEALED_PREFIX = 'v1.';

/** Seals a JSON payload with AES-256-GCM. Output is `v1.<base64url(iv || ciphertext)>`. */
export async function sealJsonPayload(payload: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(secret);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.byteLength);

  return `${SEALED_PREFIX}${base64UrlEncode(packed)}`;
}

/**
 * Opens a payload produced by {@link sealJsonPayload}.
 *
 * Returns `undefined` (never throws with crypto details) when the value is
 * unreadable, so callers can degrade to "not connected" without leaking
 * anything. A null return from a *present* cookie is reported separately by the
 * caller when it matters.
 */
export async function openJsonPayload<T>(value: string, secret: string): Promise<T | undefined> {
  if (!value.startsWith(SEALED_PREFIX)) {
    return undefined;
  }

  try {
    const packed = base64UrlDecode(value.slice(SEALED_PREFIX.length));
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const key = await deriveAesKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return undefined;
  }
}

/** Constant-time-ish string comparison for signatures. */
export function signaturesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

export async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await deriveHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));

  return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyCookieSignature(value: string, signature: string, secret: string): Promise<boolean> {
  if (!signature) {
    return false;
  }

  const expected = await signCookieValue(value, secret);

  return signaturesMatch(expected, signature);
}

/**
 * Value format for signed state cookies: `<base64url(payload)>.<base64url(hmac)>`.
 * Values without a signature are treated as untrusted by callers.
 */
export async function encodeSignedCookieValue(payload: string, secret: string): Promise<string> {
  const encoded = encodeBase64UrlText(payload);

  return `${encoded}.${await signCookieValue(encoded, secret)}`;
}

export async function decodeSignedCookieValue(value: string, secret: string): Promise<string | undefined> {
  const separator = value.lastIndexOf('.');

  if (separator <= 0) {
    return undefined;
  }

  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  if (!(await verifyCookieSignature(encoded, signature, secret))) {
    return undefined;
  }

  try {
    return decodeBase64UrlText(encoded);
  } catch {
    return undefined;
  }
}

export type CookieAttributes = {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  secure?: boolean;
};

export const DEFAULT_COOKIE_PATH = '/';

/**
 * Serialises a cookie. `Secure` is always on: production runs on HTTPS and
 * browsers treat `http://localhost` as a secure context, so local development
 * keeps working.
 */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes = {}): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${attributes.path ?? DEFAULT_COOKIE_PATH}`,
    `SameSite=${attributes.sameSite ?? 'Lax'}`,
  ];

  if (attributes.maxAge !== undefined) {
    parts.push(`Max-Age=${attributes.maxAge}`);
  }

  if (attributes.httpOnly) {
    parts.push('HttpOnly');
  }

  if (attributes.secure !== false) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};

  if (!header) {
    return cookies;
  }

  for (const item of header.split(';')) {
    const separator = item.indexOf('=');

    if (separator < 0) {
      continue;
    }

    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();

    if (!name) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

export function readRequestCookies(request: Request): Record<string, string> {
  return parseCookieHeader(request.headers.get('Cookie'));
}

/** Expires a cookie. Sensitive cookies stay HttpOnly so JS can never resurrect them. */
export function clearCookie(name: string, options: { httpOnly?: boolean } = {}): string {
  return serializeCookie(name, '', {
    maxAge: 0,
    httpOnly: options.httpOnly ?? true,
  });
}

/** Origin used for OAuth redirect URIs and absolute links. */
export function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'http://localhost';
  }

  return url.origin;
}

/**
 * CSRF defence in depth for cookie-authenticated POST endpoints.
 *
 * `SameSite=Lax` already stops cross-site cookie delivery, but the browser's
 * `Origin` header is checked as well so a request forged by another origin is
 * rejected even if a cookie policy changes. Requests without an `Origin` header
 * (curl, tests, server-to-server) are allowed through.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('Origin');

  if (!origin) {
    return true;
  }

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function isSecureOrigin(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

/** Redacts credential-shaped substrings from any string that may reach a log or the UI. */
export function redactSecrets(value: string): string {
  return (
    value
      .replace(/(authorization\s*[:=]\s*(?:bearer|token|basic)\s+)[^\s,;"}]+/gi, '$1[redacted]')
      .replace(/\b(gh[pousr]_[A-Za-z0-9_-]{10,})/g, '[redacted-github-token]')
      .replace(/\b(github_pat_[A-Za-z0-9_-]{10,})/g, '[redacted-github-token]')

      /*
       * Vendor key shapes are redacted even when they appear as a bare value, which
       * is how providers usually echo them back inside an error message.
       */
      .replace(/\b(sk-[A-Za-z0-9_-]{16,})/g, '[redacted-api-key]')
      .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, '[redacted-api-key]')
      .replace(/\b(AKIA[0-9A-Z]{16})/g, '[redacted-api-key]')
      .replace(/((?:access|refresh|id)[_-]?token"?\s*[:=]\s*"?)[^\s,;"}]+/gi, '$1[redacted]')
      .replace(/((?:api[_-]?key|client[_-]?secret|password|secret)\s*[:=]\s*)[^\s,;"}]+/gi, '$1[redacted]')
  );
}
