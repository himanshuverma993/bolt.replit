#!/usr/bin/env node
/**
 * Workers-runtime smoke test (workerd, no Cloudflare account required).
 *
 * The unit suite runs on Node, where `new Function`/`eval` are allowed. Cloudflare
 * Workers forbid dynamic code generation, so a dependency that compiles JSON
 * Schemas with Ajv fails *only* in the deployed runtime - exactly how the MCP
 * client used to break ("Code generation from strings disallowed for this
 * context") whenever a remote server published an `outputSchema`.
 *
 * This script starts the real Worker with `wrangler dev` (local workerd), starts a
 * mock MCP server whose tool carries an `outputSchema`, and asserts that adding
 * the server through `POST /api/mcp` ends up `connected` with the tool
 * discovered. It exits non-zero if the Worker cannot complete the flow.
 *
 * Usage: node scripts/ci/workers-runtime-smoke.mjs   (run `pnpm run build` first)
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../../', import.meta.url).pathname);
const STARTUP_TIMEOUT_MS = 180_000;

function log(message) {
  console.log(`[smoke] ${message}`);
}

async function pickPort() {
  const server = createServer();

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));

  return port;
}

const SECURE_BEARER_TOKEN = 'smoke-bearer-token-value';

/*
 * `wrangler dev` answers a gzip-negotiated streaming response with an empty body
 * (curl, which does not ask for gzip, receives the real 140-byte payload), so the
 * smoke requests ask for the identity encoding to assert the actual bytes.
 */
const IDENTITY_HEADERS = { 'Accept-Encoding': 'identity' };

const mcpToolCalls = [];

function startMockMcpServer(port) {
  const server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) {
      body += chunk;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const secure = url.pathname === '/mcp-secure';
    const reply = (payload) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(payload));
    };

    /*
     * `/mcp-secure` accepts a bearer token only. It proves that the token the
     * Worker sealed into its credential cookie really travelled, and that the
     * AES-GCM seal/open round trip works inside workerd (WebCrypto), not just on
     * Node in the unit suite.
     */
    if (secure && (request.headers.authorization ?? '') !== `Bearer ${SECURE_BEARER_TOKEN}`) {
      response.statusCode = 401;
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('WWW-Authenticate', 'Bearer realm="smoke"');
      response.end(JSON.stringify({ error: 'unauthorized' }));

      return;
    }

    const message = body ? JSON.parse(body) : {};

    if (message.method === 'initialize') {
      return reply({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'smoke-mock', version: '1.0.0' },
        },
      });
    }

    if (message.method === 'tools/list') {
      return reply({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: secure ? 'get_secure_page' : 'get_page',
              description: 'Read a page',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
              // An outputSchema is what makes the SDK build a JSON Schema
              // validator - the exact path that used to require Ajv codegen.
              outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
            },
            {
              name: 'delete_page',
              description: 'Delete a page permanently',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            },
          ],
        },
      });
    }

    if (message.method === 'tools/call') {
      mcpToolCalls.push(String(message.params?.name ?? 'unnamed'));

      return reply({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `page-content-for:${message.params?.arguments?.id ?? 'none'}` }] },
      });
    }

    return reply({ jsonrpc: '2.0', id: message.id, result: {} });
  });

  return new Promise((resolveServer) => server.listen(port, '127.0.0.1', () => resolveServer(server)));
}

function startHarnessWorker(port, inspectorPort) {
  const configDir = mkdtempSync(join(tmpdir(), 'bolt-harness-'));
  const configPath = join(configDir, 'wrangler.harness.toml');
  const config = [
    'name = "bolt-mcp-tool-call-harness"',
    `dev = { inspector_port = ${inspectorPort} }`,
    `main = ${JSON.stringify(join(repoRoot, 'scripts/ci/mcp-tool-call-harness.ts'))}`,
    'compatibility_date = "2024-11-27"',
    'compatibility_flags = ["nodejs_compat"]',
    '',
    '[vars]',
    'APP_ENCRYPTION_SECRET = "smoke-test-secret-32-characters!!"',
  ].join('\n');
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      baseUrl: '.',
      // The harness imports the app module through the app's alias, exactly like
      // the Remix build does.
      paths: { '~/*': [join(repoRoot, 'app/*')] },
    },
    include: [join(repoRoot, 'scripts/ci/mcp-tool-call-harness.ts')],
  };

  writeFileSync(configPath, config);
  writeFileSync(join(configDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  log(`spawning the MCP tool-call harness: pnpm exec wrangler dev -c <tmp>/wrangler.harness.toml --port ${port}`);

  const child = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '-c',
      configPath,
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--ip',
      '127.0.0.1',
    ],
    // cwd stays at the repo so `pnpm exec` uses the project's own wrangler; the
    // config and its tsconfig live in the temp directory.
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = [];

  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  child.on('error', (error) => output.push(`spawn error: ${error.message}\n`));

  return { child, output };
}

