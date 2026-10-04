import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { logStore } from '~/lib/stores/logs';
import {
  connectGitHub,
  disconnectGitHub,
  fetchGitHubStatus,
  purgeLegacyGitHubCookies,
  verifyGitHub,
  GitHubClientError,
  type GitHubConnection,
  type GitHubStatus,
} from '~/lib/github/client';
import { detectShellGit, type ShellGitProbe } from '~/lib/git/shell-git.client';
import McpConnections from './McpConnections';

function describeError(error: unknown): string {
  if (error instanceof GitHubClientError) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }

  return error instanceof Error ? error.message : 'GitHub request failed';
}

function PermissionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-bolt-elements-textSecondary">{label}:</span>
      <span className="text-bolt-elements-textPrimary">{value}</span>
    </div>
  );
}

/** A GitHub App installation token is detected on the server; say what it means. */
function tokenKindLabel(kind: GitHubStatus['tokenKind']): string {
  if (kind === 'classic') {
    return 'classic personal access token';
  }

  if (kind === 'installation') {
    return 'GitHub App installation token (scopes are not exposed and repositories cannot be created)';
  }

  if (kind === 'fine_grained') {
    return 'fine-grained personal access token';
  }

  return 'unknown (fine-grained or app token; permissions are verified by pushing)';
}

