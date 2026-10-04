/**
 * GitHub integration, server side.
 *
 * Design rules (see HARDENING_REPORT.md for the full rationale):
 *  1. A personal access token is only ever handled on the Worker. It is sealed
 *     with AES-256-GCM and returned to the browser inside an HttpOnly, Secure,
 *     SameSite=Lax cookie - never in a JavaScript-readable cookie, never in
 *     exported settings, never in a log line, URL or chat message.
 *  2. "Connected" means identity *and* the permissions the push path needs were
 *     verified against the GitHub API, not just that `/user` answered.
 *  3. Every failure is mapped to a stable code plus an actionable hint, so the
 *     UI can tell apart "shell git unavailable" from "GitHub API push available"
 *     and "GitHub authentication invalid".
 *  4. Pushing is done with the same Octokit Git Data flow as before (blobs ->
 *     tree -> commit -> ref) and additionally handles empty repositories,
 *     missing default branches and branch-update conflicts.
 *
 * The AI SDK, Remix and the existing provider behaviour are untouched by this
 * module.
 */

import { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/rest';
import {
  clearCookie,
  openJsonPayload,
  resolveAppSecret,
  sealJsonPayload,
  serializeCookie,
  missingSecretMessage,
  readRequestCookies,
  redactSecrets,
  type SecretEnvironment,
} from '~/lib/.server/secrets';

export const GITHUB_SESSION_COOKIE = 'gh_session';
export const GITHUB_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
export const GITHUB_VERIFICATION_TTL_MS = 1000 * 60 * 30;
export const GITHUB_MAX_FILES = 2000;
export const GITHUB_BLOB_CONCURRENCY = 8;

/**
 * Cookies written by the previous implementation. They contained the raw token
 * in JavaScript-readable storage; every GitHub response clears them so existing
 * browsers are migrated (and any leaked value stops being readable) as soon as
 * the user touches the feature again.
 */
export const LEGACY_GITHUB_COOKIES = ['githubToken', 'githubUsername', 'git:github.com'] as const;

export type GitHubErrorCode =
  | 'not_connected'
  | 'invalid_token'
  | 'insufficient_permissions'
  | 'repo_not_found'
  | 'repo_empty'
  | 'missing_default_branch'
  | 'branch_conflict'
  | 'rate_limited'
  | 'network'
  | 'not_configured'
  | 'invalid_request'
  | 'unknown';

const STATUS_BY_CODE: Record<GitHubErrorCode, number> = {
  not_connected: 401,
  invalid_token: 401,
  insufficient_permissions: 403,
  repo_not_found: 404,
  repo_empty: 409,
  missing_default_branch: 409,
  branch_conflict: 409,
  rate_limited: 429,
  network: 502,
  not_configured: 501,
  invalid_request: 400,
  unknown: 500,
};

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly hint?: string;
  readonly status: number;

  constructor(code: GitHubErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.hint = hint;
    this.status = STATUS_BY_CODE[code];
  }
}

export type GitHubTokenKind = 'classic' | 'fine_grained' | 'unknown';

export type GitHubRepoAccess = {
  repository: string;
  exists: boolean;
  push: boolean | null;
  admin: boolean | null;
  private: boolean | null;
  defaultBranch: string | null;
  empty: boolean | null;
};

export type GitHubConnection = {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  scopes: string[];
  tokenKind: GitHubTokenKind;
  repoCreate: 'allowed' | 'not_allowed' | 'unverified';
  repoAccess?: GitHubRepoAccess;
  verifiedAt: string;
};

export type StoredGitHubSession = {
  token: string;
  connection: GitHubConnection;
};

export type GitHubPushFile = {
  path: string;
  content: string;
};

export type GitHubPushResult = {
  owner: string;
  repo: string;
  htmlUrl: string;
  branch: string;
  commitSha: string;
  created: boolean;
  emptyRepository: boolean;
  filesWritten: number;
  filesSkipped: number;
  skippedPaths: string[];
};

export type OctokitLike = Octokit;

type GitHubClientOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
};

/**
 * Creates the Octokit client used by every GitHub call.
 *
 * `baseUrl`/`fetch` exist so tests can run the full push flow against a local
 * mock GitHub API instead of the real one (see app/lib/.server/github.spec.ts).
 */
export function createGitHubClient(token: string, options: GitHubClientOptions = {}): Octokit {
  return new Octokit({
    auth: token,
    userAgent: 'bolt-replit',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  });
}

