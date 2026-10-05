// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { toast } from 'react-toastify';

/**
 * Rendered-UI tests for the MCP connection panel.
 *
 * These pin the user-visible half of the MCP auth rules: an OAuth-only server is
 * shown as "Authentication required" with an explicit OAuth action (never as a
 * connectable authless server), a bearer token travels only in the request body
 * and never reaches the DOM, the client refuses to navigate to a non-https
 * authorization URL even if the server sent one, classified failures keep their
 * code and hint, and the risky-tool opt-in is an explicit per-server action.
 */

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const refreshGlobals = globalThis as unknown as Record<string, unknown>;

refreshGlobals.$RefreshReg$ = () => undefined;
refreshGlobals.$RefreshSig$ = () => (type: unknown) => type;
refreshGlobals.__vite_plugin_react_preamble_installed__ = true;

const { default: mcpConnections } = await import('./McpConnections');

type Captured = { url: string; method: string; body: Record<string, unknown> };

const captured: Captured[] = [];
const toastMock = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};

type Server = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubMcp(options: { servers?: Server[]; post?: Record<string, unknown> }) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url, method, body });

    if (method === 'GET') {
      return jsonResponse({ servers: options.servers ?? [], credentialStorageConfigured: true });
    }

    const action = String(body.action);
    const response = options.post?.[action];

    if (response && typeof response === 'object' && 'status' in (response as Record<string, unknown>)) {
      return jsonResponse(response);
    }

    return jsonResponse({
      servers: options.servers ?? [],
      ...(response as Record<string, unknown> | undefined),
    });
  });
}

const element = React.createElement(mcpConnections);

const oauthServer: Server = {
  id: 'cloudflare-docs',
  name: 'Cloudflare Docs',
  url: 'https://docs.mcp.cloudflare.com/mcp',
  enabled: true,
  authMode: 'oauth',
  status: 'auth_required',
  tools: [],
};

