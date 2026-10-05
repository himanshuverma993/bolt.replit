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
    note: 'GitHub’s official remote MCP server (https://api.githubcopilot.com/mcp/). Paste a PAT as the bearer token. Fine-grained: Contents read & write, Metadata read, and Administration read & write to create repos. Classic: repo scope. To load fewer tools, use a toolset URL such as https://api.githubcopilot.com/mcp/x/repos,issues,pull_requests,users,context (see GitHub remote-server docs). OAuth requires a GitHub App registered by this host — PAT is the supported path here.',
  },
  {
    id: 'figma',
    name: 'Figma',
    url: 'https://mcp.figma.com/mcp',
    auth: 'oauth',
    note: 'Figma’s remote MCP server requires the Figma OAuth flow and a plan that includes MCP access.',
  },
];

export function catalogEntryFor(url: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.url === url);
}
