import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubClient, pushProjectToGitHub, verifyGitHubToken, type GitHubConnection } from './github';

/*
 * The route handlers are imported here (not in app/routes) so Remix does not
 * expose a spec file as a route.
 */
import { action, loader } from '~/routes/api.github';

/**
 * Live GitHub integration test.
 *
 * Two distinct, explicitly opt-in suites:
 *
 *  1. Read-only verification (runs when `GITHUB_E2E_TOKEN` is set):
 *     identity + repository permission checks against the real GitHub API.
 *     `GITHUB_E2E_REPO` selects the repository to probe (default: the token's
 *     own account/repository name supplied by the caller). No writes.
 *
 *  2. Disposable repository write flow (requires `GITHUB_E2E_ALLOW_WRITES=1`):
 *     creates `bolt-replit-e2e-*`, pushes, updates and deletes it again. Never
 *     touches a production repository.
 *
 * Example:
 *   NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
 *   GITHUB_E2E_TOKEN=... GITHUB_E2E_REPO=owner/repo \
 *   pnpm exec vitest --run app/lib/.server/github.live.spec.ts
 */

const token = process.env.GITHUB_E2E_TOKEN;
const probeRepo = process.env.GITHUB_E2E_REPO;
const allowWrites = process.env.GITHUB_E2E_ALLOW_WRITES === '1';
const describeLive = token ? describe : describe.skip;
const describeWrites = token && allowWrites ? describe : describe.skip;
const repoName = `bolt-replit-e2e-${Date.now().toString(36)}`;

let connection: GitHubConnection | undefined;

describeLive('live GitHub verification (read-only)', () => {
  beforeAll(async () => {
    connection = await verifyGitHubToken({ token: token!, repo: probeRepo });
  });

  it('verifies identity and reports the token kind without leaking the token', () => {
    expect(connection?.login).toBeTruthy();

    console.log(
      `[github-live] login=${connection?.login} tokenKind=${connection?.tokenKind} ` +
        `scopes=${connection?.scopes.join('|') || 'none'} repoCreate=${connection?.repoCreate}`,
    );
  });

  it('verifies repository read/write permissions when a repository is supplied', () => {
    if (!probeRepo) {
      console.log('[github-live] GITHUB_E2E_REPO not set: skipping repository permission probe');
      return;
    }

    expect(connection?.repoAccess?.repository).toBe(probeRepo);
    expect(connection?.repoAccess?.exists).toBe(true);

    console.log(
      `[github-live] repo=${connection?.repoAccess?.repository} exists=${connection?.repoAccess?.exists} ` +
        `push=${String(connection?.repoAccess?.push)} admin=${String(connection?.repoAccess?.admin)}`,
    );
  });
});

describeWrites('live GitHub push (disposable repository)', () => {
  it('creates a repository, pushes files and then updates them', async () => {
    const octokit = createGitHubClient(token!);
    const owner = connection?.login ?? (await verifyGitHubToken({ token: token! })).login;
    const created = await pushProjectToGitHub({
      token: token!,
      owner,
      repoName,
      files: [
        { path: 'README.md', content: '# bolt-replit live test\n' },
        { path: 'src/index.js', content: 'console.log("v1");\n' },
      ],
      message: 'test: initial commit from BOLT_E2E',
      octokit,
    });

    expect(created.created).toBe(true);
    expect(created.filesWritten).toBe(2);

    const updated = await pushProjectToGitHub({
      token: token!,
      owner,
      repoName,
      files: [
        { path: 'README.md', content: '# bolt-replit live test\n\nupdated\n' },
        { path: 'src/index.js', content: 'console.log("v2");\n' },
        { path: 'src/extra.js', content: 'export const extra = true;\n' },
      ],
      message: 'test: update from BOLT_E2E',
      octokit,
    });

    expect(updated.created).toBe(false);
    expect(updated.commitSha).not.toBe(created.commitSha);

    const commits = await octokit.repos.listCommits({ owner, repo: repoName, per_page: 10 });

    expect(commits.data.length).toBeGreaterThanOrEqual(2);
  });
});

