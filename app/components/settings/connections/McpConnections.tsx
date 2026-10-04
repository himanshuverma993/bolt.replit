import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'react-toastify';
import { MCP_CATALOG, type McpCatalogEntry } from '~/lib/mcp/catalog';

type McpToolRisk = 'read' | 'write' | 'destructive';

type McpTool = {
  name: string;
  description?: string;
  risk?: McpToolRisk;
};

type McpServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authMode: 'authless' | 'bearer' | 'oauth';
  status: 'connected' | 'error' | 'auth_required';
  statusMessage?: string;
  statusCode?: string;
  statusHint?: string;
  allowRiskyTools?: boolean;
  tools: McpTool[];
};

type McpAction = 'toggle' | 'remove' | 'refresh' | 'authorize' | 'disconnect-auth' | 'set-allow-risky';

type LoadResult = {
  servers: McpServer[];
  warnings?: string[];
  oauthConfigured?: boolean;
  credentialStorageConfigured?: boolean;
  error?: string;
};

async function readResponse(response: Response): Promise<LoadResult> {
  const body = (await response.json()) as LoadResult & { authorizationUrl?: string };

  if (!response.ok) {
    throw new Error(body.error || `MCP request failed with HTTP ${response.status}`);
  }

  return body;
}

function statusBadge(server: McpServer) {
  if (server.status === 'connected') {
    return { text: 'Connected', className: 'text-xs text-green-500' };
  }

  if (server.status === 'auth_required') {
    return { text: 'Authentication required', className: 'text-xs text-amber-400' };
  }

  return { text: 'Error', className: 'text-xs text-red-500' };
}

function riskBadge(risk: McpToolRisk | undefined) {
  if (risk === 'destructive') {
    return 'text-red-400';
  }

  if (risk === 'write') {
    return 'text-amber-400';
  }

  return 'text-bolt-elements-textSecondary';
}

function oauthResultFromUrl(): { status: 'success' | 'error'; reason?: string; server?: string } | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const params = new URLSearchParams(window.location.search);
  const status = params.get('mcp_oauth');

  if (status !== 'success' && status !== 'error') {
    return undefined;
  }

  return {
    status,
    reason: params.get('reason') ?? undefined,
    server: params.get('server') ?? undefined,
  };
}

