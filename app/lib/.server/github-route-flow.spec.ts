import { describe, expect, it, vi } from 'vitest';

/**
 * Route-level flow test for the GitHub connection.
 *
 * The GitHub protocol itself is covered against a mock REST API in
 * `github.spec.ts` and against the real API in `github.live.spec.ts`; this suite
 * pins the pieces in between: the cookie minted by `connect` is accepted by
 * `GET`/`push`, the token is taken from the sealed session (never from the push
 * body), and classified failures are turned into the shapes the UI consumes.
 */

const { verifyGitHubToken, pushProjectToGitHub } = vi.hoisted(() => ({
  verifyGitHubToken: vi.fn(),
  pushProjectToGitHub: vi.fn(),
}));

vi.mock('~/lib/.server/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/.server/github')>();

  return { ...actual, verifyGitHubToken, pushProjectToGitHub };
});

import { action, loader } from '~/routes/api.github';
import { GitHubError, GITHUB_SESSION_COOKIE } from '~/lib/.server/github';

const SECRET = 'unit-test-secret-value-32-chars!!';

function contextFor(env: Record<string, unknown>) {
  return { cloudflare: { env } } as unknown as Parameters<typeof action>[0]['context'];
}

function post(body: unknown, cookie?: string): Request {
  return new Request('https://bolt.example.test/api/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    login: 'octocat',
    name: null,
    avatarUrl: null,
    scopes: ['repo'],
    tokenKind: 'classic' as const,
    repoCreate: 'allowed' as const,
    verifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('GitHub route flow (connect -> status -> push)', () => {
  it('mints a session on connect, reads it back, and pushes with that session token', async () => {
    verifyGitHubToken.mockReset();
    pushProjectToGitHub.mockReset();
    verifyGitHubToken.mockResolvedValueOnce(connection());

    const connect = await action({
      request: post({ action: 'connect', token: 'ghp_flow_token_value', repo: 'octocat/demo' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const cookies = connect.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`))!;
    const connected = (await connect.json()) as Record<string, unknown>;

    expect(connect.status).toBe(200);
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(verifyGitHubToken).toHaveBeenCalledWith({
      token: 'ghp_flow_token_value',
      repo: 'octocat/demo',
      owner: undefined,
      expectedLogin: undefined,
    });
    expect(connected).toMatchObject({ connected: true, login: 'octocat', storageConfigured: true });

    const status = await loader({
      request: new Request('https://bolt.example.test/api/github', {
        headers: { Cookie: session.split(';')[0] },
      }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const statusBody = (await status.json()) as Record<string, unknown>;

    expect(statusBody).toMatchObject({
      connected: true,
      login: 'octocat',
      tokenKind: 'classic',
      storageConfigured: true,
    });

    pushProjectToGitHub.mockResolvedValueOnce({
      owner: 'octocat',
      repo: 'demo',
      htmlUrl: 'https://github.com/octocat/demo',
      branch: 'main',
      commitSha: 'abc123',
      created: true,
      emptyRepository: false,
      filesWritten: 1,
      filesSkipped: 0,
      skippedPaths: [],
    });

    const push = await action({
      request: post(
        { action: 'push', repoName: 'demo', files: [{ path: 'README.md', content: '# demo' }] },
        session.split(';')[0],
      ),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const pushed = (await push.json()) as Record<string, unknown>;

    // The push never carries the token itself: it comes from the sealed session.
    expect(pushProjectToGitHub).toHaveBeenCalledWith({
      token: 'ghp_flow_token_value',
      owner: 'octocat',
      repoName: 'demo',
      files: [{ path: 'README.md', content: '# demo' }],
      message: undefined,
      branch: undefined,
      isPrivate: false,
    });
    expect(push.status).toBe(200);
    expect(pushed).toMatchObject({ ok: true, created: true, commitSha: 'abc123', pushedBy: 'octocat' });
  });

  it('keeps the session when a push is refused for permissions', async () => {
    verifyGitHubToken.mockReset();
    pushProjectToGitHub.mockReset();
    verifyGitHubToken.mockResolvedValueOnce(connection({ tokenKind: 'installation', repoCreate: 'not_allowed' }));

    const connect = await action({
      request: post({ action: 'connect', token: 'ghs_installation_token' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const session = connect.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`))!
      .split(';')[0];

    pushProjectToGitHub.mockRejectedValueOnce(
      new GitHubError(
        'insufficient_permissions',
        'GitHub refused the request (HTTP 403): Resource not accessible by integration',
        'GitHub App installation tokens cannot create repositories at all - connect with a personal token instead.',
      ),
    );

    const push = await action({
      request: post({ action: 'push', repoName: 'demo', files: [{ path: 'README.md', content: '# demo' }] }, session),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await push.json()) as Record<string, unknown>;

    expect(push.status).toBe(403);
    expect(body.code).toBe('insufficient_permissions');
    expect(String(body.hint)).toMatch(/installation tokens cannot create repositories/i);

    // A permission refusal must not log the user out.
    expect(push.headers.getSetCookie()).toHaveLength(0);
  });

  it('clears the session when a push reports the token as invalid', async () => {
    verifyGitHubToken.mockReset();
    pushProjectToGitHub.mockReset();
    verifyGitHubToken.mockResolvedValueOnce(connection());

    const connect = await action({
      request: post({ action: 'connect', token: 'ghp_expiring_token' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const session = connect.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`))!
      .split(';')[0];

    pushProjectToGitHub.mockRejectedValueOnce(
      new GitHubError('invalid_token', 'The GitHub token is no longer valid.', 'Create a new token and reconnect.'),
    );

    const push = await action({
      request: post({ action: 'push', repoName: 'demo', files: [{ path: 'README.md', content: '# demo' }] }, session),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(push.status).toBe(401);
    expect(
      push.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`) && cookie.includes('Max-Age=0')),
    ).toBe(true);
  });

  it('re-verifies with the session token and refreshes the stored verification time', async () => {
    verifyGitHubToken.mockReset();
    verifyGitHubToken.mockResolvedValueOnce(connection());

    const connect = await action({
      request: post({ action: 'connect', token: 'ghp_reverify_token' }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const session = connect.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`))!
      .split(';')[0];

    verifyGitHubToken.mockResolvedValueOnce(connection({ verifiedAt: '2030-01-01T00:00:00.000Z' }));

    const verify = await action({
      request: post({ action: 'verify', repo: 'octocat/demo' }, session),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await verify.json()) as Record<string, unknown>;

    expect(verifyGitHubToken).toHaveBeenLastCalledWith({ token: 'ghp_reverify_token', repo: 'octocat/demo' });
    expect(body).toMatchObject({ connected: true, verificationFresh: true, verifiedAt: '2030-01-01T00:00:00.000Z' });
    expect(verify.headers.getSetCookie().some((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`))).toBe(true);
  });
});