function startWorker(port, mcpPort, inspectorPort) {
  const configDir = mkdtempSync(join(tmpdir(), 'bolt-smoke-'));
  const configPath = join(configDir, 'wrangler.smoke.toml');
  const config = [
    'name = "bolt-replit-smoke"',
    `main = ${JSON.stringify(join(repoRoot, 'workers/entry.ts'))}`,
    'compatibility_date = "2024-11-27"',
    'compatibility_flags = ["nodejs_compat"]',
    '',
    '[assets]',
    `directory = ${JSON.stringify(join(repoRoot, 'build/client'))}`,
    'binding = "ASSETS"',
    '',
    '[vars]',
    'APP_ENCRYPTION_SECRET = "smoke-test-secret-32-characters!!"',
    // No [ai] binding on purpose: the MCP flow must not depend on Workers AI,
    // and omitting it keeps `wrangler dev` fully local (no Cloudflare account).
  ].join('\n');

  writeFileSync(configPath, config);
  log(`mock MCP server on http://127.0.0.1:${mcpPort}/mcp`);
  log(`node ${process.version}, CI=${process.env.CI ?? 'unset'}`);
  log(`spawning: pnpm exec wrangler dev -c <tmp>/wrangler.smoke.toml --port ${port} --ip 127.0.0.1`);

  const child = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '-c',
      configPath,
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--ip',
      '127.0.0.1',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = [];

  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  child.on('error', (error) => output.push(`spawn error: ${error.message}\n`));

  return { child, output, configDir };
}

