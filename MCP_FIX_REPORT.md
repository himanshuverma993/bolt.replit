# MCP cookie storage, GitHub MCP, and Groq — fix report

**Repo:** `himanshuverma993/bolt.replit`
**Branch:** `arena/01a10b89-bolt-replit`
**Date:** 2026-10-05

Official sources used (not guessed):

- Groq models: https://console.groq.com/docs/models
- Groq deprecations: https://console.groq.com/docs/deprecations
- GitHub remote MCP: https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
- GitHub PAT setup: https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server

## Architecture (what changed)

### MCP OAuth storage (Finding A)

Previously every server's OAuth material (access token, refresh token, client info, discovery) was AES-256-GCM sealed into **one** `mcp_oauth` cookie capped at 3500 bytes. Cloudflare access tokens are JWTs (typically 800–2000+ chars). Token exchange succeeded, tools/list returned tools, then `oauthStoreHeaders()` threw `storage_limit` and the app threw the tokens away — UI: "Authentication required, 0 tools".

**Now:**

1. JSON is DEFLATE-compressed then sealed (`v2.` prefix). Legacy `v1.` cookies still open.
2. The sealed payload is sharded across `mcp_oauth`, `mcp_oauth_2`, … (max 8 shards, each ≤ 3500 bytes, under the browser ~4 KiB limit).
3. Discovery metadata is still dropped first if even the sharded budget is exceeded.
4. Tokens stay HttpOnly + Secure + SameSite=Lax. Never in JS-readable cookies, URLs, logs, or chat.

KV/Durable Objects were **not** used: `wrangler.toml` has an empty `[previews]` block, so extra bindings would not exist on branch previews, and a JWT fits in 2–3 compressed shards.

### Tool catalog storage (Finding B)

Previously the full tool list **including JSON Schemas** was stored in `mcpServers`, with a 12 KiB guard — already past the browser's ~4 KiB per-cookie limit. Five realistic GitHub-like tools produced an 8 KiB cookie that browsers drop; 20+ tools threw `oauth_failed` and lost the real message.

**Now:**

1. Cookies store a **compact** catalog: names, short descriptions, risk. Schemas are replaced with `{ type: "object", properties: {} }`.
2. `mcpServers` / `mcpSecrets` are sharded the same way. No cookie value exceeds ~3.5 KiB.
3. If even the compact catalog is too big: drop descriptions, then drop tools (metadata only).
4. `getMcpTools` **rediscovers live schemas** from the MCP server for chat (falls back to the stored catalog if the server is briefly down).
5. API JSON responses still return the full in-memory tool list after add/refresh/OAuth.

### Failure visibility

OAuth callback now redirects to `/?settings=connection&mcp_oauth=error&reason=…&detail=…` (redacted, truncated). Settings opens on the Connection tab. A persistent alert banner shows the real reason/message, not only a toast after the user happens to open the tab.

### Groq (Finding C)

- Removed decommissioned Llama 3.2 preview IDs.
- Static list from Groq's 2026-10-05 production/preview tables: `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, plus enterprise Llama 3.1/3.3 IDs.
- `maxTokenAllowed` is Groq's documented max completion tokens.
- `getModelInstance` honours `providerSettings.baseUrl` (default `https://api.groq.com/openai/v1`). Groq is URL-configurable in Settings → Providers.
- `getDynamicModels` lists live `/models` when a key is present (filters whisper/tts/guard).
- `base-provider.ts` last-branch fallback now reads `manager.env?.[apiTokenKey]`, not `baseUrlKey`.

### GitHub MCP

Catalog chips: `https://api.githubcopilot.com/mcp/` (default) and `https://api.githubcopilot.com/mcp/x/all` as **bearer** (PAT). OAuth for GitHub's remote server requires a GitHub App registered by this host — PAT is the supported path. Toolsets are **distinct** URLs (`/mcp/x/<name>`, `/mcp/x/all`). Comma-combined paths (`/mcp/x/repos,issues`) are not in GitHub's remote-server docs.

## Security preserved

- Tokens never in JS-readable cookies, URLs, logs, or chat.
- Write/destructive MCP tools still require per-server opt-in.
- 10 s timeout, 16 KiB output cap, 3-step tool loop.
- No-MCP chat path unchanged when no servers are enabled.
- OAuth state + PKCE + constant-time state comparison.
- Fail-closed without `APP_ENCRYPTION_SECRET`.
- Settings export rejects `mcp_oauth*` / `mcpSecrets*` / `mcpServers*` keys.

## Tests added

| Test | What it catches |
| --- | --- |
| 1885-char JWT-shaped access token round-trip | Finding A (`storage_limit` on Cloudflare JWTs) |
| 50-tool GitHub-sized catalog persist, each cookie ≤ 4 KiB | Finding B |
| Callback `settings=connection&reason&detail` + UI alert banner | Lost error message |
| Groq static list omits Llama 3.2 previews; honours baseUrl | Finding C |
| `manager.env[apiTokenKey]` fallback | `base-provider.ts` typo |

## Local CI (this branch)

| Command | Result |
| --- | --- |
| `pnpm run test` | 199 passed, 8 skipped |
| `pnpm run typecheck` | pass |
| `pnpm run lint` | pass |
| `pnpm run build` | pass |
| `pnpm exec wrangler deploy --dry-run` | pass |
| `node scripts/ci/workers-runtime-smoke.mjs` | OK (workerd MCP connect + tools/call) |

## GitHub Actions (PR #8)

| Check | Result | Evidence |
| --- | --- | --- |
| Test (Node 20.15.1, run `37296938850`) | fail | CompressionStream cookie sealing needs Node 22 |
| Test (Node 22.16.0, run `37297274120`) | pass | 1m25s, including workerd MCP smoke |
| Validate PR Title | pass | run `37297330468` (subject must not start with uppercase) |
| validate | pass | run `37297274224` |
| live-probe | pass | run `37297268518` (2m1s, all 15 steps) |
| Workers Builds: bolt-replit | pass | preview `arena-01a10b89-bolt-replit` build `6ea17633-4da7-4e89-b653-290892b91f5d` |

`live-verification.yml` probes **Cloudflare** Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), not Groq `llama-3.1-8b-instant`. No Groq live step exists (would need `GROQ_API_KEY`). Groq static catalog already uses `openai/gpt-oss-20b` / `120b` and `qwen/qwen3.8-27b`; Llama 3.1/3.3 stay labeled enterprise.

## Live verification from this sandbox

**Blocked:** TLS to `bolt-replit.biharzone37.workers.dev` and `api.githubcopilot.com` (`SSL_ERROR_SYSCALL` / `ECONNRESET`). GitHub.com API via `gh` works. GitHub Actions `live-probe` above is the live path.