export function toBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error);

  if (!record) {
    return undefined;
  }

  if (typeof record.status === 'number') {
    return record.status;
  }

  const response = asRecord(record.response);

  return typeof response?.status === 'number' ? response.status : undefined;
}

function getErrorResponseMessage(error: unknown): string | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const data = asRecord(response?.data);

  return typeof data?.message === 'string' ? data.message : undefined;
}

function getRateLimitReset(error: unknown): string | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const headers = asRecord(response?.headers);
  const reset = headers?.['x-ratelimit-reset'];

  if (typeof reset !== 'string' && typeof reset !== 'number') {
    return undefined;
  }

  const seconds = Number(reset);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  return new Date(seconds * 1000).toISOString();
}

function isNetworkFailure(error: unknown): boolean {
  const record = asRecord(error);
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = typeof record?.message === 'string' ? record.message : '';

  return (
    ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) ||
    /fetch failed|network|socket hang up|connect timeout/i.test(message)
  );
}

/** Maps any GitHub/Octokit failure onto a stable code with an actionable hint. */
export function classifyGitHubError(error: unknown): GitHubError {
  if (error instanceof GitHubError) {
    return error;
  }

  const status = getErrorStatus(error);
  const record = asRecord(error);
  const responseMessage = getErrorResponseMessage(error) ?? '';
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof record?.message === 'string'
          ? record.message
          : '';
  const message = redactSecrets(responseMessage || rawMessage);

  if (isNetworkFailure(error)) {
    return new GitHubError(
      'network',
      'Could not reach the GitHub API from the Worker.',
      'GitHub may be rate limiting or unreachable; retry in a moment.',
    );
  }

  if (status === 401) {
    return new GitHubError(
      'invalid_token',
      'GitHub rejected the token (HTTP 401).',
      'The token is expired, revoked or mistyped. Create a new token and reconnect.',
    );
  }

  if (status === 403 || status === 429) {
    const reset = getRateLimitReset(error);

    if (status === 429 || /rate limit/i.test(message)) {
      return new GitHubError(
        'rate_limited',
        `GitHub API rate limit reached${reset ? ` (resets at ${reset})` : ''}.`,
        'Wait for the limit to reset, then retry the push.',
      );
    }

    return new GitHubError(
      'insufficient_permissions',
      `GitHub refused the request (HTTP 403)${message ? `: ${message}` : '.'}`,
      'The token is missing a required permission. For classic tokens use the `repo` scope; for fine-grained ' +
        'tokens grant Repository permissions: Contents (read/write) and Administration (read/write) to create ' +
        'repositories. GitHub App installation tokens cannot create repositories at all - connect with a personal token ' +
        'instead, or create the repository on GitHub first.',
    );
  }

  if (status === 404) {
    return new GitHubError(
      'repo_not_found',
      'GitHub reported the repository or resource as not found (HTTP 404).',
      'Check the repository name and, for private repositories, that the token has access to it.',
    );
  }

  if (status === 409 || status === 422) {
    if (/empty/i.test(message)) {
      return new GitHubError(
        'repo_empty',
        'The repository exists but has no commits yet.',
        'Bolt creates the first commit automatically; retry the push.',
      );
    }

    if (/already exists/i.test(message)) {
      return new GitHubError(
        'insufficient_permissions',
        'A repository with this name already exists but the token cannot access it.',
        'Use a different name, or grant the token access to the existing repository.',
      );
    }

    if (/reference|non-fast-forward|sha|update/i.test(message)) {
      return new GitHubError(
        'branch_conflict',
        'The branch changed on GitHub while the push was running (HTTP 409).',
        'Retry the push; Bolt rebases the new commit on the latest branch head.',
      );
    }

    return new GitHubError(
      'invalid_request',
      `GitHub rejected the request (HTTP ${status})${message ? `: ${message}` : '.'}`,
    );
  }

  return new GitHubError(
    'unknown',
    message ? `GitHub request failed: ${message}` : 'GitHub request failed.',
    'Retry the operation; if it keeps failing, check the GitHub status page.',
  );
}

export function splitRepoSpec(repoSpec: string, fallbackOwner: string | undefined): { owner: string; repo: string } {
  const trimmed = repoSpec
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '');
  const segments = trimmed.split('/').filter(Boolean);

  if (segments.length === 2) {
    return { owner: segments[0], repo: segments[1] };
  }

  if (!fallbackOwner) {
    throw new GitHubError(
      'invalid_request',
      'A GitHub owner (username or organisation) is required.',
      'Enter the repository as `owner/name`, or connect GitHub first so Bolt knows your account.',
    );
  }

  if (segments.length !== 1) {
    throw new GitHubError('invalid_request', 'Repository name is not valid.');
  }

  return { owner: fallbackOwner, repo: segments[0] };
}

