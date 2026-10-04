/**
 * Client-side GitHub API wrapper.
 *
 * Every credential operation happens on the Worker (`/api/github`); this module
 * only shapes requests and turns the server's stable error codes into typed
 * errors for the UI. No token is ever written to a cookie, localStorage or the
 * URL by this code.
 */

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
  connected: boolean;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  scopes: string[];
  tokenKind: 'classic' | 'fine_grained' | 'unknown';
  repoCreate: 'allowed' | 'not_allowed' | 'unverified';
  repoAccess?: GitHubRepoAccess;
  verifiedAt: string;
  verificationFresh?: boolean;
};

export type GitHubStatus = Partial<GitHubConnection> & {
  connected: boolean;
  storageConfigured: boolean;
  reason?: 'missing_secret' | 'unreadable';
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
  pushedBy: string;
  pushedAt: string;
};

export class GitHubClientError extends Error {
  readonly code: GitHubErrorCode;
  readonly hint?: string;
  readonly status: number;

  constructor(code: GitHubErrorCode, message: string, hint: string | undefined, status: number) {
    super(message);
    this.name = 'GitHubClientError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

async function requestGitHub<T>(init: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch('/api/github', {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    throw new GitHubClientError(
      'network',
      'Could not reach the Bolt server to talk to GitHub.',
      error instanceof Error ? error.message : undefined,
      0,
    );
  }

  let body: Record<string, unknown> = {};

  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (!response.ok) {
    throw new GitHubClientError(
      typeof body.code === 'string' ? (body.code as GitHubErrorCode) : 'unknown',
      typeof body.error === 'string' ? body.error : `GitHub request failed with HTTP ${response.status}`,
      typeof body.hint === 'string' ? body.hint : undefined,
      response.status,
    );
  }

  return body as T;
}

export function fetchGitHubStatus(): Promise<GitHubStatus> {
  return requestGitHub<GitHubStatus>({ method: 'GET' });
}

export function connectGitHub(options: { token: string; repo?: string; owner?: string }): Promise<GitHubConnection> {
  return requestGitHub<GitHubConnection>({
    method: 'POST',
    body: JSON.stringify({ action: 'connect', ...options }),
  });
}

export function verifyGitHub(options: { repo?: string } = {}): Promise<GitHubConnection> {
  return requestGitHub<GitHubConnection>({ method: 'POST', body: JSON.stringify({ action: 'verify', ...options }) });
}

export function disconnectGitHub(): Promise<{ connected: boolean }> {
  return requestGitHub<{ connected: boolean }>({ method: 'POST', body: JSON.stringify({ action: 'disconnect' }) });
}

export function pushFilesToGitHub(options: {
  repoName: string;
  files: Array<{ path: string; content: string }>;
  message?: string;
  branch?: string;
  isPrivate?: boolean;
}): Promise<GitHubPushResult> {
  return requestGitHub<GitHubPushResult>({ method: 'POST', body: JSON.stringify({ action: 'push', ...options }) });
}

/** Removes any credential-bearing cookie the previous implementation created. */
export function purgeLegacyGitHubCookies(): void {
  if (typeof document === 'undefined') {
    return;
  }

  for (const name of ['githubToken', 'githubUsername', 'git:github.com']) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}
