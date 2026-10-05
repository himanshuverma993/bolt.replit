import { describe, expect, it } from 'vitest';
import { MCP_CATALOG, catalogAuthForUrl, catalogEntryFor } from './catalog';

describe('MCP catalog', () => {
  it('points GitHub at the official remote host with PAT-first auth and distinct toolset URLs', () => {
    const github = MCP_CATALOG.find((entry) => entry.id === 'github');
    const githubAll = MCP_CATALOG.find((entry) => entry.id === 'github-all');

    expect(github?.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(github?.auth).toBe('bearer');
    expect(github?.note).toMatch(/Authorization: Bearer/);
    expect(github?.note).toMatch(/mcp\/x\/all/);
    expect(github?.note).toMatch(/Comma-combined path segments are not/);
    expect(github?.note).not.toMatch(/use a toolset URL such as https:\/\/api\.githubcopilot\.com\/mcp\/x\/[^ ]+,/);

    expect(githubAll?.url).toBe('https://api.githubcopilot.com/mcp/x/all');
    expect(githubAll?.auth).toBe('bearer');

    expect(catalogAuthForUrl('https://api.githubcopilot.com/mcp/')).toBe('bearer');
    expect(catalogAuthForUrl('https://api.githubcopilot.com/mcp')).toBe('bearer');
    expect(catalogAuthForUrl('https://api.githubcopilot.com/mcp/x/repos')).toBe('bearer');
    expect(catalogAuthForUrl('https://mcp.cloudflare.com/mcp')).toBe('oauth');
    expect(catalogEntryFor('https://mcp.cloudflare.com/mcp')?.auth).toBe('oauth');
  });
});
