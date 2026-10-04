# Hardening report — GitHub, Workers AI and MCP

**Target deployment:** <https://bolt-replit.biharzone37.workers.dev/>
**Base commit:** `b3b6ec4` (`main` — "feat: add Cloudflare Workers AI and MCP support")
**Branch:** `arena/01a106dd-bolt-replit`
**Date:** 2026-10-04

This report is written against evidence: every claim below is tied to a command, a test or an HTTP
probe that was actually executed. Anything that could not be executed is marked **BLOCKED** or
**UNVERIFIED** — nothing is presented as verified that was not.

---

## 1. Architecture summary

```
Browser (Remix SPA)
 ├─ Settings → Connection
 │    ├─ GitHub status/connect/disconnect  ──► POST/GET /api/github   (server-side only)
 │    ├─ MCP server management            ──► POST/GET /api/mcp
 │    └─ Capability panel: shell git probe (WebContainer) + GitHub API push + auth state
 ├─ Workbench "Push to GitHub" ────────────► workbenchStore.pushToGitHub() ──► /api/github {action:"push"}
 └─ Chat ──────────────────────────────────► POST /api/chat ──► streamText() ──► provider + MCP tools

Worker (workers/entry.ts → Remix server build, assets via ASSETS binding)
 ├─ /api/github   Octokit Git Data flow (blobs → tree → commit → ref)
 │      token: AES-256-GCM sealed, HttpOnly `gh_session` cookie (server-side only)
 ├─ /api/mcp      server list (HMAC-signed `mcpServers`), bearer store (sealed `mcpSecrets`)
 ├─ /api/mcp/oauth/{callback,client-metadata}   MCP OAuth (SDK client + sealed `mcp_oauth`)
 ├─ /api/chat     AI SDK v4 streamText, tool loop max 3 steps, MCP tools injected when enabled
 └─ Providers    Cloudflare → env.AI.run (native binding, no API key)
```

### Credential flow (after this change)

| Secret | Where it lives | Browser-readable? | In settings export? |
|---|---|---|---|
| GitHub PAT | AES-256-GCM sealed, `HttpOnly; Secure; SameSite=Lax` `gh_session` cookie | no | no |
| MCP bearer token | AES-256-GCM sealed, `HttpOnly` `mcpSecrets` cookie | no | no |
| MCP OAuth access/refresh tokens, PKCE verifier, client registration | AES-256-GCM sealed, `HttpOnly` `mcp_oauth` cookie | no | no |
| MCP server *configuration* | `mcpServers` cookie, HMAC-signed whenever a Worker secret exists | yes (by design, contains no secret) | no |
| Provider API keys (pre-existing behaviour) | `apiKeys` cookie (unchanged) | yes | no (already filtered) |

`APP_ENCRYPTION_SECRET` (fallbacks: `GITHUB_COOKIE_SECRET`, `MCP_COOKIE_SECRET`) is the Worker secret
that keys all sealing/signing. Without it the credential flows refuse to store anything and say so
explicitly instead of silently falling back to insecure storage.

---

## 2. What was wrong before (verified in code and on the live deployment)

| # | Finding | Evidence |
|---|---|---|
| 1 | The GitHub PAT was written to a JavaScript-readable cookie (`Cookies.set('githubToken', …)`) and also copied into `git:github.com` | `ConnectionsTab.tsx` (`b3b6ec4`), grep in §4 |
| 2 | The settings export included `githubToken` and `githubUsername` | `DataTab.tsx` (`b3b6ec4`) |
| 3 | "Connected" only proved `/user` answered — no repository permission or push capability check | `ConnectionsTab.verifyGitHubCredentials()` |
| 4 | Push ran in the browser with Octokit, so the token lived in client memory and had to come from a cookie | `workbenchStore.pushToGitHub()` (imported `@octokit/rest` client-side) |
| 5 | Empty repositories and missing default branches crashed the push (`git.getRef` 409 / `default_branch === null`) | `workbenchStore.pushToGitHub()` |
| 6 | Branch update conflicts were unhandled (`updateRef` without retry) | same |
| 7 | MCP credentials were stored in a cookie without integrity protection, and the server *configuration* cookie was unsigned — a rewritten URL would have received the stored bearer token | `mcp.ts` (`b3b6ec4`) |
| 8 | MCP had no OAuth support at all: Cloudflare (`https://mcp.cloudflare.com/mcp`) and Figma (`https://mcp.figma.com/mcp`) were offered as if a bearer token were enough, producing the `Error POSTing to endpoint` seen in the screenshots | `McpConnections.tsx` suggestions + `safeMessage()` in `mcp.ts` |
| 9 | MCP errors were a single free-form string; the UI could not distinguish DNS vs TLS vs 401 vs OAuth vs timeout | `safeMessage()` |
| 10 | No risk review for destructive MCP tools | `getMcpTools()` |
| 11 | MCP state cookie was written without `HttpOnly` for the public part and used AES-GCM without signing | `mcpStateHeaders()` |

