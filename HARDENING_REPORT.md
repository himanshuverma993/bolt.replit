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

`app/lib/.server/github.spec.ts` (25), `app/lib/.server/mcp.spec.ts` (14, rewritten), `app/lib/.server/mcp-oauth.spec.ts` (11),
`app/lib/.server/secrets.spec.ts` (11, new — sealing, signing, cookie policy, redaction, origin checks),
`app/lib/.server/github-route.spec.ts` (11), `app/lib/.server/mcp-route.spec.ts` (11),
`app/lib/settings/export.spec.ts` (3), `app/lib/security/credential-handling.spec.ts` (5),
`app/lib/modules/llm/providers/cloudflare.spec.ts` (6, extended), `app/lib/modules/llm/providers/cloudflare.config.spec.ts` (4),
`app/lib/.server/github.live.spec.ts` (opt-in live suite), `app/lib/.server/mcp-oauth-mock.fixture.ts`
(shared mock authorization server), `app/lib/.server/mcp-oauth-callback-route.spec.ts` (route-level OAuth
callback), `app/lib/modules/llm/providers/cloudflare-tool-loop.spec.ts` (full AI SDK v4 tool loop over the
Workers AI adapter). Total suite: **142 passing, 6 opt-in skips** (see §11 for the second-pass additions).

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
| GitHub App installation token detection | `github.spec.ts` → "detects a GitHub App installation token…" (installation permissions → `repoCreate: not_allowed`), live run in §6.2 |
| GitHub push never loses a commit | `github.spec.ts` → "updates the branch instead of losing the commit when a repository reports size 0 but already has a branch", "writes the first commit when the branch does not exist yet (404 on the ref)" |
| GitHub cookie headers are valid HTTP | `github-route.spec.ts` → "clears every legacy cookie as its own Set-Cookie header when connect fails" |
| Push limits are enforced, not silently applied | `github-route.spec.ts` → "refuses a push with more files than the limit instead of silently dropping them" |
| OAuth redirect cannot reach `window.location` as `javascript:` | `mcp.spec.ts` → "only allows https (or loopback http) authorization URLs to reach the browser" |
| Secure-cookie capacity degrades safely | `mcp-oauth.spec.ts` → "drops the discovery cache instead of failing when the sealed store is too large" |
| Workers AI tool loop keeps call/result association | `cloudflare.spec.ts` → "sends tool results with their tool_call_id…", "omits tool definitions when toolChoice is none" |
| Secret sealing, signing and redaction | `secrets.spec.ts` (round-trip, tamper, wrong key, signed-cookie tamper, cookie policy, `sk-`/`xox`/`AKIA`/`ghp_` redaction, Origin checks) |
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

Live runs of `.github/workflows/live-verification.yml` (GitHub's network, no secrets required):

* **Production** — <https://github.com/himanshuverma993/bolt.replit/actions/runs/37203965671> (all steps green;
  `LIVE_OK` inference, served bundle embeds `b3b6ec4` = `main` tip, `/api/github` 404 because the route
  ships with this PR)
* **The branch preview deployment built by Cloudflare Workers Builds (current head)** —
  <https://github.com/himanshuverma993/bolt.replit/actions/runs/37206510642> (all 11 steps green,
  including the new fail-closed probe and the staleness check reporting
  `live bundle embeds f9aaabd, the current pushed commit`)

Earlier preview runs: <https://github.com/himanshuverma993/bolt.replit/actions/runs/37204483345> (10/10,
first proof that the hardened routes answer on a live deployment) and
<https://github.com/himanshuverma993/bolt.replit/actions/runs/37204091044> (the run that discovered the
preview has no `env.AI` binding and produced the actionable error message quoted below).

