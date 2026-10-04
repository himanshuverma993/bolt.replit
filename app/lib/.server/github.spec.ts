import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GITHUB_SESSION_COOKIE,
  LEGACY_GITHUB_COOKIES,
  classifyGitHubError,
  createGitHubClient,
  githubSessionHeaders,
  pushProjectToGitHub,
  readGitHubSession,
  requireAppSecret,
  verifyGitHubToken,
  GitHubError,
} from './github';

/**
 * These tests run the real Octokit flow against a local mock of the GitHub REST
 * API (no network, no real repository). The companion live test
 * (`github.live.spec.ts`) exercises a disposable repository when
 * GITHUB_E2E_TOKEN is provided.
 */

type MockOptions = {
  login?: string;
  scopes?: string;
  userStatus?: number;
  repoStatus?: number;
  repoPrivate?: boolean;
  repoSize?: number;
  defaultBranch?: string | null;
  permissions?: { push: boolean; admin: boolean };
  refStatus?: number;
  refBody?: unknown;
  updateRefFailures?: number;
  updateRefStatus?: number;
  createRepoStatus?: number;
  blobsStatus?: number;
};

type MockState = {
  updateRefCalls: number;
  createRefCalls: number;
  createCommitCalls: number;
  createRepoCalls: number;
  lastBlobContent: string | undefined;
};

const servers: Server[] = [];
const state: MockState = {
  updateRefCalls: 0,
  createRefCalls: 0,
  createCommitCalls: 0,
  createRepoCalls: 0,
  lastBlobContent: undefined,
};

function resetState(): void {
  state.updateRefCalls = 0;
  state.createRefCalls = 0;
  state.createCommitCalls = 0;
  state.createRepoCalls = 0;
  state.lastBlobContent = undefined;
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');

  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }

  response.end(JSON.stringify(body));
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

