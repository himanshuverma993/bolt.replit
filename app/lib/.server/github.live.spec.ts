import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubClient, pushProjectToGitHub, verifyGitHubToken, type GitHubConnection } from './github';

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