| Gate | Result | Evidence |
|---|---|---|
| `GET /` + asset delivery | ✅ 200, `<title>Bolt</title>`, hashed asset 200 | production run, step 3 |
| `GET /api/models` | ✅ 200, Cloudflare provider with both `@cf/...` model ids | production run, step 4 |
| `GET /api/mcp` | ✅ 200 | production run, step 5 |
| `/api/github` status endpoint | ✅ 404 on production (the route is added by this PR) and **✅ 200 on the branch preview** with no token-shaped value in the payload | preview runs, step 6 (404 → documented warning on production) |
| Real Workers AI inference (`env.AI.run`) | ✅ production: `POST /api/chat` → HTTP 200, AI SDK v4 data stream (`0:"..."` frames) whose concatenated text contains `LIVE_OK` | production run, step 7 |
| Clear error when the binding is missing | ✅ the preview deployment (no `env.AI`, see §8.2) returns `Cloudflare Workers AI binding is unavailable. Add [ai] binding = "AI" to wrangler.toml and deploy the Worker with Workers AI enabled.` | preview run, step 7 |
| Credential-shaped values in the chat error path | ✅ none (`sk-…`, `gh[pousr]_…` scan) | both runs, step 8 |
| Credential storage fails closed without a Worker secret | ✅ preview: `POST /api/mcp` with a bearer token → HTTP 501 naming `APP_ENCRYPTION_SECRET`, credential not echoed | preview run, step 9 |
| Deployed bundle == deployed revision | ✅ production serves `b3b6ec4` (= `main` tip); ✅ the branch preview serves the pushed commit (`f9aaabd`) | run step 10 (polls until the preview build finishes) |
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
→ [github-live] login=himanshuverma993 tokenKind=installation scopes=none repoCreate=not_allowed
→ [github-live] repo=himanshuverma993/bolt.replit exists=true push=true admin=true
→ 2 passed | 1 skipped
```

`tokenKind=installation` and `repoCreate=not_allowed` are produced by the deep-audit change that probes
`GET /user/installations`; earlier the same token was reported as `unknown` / `unverified`. The probe
was verified independently with the raw API:

```
GET  /user/installations → installation 155860339 (account himanshuverma993), permissions:
     checks:read issues:read actions:read contents:write metadata:read statuses:read
     workflows:write pull_requests:write repository_hooks:write      (no `administration`)
POST /user/repos         → HTTP 403 {"message":"Resource not accessible by integration"}
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
is the run on the current head of the branch (`9ddfac0`, the deep-audit commit) — every gate exits 0.

Baseline (before changes, commit `b3b6ec4`): install ✅, typecheck ✅, lint ✅, tests 44/44 ✅,
build ✅, `wrangler deploy --dry-run` ✅ (3.84 MiB bundle, 329 assets).

After changes (`/tmp/evidence/gates.log`, runner `/tmp/evidence/run-gates.sh`; exit codes captured
with `set -o pipefail`):

| Gate | Command | Exit | Result |
|---|---|---|---|
| Frozen install | `pnpm install --frozen-lockfile` | 0 | lockfile up to date, 6 s |
| Typecheck | `pnpm run typecheck` (`tsc`) | 0 | clean |
| Lint | `pnpm run lint` (eslint, blitz config) | 0 | clean |
| Tests | `pnpm exec vitest --run` | 0 | **142 passed, 6 skipped, 17 files** (baseline: 44 passed, 6 files) |
| Production build | `pnpm run build` | 0 | client + SSR bundle (`build/server/index.js` 239.31 kB) |
| Worker dry-run | `npx wrangler deploy --dry-run` | 0 | 333 asset files, `Total Upload: 3432.69 KiB / gzip: 682.43 KiB`, bindings **`env.AI → AI`** and `env.ASSETS → Assets` |

The 6 skipped tests are the opt-in live GitHub suite: two read-only verifications (no
`GITHUB_E2E_TOKEN`) and the disposable-repository write flow (no `GITHUB_E2E_ALLOW_WRITES`). The
read-only pair was executed separately against the real API — see §6.2 and §10.
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
8. **Provider API keys are still stored in the JavaScript-readable `apiKeys` cookie** (pre-existing
   bolt.diy architecture: the browser sends them with every chat request). They are excluded from
   settings export and rejected on import (`settings/export.spec.ts`), but any XSS on the deployment
   could read them. Moving provider keys server-side is an architecture change and was out of scope for
   this hardening pass; the sealing/signing primitives needed for it are already in
   `app/lib/.server/secrets.ts`.
9. **Dependency advisories are pre-existing and unchanged.** `pnpm audit --prod` reports 53 advisories
   (2 critical, 18 high, 21 moderate, 12 low) and the dependency set is byte-identical to `main`
   (`git diff main...HEAD -- package.json pnpm-lock.yaml` is empty). The connected ones are
   `sha.js` via `isomorphic-git` (critical), React Router path traversal / XSS advisories in
   `@remix-run/*` 2.15.0 (critical + high), `js-cookie` prototype hijack (high), `jsondiffpatch`
   prototype pollution pulled in by `ai@4.0.18` (high) and `undici` DoS advisories via `remix-utils`
   (high). Fixing them means upgrading Remix / the AI SDK, which this mission explicitly forbids here —
   they need a separate, dedicated dependency PR.
10. **A token refresh that happens inside a chat tool call is not persisted.** A streaming chat response
    cannot set cookies, so `transportAuthProvider` can rotate an access token in memory without writing
    it back; the Settings → Refresh path does persist rotations. Consequence: with an MCP provider that
    rotates refresh tokens on every use, a long chat may need one re-authorization. Tool discovery and
    calls themselves are unaffected.

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
8. **Optional**: the live workflow now also probes that credential storage fails closed (HTTP 501 with an
   actionable hint, credential never echoed) on the branch preview. Once `APP_ENCRYPTION_SECRET` is set
   on production, the same step reports a warning instead of failing, because the expectation changes.

