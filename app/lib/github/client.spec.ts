import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubClientError,
  connectGitHub,
  disconnectGitHub,
  fetchGitHubStatus,
  purgeLegacyGitHubCookies,
  pushFilesToGitHub,
  verifyGitHub,
} from './client';

/**
 * Client-side tests for the GitHub connection surface the UI actually calls.
 *
 * The server is covered by app/lib/.server/github-route.spec.ts; this suite pins
 * the browser contract: which request goes out (and that a token only ever
 * travels in the JSON body), how the server's error codes and hints reach the
 * UI, and that legacy credential cookies are removed.
 */

type Captured = { url: string; init: RequestInit };

function stubFetch(response: Response | Error) {
  const captured: Captured[] = [];

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    captured.push({ url, init });

    if (response instanceof Error) {
      throw response;
    }

    return response.clone();
  });

  return captured;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub client', () => {
  it('reads the connection status with a GET and no body', async () => {
    const captured = stubFetch(jsonResponse({ connected: false, storageConfigured: true, reason: 'missing_secret' }));
    const status = await fetchGitHubStatus();

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('/api/github');
    expect(captured[0].init.method).toBe('GET');
    expect(captured[0].init.body).toBeUndefined();
    expect(status).toMatchObject({ connected: false, storageConfigured: true, reason: 'missing_secret' });
  });

  it('sends a token in the JSON body only, never in the URL', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const captured = stubFetch(
      jsonResponse({
        connected: true,
        login: 'octocat',
        name: null,
        avatarUrl: null,
        scopes: [],
        tokenKind: 'installation',
        repoCreate: 'not_allowed',
        verifiedAt: new Date().toISOString(),
      }),
    );
    const connection = await connectGitHub({ token, repo: 'octocat/demo' });

    const [request] = captured;

    expect(request.url).toBe('/api/github');
    expect(request.url).not.toContain(token);
    expect(request.init.method).toBe('POST');
    expect(JSON.parse(String(request.init.body))).toEqual({
      action: 'connect',
      token,
      repo: 'octocat/demo',
    });
    expect(connection.tokenKind).toBe('installation');
    expect(connection.repoCreate).toBe('not_allowed');
  });

  it('turns a fail-closed 501 into a typed error that carries the secret hint', async () => {
    stubFetch(
      jsonResponse(
        {
          error: 'GitHub is not connected and this deployment has no credential secret configured.',
          code: 'not_configured',
          hint: 'Set APP_ENCRYPTION_SECRET (or GITHUB_COOKIE_SECRET) as a Worker secret, then reconnect GitHub.',
        },
        501,
      ),
    );

    const failure = await connectGitHub({ token: 'ghp_example' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubClientError);
    expect(failure).toMatchObject({ code: 'not_configured', status: 501 });
    expect(String((failure as GitHubClientError).hint)).toMatch(/APP_ENCRYPTION_SECRET/);
  });

  it('reports a network failure as a typed error instead of throwing a fetch error', async () => {
    stubFetch(new TypeError('Failed to fetch'));

    const failure = await fetchGitHubStatus().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubClientError);
    expect(failure).toMatchObject({ code: 'network', status: 0 });
  });

  it('survives a non-JSON error body (for example an HTML 500 page)', async () => {
    stubFetch(new Response('<html>error</html>', { status: 500 }));

    const failure = await connectGitHub({ token: 'ghp_example' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubClientError);
    expect(failure).toMatchObject({ code: 'unknown', status: 500 });
    expect(String((failure as Error).message)).toContain('500');
  });

  it('pushes files without ever attaching a credential to the request', async () => {
    const captured = stubFetch(
      jsonResponse({
        owner: 'octocat',
        repo: 'demo',
        htmlUrl: 'https://github.com/octocat/demo',
        branch: 'main',
        commitSha: 'abc123',
        created: true,
        emptyRepository: false,
        filesWritten: 2,
        filesSkipped: 0,
        skippedPaths: [],
        pushedBy: 'octocat',
        pushedAt: new Date().toISOString(),
      }),
    );
    const result = await pushFilesToGitHub({
      repoName: 'demo',
      files: [
        { path: 'README.md', content: '# demo' },
        { path: 'src/index.js', content: 'console.log(1);' },
      ],
      message: 'initial commit',
    });
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(['action', 'repoName', 'files', 'message']);
    expect(body).not.toHaveProperty('token');
    expect(JSON.stringify(body)).not.toMatch(/gh[pousr]_/);
    expect(result).toMatchObject({ created: true, filesWritten: 2, branch: 'main' });
  });

  it('verifies and disconnects through the documented actions', async () => {
    const captured = stubFetch(jsonResponse({ connected: true, login: 'octocat' }));

    await verifyGitHub({ repo: 'octocat/demo' });
    await disconnectGitHub();

    expect(captured.map((request) => JSON.parse(String(request.init.body)).action)).toEqual(['verify', 'disconnect']);
    expect(captured.every((request) => request.url === '/api/github')).toBe(true);
  });

  it('expires every legacy credential cookie and tolerates a missing document', () => {
    const writes: string[] = [];

    vi.stubGlobal('document', {
      get cookie() {
        return '';
      },
      set cookie(value: string) {
        writes.push(value);
      },
    });

    purgeLegacyGitHubCookies();

    for (const name of ['githubToken', 'githubUsername', 'git:github.com']) {
      expect(writes.some((write) => write.startsWith(`${name}=`) && write.includes('Max-Age=0'))).toBe(true);
    }

    vi.unstubAllGlobals();
    expect(() => purgeLegacyGitHubCookies()).not.toThrow();
  });
});