---

## 3. Files changed and why

### New — server

| File | Why |
|---|---|
| `app/lib/.server/secrets.ts` | One AES-256-GCM sealing + HMAC signing + cookie policy + redaction implementation, used by GitHub and MCP. Encodes the "never store a credential in a JS-readable cookie" rule in one place. |
| `app/lib/.server/github.ts` | Server-side GitHub: session cookie, identity + scopes + repository/permission verification, full push flow (create repo, empty repo, first commit, conflict retry, binary/size limits), stable error taxonomy. |
| `app/routes/api.github.ts` | `GET` status, `POST connect/verify/disconnect/push`. Token never leaves the Worker; legacy cookies are cleared on every response. |
| `app/lib/.server/mcp-oauth.ts` | OAuth client for MCP servers built on the official SDK `auth()` + `OAuthClientProvider`; sealed cookie store for tokens/verifier/client registration/discovery; state validation; revoke/remove. |
| `app/routes/api.mcp.oauth.callback.ts` | OAuth redirect target: state-cookie + sealed-state validation, code exchange, tool re-discovery, redirect back to the app. |
| `app/routes/api.mcp.oauth.client-metadata.ts` | Public OAuth client-metadata document (SEP-991 / RFC 7591) served over https only. |
| `app/lib/github/client.ts` | Typed browser wrapper for `/api/github` + `purgeLegacyGitHubCookies()`. |
| `app/lib/settings/export.ts` | Allow-list settings export, credential-key/value rejection on import, `assertExportIsCredentialFree()`. |
| `app/lib/git/shell-git.client.ts` | Runtime probe for a `git` binary inside the WebContainer (never throws, 5 s timeouts). |
| `app/lib/mcp/catalog.ts` | Known servers (Cloudflare, Figma) with their real auth requirements, used by the UI. |

### Changed

| File | Why |
|---|---|
| `app/lib/.server/mcp.ts` | Signed server configuration; sealed bearer store; OAuth-aware transport; error taxonomy (`dns`, `tls`, `http_401`, `http_403`, `oauth_required`, `invalid_bearer_token`, `unsupported_transport`, `protocol_negotiation_failed`, `tools_list_failed`, `tools_call_failed`, `timeout`, `malformed_response`, …); tool-risk classification with server-side approval gating; audit-safe tool-call logging. Limits unchanged (10 s, 16 KiB, 3 steps, 12 KiB config). |
| `app/routes/api.mcp.ts` | Adds `authorize`, `disconnect-auth`, `set-allow-risky`; returns warnings/flags; same-origin guard; legacy/unsigned state is reported instead of trusted. |
| `app/components/settings/connections/ConnectionsTab.tsx` | Rewritten: no cookie credentials, verified identity + scopes + repository permission display, explicit "shell git / GitHub API push / GitHub authentication" state panel. |
| `app/components/settings/connections/McpConnections.tsx` | Rewritten: OAuth-required state, "Connect with OAuth", risk badges, per-server "allow write tools" opt-in, precise error codes + hints, OAuth result toasts. |
| `app/components/settings/data/DataTab.tsx` | Export/import through the sanitiser; legacy credential cookies purged before export. |
| `app/components/workbench/Workbench.client.tsx` | Push flow uses `/api/github`; typed, actionable error toasts; no cookie reads. |
| `app/lib/stores/workbench.ts` | `pushToGitHub()` delegates to the server route; Octokit and `js-cookie` removed from the client store. |
| `app/lib/hooks/useGit.ts` | Clone credentials are session-memory only; legacy `git:<domain>` cookies are deleted on sight. |
| `worker-configuration.d.ts`, `wrangler.toml` | Typed `APP_ENCRYPTION_SECRET`/`GITHUB_COOKIE_SECRET`/`MCP_COOKIE_SECRET` and documentation. `keep_vars = true`, `[ai]`, `[previews]` and `nodejs_compat` are untouched (guarded by a test). |
| `.github/workflows/live-verification.yml` | Executable live probes (home page, assets, models, MCP, GitHub status, **real Workers AI inference**, credential-echo check) from GitHub's network. |