---

## 9. Commits and PR

* Base: `b3b6ec4` — the tip of `main` when this work started. `main` was never pushed to or merged by
  this session.
* Hardening commit: **`37e2df7`** — `fix(security): server-side GitHub auth, MCP OAuth and hardened credentials`
  (application code, tests, `HARDENING_REPORT.md`).
* Deep-audit commit: **`9ddfac0`** (documented in `ba3536d`), follow-up CI commits `86d1be2`, `f9aaabd` — `fix(audit): close cookie-header, push-loss, OAuth-redirect and tool-loop gaps`
  (the findings in §10, plus their tests; see §3 for the files).
* Follow-up commits on the branch are CI-only and touch `.github/workflows/live-verification.yml`
  exclusively: `5369666`, `8103fa9`, `26b5671`, `dcba1eb`, `efc5285`, `cff1d34`, `9f9c040`, `974b5b7`,
  `6abdb6e`, `0c42a4c`.
* Branch: `arena/01a106dd-bolt-replit`
* **PR: <https://github.com/himanshuverma993/bolt.replit/pull/3>**

Both live runs referenced in §6 are attached to this branch: production was probed at the merged `main`
revision and the branch preview at the hardened revision.

---

## 10. Deep audit (second pass)

Everything that was skipped, blocked or assumed in the first pass was re-examined, and the whole change
surface was re-read line by line. This section is the record; the fixes below are in commit `9ddfac0`.

### 10.1 The skipped tests, re-verified

`pnpm exec vitest --run` reports exactly three skips, all inside `app/lib/.server/github.live.spec.ts`:

| Test | Status |
|---|---|
| live GitHub verification — identity/token kind | ✅ **executed** against the real API (`tokenKind=installation`, see §6.2) |
| live GitHub verification — repository permissions | ✅ **executed** against the real API (`exists=true push=true admin=true`) |
| live GitHub push — disposable repository write flow | ⛔ blocked, with hard evidence (below) |

Why the write test cannot run in this environment — verified with the raw API rather than assumed:

```
token         → GitHub App installation token (client id Iv23lifFg4c9eT1T6hLC, installation 155860339,
                expires 2026-10-04 21:16 UTC, permissions listed in §6.2)
POST /user/repos → 403 Resource not accessible by integration   (no `administration` permission)
GET  /user/orgs  → []                                           (no organisation to create in)
```

There is no other credential in the sandbox (`env` holds only `GH_TOKEN`/`GITHUB_TOKEN`, the same
installation token; no `~/.netrc`, no git credential helper, no gh hosts file), and pushing to
`himanshuverma993/bolt.replit` is forbidden as a test. The command that closes this gate remains:

```bash
GITHUB_E2E_TOKEN=<fine-grained PAT with Contents/Administration read+write> \
  GITHUB_E2E_ALLOW_WRITES=1 pnpm exec vitest --run app/lib/.server/github.live.spec.ts
```

### 10.2 Defects found and fixed in this pass

1. **Invalid `Set-Cookie` header on the failed-connect path** (`app/routes/api.github.ts`): several
   cookies were joined with `", "` into one header. Browsers would have kept the legacy
   JS-readable credential cookie. Now one header per cookie; asserted by
   `github-route.spec.ts` → "clears every legacy cookie as its own Set-Cookie header".
2. **A push could be silently lost** (`pushProjectToGitHub`): for a repository that reports `size: 0` but
   already has a branch, the first-commit path swallowed the `422 Reference already exists` conflict and
   returned a commit SHA that was never attached to a ref — every file silently dropped. The
   first-commit helper now reports whether the ref was created and the flow falls back to the normal
   branch-update path; the classifier maps `422 Reference already exists` to `branch_conflict`.
   Two new tests cover both directions (size 0 + existing branch, and 404 on the ref).
3. **GitHub App installation tokens were mislabelled** (`verifyGitHubToken`): they were reported as
   `tokenKind: unknown` / `repoCreate: unverified`, which invites a user to try a flow that GitHub will
   always refuse. `GET /user/installations` now classifies them (`tokenKind: installation`) and
   `repoCreate` is `not_allowed` unless the installation carries `administration: write`. Live-verified
   (§6.2); the Settings UI shows a plain-language label and an actionable hint.
4. **Files beyond the push limit were silently dropped** (`normalizeFiles` used `slice`): now an explicit
   `400` naming the 2000-file limit, plus a 12 MiB `Content-Length` guard returning `413`.
