# Workers AI and MCP

## Cloudflare Workers AI

Bolt exposes Cloudflare Workers AI as a first-class provider. It calls the native `env.AI.run` binding; no provider API key is collected or required in the UI.

The registered model IDs are:

- `@cf/meta/llama-3.1-8b-instruct-fp8`
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

The Worker binding is declared in `wrangler.toml`:

```toml
[ai]
binding = "AI"
remote = true
```

`remote = true` is intentional: Cloudflare does not simulate Workers AI locally. A real remote development or deployed test needs an authenticated Wrangler session with access to the AI binding. The application reports an actionable error when `env.AI` is missing instead of silently falling back to another provider.

For a deployed Worker, configure the binding through Wrangler and select the Cloudflare provider/model in the application. Workers AI usage and model availability are subject to the Cloudflare account's current limits and model availability.

## MCP connections

The Connections settings tab supports external MCP servers using the official SDK's Streamable HTTP transport. The v1 scope is:

- authless endpoints;
- bearer-token endpoints, entered in the UI and sent only as a server-side `Authorization: Bearer` header;
- tool discovery with `tools/list`;
- model-selected tool execution with `tools/call`.

OAuth negotiation is not implemented in v1. An OAuth-required server is shown as an actionable connection error rather than being retried with browser credentials. The UI includes suggestions for Cloudflare (`https://mcp.cloudflare.com/mcp`) and Figma (`https://mcp.figma.com/mcp`); any HTTPS or HTTP Streamable HTTP endpoint can be entered manually.

### Configure bearer-token storage

Bearer tokens require a Worker secret. Set it once for the deployment and never put the secret or a provider token in `wrangler.toml`, `.dev.vars`, a URL, logs, tool arguments, or source control:

```bash
wrangler secret put MCP_COOKIE_SECRET
```

Bolt stores MCP server metadata and discovered schemas in a bounded browser cookie. Bearer tokens are stored in a separate encrypted, `HttpOnly` cookie using AES-GCM derived from `MCP_COOKIE_SECRET`. The UI never renders the token after saving it. Removing a server removes its stored token. Authless connections work without `MCP_COOKIE_SECRET`.

### Guardrails and behavior

- Each MCP initialize, discovery, and tool call has a 10-second timeout.
- Tool output is bounded to 16 KiB.
- An enabled MCP tool loop is limited to three model steps.
- MCP tools and automatic tool choice are added only when at least one enabled server has discovered tools. With no enabled MCP server, the existing chat stream options are unchanged.
- Server URLs must be HTTP(S) and cannot contain URL credentials or token-like query parameters.
- MCP calls happen in the Worker, not in the browser, so external endpoints do not receive browser cookies.

### Manual smoke test

1. Set `MCP_COOKIE_SECRET` for the Worker if testing a bearer-token server.
2. Open Settings → Connections → MCP Connections.
3. Select the Cloudflare or Figma suggestion, or enter a Streamable HTTP endpoint and optional bearer token.
4. Confirm the connection status and discovered tools.
5. Disable the connection and send a normal chat prompt; it must not invoke MCP tools.
6. Re-enable it and ask a prompt that requires one discovered tool; verify the tool call and result in the chat stream.
7. Remove the connection and confirm it disappears after a reload.

### Local verification

The deterministic mock-server test exercises Streamable HTTP initialization, discovery, tool execution, oversized output handling, malformed/HTTP failures, encrypted cookie round-tripping, and the no-MCP path:

```bash
corepack pnpm exec vitest --run app/lib/.server/mcp.spec.ts
```

The full project checks are:

```bash
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run test
corepack pnpm run build
corepack pnpm exec wrangler deploy --dry-run
```

A sandbox without Cloudflare authentication cannot perform real Workers AI inference or connect to remote MCP providers. Those remain deployment/manual gates; the local mock test is the reproducible protocol verification.