async function waitForWorker(base, child, output) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (code ${child.exitCode}):\n${output.join('').slice(-2000)}`);
    }

    try {
      const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });

      if (response.status === 200) {
        return;
      }
    } catch {
      // not ready yet
    }

    await new Promise((done) => setTimeout(done, 2000));
  }

  throw new Error(
    `the Worker did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s:\n${output.join('').slice(-2000)}`,
  );
}

async function main() {
  const workerPort = await pickPort();
  const mcpPort = await pickPort();
  const harnessPort = await pickPort();
  const inspectorPort = await pickPort();
  const harnessInspectorPort = await pickPort();
  const mcpServer = await startMockMcpServer(mcpPort);
  const { child, output, configDir } = startWorker(workerPort, mcpPort, inspectorPort);
  const harness = startHarnessWorker(harnessPort, harnessInspectorPort);
  const base = `http://127.0.0.1:${workerPort}`;
  const harnessBase = `http://127.0.0.1:${harnessPort}`;
  const failures = [];
  let cookieHeader = '';

  const fail = (message) => {
    failures.push(message);
    log(`FAIL: ${message}`);
  };

  try {
    await waitForWorker(base, child, output);
    log('Worker is serving requests');

    // 1. Authless MCP connect in workerd - the Ajv codegen regression guard.
    const response = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...IDENTITY_HEADERS },
      body: JSON.stringify({ action: 'add', name: 'smoke-mock', url: `http://127.0.0.1:${mcpPort}/mcp` }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    const server = body.server ?? {};
    const tools = Array.isArray(server.tools) ? server.tools.map((tool) => tool.name) : [];

    log(`POST /api/mcp (add) -> ${response.status} status=${server.status} code=${server.statusCode ?? 'none'}`);
    log(`tools: ${tools.join(', ') || 'none'}`);

    const authlessCookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);

    if (response.status !== 200) {
      fail(`expected HTTP 200 from /api/mcp, received ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    } else if (server.status !== 'connected') {
      fail(
        `the Worker could not connect to the mock MCP server: status=${server.status} code=${server.statusCode} message=${server.statusMessage}`,
      );
    } else if (!tools.includes('get_page')) {
      fail(`the mock tool was not discovered: ${JSON.stringify(server).slice(0, 300)}`);
    } else {
      log(`MCP connect inside workerd works: status=connected tools=${tools.join(',')}`);
    }

    /*
     * 2. Bearer MCP server: the token must be sealed into an HttpOnly cookie in
     * workerd (AES-GCM via WebCrypto) and never echoed, then read back through
     * GET /api/mcp. `/mcp-secure` answers 401 unless the token really arrived.
     */
    const secureResponse = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        ...(authlessCookies.length ? { Cookie: authlessCookies.join('; ') } : {}),
        ...IDENTITY_HEADERS,
      },
      body: JSON.stringify({
        action: 'add',
        name: 'smoke-secure',
        url: `http://127.0.0.1:${mcpPort}/mcp-secure`,
        token: SECURE_BEARER_TOKEN,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const secureBody = await secureResponse.json();
    const secureServer = secureBody.server ?? {};
    const secureTools = Array.isArray(secureServer.tools) ? secureServer.tools.map((tool) => tool.name) : [];
    const cookies = secureResponse.headers.getSetCookie();
    const credentialCookie = cookies.find((cookie) => cookie.startsWith('mcpSecrets='));
    cookieHeader = cookies.map((value) => value.split(';')[0]).join('; ');

    log(
      `POST /api/mcp (bearer) -> ${secureResponse.status} status=${secureServer.status} code=${secureServer.statusCode ?? 'none'}`,
    );
    log(`bearer tools: ${secureTools.join(', ') || 'none'}`);

    if (secureResponse.status !== 200) {
      fail(`adding a bearer MCP server returned HTTP ${secureResponse.status}`);
    } else if (secureServer.status !== 'connected') {
      fail(
        `the bearer server did not connect: status=${secureServer.status} code=${secureServer.statusCode} message=${secureServer.statusMessage}`,
      );
    } else if (!secureTools.includes('get_secure_page')) {
      fail('the bearer-protected tool was not discovered (the token did not reach the server)');
    } else if (JSON.stringify(secureBody).includes(SECURE_BEARER_TOKEN)) {
      fail('the MCP add response echoed the bearer token');
    } else if (!credentialCookie || !/HttpOnly/i.test(credentialCookie)) {
      fail(`no HttpOnly credential cookie was set: ${cookies.map((cookie) => cookie.split('=')[0]).join(', ') || 'none'}`);
    } else if (credentialCookie.includes(SECURE_BEARER_TOKEN)) {
      fail('the credential cookie contains the raw bearer token instead of a sealed value');
    }

    if (failures.length === 0) {
      const listResponse = await fetch(`${base}/api/mcp`, {
        headers: { Cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; '), ...IDENTITY_HEADERS },
        signal: AbortSignal.timeout(30_000),
      });
      const listText = await listResponse.text();

      if (listResponse.status !== 200) {
        fail(`GET /api/mcp with the sealed credential cookie returned HTTP ${listResponse.status}`);
      } else if (!listText.includes('smoke-secure')) {
        fail('the bearer server could not be read back from the sealed cookie (seal/open round trip failed)');
      } else if (listText.includes(SECURE_BEARER_TOKEN)) {
        fail('GET /api/mcp echoed the bearer token');
      } else {
        log('credential seal/open inside workerd works: the cookie was accepted and the token stayed sealed');
      }
    }

    /*
     * 3. GitHub session handling in the real runtime: an unreadable sealed cookie
     * must be reported as such instead of crashing or pretending to be connected.
     */
    const githubResponse = await fetch(`${base}/api/github`, {
      headers: { Cookie: 'gh_session=v1.not-a-real-sealed-value', ...IDENTITY_HEADERS },
      signal: AbortSignal.timeout(30_000),
    });
    const githubBody = await githubResponse.json();

    log(`GET /api/github (unreadable session) -> ${githubResponse.status} reason=${githubBody.reason ?? 'none'}`);

    if (githubResponse.status !== 200) {
      fail(`GET /api/github returned HTTP ${githubResponse.status} for an unreadable session`);
    } else if (githubBody.connected !== false || githubBody.reason !== 'unreadable') {
      fail(`an unreadable GitHub session was not flagged: ${JSON.stringify(githubBody).slice(0, 200)}`);
    } else {
      log('GitHub session handling inside workerd works: unreadable cookie -> connected=false reason=unreadable');
    }

    /*
     * 4. The Cloudflare provider without the Workers AI binding: the smoke config
     * deliberately omits `[ai]`, so the user-facing error must be explicit and
     * actionable instead of a crash or an API-key demand.
     */
    const chatResponse = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...IDENTITY_HEADERS },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: '[Model: @cf/meta/llama-3.1-8b-instruct-fp8]\n\n[Provider: Cloudflare]\n\nSay hi',
          },
        ],
        files: {},
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const chatText = await chatResponse.text();

    log(`POST /api/chat (Cloudflare, no [ai] binding) -> ${chatResponse.status} bytes=${chatText.length}`);

    if (!/binding is unavailable/i.test(chatText)) {
      fail(`the missing Workers AI binding did not produce the explicit error: ${chatText.slice(0, 300)}`);
    } else if (!/\[ai\] binding/i.test(chatText) || !/Workers AI/i.test(chatText)) {
      fail(`the missing-binding error is not actionable: ${chatText.slice(0, 300)}`);
    } else if (/API key/i.test(chatText)) {
      fail('the Cloudflare provider asked for an API key on the env.AI path');
    } else {
      log('missing Workers AI binding produces an explicit, actionable error inside workerd');
    }
    /*
     * 5. A real MCP tools/call, executed in the Worker: the harness calls the
     * tool object `getMcpTools()` built (the same object the chat route hands to
     * the AI SDK), with the sealed cookie produced above - so cookie decryption
     * across Workers and the tools/call path are both exercised, which the chat
     * route cannot reach without an [ai] binding.
     */
    if (cookieHeader.length === 0) {
      fail('no sealed MCP credential cookie was captured, so the tool-call checks cannot run');
    } else {
      await waitForWorker(harnessBase, harness.child, harness.output);

      const harnessResponse = await fetch(harnessBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mcp-cookie': cookieHeader, ...IDENTITY_HEADERS },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(60_000),
      });
      const harnessBody = await harnessResponse.json();

      log(`harness tool list -> ${harnessResponse.status} ${JSON.stringify(harnessBody.names ?? harnessBody).slice(0, 200)}`);

      const nameFor = (serverName, toolName) => `mcp_${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}_${toolName}`;
      const readTool = nameFor('smoke-mock', 'get_page');
      const destructiveTool = nameFor('smoke-mock', 'delete_page');

      for (const expected of [readTool, destructiveTool, nameFor('smoke-secure', 'get_secure_page')]) {
        if (!Array.isArray(harnessBody.names) || !harnessBody.names.includes(expected)) {
          fail(`the harness did not discover ${expected} from the sealed cookie: ${JSON.stringify(harnessBody.names)}`);
        }
      }

      const callResponse = await fetch(harnessBase, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mcp-cookie': cookieHeader,
          'x-mcp-tool': readTool,
          ...IDENTITY_HEADERS,
        },
        body: JSON.stringify({ id: 'smoke-1' }),
        signal: AbortSignal.timeout(60_000),
      });
      const callBody = await callResponse.json();

      log(
        `harness tools/call ${readTool} -> ${callResponse.status} ${JSON.stringify(callBody.result ?? callBody).slice(0, 160)}`,
      );

      if (callResponse.status !== 200) {
        fail(`the harness tool call failed with HTTP ${callResponse.status}: ${JSON.stringify(callBody).slice(0, 200)}`);
      } else if (!String(callBody.result ?? '').includes('page-content-for:smoke-1')) {
        fail(`the MCP tools/call did not return the server's payload: ${JSON.stringify(callBody).slice(0, 200)}`);
      } else if (!mcpToolCalls.includes('get_page')) {
        fail('the mock MCP server never received the tools/call request');
      } else {
        log('MCP tools/call works inside workerd and returned the server payload');
      }

      /*
       * 6. The destructive-tool gate: a tool classified as destructive must not be
       * dispatched at all until the user opts in per server.
       */
      const before = mcpToolCalls.length;
      const deniedResponse = await fetch(harnessBase, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mcp-cookie': cookieHeader,
          'x-mcp-tool': destructiveTool,
          ...IDENTITY_HEADERS,
        },
        body: JSON.stringify({ id: 'smoke-1' }),
        signal: AbortSignal.timeout(60_000),
      });
      const deniedBody = await deniedResponse.json();
      const deniedText = String(deniedBody.result ?? '');

      log(`harness tools/call ${destructiveTool} -> ${deniedResponse.status} ${deniedText.slice(0, 160)}`);

      if (!/was NOT executed/i.test(deniedText)) {
        fail(`a destructive tool was not gated: ${deniedText.slice(0, 200) || JSON.stringify(deniedBody).slice(0, 200)}`);
      } else if (mcpToolCalls.length !== before) {
        fail(`a destructive tool reached the MCP server despite being unapproved: ${mcpToolCalls.slice(before).join(', ')}`);
      } else {
        log('destructive tools are refused before dispatch inside workerd');
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    child.kill('SIGTERM');
    harness.child.kill('SIGTERM');
    mcpServer.close();
    setTimeout(() => process.exit(failures.length ? 1 : 0), 250).unref();
  }

  if (failures.length > 0) {
    console.error(`[smoke] FAILED: ${failures.join(' | ')}`);
    console.error(`[smoke] wrangler output tail:\n${output.join('').slice(-3000)}`);

    /*
     * GitHub Actions turns `::error::` lines into check-run annotations, which is
     * the only failure detail that is readable without the raw job log.
     */
    for (const failure of failures) {
      console.log(`::error::workers runtime smoke test failed: ${String(failure).slice(0, 500)}`);
    }

    for (const line of output.join('').split('\n').slice(-12)) {
      if (line.trim()) {
        console.log(`::error::wrangler: ${line.slice(0, 400)}`);
      }
    }

    process.exitCode = 1;
  } else {
    console.log('[smoke] OK');
  }

  return configDir;
}

await main();