export default function ConnectionsTab() {
  const [status, setStatus] = useState<GitHubStatus>({ connected: false, storageConfigured: true });
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [shellGit, setShellGit] = useState<ShellGitProbe>({ status: 'unknown', detail: 'Not checked yet.' });

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchGitHubStatus();
      setStatus(next);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    /*
     * The previous implementation wrote the token into a JavaScript-readable
     * cookie; remove it as soon as the settings tab opens.
     */
    purgeLegacyGitHubCookies();
    refreshStatus();
  }, [refreshStatus]);

  const handleConnect = async () => {
    if (!token.trim()) {
      toast.error('Paste a GitHub token first');
      return;
    }

    setIsBusy(true);

    try {
      const connection = await connectGitHub({ token: token.trim(), repo: repo.trim() || undefined });
      setToken('');
      setStatus({ ...connection, connected: true, storageConfigured: true, verificationFresh: true });
      logStore.logSystem('GitHub connection verified', {
        login: connection.login,
        tokenKind: connection.tokenKind,
        scopes: connection.scopes,
        repoAccess: connection.repoAccess?.repository,
      });
      toast.success(`Connected to GitHub as ${connection.login}`);
    } catch (error) {
      toast.error(describeError(error));
      await refreshStatus();
    } finally {
      setIsBusy(false);
    }
  };

  const handleVerify = async () => {
    setIsBusy(true);

    try {
      const connection: GitHubConnection = await verifyGitHub({ repo: repo.trim() || undefined });
      setStatus({ ...connection, connected: true, storageConfigured: true, verificationFresh: true });
      toast.success('GitHub permissions re-verified');
    } catch (error) {
      toast.error(describeError(error));
      await refreshStatus();
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setIsBusy(true);

    try {
      await disconnectGitHub();
      purgeLegacyGitHubCookies();
      setStatus({ connected: false, storageConfigured: true });
      logStore.logSystem('GitHub connection removed');
      toast.success('GitHub connection removed');
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleProbeShellGit = async () => {
    setShellGit({ status: 'unknown', detail: 'Checking…' });

    const probe = await detectShellGit();
    setShellGit(probe);

    if (probe.status === 'available') {
      toast.success(`Shell git available: ${probe.detail}`);
    } else {
      toast.info('Shell git is not available; GitHub API push still works.');
    }
  };

  const repoAccess = status.repoAccess;
  const apiPushState = status.connected ? 'available' : 'not connected';

  return (
    <>
      <div className="p-4 mb-4 border border-bolt-elements-borderColor rounded-lg bg-bolt-elements-background-depth-3">
        <h3 className="text-lg font-medium text-bolt-elements-textPrimary mb-1">GitHub Connection</h3>
        <p className="text-xs text-bolt-elements-textSecondary mb-4">
          Tokens are verified and stored on the server inside an encrypted, HttpOnly cookie. They are never written to
          browser-readable cookies, settings exports, logs, URLs or chat messages. For least privilege prefer a
          fine-grained token with <em>Contents: read &amp; write</em>, <em>Metadata: read</em> and (only if Bolt must
          create repositories) <em>Administration: read &amp; write</em>; classic tokens need the <code>repo</code>{' '}
          scope.
        </p>

        {!status.storageConfigured && (
          <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
            This deployment has no credential secret, so Bolt will not store a token. Set{' '}
            <code>APP_ENCRYPTION_SECRET</code> (or <code>GITHUB_COOKIE_SECRET</code>) with{' '}
            <code>wrangler secret put APP_ENCRYPTION_SECRET</code> and reload.
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-bolt-elements-textSecondary">Loading GitHub status…</p>
        ) : status.connected ? (
          <div className="space-y-2 mb-4">
            <div className="flex items-center gap-2">
              {status.avatarUrl ? (
                <img src={status.avatarUrl} alt={status.login} className="h-6 w-6 rounded-full" />
              ) : (
                <div className="i-ph:github-logo text-xl" />
              )}
              <span className="text-sm text-bolt-elements-textPrimary">
                Connected as <strong>{status.name ? `${status.name} (${status.login})` : status.login}</strong>
              </span>
            </div>
            <PermissionRow label="Token kind" value={tokenKindLabel(status.tokenKind)} />
            <PermissionRow
              label="Scopes"
              value={
                status.scopes && status.scopes.length > 0 ? status.scopes.join(', ') : 'fine-grained / not reported'
              }
            />
            <PermissionRow
              label="Repository creation"
              value={
                status.repoCreate === 'allowed'
                  ? 'allowed'
                  : status.repoCreate === 'unverified'
                    ? 'unverified (fine-grained tokens do not expose this before the first push)'
                    : 'not permitted — create the repository on GitHub first, or reconnect with a personal token'
              }
            />
            {repoAccess && (
              <PermissionRow
                label={`Access to ${repoAccess.repository}`}
                value={
                  !repoAccess.exists
                    ? 'repository does not exist yet; Bolt will create it on push'
                    : `exists${repoAccess.private ? ' (private)' : ''}, push ${repoAccess.push === null ? 'unknown' : repoAccess.push ? 'allowed' : 'denied'}`
                }
              />
            )}
            <p className="text-xs text-bolt-elements-textTertiary">
              Verified {status.verifiedAt ? new Date(status.verifiedAt).toLocaleString() : 'recently'}
              {status.verificationFresh === false ? ' (stale — re-verify before a large push)' : ''}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={handleVerify}
                disabled={isBusy}
                className="rounded-lg bg-bolt-elements-button-primary-background px-3 py-1.5 text-sm text-bolt-elements-button-primary-text disabled:opacity-50"
              >
                {isBusy ? 'Verifying…' : 'Verify permissions again'}
              </button>
              <button
                onClick={handleDisconnect}
                disabled={isBusy}
                className="rounded-lg bg-bolt-elements-button-danger-background px-3 py-1.5 text-sm text-bolt-elements-button-danger-text disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 mb-4">
            <div>
              <label className="mb-1 block text-sm text-bolt-elements-textSecondary" htmlFor="github-repo">
                Repository (optional, verifies push permission)
              </label>
              <input
                id="github-repo"
                type="text"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/name"
                className="w-full rounded-md border border-bolt-elements-borderColor bg-white px-2 py-1.5 text-bolt-elements-textPrimary dark:bg-bolt-elements-background-depth-4"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-bolt-elements-textSecondary" htmlFor="github-token">
                GitHub token (sent once to the server, never stored in the browser)
              </label>
              <input
                id="github-token"
                type="password"
                value={token}
                autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
                className="w-full rounded-md border border-bolt-elements-borderColor bg-white px-2 py-1.5 text-bolt-elements-textPrimary dark:bg-bolt-elements-background-depth-4"
              />
            </div>
            <button
              onClick={handleConnect}
              disabled={isBusy || !token.trim() || !status.storageConfigured}
              className="rounded-lg bg-bolt-elements-button-primary-background px-4 py-2 text-bolt-elements-button-primary-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? 'Verifying…' : 'Connect'}
            </button>
            {status.reason === 'unreadable' && (
              <p className="text-xs text-amber-400">
                A previous GitHub session could not be decrypted (the Worker secret changed). Connect again.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 rounded-md border border-bolt-elements-borderColor p-3">
          <h4 className="mb-2 text-sm font-medium text-bolt-elements-textPrimary">Git capabilities</h4>
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <span className={shellGit.status === 'available' ? 'text-green-500' : 'text-amber-400'}>
                {shellGit.status === 'available' ? '●' : '○'}
              </span>
              <span className="text-bolt-elements-textPrimary">
                Shell git (WebContainer):{' '}
                {shellGit.status === 'available'
                  ? 'available'
                  : shellGit.status === 'unknown'
                    ? 'not checked'
                    : 'unavailable'}
              </span>
              <button
                type="button"
                onClick={handleProbeShellGit}
                className="text-bolt-elements-textSecondary underline hover:text-bolt-elements-textPrimary"
              >
                check again
              </button>
            </div>
            <p className="pl-4 text-bolt-elements-textTertiary">{shellGit.detail}</p>
            <div className="flex items-center gap-2">
              <span className={status.connected ? 'text-green-500' : 'text-amber-400'}>●</span>
              <span className="text-bolt-elements-textPrimary">GitHub API push: {apiPushState}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={status.connected ? 'text-green-500' : 'text-red-400'}>●</span>
              <span className="text-bolt-elements-textPrimary">
                GitHub authentication: {status.connected ? 'valid' : 'not connected'}
              </span>
            </div>
            <p className="pl-4 text-bolt-elements-textTertiary">
              Push to GitHub uses the GitHub REST API from the Worker, so it does not require shell git. Clone/import
              uses isomorphic-git in the browser and keeps credentials in memory only.
            </p>
          </div>
        </div>
      </div>
      <McpConnections />
    </>
  );
}
