/**
 * Known remote MCP servers and their authentication requirements.
 *
 * The UI must not advertise an OAuth-only server as "just works with a bearer
 * token": Cloudflare's official MCP server supports OAuth for interactive
 * clients and scoped API tokens for automation, while Figma's remote MCP server
 * requires its own OAuth flow.
 */

export type McpCatalogAuth = 'authless' | 'bearer' | 'oauth';

export type McpCatalogEntry = {
  id: string;
  name: string;
  url: string;
  auth: McpCatalogAuth;
  note: string;
};

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    url: 'https://mcp.cloudflare.com/mcp',
    auth: 'oauth',
    note: 'Cloudflare’s official MCP server. Interactive clients sign in with OAuth; automation can use a scoped Cloudflare API token as a bearer token.',
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'bearer',
    note: 'GitHub’s official remote MCP server. Paste a PAT as the bearer token (Authorization: Bearer). Fine-grained: Contents read & write, Metadata read, Administration read & write to create repos. Classic: repo scope. Default URL is https://api.githubcopilot.com/mcp/. Toolsets are distinct URLs such as https://api.githubcopilot.com/mcp/x/all, https://api.githubcopilot.com/mcp/x/repos, https://api.githubcopilot.com/mcp/x/issues (append /readonly for read-only). Comma-combined path segments are not in GitHub’s remote-server docs. OAuth requires a GitHub App registered by this host — PAT is the supported path here.',
  },
  {
    id: 'github-all',
    name: 'GitHub (all tools)',
    url: 'https://api.githubcopilot.com/mcp/x/all',
    auth: 'bearer',
    note: 'GitHub remote MCP, all toolsets: https://api.githubcopilot.com/mcp/x/all. Same PAT as the default GitHub chip. Other toolsets are distinct URLs under /mcp/x/<name> (see GitHub remote-server.md).',
  },
  {
    id: 'figma',
    name: 'Figma',
    url: 'https://mcp.figma.com/mcp',
    auth: 'oauth',
    note: 'Figma’s remote MCP server requires the Figma OAuth flow and a plan that includes MCP access.',
  },
];

function urlCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    const withSlash = parsed.pathname.endsWith('/') ? parsed.toString() : `${parsed.toString().replace(/\/?$/, '/')}`;
    const withoutSlash = withSlash.replace(/\/+$/, '') || parsed.origin;

    return [...new Set([url, parsed.toString(), withSlash, withoutSlash])];
  } catch {
    return [url];
  }
}

export function catalogEntryFor(url: string): McpCatalogEntry | undefined {
  const candidates = urlCandidates(url);
  return MCP_CATALOG.find((entry) => candidates.includes(entry.url));
}

/**
 * Auth the UI/server should assume for a URL. GitHub's remote MCP is PAT/bearer
 * on every `/mcp` path (default, `/mcp/x/all`, `/mcp/x/<toolset>`), even when
 * the exact toolset is not a catalog chip.
 */
export function catalogAuthForUrl(url: string): McpCatalogAuth | undefined {
  const entry = catalogEntryFor(url);

  if (entry) {
    return entry.auth;
  }

  try {
    const parsed = new URL(url);

    if (parsed.hostname === 'api.githubcopilot.com' && parsed.pathname.startsWith('/mcp')) {
      return 'bearer';
    }
  } catch {
    return undefined;
  }

  return undefined;
}
