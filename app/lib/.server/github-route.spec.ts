import { describe, expect, it } from 'vitest';

// Route-level tests live outside app/routes so Remix does not treat them as routes.
import { action, loader } from '~/routes/api.github';
import { GITHUB_SESSION_COOKIE } from '~/lib/.server/github';

/**
 * Route-level tests for the server-side GitHub endpoint.
 *
 * Everything here runs without network access: the flows that call GitHub are
 * covered by app/lib/.server/github.spec.ts (mock API) and github.live.spec.ts
 * (opt-in disposable repository).
 */

const SECRET = 'unit-test-secret-value-32-chars!!';

function contextFor(env: Record<string, unknown>) {
  return { cloudflare: { env } } as unknown as Parameters<typeof action>[0]['context'];
}

function postRequest(body: unknown, cookie?: string): Request {
  return new Request('https://bolt.example.test/api/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe('GET /api/github', () => {
  it('reports "not connected" and whether credential storage is configured', async () => {
    const response = await loader({
      request: new Request('https://bolt.example.test/api/github'),
      context: contextFor({}),
    } as unknown as Parameters<typeof loader>[0]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ connected: false, storageConfigured: false });
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });

  it('flags an unreadable session cookie instead of pretending to be connected', async () => {
    const response = await loader({
      request: new Request('https://bolt.example.test/api/github', {
        headers: { Cookie: `${GITHUB_SESSION_COOKIE}=v1.not-a-real-sealed-value` },
      }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.connected).toBe(false);
    expect(body.reason).toBe('unreadable');
  });
});

describe('POST /api/github', () => {
  it('refuses to store a token when no Worker secret exists', async () => {
    const response = await action({
      request: postRequest({ action: 'connect', token: 'ghp_example_token_value' }),
      context: contextFor({}),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(501);
    expect(body.code).toBe('not_configured');
    expect(body.error).toMatch(/APP_ENCRYPTION_SECRET/);
    expect(JSON.stringify(body)).not.toContain('ghp_example_token_value');
  });

  it('rejects a malformed token without calling GitHub', async () => {
    const response = await action({
      request: postRequest({ action: 'connect', token: 'not a token' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(400);
  });

  it('clears the session and the legacy cookies on disconnect', async () => {
    const response = await action({
      request: postRequest({ action: 'disconnect' }, `${GITHUB_SESSION_COOKIE}=v1.stale`),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const cookies = response.headers.getSetCookie();
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.connected).toBe(false);
    expect(
      cookies.some((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`) && cookie.includes('Max-Age=0')),
    ).toBe(true);

    for (const legacy of ['githubToken', 'githubUsername', 'git:github.com']) {
      expect(cookies.some((cookie) => cookie.startsWith(`${legacy}=`) && cookie.includes('Max-Age=0'))).toBe(true);
    }
  });

  it('requires a connection before pushing', async () => {
    const response = await action({
      request: postRequest({ action: 'push', repoName: 'demo', files: [{ path: 'index.html', content: '<h1/>' }] }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.code).toBe('not_connected');
    expect(body.hint).toMatch(/Settings/);
  });

  it('rejects an oversized push before contacting GitHub', async () => {
    const files = [{ path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 10) }];
    const response = await action({
      request: postRequest({ action: 'push', repoName: 'demo', files }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    // No session cookie: the connection check runs first.
    expect(response.status).toBe(401);
  });

  it('rejects non-POST methods', async () => {
    const response = await action({
      request: new Request('https://bolt.example.test/api/github', { method: 'PUT' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(405);
  });
});

describe('CSRF protection', () => {
  it('rejects a cross-origin connect attempt', async () => {
    const response = await action({
      request: new Request('https://bolt.example.test/api/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.test' },
        body: JSON.stringify({ action: 'connect', token: 'ghp_example_token_value' }),
      }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(403);
  });
});
