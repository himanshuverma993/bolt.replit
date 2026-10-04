// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { toast } from 'react-toastify';
import { logStore } from '~/lib/stores/logs';

/**
 * Rendered-UI tests for the GitHub connection panel.
 *
 * The component is exercised against the *real* `~/lib/github/client` module: only
 * `fetch` is stubbed, so the request shape, the typed error mapping and the
 * rendering of a connection are all covered together. This is the closest thing
 * to clicking through Settings -> Connections that runs without a browser.
 *
 * The React Fast Refresh preamble is not present in a test environment, so the
 * two globals Remix's JSX transform expects are installed before the component
 * module is loaded (hence the dynamic import); the spec itself is plain TS.
 */

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('~/lib/stores/logs', () => ({ logStore: { logSystem: vi.fn() } }));
vi.mock('~/lib/git/shell-git.client', () => ({
  detectShellGit: vi.fn(async () => ({ status: 'unavailable', detail: 'git is not installed in this container' })),
}));
vi.mock('./McpConnections', () => ({ default: () => null }));

const refreshGlobals = globalThis as unknown as Record<string, unknown>;

refreshGlobals.$RefreshReg$ = () => undefined;
refreshGlobals.$RefreshSig$ = () => (type: unknown) => type;
refreshGlobals.__vite_plugin_react_preamble_installed__ = true;

const { default: connectionsTab } = await import('./ConnectionsTab');

type Captured = { url: string; method: string; body: Record<string, unknown> };

const captured: Captured[] = [];
const toastMock = toast as unknown as { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handlers = {
  status: unknown;
  connect?: unknown;
  connectStatus?: number;
  verify?: unknown;
  disconnect?: unknown;
};

function stubGitHub(handlers: Handlers): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url, method, body });

    if (method === 'GET') {
      return jsonResponse(handlers.status);
    }

    if (body.action === 'connect') {
      return jsonResponse(
        handlers.connect ?? { error: 'unexpected connect', code: 'unknown' },
        handlers.connectStatus ?? 200,
      );
    }

    if (body.action === 'verify') {
      return jsonResponse(handlers.verify ?? handlers.connect ?? { error: 'unexpected verify' });
    }

    if (body.action === 'disconnect') {
      return jsonResponse(handlers.disconnect ?? { connected: false });
    }

    return jsonResponse({ error: `unexpected action ${String(body.action)}`, code: 'invalid_request' }, 400);
  });
}

const connected = {
  connected: true as const,
  login: 'octocat',
  name: 'Test User',
  avatarUrl: null,
  scopes: [] as string[],
  tokenKind: 'installation' as const,
  repoCreate: 'not_allowed' as const,
  repoAccess: {
    repository: 'octocat/hello-world',
    exists: true,
    push: true,
    admin: true,
    private: true,
    defaultBranch: 'main',
    empty: false,
  },
  verifiedAt: '2026-10-04T00:00:00.000Z',
};

const element = React.createElement(connectionsTab);

beforeEach(() => {
  captured.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GitHub connection panel', () => {
  it('shows the missing-secret banner and disables Connect when storage is not configured', async () => {
    stubGitHub({ status: { connected: false, storageConfigured: false, reason: 'missing_secret' } });

    render(element);

    const banner = await screen.findByText(/This deployment has no credential secret/);
    expect(banner.textContent).toContain('APP_ENCRYPTION_SECRET');

    fireEvent.change(screen.getByLabelText(/GitHub token/), { target: { value: 'ghp_example' } });

    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);

    // The token only ever lives in component state until Connect is enabled.
    expect(document.cookie).not.toContain('ghp_example');
    expect(document.body.textContent).not.toContain('ghp_example');
  });

  it('connects with the token in the JSON body and renders the verified permissions', async () => {
    stubGitHub({ status: { connected: false, storageConfigured: true }, connect: connected });

    render(element);

    fireEvent.change(await screen.findByLabelText(/Repository/), { target: { value: 'octocat/hello-world' } });
    fireEvent.change(screen.getByLabelText(/GitHub token/), { target: { value: 'ghp_example_token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText(/Connected as/);

    const post = captured.find((call) => call.method === 'POST');
    expect(post?.url).toBe('/api/github');
    expect(post?.body).toEqual({
      action: 'connect',
      token: 'ghp_example_token',
      repo: 'octocat/hello-world',
    });

    expect(screen.getByText(/Test User \(octocat\)/)).toBeTruthy();
    expect(screen.getByText(/GitHub App installation token/)).toBeTruthy();
    expect(screen.getByText(/not permitted — create the repository on GitHub first/)).toBeTruthy();
    expect(screen.getByText(/exists \(private\), push allowed/)).toBeTruthy();
    expect(screen.getByText(/GitHub authentication: valid/)).toBeTruthy();
    expect(toastMock.success.mock.calls.some(([message]) => String(message).includes('octocat'))).toBe(true);

    // The token input is gone with the form, and the token never reaches a cookie or the DOM.
    expect(screen.queryByLabelText(/GitHub token/)).toBeNull();
    expect(document.cookie).not.toContain('ghp_example_token');
    expect(document.body.innerHTML).not.toContain('ghp_example_token');
  });

  it('surfaces the server hint on failure, refreshes the status and clears legacy cookies', async () => {
    document.cookie = 'githubToken=legacy-value; Path=/';
    document.cookie = 'git:github.com=legacy; Path=/';
    expect(document.cookie).toContain('legacy-value');

    stubGitHub({
      status: { connected: false, storageConfigured: true },
      connectStatus: 403,
      connect: {
        error: 'GitHub refused the request (HTTP 403): Resource not accessible by integration',
        code: 'insufficient_permissions',
        hint: 'Update the token to include Contents: read and write.',
      },
    });

    render(element);

    fireEvent.change(await screen.findByLabelText(/GitHub token/), { target: { value: 'ghp_expired' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());

    const [message] = toastMock.error.mock.calls[0] as [string];
    expect(message).toContain('Resource not accessible by integration');
    expect(message).toContain('Update the token to include Contents: read and write.');

    // The failed attempt refreshes the status instead of leaving a stale card.
    await waitFor(() => expect(captured.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();

    await waitFor(() => expect(document.cookie).not.toContain('legacy-value'));
    expect(document.cookie).not.toContain('git:github.com=legacy');
  });

  it('disconnects through the server, clears the card and purges the legacy cookies', async () => {
    document.cookie = 'githubUsername=legacy-user; Path=/';
    stubGitHub({ status: connected, disconnect: { connected: false } });

    render(element);

    await screen.findByText(/Connected as/);
    await waitFor(() => expect(document.cookie).not.toContain('legacy-user'));

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await screen.findByRole('button', { name: 'Connect' });

    const post = captured.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ action: 'disconnect' });
    expect(screen.queryByText(/Connected as/)).toBeNull();
    expect(logStore.logSystem).toHaveBeenCalledWith('GitHub connection removed');
  });

  it('re-verifies permissions and refreshes the verification timestamp', async () => {
    stubGitHub({
      status: { ...connected, verificationFresh: false },
      verify: { ...connected, verifiedAt: '2026-10-04T12:00:00.000Z' },
    });

    render(element);

    await screen.findByText(/stale — re-verify before a large push/);
    fireEvent.click(screen.getByRole('button', { name: 'Verify permissions again' }));

    await waitFor(() => expect(captured.some((call) => call.body.action === 'verify')).toBe(true));
    await waitFor(() => expect(screen.queryByText(/stale/)).toBeNull());
    expect(toastMock.success).toHaveBeenCalledWith('GitHub permissions re-verified');
  });
});
