import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { json } from '@remix-run/cloudflare';
import {
  GITHUB_MAX_FILES,
  GitHubError,
  classifyGitHubError,
  clearGitHubSessionHeaders,
  githubSessionHeaders,
  isVerificationFresh,
  publicConnectionView,
  pushProjectToGitHub,
  readGitHubSession,
  requireAppSecret,
  verifyGitHubToken,
  type GitHubPushFile,
} from '~/lib/.server/github';
import { isSameOriginRequest, resolveAppSecret, redactSecrets, type SecretEnvironment } from '~/lib/.server/secrets';

/**
 * Server-side GitHub endpoint.
 *
 * The browser never sees a token: `connect` verifies and seals it into an
 * HttpOnly cookie, `push` performs the Octokit flow inside the Worker.
 */

type GitHubEnv = SecretEnvironment & {
  ASSETS?: unknown;
  AI?: unknown;
};

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

function getEnv(context: ActionFunctionArgs['context'] | LoaderFunctionArgs['context']): GitHubEnv {
  return (context.cloudflare.env ?? {}) as GitHubEnv;
}

function errorResponse(error: unknown, headers?: HeadersInit): Response {
  const classified = error instanceof GitHubError ? error : classifyGitHubError(error);

  console.error(`[github] ${classified.code}: ${redactSecrets(classified.message)}`);

  return json(
    {
      error: classified.message,
      code: classified.code,
      hint: classified.hint,
    },
    { status: classified.status, headers },
  );
}

function normalizeFiles(value: unknown): GitHubPushFile[] {
  if (!Array.isArray(value)) {
    throw new GitHubError('invalid_request', 'A list of project files is required for the push.');
  }

  if (value.length > GITHUB_MAX_FILES) {
    throw new GitHubError(
      'invalid_request',
      `This push contains ${value.length} entries, more than the ${GITHUB_MAX_FILES}-file limit.`,
      'Remove generated artefacts (node_modules, build output) and retry. Files are never silently dropped.',
    );
  }

  const files: GitHubPushFile[] = [];
  let totalBytes = 0;

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;

    if (typeof record.path !== 'string' || typeof record.content !== 'string') {
      continue;
    }

    const path = record.path.trim();

    if (!path || path.includes('\u0000')) {
      continue;
    }

    const size = new TextEncoder().encode(record.content).byteLength;

    if (size > MAX_FILE_BYTES) {
      throw new GitHubError(
        'invalid_request',
        `File "${path}" is larger than the 1 MiB per-file push limit.`,
        'Remove large binary or generated files and retry.',
      );
    }

    totalBytes += size;

    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new GitHubError(
        'invalid_request',
        'The project is larger than the 8 MiB push limit.',
        'Remove large generated files (node_modules, build output) and retry.',
      );
    }

    files.push({ path, content: record.content });
  }

  if (files.length === 0) {
    throw new GitHubError('invalid_request', 'There are no files to push.');
  }

  return files;
}

function readToken(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GitHubError('invalid_request', 'A GitHub personal access token is required.');
  }

  const token = value.trim();

  if (token.length > 512 || /\s/.test(token)) {
    throw new GitHubError('invalid_request', 'That does not look like a GitHub token.');
  }

  return token;
}

