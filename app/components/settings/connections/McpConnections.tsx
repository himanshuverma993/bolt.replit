import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'react-toastify';

type McpTool = {
  name: string;
  description?: string;
};

type McpServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: 'connected' | 'error';
  statusMessage?: string;
  tools: McpTool[];
};

type McpAction = 'toggle' | 'remove' | 'refresh';

const suggestions = [
  { name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp' },
  { name: 'Figma', url: 'https://mcp.figma.com/mcp' },
];

async function readResponse(response: Response): Promise<{ servers?: McpServer[]; error?: string }> {
  const body = (await response.json()) as { servers?: McpServer[]; error?: string };

  if (!response.ok) {
    throw new Error(body.error || `MCP request failed with HTTP ${response.status}`);
  }

  return body;
}

export default function McpConnections() {
  const [servers, setServers] = useState<McpServer[]>([]);
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load MCP servers');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  const runAction = async (action: McpAction, server: McpServer) => {
    try {
      const response = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: server.id, enabled: action === 'toggle' ? !server.enabled : undefined }),
      });
      const body = await readResponse(response);
      setServers(body.servers || []);
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
      const body = await readResponse(response);
      setServers(body.servers || []);
      setName('');
      setUrl('');
      setToken('');

      const added = body.servers?.[body.servers.length - 1];

      if (added?.status === 'connected') {
        toast.success(`Connected to ${added.name}; discovered ${added.tools.length} tool(s)`);
      } else {
        toast.error(added?.statusMessage || 'MCP server was saved but could not be connected');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add MCP server');
    } finally {
      setIsSaving(false);
    }
  };

  const removeServer = async (server: McpServer) => {
    if (!window.confirm(`Remove MCP server “${server.name}”?`)) {
      return;
    }

    await runAction('remove', server);
  };

  return (
    <div className="p-4 mb-4 border border-bolt-elements-borderColor rounded-lg bg-bolt-elements-background-depth-3">
      <h3 className="text-lg font-medium text-bolt-elements-textPrimary mb-2">MCP Connections</h3>
      <p className="text-sm text-bolt-elements-textSecondary mb-4">
        Connect authless or bearer-token MCP servers. Bolt sends only the arguments for a model-selected tool call; it
        does not upload project files. Browser OAuth is not included in v1.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.url}
            type="button"
            onClick={() => {
              setName(suggestion.name);
              setUrl(suggestion.url);
            }}
            className="rounded-md border border-bolt-elements-borderColor px-3 py-1 text-xs text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
          >
            Use {suggestion.name}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="MCP server name"
            className="w-full bg-white dark:bg-bolt-elements-background-depth-4 px-2 py-1.5 rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary"
          />
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label="MCP server Streamable HTTP URL"
            className="w-full bg-white dark:bg-bolt-elements-background-depth-4 px-2 py-1.5 rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary"
          />
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-label="Optional MCP bearer token"
            autoComplete="off"
            className="flex-1 bg-white dark:bg-bolt-elements-background-depth-4 px-2 py-1.5 rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary"
          />
          <button
            type="submit"
            disabled={isSaving}
            className="bg-bolt-elements-button-primary-background rounded-lg px-4 py-2 text-bolt-elements-button-primary-text disabled:opacity-50"
          >
            {isSaving ? 'Connecting...' : 'Add server'}
          </button>
        </div>
        <p className="text-xs text-bolt-elements-textTertiary">
          Bearer tokens require the Worker secret <code>MCP_COOKIE_SECRET</code>. Tokens are never shown in this list,
          logs, URLs, or chat tool arguments.
        </p>
      </form>

      {isLoading ? (
        <p className="text-sm text-bolt-elements-textSecondary">Loading MCP connections...</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-bolt-elements-textSecondary">No MCP servers connected.</p>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <div key={server.id} className="rounded-md border border-bolt-elements-borderColor p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-bolt-elements-textPrimary">{server.name}</span>
                <span className={server.status === 'connected' ? 'text-xs text-green-500' : 'text-xs text-red-500'}>
                  {server.status === 'connected' ? 'Connected' : 'Error'}
                </span>
                <span className="text-xs text-bolt-elements-textSecondary">
                  {server.tools.length} tool{server.tools.length === 1 ? '' : 's'}
                </span>
                <div className="ml-auto flex gap-2">
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
              <p className="text-xs text-bolt-elements-textTertiary mt-1 break-all">{server.url}</p>
              {server.statusMessage && <p className="text-xs text-red-400 mt-2">{server.statusMessage}</p>}
              {server.tools.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-bolt-elements-textSecondary">
                    Discovered tools
                  </summary>
                  <ul className="mt-2 space-y-1 pl-4 list-disc">
                    {server.tools.map((tool) => (
                      <li key={tool.name} className="text-xs text-bolt-elements-textSecondary">
                        <span className="text-bolt-elements-textPrimary">{tool.name}</span>
                        {tool.description ? ` — ${tool.description}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
