import { describe, expect, it } from 'vitest';
import {
  EXPORTABLE_COOKIE_KEYS,
  FORBIDDEN_SETTINGS_KEYS,
  assertExportIsCredentialFree,
  buildSettingsExport,
  filterImportedSettings,
} from './export';

/**
 * Regression guard for the leak found in the previous implementation: the
 * settings export used to contain `githubUsername` and `githubToken`.
 */

describe('settings export', () => {
  it('never exports GitHub or MCP credentials', () => {
    const cookies: Record<string, string> = {
      providers: '{"Anthropic":{"settings":{"enabled":true}}}',
      selectedModel: 'claude-3-5-sonnet-latest',
      githubToken: 'ghp_this_must_never_be_exported',
      githubUsername: 'octocat',
      'git:github.com': JSON.stringify({ username: 'ghp_this_must_never_be_exported', password: 'x-oauth-basic' }),
      mcpSecrets: 'sealed-value',
      mcp_oauth: 'sealed-oauth-value',
      apiKeys: '{"Anthropic":"sk-ant-secret"}',
    };

    const exported = buildSettingsExport((name) => cookies[name], 'dark');
    const serialized = JSON.stringify(exported);

    expect(exported.githubToken).toBeUndefined();
    expect(exported.githubUsername).toBeUndefined();
    expect(exported['git:github.com']).toBeUndefined();
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('sk-ant-secret');
    expect(Object.keys(exported).sort()).toEqual([...EXPORTABLE_COOKIE_KEYS, 'bolt_theme'].sort());
    expect(() => assertExportIsCredentialFree(exported)).not.toThrow();
  });

  it('refuses to serialise a payload that still contains a credential', () => {
    expect(() => assertExportIsCredentialFree({ githubToken: 'ghp_abc' })).toThrow(/never exported/);
    expect(() => assertExportIsCredentialFree({ selectedModel: 'ghp_abcdefghijklmnopqrstuvwxyz012345' })).toThrow(
      /looks like a credential/,
    );
  });
});

describe('settings import', () => {
  it('rejects credential-shaped keys and values', () => {
    const result = filterImportedSettings({
      providers: '{"OpenAI":{"settings":{"enabled":true}}}',
      githubToken: 'ghp_should_be_ignored',
      apiKeys: '{"Anthropic":"sk-ant"}',
      mcpSecrets: 'sealed',
      sessionToken: 'abc',
      selectedModel: 'ghp_token_value_that_is_long_enough',
      goodValue: 'plain',
    });

    expect(result.accepted).toEqual({ providers: '{"OpenAI":{"settings":{"enabled":true}}}', goodValue: 'plain' });
    expect(result.rejectedKeys).toEqual(
      expect.arrayContaining(['githubToken', 'apiKeys', 'mcpSecrets', 'sessionToken', 'selectedModel']),
    );

    for (const forbidden of FORBIDDEN_SETTINGS_KEYS) {
      const single = filterImportedSettings({ [forbidden]: 'value' });

      expect(single.rejectedKeys).toContain(forbidden);
    }
  });
});