5. **OAuth authorization URL reached `window.location` unchecked**: a hostile MCP server could have
   answered with `javascript:` (script execution in Bolt's origin) or a plain-http URL.
   `assertSafeAuthorizationUrl()` (server) and a second check in `McpConnections.tsx` (client) now allow
   only `https:` — with `http://127.0.0.1|localhost` for local development and tests.
6. **MCP OAuth storage limit could break the whole flow**: the sealed `mcp_oauth` cookie holds every
   server's tokens *and* the discovery cache, and long JWT access tokens plus two servers exceed the
   ~3.5 KB budget. The discovery cache (re-fetched automatically) is now evicted first; tokens survive.
7. **`validateOAuthState`** now compares through the constant-time helper instead of `!==`.
8. **Workers AI tool loop had no call/result association**: tool messages now carry `tool_call_id`
   (the documented Workers AI / OpenAI-compatible field), so a multi-step MCP tool loop can be resolved
   by the model; tool definitions are still omitted when `toolChoice` is `none` (the no-MCP path).
9. **Redaction widened**: bare `sk-…`, `xox…-…` and `AKIA…` shapes are redacted in `redactSecrets()` and
   `getErrorMessage()`, and MCP OAuth discovery errors are redacted before they reach the UI or the log.
10. **Workflow hygiene**: the dispatch input, branch name, `github.token` and `github.sha` are passed
    through `env:` instead of being interpolated into shell scripts, and `base_url` is validated with a
    strict URL character class (removes a shell-injection path for anyone with dispatch rights).
11. **`package.json` `deploy` script** ran `wrangler pages deploy` although this project is a Worker
    (`wrangler.toml` with `main` + `[assets]`); it is now `wrangler deploy`. `start`/`preview` still use
    the legacy Pages dev command and are documented as such.

### 10.3 Checks that came back clean

* **No server code or secret material in the client bundle**: `build/client` contains
  `sealJsonPayload`, `openJsonPayload`, `requireOAuthSecret`, `@octokit/rest` → 0 occurrences; the only
  hits for `APP_ENCRYPTION_SECRET`, `gh_session`, `mcpSecrets`, `mcp_oauth` are UI copy, the
  export deny-list and the `?mcp_oauth=` redirect parameter.
* **No client-side write of a credential**: `git:github.com` / `githubToken` / `githubUsername` appear
  only in the *clearing* path and the deny-lists; `Cookies.set` calls are limited to provider keys and
  UI settings (pre-existing).
* **No placeholders left**: no `TODO`/`FIXME`/`XXX` in the changed scope, and the only skipped tests in
  the repository are the two opt-in live suites listed above.
* **Configuration untouched**: `wrangler.toml` (AI binding, `keep_vars`, intentionally empty
  `[previews]`), `workers/entry.ts` and `worker-configuration.d.ts` are unchanged apart from the secret
  type declarations added earlier.
* **No tracked secrets**: `.env.example` holds empty placeholders only; no `.env`/`.dev.vars` is tracked;
  the full branch diff contains no live credential (only the deliberate `ghp_abcdef…` fixtures in tests).
* **Repo workflows**: no `pull_request_target`, no untrusted `github.event.*` interpolation, and the new
  live-verification workflow uses no secrets at all.
* **CSRF and logging**: every state-changing POST checks `Origin` (`isSameOriginRequest`), and both new
  endpoints log exclusively through `redactSecrets`.
* **Client-side token handling**: the one-off push token lives in a local variable / React state only
  (`Workbench.client.tsx`), and `useGit.ts` keeps clone credentials in a module-level `Map` that is
  never persisted.

### 10.4 Still blocked (unchanged)

Live Cloudflare MCP, live Figma MCP (interactive OAuth + plan), the disposable-repository push
(fine-grained PAT), `wrangler secret put APP_ENCRYPTION_SECRET` (no Cloudflare credentials in this
session) and Phase 5 of the roadmap. Each one is listed with its exact manual step in §8.

## 11. Second verification pass (feature-level, current head)

The follow-up request was to stop at nothing short of "every feature works", with GitHub and Cloudflare
called out by name. Everything that was previously verified only at unit level or not at all was driven one
level closer to the real thing.

### 11.1 New local evidence

| Suite | What it now proves | Result |
| --- | --- | --- |
| `app/lib/modules/llm/providers/cloudflare-tool-loop.spec.ts` (2 tests) | The **real AI SDK v4 `streamText` loop** over the Cloudflare adapter: tool schema sent to Workers AI in the OpenAI shape, the streamed `tool_calls` frame mapped to a v4 tool call, the tool executed, the result returned with its `tool_call_id`, the final text assembled, and `maxSteps` stopping a model that keeps calling tools | 2 passed |
| `app/lib/.server/mcp-oauth-callback-route.spec.ts` (5 tests) | The **real OAuth redirect route**: a forged callback lands on `/?mcp_oauth=error&reason=…` with the pointer cookie cleared and **zero** requests to the authorization server; a missing cookie, an unknown server and an authorization-server `error` are each surfaced verbatim; a genuine PKCE exchange completes, discovers tools with the token, seals the tokens into an HttpOnly cookie and returns them nowhere in the redirect | 5 passed |
| `app/lib/.server/github.live.spec.ts` → `live GitHub route (read-only)` (3 tests, opt-in) | The **real route handlers against the real GitHub API**: `connect` returns a sealed `gh_session` cookie and never echoes the token, `GET /api/github` accepts that cookie, a push attempt with an installation token is classified as `insufficient_permissions` with the actionable hint (GitHub rejected `POST /user/repos` with 403 - nothing was created), and a cross-origin POST is refused before any GitHub call | 3 passed live |
| `app/lib/.server/mcp-oauth-mock.fixture.ts` | The mock MCP resource + authorization server is now shared by the client-level and route-level suites, so both exercise the same protocol implementation | 11 + 5 passed |

Live GitHub route output (real API, read-only):

```
[github-live] login=himanshuverma993 tokenKind=installation scopes=none repoCreate=not_allowed
[github-live] repo=himanshuverma993/bolt.replit exists=true push=true admin=true
POST /user/repos - 403 with id E9A2:3800CF:119DFEA:13524E8:6AC25AE8 in 164ms
[github] insufficient_permissions: GitHub refused the request (HTTP 403): Resource not accessible by integration
```

One environment caveat, verified rather than assumed: a deliberately invalid token still authenticates inside
this sandbox because the network path injects GitHub credentials for `api.github.com`. The invalid-token test
therefore detects that condition and says so instead of passing vacuously
(`[github-live] environment injects GitHub credentials for api.github.com - invalid-token path not exercisable here`);
the 401 → `invalid_token` mapping stays covered by `github.spec.ts` against the mock API.

### 11.2 New live CI steps (`.github/workflows/live-verification.yml`, now 13 steps)

| Step | Runs on | Assertion |
| --- | --- | --- |
| 9. Both Cloudflare model ids answer through the production deployment | production | Both `@cf/meta/llama-3.1-8b-instruct-fp8` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` answer `LIVE_OK` through `/api/chat` with no API key; a failure names the model, the status and the body |
| 10. GitHub endpoint rejects cross-origin, malformed and unauthenticated requests | branch preview | Cross-origin POST → 403, malformed body → 400, `connect` without a Worker secret → 501 naming `APP_ENCRYPTION_SECRET`, the token is never echoed, and `GET /api/github` stays free of credential-shaped values |
| 11. MCP rejects insecure URLs and classifies a real remote server honestly | branch preview | A **public** `http://` URL is refused with 400 before any network call (see the findings below); adding a **real remote MCP server** (`https://docs.mcp.cloudflare.com/mcp`) discovers its tools - it now reports `connected` with 2 tools (`search_cloudflare_documentation`, `migrate_pages_to_workers_guide`). `connected` with zero tools, an unclassified error, or any token material in the response fails the step |
| 12. MCP OAuth callback rejects a forged redirect without contacting the authorization server | branch preview | The forged callback must land on `reason=missing_state_cookie`, must not reflect the attacker's code or any token, and `/api/mcp/oauth/client-metadata` must advertise `token_endpoint_auth_method: none` with the callback redirect URI and no client secret |

The new step found a real gap on its first live run: `POST /api/mcp` accepted
`http://example.com/mcp` (HTTP 200) and only rejected `ftp://`. `validateServerUrl` had allowed plain http
for every host since the upstream code, so a bearer token could be sent in cleartext to a remote server. The
rule is now aligned with the authorization-URL rule: **https is required for remote hosts, http is accepted
only for localhost and private-network addresses** (loopback, `.local`/`.internal`, RFC 1918, IPv6 ULA/link
local), with unit tests for each case. The three preview-only steps now also run *after* the staleness step,
so they probe a preview that has had time to rebuild.

All step bodies were validated structurally (`bash -n` on every `run:` block) and **behaviourally** by running
them against a stubbed `curl` with canned Worker responses: the happy path of each new step exits 0 with its
notice, and each failure variant (cross-origin accepted, model failure, `connected` with no tools,
unclassified MCP error, token material in the body, reflected attacker code, confidential client metadata,
missing callback URI) exits non-zero. The workflow YAML parses with `js-yaml` (13 steps).

### 11.3 How each named feature is verified, level by level

* **GitHub connection** - cookie/AES unit tests (`secrets.spec.ts`, 11) → full push protocol against a mock
  GitHub API (`github.spec.ts`, 25) → route wiring and limits (`github-route.spec.ts`, 11) → **real GitHub API
  through the real routes** (§11.1, 3 live tests) → live deployment probes (§11.2 step 10). The only remaining
  gap is the disposable-repository write flow, which needs a fine-grained PAT (§10.1).
* **Cloudflare connection** - provider contract, streaming, tool calls and `tool_call_id` (`cloudflare.spec.ts`,
  6 + `cloudflare.config.spec.ts`, 4) → **full v4 tool loop** (`cloudflare-tool-loop.spec.ts`, 2) → **real
  inference on the production deployment** (`LIVE_OK`, 8B; §11.2 step 9 adds the 70B fast model). The live tool
  loop with real MCP tools still needs a deployment that has both `env.AI` and a merged branch (§10.4).
* **MCP (authless, bearer, OAuth)** - 14 + 11 + 11 tests, plus the route-level OAuth callback suite (§11.1) and
  the live steps 11 and 12.
* **No-MCP chat** - `toolChoice: 'none'` path asserted in `cloudflare.spec.ts` and the live production chat probe
  (no tools configured).

### 11.5 Production-only defect found by the new live step (MCP + workerd)

The new "real remote MCP server" step first reported:

```
[warning] the remote MCP failure was only classified as unknown :: MCP connection failed: Code generation from strings disallowed for this context
```

That message is *our* bug, not a refusal by the remote server. Reproduced locally in the real runtime
(`npx wrangler dev` with a temporary config that omits the `[ai]` binding, plus a mock MCP server whose tool
publishes an `outputSchema`):

| Runtime | Result |
| --- | --- |
| Node (unit tests) | connected, because Node allows `new Function` |
| workerd, before the fix | `status=error`, `statusCode=unknown`, `MCP connection failed: Code generation from strings disallowed for this context` |
| workerd, after the fix | `status=connected`, `tools=get_page` (risk `read`) |

Root cause: `@modelcontextprotocol/sdk@1.32.0` constructs its `Client` with `AjvJsonSchemaValidator` by
default, and Ajv compiles every JSON Schema with `new Function`. On `tools/list` the client builds a validator
for each tool that has an `outputSchema` (SDK `client/index.js:535`), which workerd refuses. Fix: the SDK ships
a codegen-free validator, so the client is now created with
`CfWorkerJsonSchemaValidator` from `@cfworker/json-schema` (new pinned dependency `4.1.1`); see
`mcpClientOptions()` in `app/lib/.server/mcp.ts` and the unit test that asserts the wiring.

Durable guard: `scripts/ci/workers-runtime-smoke.mjs` boots the built Worker in local workerd, connects it to a
mock MCP server, and asserts `connected` plus the discovered tool. It is wired into `.github/workflows/ci.yaml`
and was proved to have teeth: with the fix removed it exits 1 with
`the Worker could not connect to the mock MCP server: status=error code=unknown message=MCP connection failed: Code generation from strings disallowed for this context`;
with the fix it exits 0 (`status=connected tools=get_page`). Because the unit suite runs on Node, only a
workerd-based check can catch this class of defect. Two CI details were fixed along the way: wrangler 4 requires
Node >= 22 (the repository pins Node 20), so the smoke step installs Node 22 first, and the script now emits
`::error::` annotations so a failure is readable from the check run.

Live confirmation after the fix (run `37210413987`, branch preview at `9199216`):

```
[notice] real remote MCP server connected with 2 discovered tool(s): search_cloudflare_documentation, migrate_pages_to_workers_guide
[notice] both Cloudflare Workers AI model ids answered through the production deployment without an API key
[notice] forged MCP OAuth callback rejected with reason=missing_state_cookie
[notice] GitHub token storage fails closed without a Worker secret (HTTP 501) and the token was not echoed
[notice] live bundle embeds 9199216, the current pushed commit - the deployment is built from that revision
```

The earlier "the remote MCP server refused anonymous access" warning was therefore never a property of
Cloudflare's server: it was this defect failing before the handshake could finish.

### 11.4 Blocked or unverified in this environment (unchanged, now restated)

* The disposable-repository write flow (fine-grained PAT with Contents + Administration) - §10.1 has the
  closing command.
* Live Cloudflare / Figma MCP authorization (interactive browser OAuth, Figma MCP-capable plan).
* A browser run of the UI: there is no browser in the sandbox, so UI interaction (Settings → Connection tabs)
  remains verified by code review, unit tests and HTTP probes rather than by clicking. The *Remix dev server*
  additionally cannot start here because `wrangler.toml` sets `[ai] remote = true`, which needs a
  `CLOUDFLARE_API_TOKEN`. Route-level behaviour **can** be exercised in the real runtime without an account
  (`wrangler dev` with a config that omits `[ai]`, as the new smoke test does), and that is how the MCP connect
  defect above was reproduced and fixed.
* Live Workers AI **tool looping** (needs a deployment that carries both `env.AI` and this branch).
* `wrangler secret put APP_ENCRYPTION_SECRET`, and the 53 pre-existing dependency advisories.

## 12. Third verification pass (current head)

The follow-up instruction was explicit: nothing that was previously skipped is to stay skipped, and the GitHub
and Cloudflare connections get another, deeper pass. This section records only what is new; §1-§11 still stand.

### 12.1 New local evidence

| Suite | What it now pins | Result |
| --- | --- | --- |
| `app/lib/github/client.spec.ts` (8 tests) | The **browser** side of GitHub: every action is a single `POST /api/github` with `content-type: application/json`; a token travels only inside the JSON body (never a query string or header); the 501 "no Worker secret" answer is translated into a message naming `APP_ENCRYPTION_SECRET`; a network failure and a non-JSON body both become typed `GitHubClientError`s instead of `undefined`; the push request carries **no** credential at all (the sealed session does); `purgeLegacyGitHubCookies` expires `githubToken`, `githubUsername` and `git:github.com` with `Path=/` and `SameSite=Lax` | 8 passed |
| `app/lib/.server/github-route-flow.spec.ts` (4 tests) | The **route wiring end to end** with `~/lib/.server/github` mocked: `connect` mints a sealed `gh_session` cookie and reports `connected:true` without echoing the token; the `loader` reads that same cookie back; `push` pushes with the **session** token and ignores a token supplied in the request body; a 403 permission refusal **keeps** the session (the user only needs to widen the token); a 401 `invalid_token` **clears** it; `verify` refreshes `verifiedAt` and re-sets the cookie | 4 passed |
| `app/lib/modules/llm/providers/cloudflare.spec.ts` (6 → 9 tests) | `usage` and `finish_reason` are lifted out of the streamed frames; a stream larger than the 1 MiB safety cap raises an explicit error instead of truncating silently; `max_tokens`, `temperature` and `top_p` reach the binding, and are omitted when the caller did not set them | 9 passed |
| `app/entry.client.tsx` | Legacy GitHub credential cookies are expired on **every** page load (before hydration), not only when the Settings → Connections tab happens to be opened | build + unit gate |

### 12.1b Rendered UI tests (the closest available substitute for a browser)

There is still no browser in this environment (§11.4), so the two connection panels are now rendered for
real with React Testing Library under `happy-dom`. Only `fetch` is stubbed, which means the components run
against the **real** client modules and the assertions cover the DOM a user would see. Two dev-only
dependencies were added for this: `@testing-library/react` 16.3.3 + `@testing-library/dom` 10.4.2 and
`happy-dom` 15.11.7.

| Suite | What it proves | Result |
| --- | --- | --- |
| `app/components/settings/connections/ConnectionsTab.spec.ts` (5 tests) | The GitHub panel as rendered: the missing-secret banner and a disabled Connect button when storage is not configured; Connect sends exactly `{action:'connect', token, repo}` with the token **only in the JSON body**, then renders the verified card (login, installation-token explanation, "repository creation not permitted", repository access, `GitHub authentication: valid`) and removes the token input from the DOM; a 403 renders the server's message **and its hint** and refreshes the status; opening the panel purges the legacy `githubToken`/`git:github.com`/`githubUsername` cookies; Disconnect posts `{action:'disconnect'}` and returns to the form; Verify re-verifies and drops the "stale" marker. In every case `document.cookie` and `document.body.innerHTML` contain no token | 5 passed |
| `app/components/settings/connections/McpConnections.spec.ts` (6 tests) | The MCP panel as rendered: an OAuth-only server shows "Authentication required" plus a **Connect with OAuth** action and never "Connected"; the catalog buttons advertise Cloudflare and Figma as `(OAuth required)` and `Use Cloudflare` fills `https://mcp.cloudflare.com/mcp`; adding that server without a token is classified as auth-required instead of silently connecting, while the bearer token travels only in the JSON body and appears nowhere in the DOM; a `javascript:` **and** a plain-`http` remote authorization URL are both refused by the client; a classified failure keeps its `[http_401]` code, message and hint; the risky-tool checkbox posts `set-allow-risky` with `allowRiskyTools: true`; an OAuth callback result (`?mcp_oauth=error&reason=missing_state_cookie`) is surfaced and stripped from the URL; the missing-credential-secret warning and warnings list render, `Revoke OAuth` only appears for a connected OAuth server, and Remove deletes the server through the API | 6 passed |

### 12.1c Two live-harness fixes and one new live assertion

1. **Unsanctioned write removed from the live GitHub harness.** `app/lib/.server/github.live.spec.ts`
   drives the real `push` route against the real GitHub API to prove the 403 classification. It already
   asserted that an installation token is `not_allowed`, but a *fine-grained* token with Contents +
   Administration write reports `unverified`, which passed that assertion and would then have created a
   repository for real - and the `afterAll` cleanup only runs when `GITHUB_E2E_ALLOW_WRITES=1`. The push
   attempt now requires `repoCreate === 'not_allowed'` (the token provably cannot create repositories);
   any other kind is skipped with a `[github-live]` warning. Re-run after the change:
   `[github-live] login=himanshuverma993 tokenKind=installation scopes=none repoCreate=not_allowed`,
   `5 passed | 1 skipped`, and the 403 `insufficient_permissions` assertion still executed.
2. **Live assertion that an OAuth-only MCP server is never "connected".** The live MCP step now also adds
   Cloudflare's own OAuth-protected server (`https://mcp.cloudflare.com/mcp`) and fails if it is reported
   `connected` without credentials or if the refusal has no classification (`unknown`/missing). The step
   body was executed against canned responses: `auth_required/http_401` -> notice + exit 0,
   `connected` with tools -> exit 2, `error/unknown` -> exit 4, `error` with no code -> exit 4,
   `error/http_403` -> notice + exit 0. All 13 `run:` blocks still pass `bash -n` and the workflow YAML
   still parses (13 steps).

| `app/components/chat/APIKeyManager.spec.ts` (3 tests) | The provider key panel: the Cloudflare provider is rendered as "no API key needed - runs on your Cloudflare account's Workers AI free tier" with no edit affordance; a keyed provider still masks a stored key and saves an edit through `setApiKey`; an unset key is not presented as an error | 3 passed |

### 12.2 Local gates at this head

```
INSTALL_EXIT=0   (install 5s, frozen lockfile)
TYPECHECK_EXIT=0 (tsc 11s)
LINT_EXIT=0      (eslint 2s)
TESTS_EXIT=0     (vitest: 172 passed | 6 skipped, 21 files passed + 1 skipped)
BUILD_EXIT=0     (remix vite:build 29s)
DRYRUN_EXIT=0    (wrangler deploy --dry-run 31s; bindings env.AI, env.ASSETS)
```

### 12.3 Real-world GitHub and Cloudflare cases re-checked in this pass

| Case | Where it is handled | Evidence |
| --- | --- | --- |
| Empty repository (GitHub answers 409 on the ref) | `github.ts` `createInitialCommit` / `classifyGitHubError` → first commit written with no parents | `github.spec.ts` "handles an existing but empty repository (GitHub answers 409 on the ref)" |
| Repository reports `size: 0` but a branch already exists | `{sha, refCreated}` result; the caller takes the update path instead of losing the commit | `github.spec.ts` "updates the branch instead of losing the commit when a repository reports size 0 but already has a branch" |
| Branch moved during a push | 3 attempts, then `branch_conflict` with the actionable hint | `github.spec.ts` "retries when the branch moved while pushing" / "fails with a branch conflict after three attempts" |
| Branch does not exist yet (404 on the ref) | first commit on the default branch | `github.spec.ts` "writes the first commit when the branch does not exist yet (404 on the ref)" |
| Revoked or invalid token | 401 → `invalid_token`, session cookie cleared, no token in the message | `github.spec.ts` + `github-route-flow.spec.ts` |
| Token that can read but cannot push | 403 → `insufficient_permissions` with the update-scope hint, session kept | `github.spec.ts` + `github-route-flow.spec.ts` |
| GitHub App installation token | `tokenKind: installation`, `repoCreate: not_allowed`, VCS import still allowed | `github.spec.ts` + the live route suite (`himanshuverma993`, installation) |
| `env.AI` missing at runtime | `cloudflare.ts` throws *"Cloudflare Workers AI binding is unavailable. Add `[ai] binding = \"AI\"` to wrangler.toml and deploy the Worker with Workers AI enabled."* before any inference is attempted | `cloudflare.spec.ts` |
| Cloudflare model list on the live deployment | `GET /api/models` returns both ids with `provider: "Cloudflare"` and `maxTokenAllowed: 4096`. Note what this endpoint does **and does not** carry: it is a flat `{name,label,provider,maxTokenAllowed}` list, so `requiresApiKey` is not part of it - the keyless behaviour comes from the provider instance (`BaseChat` passes `PROVIDER_LIST`, i.e. the provider objects, to `APIKeyManager`), which is pinned by `app/components/chat/APIKeyManager.spec.ts` and by the live inference step that reaches `env.AI.run` with no key | live probe (fetched just now) + live-verification steps 9/12 |