beforeEach(() => {
  captured.length = 0;
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MCP connection panel', () => {
  it('shows an OAuth-only server as authentication required, never as connected', async () => {
    stubMcp({ servers: [oauthServer] });

    render(element);

    await screen.findByText('Cloudflare Docs');

    expect(screen.getByText('Authentication required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect with OAuth' })).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.getByText('oauth · 0 tools')).toBeTruthy();

    /*
     * Cloudflare and Figma are advertised as OAuth-only in the catalog, never as
     * servers that would connect without authentication.
     */
    expect(screen.getByRole('button', { name: /Use Cloudflare.*\(OAuth required\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Use GitHub \(bearer\)$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Use GitHub \(all tools\) \(bearer\)$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Use Figma.*\(OAuth required\)/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Use GitHub \(bearer\)$/ }));

    expect((screen.getByLabelText('MCP server Streamable HTTP URL') as HTMLInputElement).value).toBe(
      'https://api.githubcopilot.com/mcp/',
    );

    fireEvent.click(screen.getByRole('button', { name: /^Use GitHub \(all tools\) \(bearer\)$/ }));

    expect((screen.getByLabelText('MCP server Streamable HTTP URL') as HTMLInputElement).value).toBe(
      'https://api.githubcopilot.com/mcp/x/all',
    );

    fireEvent.click(screen.getByRole('button', { name: /Use Cloudflare/ }));

    const url = screen.getByLabelText('MCP server Streamable HTTP URL') as HTMLInputElement;
    expect(url.value).toBe('https://mcp.cloudflare.com/mcp');
    expect((screen.getByLabelText('MCP server name') as HTMLInputElement).value).toBe('Cloudflare');
  });

  it('classifies an auth-required add, keeps credentials out of the DOM and lists the server', async () => {
    stubMcp({
      servers: [],
      post: {
        add: {
          servers: [oauthServer],
          server: { ...oauthServer, status: 'auth_required' },
        },
      },
    });

    render(element);

    fireEvent.change(await screen.findByLabelText('MCP server name'), { target: { value: 'Cloudflare Docs' } });
    fireEvent.change(screen.getByLabelText('MCP server Streamable HTTP URL'), {
      target: { value: 'https://docs.mcp.cloudflare.com/mcp' },
    });
    fireEvent.change(screen.getByLabelText('Optional MCP bearer token'), { target: { value: 'secret-bearer-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    await waitFor(() => expect(toastMock.info).toHaveBeenCalled());

    const post = captured.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      action: 'add',
      name: 'Cloudflare Docs',
      url: 'https://docs.mcp.cloudflare.com/mcp',
      token: 'secret-bearer-token',
    });
    expect(String(toastMock.info.mock.calls[0][0])).toContain('requires OAuth');
    await screen.findByText('Authentication required');
    expect(document.body.innerHTML).not.toContain('secret-bearer-token');
  });

  it('refuses to navigate to a non-https authorization URL sent by the server', async () => {
    stubMcp({
      servers: [oauthServer],
      post: { authorize: { authorizationUrl: 'javascript:alert(1)', servers: [oauthServer] } },
    });

    render(element);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect with OAuth' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(String(toastMock.error.mock.calls[0][0])).toContain('Refusing to redirect to a non-https');

    // A plain-http remote authorization URL is refused for the same reason.
    captured.length = 0;
    stubMcp({
      servers: [oauthServer],
      post: { authorize: { authorizationUrl: 'http://evil.example.com/authorize', servers: [oauthServer] } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with OAuth' }));

    await waitFor(() => expect(toastMock.error.mock.calls.length).toBeGreaterThan(1));
    expect(String(toastMock.error.mock.calls[1][0])).toContain('Refusing to redirect to a non-https');
  });

  it('renders a classified failure with its code and hint, and posts the risky-tool opt-in', async () => {
    const failing: Server = {
      id: 'internal',
      name: 'Internal MCP',
      url: 'https://mcp.internal.example.com/mcp',
      enabled: true,
      authMode: 'bearer',
      status: 'error',
      statusCode: 'http_401',
      statusMessage: 'The MCP server rejected the request (HTTP 401).',
      statusHint: 'Add a bearer token for this server, or use OAuth if it does not accept one.',
      allowRiskyTools: false,
      tools: [{ name: 'get_page', risk: 'read' }],
    };

    stubMcp({ servers: [failing], post: { 'set-allow-risky': { servers: [{ ...failing, allowRiskyTools: true }] } } });

    render(element);

    await screen.findByText('Internal MCP');
    expect(screen.getByText(/\[http_401\]/)).toBeTruthy();
    expect(screen.getByText(/Add a bearer token for this server/)).toBeTruthy();
    expect(screen.getByText(/bearer · 1 tool/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(captured.some((call) => call.body.action === 'set-allow-risky')).toBe(true));

    const post = captured.find((call) => call.body.action === 'set-allow-risky');
    expect(post?.body).toEqual({ action: 'set-allow-risky', id: 'internal', allowRiskyTools: true });
  });

  it('reports an OAuth callback failure from the URL and strips the query parameters', async () => {
    window.history.replaceState(
      {},
      '',
      '/?settings=connection&mcp_oauth=error&reason=storage_limit&detail=MCP+OAuth+state+is+too+large+for+secure+cookie+storage.&server=cloudflare-docs',
    );
    stubMcp({ servers: [] });

    render(element);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(String(toastMock.error.mock.calls[0][0])).toContain('storage_limit');
    expect(String(toastMock.error.mock.calls[0][0])).toMatch(/too large/i);
    expect(window.location.search).toBe('');

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('storage_limit');
    expect(banner.textContent).toMatch(/too large/i);
  });

  it('warns when no credential secret exists and removes a server through the API', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      captured.push({ url, method, body });

      if (method === 'GET') {
        return jsonResponse({
          servers: [{ ...oauthServer, status: 'connected', tools: [{ name: 'search', risk: 'read' }] }],
          credentialStorageConfigured: false,
          warnings: ['Bearer tokens cannot be stored without APP_ENCRYPTION_SECRET.'],
        });
      }

      return jsonResponse({ servers: [] });
    });

    render(element);

    await screen.findByText(/No credential secret is configured/);
    expect(screen.getByText(/Bearer tokens cannot be stored without APP_ENCRYPTION_SECRET/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke OAuth' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(captured.some((call) => call.body.action === 'remove')).toBe(true));
    expect(screen.getByText('No MCP servers connected.')).toBeTruthy();
  });
});