async function startGitHubMock(options: MockOptions = {}): Promise<string> {
  const settings: Required<Omit<MockOptions, 'refBody'>> & { refBody?: unknown } = {
    login: options.login ?? 'octocat',
    scopes: options.scopes ?? 'repo',
    userStatus: options.userStatus ?? 200,
    repoStatus: options.repoStatus ?? 200,
    repoPrivate: options.repoPrivate ?? false,
    repoSize: options.repoSize ?? 1024,
    defaultBranch: options.defaultBranch === undefined ? 'main' : options.defaultBranch,
    permissions: options.permissions ?? { push: true, admin: true },
    refStatus: options.refStatus ?? 200,
    updateRefFailures: options.updateRefFailures ?? 0,
    updateRefStatus: options.updateRefStatus ?? 200,
    createRepoStatus: options.createRepoStatus ?? 201,
    blobsStatus: options.blobsStatus ?? 201,
    refBody: options.refBody,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const authorization = request.headers.authorization ?? '';

    if (authorization.trim().length === 0) {
      return json(response, 401, { message: 'Bad credentials' });
    }

    const path = url.pathname;

    if (path === '/user' && request.method === 'GET') {
      if (settings.userStatus !== 200) {
        return json(response, settings.userStatus, { message: 'Bad credentials' });
      }

      return json(
        response,
        200,
        { login: settings.login, name: 'Test User', avatar_url: 'https://avatars.example.test/u.png' },
        { 'x-oauth-scopes': settings.scopes },
      );
    }

    if (/^\/repos\/[^/]+\/[^/]+$/.test(path) && request.method === 'GET') {
      if (settings.repoStatus !== 200) {
        return json(response, settings.repoStatus, { message: 'Not Found' });
      }

      const [owner, repo] = path.split('/').slice(2);

      return json(response, 200, {
        name: repo,
        owner: { login: owner },
        private: settings.repoPrivate,
        size: settings.repoSize,
        default_branch: settings.defaultBranch,
        permissions: settings.permissions,
      });
    }

    if (path === '/user/repos' && request.method === 'POST') {
      state.createRepoCalls += 1;

      const body = JSON.parse(await readBody(request)) as { name: string };

      if (settings.createRepoStatus >= 400) {
        return json(response, settings.createRepoStatus, { message: 'Repository creation failed' });
      }

      return json(response, settings.createRepoStatus, {
        name: body.name,
        owner: { login: settings.login },
        private: false,

        // A freshly created repository with `auto_init: false` is empty and has no default branch.
        size: 0,
        default_branch: null,
        permissions: settings.permissions,
        html_url: `https://github.example.test/${settings.login}/${body.name}`,
      });
    }

    if (/^\/repos\/[^/]+\/[^/]+\/git\/blobs$/.test(path) && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as { content: string };

      state.lastBlobContent = body.content;

      if (settings.blobsStatus >= 400) {
        return json(response, settings.blobsStatus, { message: 'Blob failed' });
      }

      return json(response, settings.blobsStatus, { sha: `blob-${Math.random().toString(16).slice(2, 10)}` });
    }

    if (/^\/repos\/[^/]+\/[^/]+\/git\/trees$/.test(path) && request.method === 'POST') {
      return json(response, 201, { sha: 'tree-sha' });
    }

    if (/^\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(path) && request.method === 'POST') {
      state.createCommitCalls += 1;

      return json(response, 201, { sha: `commit-${state.createCommitCalls}` });
    }

    if (/^\/repos\/[^/]+\/[^/]+\/git\/ref\/.+$/.test(path) && request.method === 'GET') {
      if (settings.refStatus !== 200) {
        return json(response, settings.refStatus, {
          message: settings.refStatus === 409 ? 'Git Repository is empty.' : 'Not Found',
        });
      }

      return json(response, 200, settings.refBody ?? { object: { sha: 'base-commit-sha' } });
    }

    if (/^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(path) && request.method === 'POST') {
      state.createRefCalls += 1;

      return json(response, 201, { ref: 'refs/heads/main' });
    }

    if (/^\/repos\/[^/]+\/[^/]+\/git\/refs\/.+$/.test(path) && request.method === 'PATCH') {
      state.updateRefCalls += 1;

      if (state.updateRefCalls <= settings.updateRefFailures) {
        return json(response, 409, { message: 'Update is not a fast forward' });
      }

      if (settings.updateRefStatus >= 400) {
        return json(response, settings.updateRefStatus, { message: 'Reference update failed' });
      }

      return json(response, 200, { object: { sha: 'updated-sha' } });
    }

    return json(response, 404, { message: 'Not Found' });
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Mock GitHub server did not receive a TCP address');
  }

  return `http://127.0.0.1:${address.port}`;
}

function clientFor(baseUrl: string, token = 'test-token') {
  return createGitHubClient(token, { baseUrl });
}