### Tests added

`app/lib/.server/github.spec.ts` (20), `app/lib/.server/mcp.spec.ts` (13, rewritten), `app/lib/.server/mcp-oauth.spec.ts` (10),
`app/lib/.server/github-route.spec.ts` (9), `app/lib/.server/mcp-route.spec.ts` (11), `app/lib/settings/export.spec.ts` (3),
`app/lib/security/credential-handling.spec.ts` (5), `app/lib/modules/llm/providers/cloudflare.config.spec.ts` (4),
`app/lib/.server/github.live.spec.ts` (opt-in live suite).

The two route-level suites live in `app/lib/.server/` and import `~/routes/api.github` / `~/routes/api.mcp`:
Remix strips server-only exports from modules inside `app/routes/`, so a spec file placed there broke the
production build. The tests exercise the route modules; the files themselves stay out of the route tree.

---

## 4. Security decisions

1. **No credential in JavaScript-readable state.** PATs, MCP bearer tokens and OAuth tokens are sealed
   with AES-256-GCM under a Worker secret and returned only inside `HttpOnly; Secure; SameSite=Lax`
   cookies. `app/lib/security/credential-handling.spec.ts` fails the build if any source file writes a
   credential-shaped cookie again.
2. **Signed MCP configuration.** The public `mcpServers` cookie is HMAC-SHA256 signed whenever a
   secret exists, so a client cannot point a stored credential at another host
   (`app/lib/.server/mcp.spec.ts` → "signs server configuration so a tampered cookie cannot redirect a
   credential"). Unsigned cookies from the previous version are dropped with a visible warning rather
   than trusted.
3. **Refuse rather than degrade.** Without a Worker secret the credential endpoints return
   `not_configured` (HTTP 501) with the exact `wrangler secret put` command; there is no insecure
   fallback.
4. **Least privilege by construction.** The UI asks for fine-grained tokens with
   *Contents read/write* + *Metadata read* (+ *Administration read/write* only when Bolt must create
   repositories) and explains the classic `repo` alternative; verification reports the token kind and
   scopes it actually observed, and repository-level `push` permission when a repository is supplied.
5. **OAuth correctness.** MCP OAuth uses the official SDK client: RFC 9728 protected-resource
   discovery, RFC 8414 authorization-server discovery, dynamic client registration / SEP-991 URL
   client IDs, PKCE S256, refresh-token rotation and `invalidateCredentials` on `invalid_grant`. The
   `state` parameter is validated server-side before the code is exchanged (the SDK does not do this
   on the exchange path). Callback, PKCE verifier and tokens are bound to one server id and one
   browser session.
6. **CSRF.** All state-changing POST endpoints require a same-origin `Origin` when the header is
   present; cookies are `SameSite=Lax`; OAuth flows additionally use the state parameter.
7. **No secrets in logs/URLs/errors.** `redactSecrets()` scrubs bearer headers, `ghp_`/`github_pat_`
   values and token fields; error responses are built from known fields and bounded; tool-call audit
   logs contain only server/tool/risk/outcome/duration.
8. **Destructive-tool gating.** Tools are classified read/write/destructive (conservative default:
   `write`). Anything above `read` is refused server-side until the user opts in per server from
   Settings → Connection; the model cannot bypass it (tests: "refuses destructive tools until the
   server is explicitly opted in").
9. **Transport correctness.** Streamable HTTP only; SSE is never forced; the official endpoints keep
   their real auth model (Cloudflare: OAuth for interactive clients or a scoped API token as bearer;
   Figma: OAuth). Authless operation is not advertised for them.

---

## 5. Test / evidence table

Command: `pnpm exec vitest --run` (Node 22.22.3, pnpm 9.4.0). See §7 for the exact pipeline log.

| Requirement | Test |
|---|---|
| GitHub token never in browser-readable state | `security/credential-handling.spec.ts` (cookie-write scan), `github-route.spec.ts` (session cookie `HttpOnly`/`Secure`), `github.spec.ts` (sealed cookie does not contain the token) |
| GitHub token never in settings export | `settings/export.spec.ts` (export + import + `assertExportIsCredentialFree`) |
| GitHub disconnect clears session state | `github-route.spec.ts` → "clears the session and the legacy cookies on disconnect" |
| GitHub identity + repository permission checks | `github.spec.ts` → identity/scopes/repo permission, read-but-not-push detection, identity mismatch |
| GitHub mocked create/update/push flow | `github.spec.ts` → create repo + first commit, update with parented commit, empty repo (409), conflict retry, 3-attempt failure |
| GitHub API errors and rate limits | `github.spec.ts` → 401/403/404/409/429/network classification, token never in message |
| MCP authless discovery | `mcp.spec.ts`, `mcp-route.spec.ts` |
| MCP bearer discovery | `mcp.spec.ts` (header only), `mcp-route.spec.ts` (sealed, HttpOnly, absent from body) |
| MCP OAuth authorize + callback | `mcp-oauth.spec.ts` (discovery, DCR, PKCE URL, code exchange, state validation) |
| MCP expired-token refresh | `mcp-oauth.spec.ts` → "refreshes an expired access token automatically and recovers" |
| MCP 401/403/error classification | `mcp.spec.ts` → classification suite; `mcp-route.spec.ts` → `oauth_required` state |
| MCP protocol negotiation / malformed / timeout / output limit | `mcp.spec.ts` (DNS, TLS, timeout, network, protocol version, malformed, 16 KiB cap) |
| MCP dangerous-tool approval | `mcp.spec.ts` (risk classification + refusal) |
| MCP-disabled chat path | `mcp.spec.ts` → "returns no tools when MCP is disabled or unavailable" |
| Workers AI missing binding | `cloudflare.spec.ts` → actionable error |
| Workers AI stream / non-stream / tool mapping | `cloudflare.spec.ts` (stub binding through the real AI SDK v4 adapter) |
| Safe provider error output | `get-error-message.spec.ts` + `github.spec.ts` redaction test |
| Worker asset fallback | pre-existing `workers/entry.ts` behaviour; live probes (§6) |
| Existing chat/provider behaviour | full suite green, including `message-parser.spec.ts`, `Markdown.spec.ts`, `diff.spec.ts` |
| Cloudflare/Cloudflare-config invariants | `cloudflare.config.spec.ts` (`[ai]` binding, `keep_vars`, `[previews]`, model ids, no API key required) |

---

## 6. Live verification

Two live runs of `.github/workflows/live-verification.yml` (GitHub's network, no secrets required):

* **Production** — <https://github.com/himanshuverma993/bolt.replit/actions/runs/37203965671> (all steps green)
* **The branch preview deployment built by Cloudflare Workers Builds** —
  <https://github.com/himanshuverma993/bolt.replit/actions/runs/37204483345> (all steps green)

| Gate | Result | Evidence |
|---|---|---|
| `GET /` + asset delivery | ✅ 200, `<title>Bolt</title>`, hashed asset 200 | production run, step 3 |
| `GET /api/models` | ✅ 200, Cloudflare provider with both `@cf/...` model ids | production run, step 4 |
| `GET /api/mcp` | ✅ 200 | production run, step 5 |
| `/api/github` status endpoint | ✅ 404 on production (the route is added by this PR) and **✅ 200 on the branch preview** with no token-shaped value in the payload | preview run, step 6 (404 → documented warning on production) |
| Real Workers AI inference (`env.AI.run`) | ✅ production: `POST /api/chat` → HTTP 200, AI SDK v4 data stream (`0:"..."` frames) whose concatenated text contains `LIVE_OK` | production run, step 7 |
| Clear error when the binding is missing | ✅ the preview deployment (no `env.AI`, see §8.2) returns `Cloudflare Workers AI binding is unavailable. Add [ai] binding = "AI" to wrangler.toml and deploy the Worker with Workers AI enabled.` | preview run, step 7 |
| Credential-shaped values in the chat error path | ✅ none (`sk-…`, `gh[pousr]_…` scan) | both runs, step 8 |
| Deployed bundle == merged revision | ✅ the served entry bundle embeds `b3b6ec4`, the current `main` tip | production run, step 9 |
| GitHub least-privilege connection | ⚠️ partial — read-only verification, §6.2 | `github.live.spec.ts` against the real API |
| GitHub disposable repository create/push/update | ⛔ **BLOCKED** — needs a fine-grained PAT (§6.2, §8.4) | — |
| MCP authless / bearer | ✅ local HTTP mocks | `mcp.spec.ts` + `mcp-route.spec.ts` |
| MCP OAuth (discovery, DCR, PKCE, exchange, refresh) | ✅ local authorization + resource server | `mcp-oauth.spec.ts` |
| Live Cloudflare MCP / Figma MCP after authentication | ⛔ **BLOCKED** — interactive browser login (§8.5) | — |
| No-MCP chat flow | ✅ the live deployment has no MCP servers configured, so the live chat above ran on the no-tool path | production run, step 7 |

### 6.1 Workers AI

Deterministic evidence (this environment cannot reach `*.workers.dev` over TLS — only `api.github.com`
and `registry.npmjs.org` are reachable from the sandbox — and it has no Cloudflare credentials, so the
real inference probe runs from GitHub's network instead):

* `cloudflare.spec.ts` drives the provider through the real AI SDK v4 `LanguageModelV1` contract with a
  stubbed `env.AI` binding: streaming deltas + `finish` usage, non-streaming result, tool-call mapping
  (`finishReason: 'tool-calls'`, JSON-encoded args), `specificationVersion: 'v1'`.
* `cloudflare.config.spec.ts` asserts the `[ai]` binding exists in `wrangler.toml`, that an API key is
  *not* required (`requiresApiKey === false`), and that the two model ids are exactly the verified ones.
* The live workflow (§6.3) POSTs a Cloudflare-model chat request to the deployed Worker, parses the
  AI SDK v4 data stream (text frames are `0:"..."`) and fails the run if no text frame is produced, if
  the concatenated text does not contain the requested `LIVE_OK` token, if the binding is unavailable
  (production) or if the provider asks for an API key. Observed production response:
  `0:"<b"|0:">"|0:" LIVE"|0:"_OK"|0:" </"|0:"b"|0:">"` — i.e. the model really answered through
  `env.AI.run` with no API key. On the branch preview, where the binding is absent by configuration,
  the same request produces the explicit actionable binding error shown in §6.

### 6.2 GitHub

Executed live, read-only (no writes to any repository):

```
NODE_EXTRA_CA_CERTS=… GITHUB_E2E_TOKEN=… GITHUB_E2E_REPO=himanshuverma993/bolt.replit \
  pnpm exec vitest --run app/lib/.server/github.live.spec.ts
→ [github-live] login=himanshuverma993 tokenKind=unknown scopes=none repoCreate=unverified
→ [github-live] repo=himanshuverma993/bolt.replit exists=true push=true admin=true
→ 2 passed | 1 skipped
```

**Where the write test stops and why it is blocked:** the only GitHub credential available inside this
sandbox is a GitHub App installation token. GitHub answers `POST /user/repos` with
`403 Resource not accessible by integration`, i.e. that credential cannot create repositories, and the
mission forbids pushing to the production repository as a test. Therefore:

* `verifyGitHubToken` correctly reported `scopes=none tokenKind=unknown repoCreate=unverified`
  (app/installation tokens expose neither scopes nor fine-grained permissions), and the 403 was mapped
  to `insufficient_permissions` with an actionable hint that now names installation tokens explicitly.
* The complete create → push → update → delete flow is proven against a mock GitHub API
  (`github.spec.ts`, including empty repositories and conflict retries) and remains available as an
  opt-in live test: set `GITHUB_E2E_TOKEN` **and** `GITHUB_E2E_ALLOW_WRITES=1` with a fine-grained PAT
  (Contents read/write, Administration read/write) to run it. It creates `bolt-replit-e2e-*`, pushes,
  updates, verifies the commits and deletes the repository again.

### 6.3 Live workflow

`.github/workflows/live-verification.yml` runs the probes from GitHub's network (no secrets needed) on
every push to `arena/**` and `main`, plus manual dispatch with an optional `base_url`:

1. home page + asset delivery;
2. `/api/models` — the Cloudflare provider must expose both `@cf/...` model ids;
3. `/api/mcp` — the hardened status endpoint;
4. `/api/github` — must not leak token-shaped values (a 404 is tolerated with a warning for deployments
   that predate this PR);
5. **real Workers AI inference through `/api/chat`**, parsed as an AI SDK v4 data stream;
6. the chat error path must not echo a credential-shaped value;
7. the served entry bundle must embed the deployed revision (`b3b6ec4` = current `main` tip on
   production; the pushed revision on a branch preview).

A push to a branch first tries the Cloudflare Workers Builds preview alias for that branch
(`https://<branch-slug>-bolt-replit.biharzone37.workers.dev`) and probes it when it answers; otherwise
it probes the production URL. That is how the hardened branch code was verified live before merge: the
preview run above answers `/api/github` with 200 and shows the new binding error message, while the
production run shows real inference. Because GitHub blocks log downloads for this sandbox, every step
also publishes its result as a check-run annotation, which is where the quoted evidence strings come
from.

---

## 7. Local gate output

Runner: `/tmp/evidence/run-gates.sh`, log: `/tmp/evidence/gates.log` (`pnpm install --frozen-lockfile`,
`pnpm run typecheck`, `pnpm run lint`, `pnpm exec vitest --run`, `pnpm run build`,
`npx wrangler deploy --dry-run`; exit codes captured per step with `set -o pipefail`). The table below
was reproduced at the final commit (`956823f`) with identical results — app code is unchanged since
`37e2df7`, only the live-verification workflow and this report changed afterwards.

Baseline (before changes, commit `b3b6ec4`): install ✅, typecheck ✅, lint ✅, tests 44/44 ✅,
build ✅, `wrangler deploy --dry-run` ✅ (3.84 MiB bundle, 329 assets).

After changes (`/tmp/evidence/gates.log`, runner `/tmp/evidence/run-gates.sh`; exit codes captured
with `set -o pipefail`):

| Gate | Command | Exit | Result |
|---|---|---|---|
| Frozen install | `pnpm install --frozen-lockfile` | 0 | lockfile up to date, 6 s |
| Typecheck | `pnpm run typecheck` (`tsc`) | 0 | clean |
| Lint | `pnpm run lint` (eslint, blitz config) | 0 | clean |
| Tests | `pnpm exec vitest --run` | 0 | **113 passed, 3 skipped, 14 files** (baseline: 44 passed, 6 files) |
| Production build | `pnpm run build` | 0 | client + SSR bundle (`build/server/index.js` 235.49 kB) |
| Worker dry-run | `npx wrangler deploy --dry-run` | 0 | 333 asset files, `Total Upload: 3428.64 KiB / gzip: 681.45 KiB`, bindings **`env.AI → AI`** and `env.ASSETS → Assets` |

The 3 skipped tests are the opt-in live GitHub write suite (`GITHUB_E2E_ALLOW_WRITES` unset).
`Tests closed successfully but something prevents Vite server from exiting` is pre-existing noise:
the baseline commit `b3b6ec4` prints the same message and also exits 0.

---

## 8. Known limitations and manual steps

### Limitations (honest list)

1. **Phase 5 of the mission (plan mode, task queue, checkpoints/rollback, browser preview testing,
   auto test-and-repair, model routing/fallback, deployment rollback, usage metrics, persistent
   project/user identity, D1/R2/secrets-manager integrations, MCP directory + tool scanner) was not
   implemented in this change.** The mission explicitly ordered it *after* the security, GitHub, MCP
   and Workers-AI corrections and warned against implementing the roadmap blindly in one change. What
   this PR does deliver is the foundation those features need (typed server-side credential services,
   audit-safe MCP tool calling, error taxonomy, deterministic test harness).
2. **Storage is cookie-based, not D1/KV.** There is no database binding in this Worker and no
   Cloudflare account access from this session, so per-user credential state is sealed into
   `HttpOnly` cookies with a 30-day lifetime instead of a durable server-side session. The sealing,
   signing and redaction primitives are isolated in `app/lib/.server/secrets.ts`, so moving to
   KV/D1 later is a storage swap rather than a redesign. Consequence: credentials are per-browser,
   not shared across devices, and there is no server-side revocation list beyond GitHub's own.
3. **Fine-grained token creation capability cannot be proven without attempting a create** (GitHub
   does not expose it), so the UI reports `unverified` for such tokens and the push path surfaces the
   precise failure if it is missing.
4. **Tool-approval model is per server**, not per tool-per-invocation confirmation dialog; destructive
   tools are refused until the user opts the server in.
5. **The branch preview deployment runs without the Workers AI binding.** Cloudflare Workers Builds
   deploys branch previews from the (intentionally empty) `[previews]` block of `wrangler.toml`, so the
   preview has no `env.AI` while production does — verified live: the same `/api/chat` request returns
   `LIVE_OK` on production and the explicit binding error on the preview (§6). This is a configuration
   property of the current `wrangler.toml`, not a code path; the AI binding was deliberately **not**
   added to `[previews]` here to preserve the existing intentional configuration.
6. **GitHub Actions job logs cannot be downloaded from this sandbox** (`results-receiver.actions.githubusercontent.com`
   is not reachable), so every workflow step publishes its result and the relevant response excerpts as
   check-run annotations; those annotations are the quoted live evidence in §6.
7. `pnpm exec vitest` prints `close timed out after 10000ms … prevents Vite server from exiting`
   (pre-existing, exit code stays 0) — noise, not a failure.

### Manual steps required from the user

1. **Set the Worker secret** (required before GitHub or MCP credentials can be stored):

   ```bash
   npx wrangler secret put APP_ENCRYPTION_SECRET   # 32+ random characters
   ```

   (`GITHUB_COOKIE_SECRET` / `MCP_COOKIE_SECRET` are accepted fallbacks for existing deployments.)

2. **Revoke and rotate the GitHub token** that appeared in the earlier screenshots if it was a real
   credential. It was written to a JavaScript-readable cookie on the deployment and possibly into an
   exported settings file, so it must be treated as compromised:
   <https://github.com/settings/tokens>. The new code clears those cookies on the next visit, but it
   cannot revoke a token.
3. **Reconnect GitHub** in Settings → Connection with a least-privilege token and (optionally) enter a
   `owner/name` to have repository push permission verified immediately.
4. **Run the opt-in live push test** with a disposable repository to close the one blocked write gate:

   ```bash
   GITHUB_E2E_TOKEN=<fine-grained PAT> GITHUB_E2E_ALLOW_WRITES=1 \
     pnpm exec vitest --run app/lib/.server/github.live.spec.ts
   ```

5. **MCP live gates (Cloudflare, Figma)** need an interactive browser: open the deployment →
   Settings → Connection → *Use Cloudflare* / *Use Figma* → **Add server** → **Connect with OAuth**
   and complete the provider login. Bolt registers its OAuth client dynamically (or via the served
   client-metadata document) and stores the tokens sealed. A Figma plan with MCP access is required
   for the Figma server.
6. **Workers AI**: nothing to configure — the `[ai]` binding is already in `wrangler.toml`, and the live
   workflow proves `env.AI.run` works on the production deployment (branch previews deploy without it,
   see limitation 5).
7. **Optional**: if branch previews should also exercise Workers AI, add an AI binding inside the
   existing `[previews]` block of `wrangler.toml`. This was deliberately left untouched because the
   empty block is part of the current intentional configuration.

---

## 9. Commits and PR

* Base: `b3b6ec4` — the tip of `main` when this work started. `main` was never pushed to or merged by
  this session.
* Hardening commit: **`37e2df7`** — `fix(security): server-side GitHub auth, MCP OAuth and hardened credentials`
  (application code, tests, `HARDENING_REPORT.md`).
* Follow-up commits on the branch are CI-only and touch `.github/workflows/live-verification.yml`
  exclusively: `5369666`, `8103fa9`, `26b5671`, `dcba1eb`, `efc5285`, `cff1d34`, `9f9c040`, `974b5b7`,
  `6abdb6e`, `0c42a4c`.
* Branch: `arena/01a106dd-bolt-replit`
* **PR: <https://github.com/himanshuverma993/bolt.replit/pull/3>**

Both live runs referenced in §6 are attached to this branch: production was probed at the merged `main`
revision and the branch preview at the hardened revision.