function readRepoName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GitHubError('invalid_request', 'A repository name is required.');
  }

  return value.trim();
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const storageConfigured = resolveAppSecret(env) !== undefined;
  const { session, reason } = await readGitHubSession(request, env);

  if (!session) {
    return json({
      connected: false,
      storageConfigured,
      reason,
    });
  }

  return json({
    ...publicConnectionView(session),
    storageConfigured: true,
    verificationFresh: isVerificationFresh(session.connection),
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);

  if (request.method !== 'POST') {
    return json(
      { error: 'GitHub endpoint accepts POST for connection management', code: 'invalid_request' },
      { status: 405 },
    );
  }

  if (!isSameOriginRequest(request)) {
    return json({ error: 'Cross-origin request rejected', code: 'invalid_request' }, { status: 403 });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');

  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return json(
      {
        error: `The request body is larger than the ${Math.round(MAX_REQUEST_BYTES / (1024 * 1024))} MiB endpoint limit.`,
        code: 'invalid_request',
        hint: 'Push fewer files, or exclude generated directories.',
      },
      { status: 413 },
    );
  }

  let body: Record<string, unknown>;

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Request body must be JSON', code: 'invalid_request' }, { status: 400 });
  }

  const action = body.action;

  if (action === 'connect') {
    try {
      const token = readToken(body.token);
      const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : undefined;
      const owner = typeof body.owner === 'string' && body.owner.trim() ? body.owner.trim() : undefined;
      const expectedLogin = typeof body.expectedLogin === 'string' ? body.expectedLogin : undefined;

      requireAppSecret(env);

      const connection = await verifyGitHubToken({ token, repo, owner, expectedLogin });
      const headers = new Headers();

      for (const cookie of await githubSessionHeaders({ token, connection }, env)) {
        headers.append('Set-Cookie', cookie);
      }

      return json({ connected: true, ...connection, storageConfigured: true, verificationFresh: true }, { headers });
    } catch (error) {
      /*
       * A failed connect must not leave a half-written session behind: clear the
       * session cookie and every legacy cookie. Each cookie needs its own
       * Set-Cookie header - joining them into one value is not valid HTTP.
       */
      const headers = new Headers();

      for (const cookie of clearGitHubSessionHeaders()) {
        headers.append('Set-Cookie', cookie);
      }

      return errorResponse(error, headers);
    }
  }

  if (action === 'disconnect') {
    const headers = new Headers();

    for (const cookie of clearGitHubSessionHeaders()) {
      headers.append('Set-Cookie', cookie);
    }

    return json({ connected: false, storageConfigured: resolveAppSecret(env) !== undefined }, { headers });
  }

  const { session, reason } = await readGitHubSession(request, env);

  if (!session) {
    const missingSecret = reason === 'missing_secret' || !resolveAppSecret(env);

    return errorResponse(
      missingSecret
        ? new GitHubError(
            'not_configured',
            'GitHub is not connected and this deployment has no credential secret configured.',
            'Set APP_ENCRYPTION_SECRET (or GITHUB_COOKIE_SECRET) as a Worker secret, then reconnect GitHub.',
          )
        : new GitHubError(
            'not_connected',
            'GitHub is not connected.',
            'Open Settings → Connection and connect a GitHub token, then push again.',
          ),
    );
  }

  if (action === 'verify') {
    try {
      const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : undefined;
      const connection = await verifyGitHubToken({ token: session.token, repo });
      const headers = new Headers();

      for (const cookie of await githubSessionHeaders({ token: session.token, connection }, env)) {
        headers.append('Set-Cookie', cookie);
      }

      return json({ connected: true, ...connection, storageConfigured: true, verificationFresh: true }, { headers });
    } catch (error) {
      const classified = error instanceof GitHubError ? error : classifyGitHubError(error);

      if (classified.code === 'invalid_token') {
        const headers = new Headers();

        for (const cookie of clearGitHubSessionHeaders()) {
          headers.append('Set-Cookie', cookie);
        }

        return errorResponse(classified, headers);
      }

      return errorResponse(classified);
    }
  }

  if (action === 'push') {
    try {
      const repoName = readRepoName(body.repoName);
      const files = normalizeFiles(body.files);

      const result = await pushProjectToGitHub({
        token: session.token,
        owner: session.connection.login,
        repoName,
        files,
        message: typeof body.message === 'string' ? body.message : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        isPrivate: body.isPrivate === true,
      });

      return json({
        ok: true,
        ...result,
        pushedBy: session.connection.login,
        pushedAt: new Date().toISOString(),
      });
    } catch (error) {
      const classified = error instanceof GitHubError ? error : classifyGitHubError(error);

      if (classified.code === 'invalid_token') {
        const headers = new Headers();

        for (const cookie of clearGitHubSessionHeaders()) {
          headers.append('Set-Cookie', cookie);
        }

        return errorResponse(classified, headers);
      }

      return errorResponse(classified);
    }
  }

  return json({ error: 'Unsupported GitHub action', code: 'invalid_request' }, { status: 400 });
}