afterAll(async () => {
  if (!token || !allowWrites || !connection) {
    return;
  }

  try {
    const octokit = createGitHubClient(token);

    await octokit.repos.delete({ owner: connection.login, repo: repoName });
    console.log(`[github-live] cleaned up disposable repository ${connection.login}/${repoName}`);
  } catch (error) {
    console.warn(
      `[github-live] disposable repository could not be deleted automatically: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
});

/**
 * Route-level live suite: drives the real Remix route handlers against the real
 * GitHub API. Read-only - the only write it attempts is a repository creation
 * and that attempt is skipped unless the token provably cannot create
 * repositories (installation tokens never can), so nothing is ever written.
 */
describeLive('live GitHub route (read-only)', () => {
  const SECRET = 'live-route-test-secret-32-characters';
  const contextFor = (env: Record<string, unknown>) =>
    ({ cloudflare: { env } }) as unknown as Parameters<typeof action>[0]['context'];
  const post = (body: unknown, cookie?: string) =>
    new Request('https://bolt.example.test/api/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });

  it('connects, reports status and refuses a repository creation from the UI route', async () => {
    const connect = await action({
      request: post({ action: 'connect', token: token!, repo: probeRepo }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const connected = (await connect.json()) as Record<string, unknown>;
    const cookies = connect.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith('gh_session='))!;

    expect(connect.status).toBe(200);
    expect(connected.connected).toBe(true);
    expect(connected.login).toBeTruthy();
    expect(connected.tokenKind).toBe('installation');
    expect(connected.repoCreate).toBe('not_allowed');
    expect(session).toContain('HttpOnly');
    expect(session).not.toContain(token!);
    expect(JSON.stringify(connected)).not.toContain(token!);

    const status = await loader({
      request: new Request('https://bolt.example.test/api/github', {
        headers: { Cookie: session.split(';')[0] },
      }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof loader>[0]);
    const statusBody = (await status.json()) as Record<string, unknown>;

    expect(status.status).toBe(200);
    expect(statusBody.connected).toBe(true);
    expect(statusBody.login).toBe(connected.login);
    expect(statusBody.tokenKind).toBe('installation');
    expect(statusBody.storageConfigured).toBe(true);
    expect(JSON.stringify(statusBody)).not.toContain(token!);

    /*
     * Write safety: this suite must never create a repository. `repoCreate` is
     * only `not_allowed` when the token provably cannot create one (an
     * installation token, or a classic token without the `repo` scope). Any
     * other token kind may write, and a fine-grained token with Administration
     * write reports `unverified`, so in that case the attempt is skipped
     * entirely instead of risking a real write on an unsanctioned run.
     */
    if (connected.repoCreate !== 'not_allowed') {
      console.warn(
        `[github-live] refusing to attempt a repository creation with repoCreate=${String(connected.repoCreate)}; ` +
          'set GITHUB_E2E_ALLOW_WRITES=1 for the disposable-repository flow if a write is intended',
      );

      return;
    }

    const push = await action({
      request: post(
        { action: 'push', repoName, files: [{ path: 'README.md', content: '# live route test\n' }] },
        session.split(';')[0],
      ),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const pushBody = (await push.json()) as Record<string, unknown>;

    expect(push.status).toBe(403);
    expect(pushBody.code).toBe('insufficient_permissions');
    expect(String(pushBody.hint)).toMatch(/Administration|create the repository on GitHub first/i);
    expect(JSON.stringify(pushBody)).not.toContain(token!);
  });

  it('reports a repository that does not exist yet as creatable instead of failing', async () => {
    const missing = `bolt-replit-live-probe-${Date.now().toString(36)}`;
    const probed = await verifyGitHubToken({ token: token!, repo: `${connection?.login ?? ''}/${missing}` });

    expect(probed.repoAccess?.exists).toBe(false);
    expect(probed.repoAccess?.push).toBeNull();

    console.log(
      `[github-live] ${probed.repoAccess?.repository} does not exist yet -> exists=${String(
        probed.repoAccess?.exists,
      )} (no repository was created by this check)`,
    );
  });

  it('re-verifies permissions and clears the sealed session on disconnect', async () => {
    const connect = await action({
      request: post({ action: 'connect', token: token!, repo: probeRepo }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const session = connect.headers.getSetCookie().find((cookie) => cookie.startsWith('gh_session='))!;
    const cookie = session.split(';')[0];

    const verify = await action({
      request: post({ action: 'verify', repo: probeRepo }, cookie),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const verified = (await verify.json()) as Record<string, unknown>;
    const resealed = verify.headers.getSetCookie().find((value) => value.startsWith('gh_session='));

    expect(verify.status).toBe(200);
    expect(verified.connected).toBe(true);
    expect(verified.verificationFresh).toBe(true);
    expect(typeof verified.verifiedAt).toBe('string');
    expect(JSON.stringify(verified)).not.toContain(token!);
    expect(resealed).toBeDefined();
    expect(resealed).toContain('HttpOnly');
    expect(resealed).not.toContain(token!);

    // Re-sealing refreshes the timestamp, so the sealed value must differ.
    expect(resealed).not.toBe(session);
    console.log(`[github-live] verify refreshed the sealed session for ${String(verified.login)}`);

    const disconnect = await action({
      request: post({ action: 'disconnect' }, cookie),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const disconnected = (await disconnect.json()) as Record<string, unknown>;
    const cleared = disconnect.headers.getSetCookie();

    expect(disconnect.status).toBe(200);
    expect(disconnected.connected).toBe(false);
    expect(JSON.stringify(disconnected)).not.toContain(token!);

    for (const name of ['gh_session', 'githubToken', 'githubUsername', 'git:github.com']) {
      expect(cleared.some((value) => value.startsWith(`${name}=`) && /Max-Age=0/i.test(value))).toBe(true);
    }

    console.log('[github-live] disconnect cleared the sealed session and every legacy cookie');
  });

  it('classifies an invalid token, clears every credential cookie and echoes nothing', async () => {
    const invalid = `ghp_${'x'.repeat(36)}`;
    const outcome = await verifyGitHubToken({ token: invalid }).then(
      () => 'accepted',
      () => 'rejected',
    );

    if (outcome === 'accepted') {
      /*
       * This environment authenticates api.github.com requests itself (a
       * managed proxy injects credentials), so an invalid token cannot be
       * simulated from inside it. The 401 classification is covered by
       * app/lib/.server/github.spec.ts against the mock API.
       */
      console.warn(
        '[github-live] environment injects GitHub credentials for api.github.com - invalid-token path not exercisable here',
      );

      return;
    }

    const response = await action({
      request: post({ action: 'connect', token: invalid }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.code).toBe('invalid_token');
    expect(JSON.stringify(body)).not.toContain(invalid);

    for (const name of ['gh_session', 'githubToken', 'githubUsername', 'git:github.com']) {
      expect(
        response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${name}=`) && cookie.includes('Max-Age=0')),
      ).toBe(true);
    }
  });

  it('rejects a cross-origin connect before any GitHub call', async () => {
    const response = await action({
      request: new Request('https://bolt.example.test/api/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.test' },
        body: JSON.stringify({ action: 'connect', token }),
      }),
      context: contextFor({ APP_ENCRYPTION_SECRET: SECRET }),
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });
});
