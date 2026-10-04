import { describe, expect, it } from 'vitest';
import {
  MIN_SECRET_LENGTH,
  clearCookie,
  decodeSignedCookieValue,
  encodeSignedCookieValue,
  isSameOriginRequest,
  isSecureOrigin,
  openJsonPayload,
  parseCookieHeader,
  redactSecrets,
  resolveAppSecret,
  sealJsonPayload,
  serializeCookie,
  signaturesMatch,
} from './secrets';

/**
 * Unit coverage for the shared secret layer. Everything else in the app
 * (GitHub session, MCP tokens, MCP configuration signing) depends on these
 * primitives, so the failure modes (wrong key, tampered value, malformed input)
 * are asserted explicitly here.
 */

const SECRET = 'unit-test-secret-value-32-chars!!';

describe('sealing', () => {
  it('round-trips a JSON payload through AES-256-GCM', async () => {
    const sealed = await sealJsonPayload({ token: 'ghp_example', nested: { a: 1 } }, SECRET);

    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('ghp_example');
    await expect(openJsonPayload(sealed, SECRET)).resolves.toEqual({ token: 'ghp_example', nested: { a: 1 } });
  });

  it('returns undefined for a tampered value, a wrong key or a foreign payload', async () => {
    const sealed = await sealJsonPayload({ token: 'ghp_example' }, SECRET);
    const tampered = `${sealed.slice(0, -4)}AAAA`;

    await expect(openJsonPayload(tampered, SECRET)).resolves.toBeUndefined();
    await expect(openJsonPayload(sealed, 'another-secret-of-sufficient-length')).resolves.toBeUndefined();
    await expect(openJsonPayload('githubToken=plain-text', SECRET)).resolves.toBeUndefined();
  });
});

describe('signed cookies', () => {
  it('signs and verifies a value', async () => {
    const signed = await encodeSignedCookieValue('[{"id":"a"}]', SECRET);

    await expect(decodeSignedCookieValue(signed, SECRET)).resolves.toBe('[{"id":"a"}]');
  });

  it('rejects an unsigned, tampered or wrongly signed value', async () => {
    const signed = await encodeSignedCookieValue('[{"id":"a"}]', SECRET);
    const tampered = `${signed.split('.')[0]}.AAAA`;

    await expect(decodeSignedCookieValue('[{"id":"a"}]', SECRET)).resolves.toBeUndefined();
    await expect(decodeSignedCookieValue(tampered, SECRET)).resolves.toBeUndefined();
    await expect(decodeSignedCookieValue(signed, 'another-secret-of-sufficient-length')).resolves.toBeUndefined();
  });

  it('compares signatures without early exit', () => {
    expect(signaturesMatch('abcdef', 'abcdef')).toBe(true);
    expect(signaturesMatch('abcdef', 'abcdeF')).toBe(false);
    expect(signaturesMatch('abcdef', 'abcde')).toBe(false);
  });
});

describe('cookie attributes', () => {
  it('always sets Path, SameSite and Secure, and HttpOnly when asked', () => {
    const cookie = serializeCookie('gh_session', 'v1.value', { httpOnly: true, maxAge: 60 });

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=60');
  });

  it('expires cookies with Max-Age=0 and keeps them HttpOnly by default', () => {
    expect(clearCookie('mcpSecrets')).toContain('Max-Age=0');
    expect(clearCookie('mcpSecrets')).toContain('HttpOnly');
    expect(clearCookie('githubToken', { httpOnly: false })).not.toContain('HttpOnly');
  });

  it('parses a cookie header and survives malformed encoding', () => {
    expect(parseCookieHeader('a=1; b=%E0%A4%A; c=3')).toMatchObject({ a: '1', c: '3' });
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});

describe('secret resolution', () => {
  it('prefers APP_ENCRYPTION_SECRET and enforces the minimum length', () => {
    expect(resolveAppSecret({ APP_ENCRYPTION_SECRET: SECRET })?.name).toBe('APP_ENCRYPTION_SECRET');
    expect(resolveAppSecret({ MCP_COOKIE_SECRET: SECRET })?.name).toBe('MCP_COOKIE_SECRET');
    expect(resolveAppSecret({ APP_ENCRYPTION_SECRET: 'short' })).toBeUndefined();
    expect(resolveAppSecret({ APP_ENCRYPTION_SECRET: 'x'.repeat(MIN_SECRET_LENGTH) })?.name).toBe(
      'APP_ENCRYPTION_SECRET',
    );
    expect(resolveAppSecret(undefined)).toBeUndefined();
  });
});

describe('request checks', () => {
  it('allows a missing Origin but rejects a cross-origin POST', () => {
    const sameOrigin = new Request('https://bolt.example.test/api/mcp', {
      method: 'POST',
      headers: { Origin: 'https://bolt.example.test' },
    });
    const crossOrigin = new Request('https://bolt.example.test/api/mcp', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.test' },
    });
    const noOrigin = new Request('https://bolt.example.test/api/mcp', { method: 'POST' });
    const malformed = new Request('https://bolt.example.test/api/mcp', {
      method: 'POST',
      headers: { Origin: 'not-a-url' },
    });

    expect(isSameOriginRequest(sameOrigin)).toBe(true);
    expect(isSameOriginRequest(crossOrigin)).toBe(false);
    expect(isSameOriginRequest(noOrigin)).toBe(true);
    expect(isSameOriginRequest(malformed)).toBe(false);
    expect(isSecureOrigin(new Request('https://bolt.example.test/'))).toBe(true);
    expect(isSecureOrigin(new Request('http://localhost/api/mcp'))).toBe(false);
  });
});

describe('redaction', () => {
  it('removes every supported credential shape from a message', () => {
    const message = [
      'Authorization: Bearer do-not-send-this-value',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'fine-grained github_pat_11ABCDEFG0abcdefghijklmnop',
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'slack xoxb-1234567890-abcdefghijklm',
      'aws AKIAIOSFODNN7EXAMPLE',
      'client_secret: super-secret-value',
    ].join(' | ');
    const redacted = redactSecrets(message);

    expect(redacted).toContain('Bearer [redacted]');
    expect(redacted).toContain('[redacted-github-token]');
    expect(redacted).toContain('[redacted-api-key]');
    expect(redacted).toContain('client_secret: [redacted]');

    for (const secret of [
      'do-not-send-this-value',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-abcdefghijklm',
      'AKIAIOSFODNN7EXAMPLE',
      'super-secret-value',
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });
});
