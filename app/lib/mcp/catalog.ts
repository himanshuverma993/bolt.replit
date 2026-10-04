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