export default function McpConnections() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [credentialStorageConfigured, setCredentialStorageConfigured] = useState(true);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const loadServers = async () => {
    try {
      const response = await fetch('/api/mcp');
      const body = await readResponse(response);
      setServers(body.servers || []);
      setWarnings(body.warnings || []);
      setCredentialStorageConfigured(body.credentialStorageConfigured !== false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load MCP servers');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const result = oauthResultFromUrl();

    if (result?.status === 'success') {
      toast.success('MCP OAuth connection completed');
    } else if (result) {
      toast.error(`MCP OAuth failed${result.reason ? `: ${result.reason}` : ''}`);
    }

    if (result) {
      const clean = new URL(window.location.href);
      clean.searchParams.delete('mcp_oauth');
      clean.searchParams.delete('reason');
      clean.searchParams.delete('server');
      window.history.replaceState({}, '', clean.toString());
    }

    loadServers();
  }, []);

  const runAction = async (action: McpAction, server: McpServer, extra: Record<string, unknown> = {}) => {
    try {
      const response = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          id: server.id,
          enabled: action === 'toggle' ? !server.enabled : undefined,
          ...extra,
        }),
      });
      const body = (await readResponse(response)) as LoadResult & { authorizationUrl?: string; status?: string };

      if (body.servers) {
        setServers(body.servers);
      } else {
        await loadServers();
      }

      if (action === 'authorize' && body.authorizationUrl) {
        /*
         * Defence in depth: the server already refuses a non-https (non-loopback)
         * authorization URL, and the browser must not navigate to `javascript:`
         * even if a future code path forgets that check.
         */
        const target = new URL(body.authorizationUrl);
        const loopback = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);

        if (target.protocol !== 'https:' && !loopback) {
          throw new Error('Refusing to redirect to a non-https authorization URL.');
        }

        window.location.href = target.toString();

        return;
      }

      if (action === 'authorize' && body.status === 'authorized') {
        toast.success('MCP authorization completed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'MCP request failed');
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!name.trim() || !url.trim()) {
      toast.error('MCP server name and URL are required');
      return;
    }

    setIsSaving(true);

    try {
      const response = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', name: name.trim(), url: url.trim(), token: token || undefined }),
      });
      const body = (await readResponse(response)) as LoadResult & { server?: McpServer };

      setServers(body.servers || []);
      setWarnings(body.warnings || []);
      setName('');
      setUrl('');
      setToken('');

      const added = body.server;

      if (added?.status === 'connected') {
        toast.success(`Connected to ${added.name}; discovered ${added.tools.length} tool(s)`);
      } else if (added?.status === 'auth_required') {
        toast.info(`${added.name} requires OAuth; use “Connect with OAuth”.`);
      } else {
        toast.error(
          `${added?.statusMessage ?? 'MCP server was saved but could not be connected'}${
            added?.statusHint ? ` ${added.statusHint}` : ''
          }`,
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add MCP server');
    } finally {
      setIsSaving(false);
    }
  };

  const removeServer = async (server: McpServer) => {
    if (!window.confirm(`Remove MCP server “${server.name}”? Stored credentials for it are deleted.`)) {
      return;
    }

    await runAction('remove', server);
  };

  const applyCatalogEntry = (entry: McpCatalogEntry) => {
    setName(entry.name);
    setUrl(entry.url);
  };

  return (
    <div className="p-4 mb-4 border border-bolt-elements-borderColor rounded-lg bg-bolt-elements-background-depth-3">
      <h3 className="text-lg font-medium text-bolt-elements-textPrimary mb-2">MCP Connections</h3>
      <p className="text-sm text-bolt-elements-textSecondary mb-4">
        Connect remote MCP servers over Streamable HTTP. Authless servers work immediately; servers that support a
        static bearer token accept one; OAuth-only servers (Cloudflare, Figma) must complete their OAuth flow before
        they are marked connected. Bolt sends only the arguments of a model-selected tool call; it never uploads project
        files. Write and destructive tools require an explicit per-server opt-in.
      </p>

      {!credentialStorageConfigured && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
          No credential secret is configured, so bearer and OAuth credentials cannot be stored. Set{' '}
          <code>APP_ENCRYPTION_SECRET</code> (or <code>MCP_COOKIE_SECRET</code>) as a Worker secret.
        </div>
      )}

      {warnings.map((warning) => (
        <div
          key={warning}
          className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300"
        >
          {warning}
        </div>
      ))}

      <div className="mb-4 flex flex-wrap gap-2">
        {MCP_CATALOG.map((entry) => (
          <button
            key={entry.id}
            type="button"
            title={entry.note}
            onClick={() => applyCatalogEntry(entry)}
            className="rounded-md border border-bolt-elements-borderColor px-3 py-1 text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
          >
            Use {entry.name}
            <span className="ml-1 text-bolt-elements-textTertiary">
              {entry.auth === 'oauth' ? '(OAuth required)' : entry.auth === 'bearer' ? '(bearer)' : '(authless)'}
            </span>
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="mb-6 space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="MCP server name"
            placeholder="Server name"
            className="w-full rounded-md border border-bolt-elements-borderColor bg-white px-2 py-1.5 text-bolt-elements-textPrimary dark:bg-bolt-elements-background-depth-4"
          />
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label="MCP server Streamable HTTP URL"
            placeholder="https://example.com/mcp"
            className="w-full rounded-md border border-bolt-elements-borderColor bg-white px-2 py-1.5 text-bolt-elements-textPrimary dark:bg-bolt-elements-background-depth-4"
          />
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-label="Optional MCP bearer token"
            autoComplete="off"
            placeholder="Optional bearer token (skip for OAuth servers)"
            className="flex-1 rounded-md border border-bolt-elements-borderColor bg-white px-2 py-1.5 text-bolt-elements-textPrimary dark:bg-bolt-elements-background-depth-4"
          />
          <button
            type="submit"
            disabled={isSaving}
            className="rounded-lg bg-bolt-elements-button-primary-background px-4 py-2 text-bolt-elements-button-primary-text disabled:opacity-50"
          >
            {isSaving ? 'Connecting…' : 'Add server'}
          </button>
        </div>
        <p className="text-xs text-bolt-elements-textTertiary">
          Bearer tokens and OAuth tokens are sealed with AES-256-GCM in HttpOnly cookies and never appear in this list,
          logs, URLs or chat tool arguments.
        </p>
      </form>

      {isLoading ? (
        <p className="text-sm text-bolt-elements-textSecondary">Loading MCP connections…</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-bolt-elements-textSecondary">No MCP servers connected.</p>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => {
            const badge = statusBadge(server);

            return (
              <div key={server.id} className="rounded-md border border-bolt-elements-borderColor p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-bolt-elements-textPrimary">{server.name}</span>
                  <span className={badge.className}>{badge.text}</span>
                  <span className="text-xs text-bolt-elements-textSecondary">
                    {server.authMode} · {server.tools.length} tool{server.tools.length === 1 ? '' : 's'}
                  </span>
                  <div className="ml-auto flex gap-2">
                    {server.status === 'auth_required' && (
                      <button
                        type="button"
                        onClick={() => runAction('authorize', server)}
                        className="text-xs font-medium text-bolt-elements-button-primary-text underline"
                      >
                        Connect with OAuth
                      </button>
                    )}
                    {server.authMode === 'oauth' && server.status === 'connected' && (
                      <button
                        type="button"
                        onClick={() => runAction('disconnect-auth', server)}
                        className="text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                      >
                        Revoke OAuth
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => runAction('toggle', server)}
                      className="text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                    >
                      {server.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => runAction('refresh', server)}
                      className="text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() => removeServer(server)}
                      className="text-xs text-red-500 hover:text-red-400"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <p className="mt-1 break-all text-xs text-bolt-elements-textTertiary">{server.url}</p>
                {server.statusMessage && (
                  <p className="mt-2 text-xs text-red-400">
                    [{server.statusCode ?? 'error'}] {server.statusMessage}
                    {server.statusHint ? ` — ${server.statusHint}` : ''}
                  </p>
                )}
                <label className="mt-2 flex items-center gap-2 text-xs text-bolt-elements-textSecondary">
                  <input
                    type="checkbox"
                    checked={server.allowRiskyTools === true}
                    onChange={(event) =>
                      runAction('set-allow-risky', server, { allowRiskyTools: event.target.checked })
                    }
                  />
                  Allow write and destructive tools on this server (read-only tools always run)
                </label>
                {server.tools.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-bolt-elements-textSecondary">
                      Discovered tools
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      {server.tools.map((tool) => (
                        <li key={tool.name} className="text-xs text-bolt-elements-textSecondary">
                          <span className={riskBadge(tool.risk)}>[{tool.risk ?? 'write'}]</span>{' '}
                          <span className="text-bolt-elements-textPrimary">{tool.name}</span>
                          {tool.description ? ` — ${tool.description}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
