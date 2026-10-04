/**
 * Settings export/import filtering.
 *
 * Rules enforced here (and covered by tests):
 *  - GitHub credentials are never exported. The token now lives server-side in
 *    an HttpOnly cookie, and the legacy `githubToken` / `githubUsername` /
 *    `git:*` cookies are additionally filtered in case a browser still has them.
 *  - Importing a settings file can never create a credential cookie: any
 *    credential-shaped key or value is rejected and reported to the user.
 */

export const EXPORTABLE_COOKIE_KEYS = [
  'providers',
  'isDebugEnabled',
  'isEventLogsEnabled',
  'isLocalModelsEnabled',
  'promptId',
  'isLatestBranch',
  'commitHash',
  'eventLogs',
  'selectedModel',
  'selectedProvider',
] as const;

/** Cookie names that must never leave the browser or be imported. */
export const FORBIDDEN_SETTINGS_KEYS = [
  'githubToken',
  'githubUsername',
  'githubtoken',
  'github_token',
  'gh_session',
  'mcpSecrets',
  'mcp_oauth',
  'mcpSecrets'.toLowerCase(),
  'access_token',
  'refresh_token',
  'apiKeys',
  'authorization',
] as const;

const FORBIDDEN_KEY_PATTERN = /(token|secret|password|credential|api[_-]?key|authorization|cookie|session)/i;

const CREDENTIAL_VALUE_PATTERN =
  /\b(gh[pousr]_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{10,})\b/;

export type SettingsExport = Record<string, string | null>;

export type ExportReader = (name: string) => string | undefined;

export function buildSettingsExport(read: ExportReader, theme: string | null): SettingsExport {
  const payload: SettingsExport = {};

  for (const key of EXPORTABLE_COOKIE_KEYS) {
    payload[key] = read(key) ?? null;
  }

  payload.bolt_theme = theme;

  return payload;
}

export type ImportFilterResult = {
  accepted: Record<string, string>;
  rejectedKeys: string[];
};

/** Filters an imported settings object down to safe, non-credential values. */
export function filterImportedSettings(settings: Record<string, unknown>): ImportFilterResult {
  const accepted: Record<string, string> = {};
  const rejectedKeys: string[] = [];

  for (const [key, value] of Object.entries(settings)) {
    const forbidden =
      FORBIDDEN_KEY_PATTERN.test(key) ||
      (FORBIDDEN_SETTINGS_KEYS as readonly string[]).some((name) => name.toLowerCase() === key.toLowerCase());

    if (forbidden) {
      rejectedKeys.push(key);
      continue;
    }

    if (typeof value === 'string' && CREDENTIAL_VALUE_PATTERN.test(value)) {
      rejectedKeys.push(key);
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      accepted[key] = String(value);
    }
  }

  return { accepted, rejectedKeys };
}

/** Defence in depth for the download path: nothing credential-shaped can be serialised. */
export function assertExportIsCredentialFree(payload: SettingsExport): void {
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new Error(`Refusing to export "${key}": credential-shaped settings are never exported.`);
    }

    if (typeof value === 'string' && CREDENTIAL_VALUE_PATTERN.test(value)) {
      throw new Error(`Refusing to export "${key}": the value looks like a credential.`);
    }
  }
}