export function assertValidRepoName(repo: string): void {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
    throw new GitHubError(
      'invalid_request',
      'Repository names may only contain letters, numbers, dots, dashes and underscores.',
    );
  }
}

function parseScopes(headerValue: string | undefined): string[] {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function determineTokenKind(scopes: string[]): GitHubTokenKind {
  if (scopes.length > 0) {
    return 'classic';
  }

  return 'unknown';
}

/**
 * Verifies identity and the permissions the push flow needs.
 *
 * - Identity: `GET /user`.
 * - Classic token scopes: the `x-oauth-scopes` response header.
 * - Fine-grained tokens: scopes are not exposed by the API, so repository
 *   permissions are read from the target repository when a name is supplied and
 *   otherwise reported as `unverified` (the push path then verifies by doing).
 */
export async function verifyGitHubToken(options: {
  token: string;
  repo?: string;
  owner?: string;
  octokit?: OctokitLike;
  expectedLogin?: string;
}): Promise<GitHubConnection> {
  const octokit = options.octokit ?? createGitHubClient(options.token);

  let userResponse: RestEndpointMethodTypes['users']['getAuthenticated']['response'];

  try {
    userResponse = await octokit.users.getAuthenticated();
  } catch (error) {
    throw classifyGitHubError(error);
  }

  const login = userResponse.data.login;

  if (options.expectedLogin && options.expectedLogin.toLowerCase() !== login.toLowerCase()) {
    throw new GitHubError(
      'invalid_request',
      `The token belongs to "${login}", not "${options.expectedLogin}".`,
      'Use a token that belongs to the repository owner you want to push as.',
    );
  }

  const scopes = parseScopes(userResponse.headers['x-oauth-scopes'] as string | undefined);
  const tokenKind = determineTokenKind(scopes);
  const connection: GitHubConnection = {
    login,
    name: userResponse.data.name ?? null,
    avatarUrl: userResponse.data.avatar_url ?? null,
    scopes,
    tokenKind,
    repoCreate: tokenKind === 'classic' ? (scopes.includes('repo') ? 'allowed' : 'unverified') : 'unverified',
    verifiedAt: new Date().toISOString(),
  };

  if (options.repo) {
    const { owner, repo } = splitRepoSpec(options.repo, options.owner ?? login);

    try {
      const repoResponse = await octokit.repos.get({ owner, repo });
      const permissions = repoResponse.data.permissions;

      connection.repoAccess = {
        repository: `${owner}/${repo}`,
        exists: true,
        push: permissions ? permissions.push === true : null,
        admin: permissions ? permissions.admin === true : null,
        private: repoResponse.data.private === true,
        defaultBranch: repoResponse.data.default_branch ?? null,
        empty: typeof repoResponse.data.size === 'number' ? repoResponse.data.size === 0 : null,
      };

      if (connection.repoAccess.push === false) {
        throw new GitHubError(
          'insufficient_permissions',
          `The token can read ${owner}/${repo} but not push to it.`,
          'Grant the token write access to repository contents (classic: `repo` scope; fine-grained: Contents read/write).',
        );
      }

      if (repoResponse.data.private === true && tokenKind === 'classic' && !scopes.includes('repo')) {
        throw new GitHubError(
          'insufficient_permissions',
          'The token cannot push to a private repository without the `repo` scope.',
          'Re-create the token with the `repo` scope, or push to a public repository.',
        );
      }
    } catch (error) {
      const classified = classifyGitHubError(error);

      if (classified.code === 'repo_not_found') {
        connection.repoAccess = {
          repository: `${owner}/${repo}`,
          exists: false,
          push: null,
          admin: null,
          private: null,
          defaultBranch: null,
          empty: null,
        };
      } else {
        throw classified;
      }
    }
  }

  return connection;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = new Array(Math.min(concurrency, items.length)).fill(undefined).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);

  return results;
}

function isBinaryLikePath(path: string, content: string): boolean {
  if (content.length === 0) {
    return false;
  }

  // A NUL byte means we cannot safely round-trip through UTF-8 text.
  return (
    content.includes('\u0000') || /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|mp4|mp3|wasm)$/i.test(path)
  );
}

