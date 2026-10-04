import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repository guard for the credential leak that shipped in the previous
 * implementation:
 *
 *  - the GitHub token was written to a JavaScript-readable cookie
 *    (`githubToken`, `githubUsername`, `git:github.com`);
 *  - the settings export contained it;
 *  - Octokit ran in the browser, so the token existed in client memory/state.
 *
 * These tests fail if any of that comes back.
 */

const APP_ROOT = join(process.cwd(), 'app');
const CREDENTIAL_COOKIE_NAMES = ['githubToken', 'githubUsername', 'git:github.com', 'mcpSecrets', 'mcp_oauth'];

function walk(directory: string): string[] {
  const entries: string[] = [];

  for (const name of readdirSync(directory)) {
    const fullPath = join(directory, name);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      entries.push(...walk(fullPath));
    } else if (/\.(ts|tsx)$/.test(name)) {
      entries.push(fullPath);
    }
  }

  return entries;
}

function sourceFiles(): Array<{ path: string; content: string }> {
  return walk(APP_ROOT)
    .filter((path) => !path.endsWith('.spec.ts'))
    .map((path) => ({ path: path.replace(`${process.cwd()}/`, ''), content: readFileSync(path, 'utf8') }));
}

function cookieWrites(content: string): string[] {
  const writes: string[] = [];

  for (const match of content.matchAll(/Cookies\.set\(\s*(['"`])([^'"`]+)\1/g)) {
    writes.push(match[2]);
  }

  for (const match of content.matchAll(/document\.cookie\s*=\s*(['"`])([^'"`]+)\1/g)) {
    if (!match[2].includes('Max-Age=0')) {
      writes.push(match[2].split('=')[0]);
    }
  }

  return writes;
}

describe('credential handling policy', () => {
  it('never writes a credential cookie from any app code', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      for (const name of cookieWrites(file.content)) {
        if (CREDENTIAL_COOKIE_NAMES.some((credential) => name.startsWith(credential))) {
          offenders.push(`${file.path}: ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps Octokit out of browser code', () => {
    const browserFiles = sourceFiles().filter(
      (file) => file.path.includes('/components/') || file.path.includes('/stores/'),
    );

    for (const file of browserFiles) {
      expect(file.content).not.toMatch(/from '@octokit\/rest'/);
    }
  });

  it('exports GitHub settings without the token field', () => {
    const dataTab = sourceFiles().find((file) => file.path.endsWith('settings/data/DataTab.tsx'));

    expect(dataTab).toBeDefined();
    expect(dataTab!.content).not.toContain('githubToken: Cookies.get(');
    expect(dataTab!.content).toContain('buildSettingsExport');
  });

  it('keeps the server-side GitHub module as the only Octokit entry point', () => {
    const octokitUsers = sourceFiles().filter((file) => file.content.includes("from '@octokit/rest'"));

    expect(octokitUsers.map((file) => file.path)).toEqual(['app/lib/.server/github.ts']);
  });

  it('never logs a bare token value', () => {
    for (const file of sourceFiles()) {
      expect(file.content).not.toMatch(/console\.(log|error|warn)\([^)]*\btoken\b\s*[,)]/i);
    }
  });
});