afterEach(async () => {
  resetState();

  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('GitHub connection verification', () => {
  it('reports identity, token kind, scopes and repository push permission', async () => {
    const baseUrl = await startGitHubMock();
    const octokit = clientFor(baseUrl);
    const connection = await verifyGitHubToken({ token: 'test-token', repo: 'octocat/hello-world', octokit });

    expect(connection.login).toBe('octocat');
    expect(connection.tokenKind).toBe('classic');
    expect(connection.scopes).toEqual(['repo']);
    expect(connection.repoCreate).toBe('allowed');
    expect(connection.repoAccess).toMatchObject({ repository: 'octocat/hello-world', exists: true, push: true });
  });

  it('detects a token that can read but not push', async () => {
    const baseUrl = await startGitHubMock({ permissions: { push: false, admin: false } });
    const octokit = clientFor(baseUrl);

    await expect(
      verifyGitHubToken({ token: 'test-token', repo: 'octocat/hello-world', octokit }),
    ).rejects.toMatchObject({
      code: 'insufficient_permissions',
    });
  });

  it('marks a repository that does not exist yet as creatable', async () => {
    const baseUrl = await startGitHubMock({ repoStatus: 404 });
    const connection = await verifyGitHubToken({
      token: 'test-token',
      repo: 'octocat/new-project',
      octokit: clientFor(baseUrl),
    });

    expect(connection.repoAccess).toMatchObject({ exists: false });
  });

  it('rejects an invalid token with an actionable error', async () => {
    const baseUrl = await startGitHubMock({ userStatus: 401 });

    await expect(verifyGitHubToken({ token: 'test-token', octokit: clientFor(baseUrl) })).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('flags an identity mismatch', async () => {
    const baseUrl = await startGitHubMock();

    await expect(
      verifyGitHubToken({ token: 'test-token', expectedLogin: 'someone-else', octokit: clientFor(baseUrl) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('GitHub push flow', () => {
  const files = [
    { path: 'index.html', content: '<h1>Hello</h1>' },
    { path: 'src/app.js', content: 'console.log("hello");' },
  ];

  it('updates an existing repository with a parented commit', async () => {
    const baseUrl = await startGitHubMock();
    const result = await pushProjectToGitHub({
      token: 'test-token',
      owner: 'octocat',
      repoName: 'hello-world',
      files,
      message: 'Update from test',
      octokit: clientFor(baseUrl),
    });

    expect(result).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      branch: 'main',
      created: false,
      emptyRepository: false,
      filesWritten: 2,
    });
    expect(state.updateRefCalls).toBe(1);
    expect(state.createRefCalls).toBe(0);
    expect(state.lastBlobContent).toBeTruthy();
  });

  it('creates a missing repository and writes the first commit of an empty repository', async () => {
    const baseUrl = await startGitHubMock({ repoStatus: 404 });
    const result = await pushProjectToGitHub({
      token: 'test-token',
      owner: 'octocat',
      repoName: 'brand-new',
      files,
      octokit: clientFor(baseUrl),
    });

    expect(result).toMatchObject({ repo: 'brand-new', created: true, emptyRepository: true, filesWritten: 2 });
    expect(state.createRepoCalls).toBe(1);
    expect(state.createRefCalls).toBe(1);
    expect(state.updateRefCalls).toBe(0);
  });

  it('handles an existing but empty repository (GitHub answers 409 on the ref)', async () => {
    const baseUrl = await startGitHubMock({ refStatus: 409, repoSize: 0, defaultBranch: null });
    const result = await pushProjectToGitHub({
      token: 'test-token',
      owner: 'octocat',
      repoName: 'empty-repo',
      files,
      octokit: clientFor(baseUrl),
    });

    expect(result).toMatchObject({ emptyRepository: true, created: false });
    expect(state.createRefCalls).toBe(1);
  });

  it('retries when the branch moved while pushing', async () => {
    const baseUrl = await startGitHubMock({ updateRefFailures: 1 });
    const result = await pushProjectToGitHub({
      token: 'test-token',
      owner: 'octocat',
      repoName: 'hello-world',
      files,
      octokit: clientFor(baseUrl),
    });

    expect(state.updateRefCalls).toBe(2);
    expect(result.commitSha).toBe('commit-2');
  });

  it('fails with a branch conflict after three attempts', async () => {
    const baseUrl = await startGitHubMock({ updateRefFailures: 5 });

    await expect(
      pushProjectToGitHub({
        token: 'test-token',
        owner: 'octocat',
        repoName: 'hello-world',
        files,
        octokit: clientFor(baseUrl),
      }),
    ).rejects.toMatchObject({ code: 'branch_conflict' });
  });

  it('reports an empty project instead of pushing nothing', async () => {
    const baseUrl = await startGitHubMock();

    await expect(
      pushProjectToGitHub({
        token: 'test-token',
        owner: 'octocat',
        repoName: 'hello-world',
        files: [],
        octokit: clientFor(baseUrl),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('skips binary-looking files and reports them', async () => {
    const baseUrl = await startGitHubMock();
    const result = await pushProjectToGitHub({
      token: 'test-token',
      owner: 'octocat',
      repoName: 'hello-world',
      files: [...files, { path: 'logo.png', content: 'not-really-a-png' }],
      octokit: clientFor(baseUrl),
    });

    expect(result.filesWritten).toBe(2);
    expect(result.filesSkipped).toBe(1);
    expect(result.skippedPaths).toEqual(['logo.png']);
  });

  it('rejects invalid repository names before calling GitHub', async () => {
    const baseUrl = await startGitHubMock();

    await expect(
      pushProjectToGitHub({
        token: 'test-token',
        owner: 'octocat',
        repoName: 'bad name/../..',
        files,
        octokit: clientFor(baseUrl),
      }),
    ).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('GitHub error classification', () => {
  it('maps rate limiting', () => {
    const error = classifyGitHubError({
      status: 403,
      message: 'API rate limit exceeded',
      response: {
        status: 403,
        headers: { 'x-ratelimit-reset': '1700000000' },
        data: { message: 'API rate limit exceeded' },
      },
    });

    expect(error.code).toBe('rate_limited');
    expect(error.message).toContain('rate limit');
  });

  it('maps permission failures, missing repos and empty repositories', () => {
    expect(classifyGitHubError({ status: 403, message: 'Resource not accessible by personal access token' }).code).toBe(
      'insufficient_permissions',
    );
    expect(classifyGitHubError({ status: 404, message: 'Not Found' }).code).toBe('repo_not_found');
    expect(classifyGitHubError({ status: 409, message: 'Git Repository is empty.' }).code).toBe('repo_empty');
    expect(classifyGitHubError({ status: 409, message: 'Update is not a fast forward' }).code).toBe('branch_conflict');
  });

  it('maps network failures', () => {
    expect(classifyGitHubError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.github.com' }).code).toBe(
      'network',
    );
  });

  it('never leaks a token into a message', () => {
    const error = classifyGitHubError({
      status: 401,
      message: 'Bad credentials (Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789)',
    });

    expect(error.message).not.toContain('ghp_');
  });
});

describe('GitHub credential storage', () => {
  const secret = 'unit-test-secret-value-32-chars!!';

  it('seals the token in an HttpOnly cookie and clears legacy cookies', async () => {
    const headers = await githubSessionHeaders(
      {
        token: 'ghp_secret_token_value',
        connection: {
          login: 'octocat',
          name: null,
          avatarUrl: null,
          scopes: ['repo'],
          tokenKind: 'classic',
          repoCreate: 'allowed',
          verifiedAt: new Date().toISOString(),
        },
      },
      { APP_ENCRYPTION_SECRET: secret },
    );

    const sessionCookie = headers.find((cookie) => cookie.startsWith(`${GITHUB_SESSION_COOKIE}=`))!;

    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).not.toContain('ghp_secret_token_value');

    for (const legacy of LEGACY_GITHUB_COOKIES) {
      const cleared = headers.find((cookie) => cookie.startsWith(`${legacy}=`));

      expect(cleared).toBeDefined();
      expect(cleared).toContain('Max-Age=0');
    }

    const request = new Request('http://localhost/api/github', {
      headers: { Cookie: sessionCookie.split(';')[0] },
    });
    const { session } = await readGitHubSession(request, { APP_ENCRYPTION_SECRET: secret });

    expect(session?.token).toBe('ghp_secret_token_value');
    expect(session?.connection.login).toBe('octocat');
  });

  it('refuses to store credentials without a Worker secret', async () => {
    await expect(githubSessionHeaders({ token: 't', connection: {} as never }, {})).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(() => requireAppSecret({})).toThrowError(/APP_ENCRYPTION_SECRET/);
  });

  it('treats a token sealed with a different secret as unreadable', async () => {
    const headers = await githubSessionHeaders(
      {
        token: 'ghp_secret_token_value',
        connection: { login: 'octocat' } as never,
      },
      { APP_ENCRYPTION_SECRET: secret },
    );
    const cookie = headers.find((entry) => entry.startsWith(`${GITHUB_SESSION_COOKIE}=`))!;
    const request = new Request('http://localhost/api/github', {
      headers: { Cookie: cookie.split(';')[0] },
    });
    const result = await readGitHubSession(request, { APP_ENCRYPTION_SECRET: 'different-secret-value-1234567890' });

    expect(result.session).toBeUndefined();
    expect(result.reason).toBe('unreadable');
  });
});