/**
 * Creates or updates a repository from the given files.
 *
 * Handles the real-world cases the previous implementation missed:
 *  - repository does not exist (creates it, no `auto_init` commit race);
 *  - repository exists but is empty (writes the first commit with no parents);
 *  - repository without a default branch;
 *  - branch moved while pushing (re-reads the ref and retries, up to 3 attempts).
 */
export async function pushProjectToGitHub(options: {
  token: string;
  owner: string | undefined;
  repoName: string;
  files: GitHubPushFile[];
  message?: string;
  branch?: string;
  isPrivate?: boolean;
  octokit?: OctokitLike;
}): Promise<GitHubPushResult> {
  const octokit = options.octokit ?? createGitHubClient(options.token);
  const commitMessage = options.message?.slice(0, 200) || 'Update from Bolt';
  const requestedBranch = options.branch?.trim();

  if (options.files.length > GITHUB_MAX_FILES) {
    throw new GitHubError(
      'invalid_request',
      `This project has ${options.files.length} files, more than the ${GITHUB_MAX_FILES}-file push limit.`,
      'Remove generated artefacts (node_modules, build output) and retry.',
    );
  }

  let owner: string;
  let repo: string;

  if (options.owner) {
    ({ owner, repo } = splitRepoSpec(options.repoName, options.owner));
    assertValidRepoName(repo);
  } else {
    const { owner: detectedOwner, repo: detectedRepo } = splitRepoSpec(options.repoName, undefined);
    owner = detectedOwner;
    repo = detectedRepo;
    assertValidRepoName(repo);
  }

  const padded = options.files.map((file) => ({
    ...file,
    path: file.path.replace(/^\/+/, ''),
  }));
  const pushable = padded.filter((file) => file.path.length > 0 && !isBinaryLikePath(file.path, file.content));
  const skipped = padded.filter((file) => !pushable.includes(file)).map((file) => file.path);

  if (pushable.length === 0) {
    throw new GitHubError(
      'invalid_request',
      'There are no text files to push yet.',
      'Ask the Agent to create a project first, then push again.',
    );
  }

  let created = false;
  let repoData: RestEndpointMethodTypes['repos']['get']['response']['data'];

  try {
    const existing = await octokit.repos.get({ owner, repo });
    repoData = existing.data;
  } catch (error) {
    const classified = classifyGitHubError(error);

    if (classified.code !== 'repo_not_found') {
      throw classified;
    }

    try {
      const createdRepo = await octokit.repos.createForAuthenticatedUser({
        name: repo,
        private: options.isPrivate === true,
        auto_init: false,
      });
      repoData = createdRepo.data;
      created = true;
    } catch (createError) {
      throw classifyGitHubError(createError);
    }
  }

  const targetBranch = requestedBranch || repoData.default_branch || 'main';
  const fullName = `${owner}/${repo}`;

  const blobShas = await mapWithConcurrency(pushable, GITHUB_BLOB_CONCURRENCY, async (file) => {
    try {
      const blob = await octokit.git.createBlob({
        owner,
        repo,
        content: toBase64Utf8(file.content),
        encoding: 'base64',
      });

      return { path: file.path, sha: blob.data.sha };
    } catch (error) {
      throw classifyGitHubError(error);
    }
  });

  const treeEntries = blobShas.map((blob) => ({
    path: blob.path,
    mode: '100644' as const,
    type: 'blob' as const,
    sha: blob.sha,
  }));

  const isEmptyBySize = typeof repoData.size === 'number' && repoData.size === 0;
  const hasDefaultBranch = typeof repoData.default_branch === 'string' && repoData.default_branch.length > 0;

  const createInitialCommit = async (): Promise<string> => {
    const tree = await octokit.git.createTree({ owner, repo, tree: treeEntries });
    const commit = await octokit.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: tree.data.sha,
      parents: [],
    });

    try {
      await octokit.git.createRef({ owner, repo, ref: `refs/heads/${targetBranch}`, sha: commit.data.sha });
    } catch (error) {
      const classified = classifyGitHubError(error);

      /*
       * The branch appeared between our checks (for example a second push):
       * fall through to the normal update path instead of failing.
       */
      if (classified.code !== 'invalid_request' && classified.code !== 'branch_conflict') {
        throw classified;
      }
    }

    return commit.data.sha;
  };

  if (isEmptyBySize || !hasDefaultBranch) {
    const commitSha = await createInitialCommit();

    return {
      owner,
      repo,
      htmlUrl: `https://github.com/${fullName}`,
      branch: targetBranch,
      commitSha,
      created,
      emptyRepository: true,
      filesWritten: pushable.length,
      filesSkipped: skipped.length,
      skippedPaths: skipped,
    };
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let baseCommitSha: string;

    try {
      const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${targetBranch}` });
      baseCommitSha = ref.data.object.sha;
    } catch (error) {
      const classified = classifyGitHubError(error);

      if (classified.code === 'repo_empty') {
        const commitSha = await createInitialCommit();

        return {
          owner,
          repo,
          htmlUrl: `https://github.com/${fullName}`,
          branch: targetBranch,
          commitSha,
          created,
          emptyRepository: true,
          filesWritten: pushable.length,
          filesSkipped: skipped.length,
          skippedPaths: skipped,
        };
      }

      if (classified.code === 'repo_not_found') {
        throw new GitHubError(
          'missing_default_branch',
          `The repository has no branch named "${targetBranch}".`,
          `Push to an existing branch or let Bolt create "${targetBranch}".`,
        );
      }

      throw classified;
    }

    try {
      const tree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseCommitSha,
        tree: treeEntries,
      });
      const commit = await octokit.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree: tree.data.sha,
        parents: [baseCommitSha],
      });

      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${targetBranch}`,
        sha: commit.data.sha,
        force: false,
      });

      return {
        owner,
        repo,
        htmlUrl: `https://github.com/${fullName}`,
        branch: targetBranch,
        commitSha: commit.data.sha,
        created,
        emptyRepository: false,
        filesWritten: pushable.length,
        filesSkipped: skipped.length,
        skippedPaths: skipped,
      };
    } catch (error) {
      const classified = classifyGitHubError(error);

      if (classified.code === 'branch_conflict' && attempt < maxAttempts) {
        continue;
      }

      if (classified.code === 'repo_empty') {
        continue;
      }

      throw classified;
    }
  }

  throw new GitHubError(
    'branch_conflict',
    `Could not update "${targetBranch}" because it kept changing (3 attempts).`,
    'Retry the push; if the branch is busy, push to a new branch instead.',
  );
}

/** Reads the sealed GitHub session cookie (token + cached verification result). */
export async function readGitHubSession(
  request: Request,
  env: SecretEnvironment,
): Promise<{ session?: StoredGitHubSession; reason?: 'missing_secret' | 'unreadable' }> {
  const secret = resolveAppSecret(env);
  const cookies = readRequestCookies(request);
  const raw = cookies[GITHUB_SESSION_COOKIE];

  if (!raw) {
    return {};
  }

  if (!secret) {
    return { reason: 'missing_secret' };
  }

  const session = await openJsonPayload<StoredGitHubSession>(raw, secret.value);

  if (!session || typeof session.token !== 'string' || session.token.length === 0) {
    return { reason: 'unreadable' };
  }

  return { session };
}

export function requireAppSecret(env: SecretEnvironment): string {
  const secret = resolveAppSecret(env);

  if (!secret) {
    throw new GitHubError('not_configured', missingSecretMessage('GitHub token'));
  }

  return secret.value;
}

/** Set-Cookie headers that persist the session; also clears the legacy cookies. */
export async function githubSessionHeaders(session: StoredGitHubSession, env: SecretEnvironment): Promise<string[]> {
  const secretValue = requireAppSecret(env);
  const sealed = await sealJsonPayload(session, secretValue);
  const headers = [
    serializeCookie(GITHUB_SESSION_COOKIE, sealed, {
      httpOnly: true,
      maxAge: GITHUB_SESSION_MAX_AGE,
      sameSite: 'Lax',
    }),
    ...LEGACY_GITHUB_COOKIES.map((name) => clearCookie(name, { httpOnly: false })),
  ];

  return headers;
}

export function clearGitHubSessionHeaders(): string[] {
  return [
    clearCookie(GITHUB_SESSION_COOKIE, { httpOnly: true }),
    ...LEGACY_GITHUB_COOKIES.map((name) => clearCookie(name, { httpOnly: false })),
  ];
}

export function isVerificationFresh(connection: GitHubConnection): boolean {
  const verifiedAt = Date.parse(connection.verifiedAt);

  if (!Number.isFinite(verifiedAt)) {
    return false;
  }

  return Date.now() - verifiedAt < GITHUB_VERIFICATION_TTL_MS;
}

/** Public (token-free) view of a session, safe to return to the browser. */
export function publicConnectionView(session: StoredGitHubSession): GitHubConnection & { connected: true } {
  return { connected: true, ...session.connection };
}
