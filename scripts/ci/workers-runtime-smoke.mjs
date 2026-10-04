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

function startMockMcpServer(port) {
  const server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) {
      body += chunk;
    }

    const message = body ? JSON.parse(body) : {};
    const reply = (payload) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(payload));
    };

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
              name: 'get_page',
              description: 'Read a page',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
              // An outputSchema is what makes the SDK build a JSON Schema
              // validator - the exact path that used to require Ajv codegen.
              outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
            },
          ],
        },
      });
    }

    return reply({ jsonrpc: '2.0', id: message.id, result: {} });
  });

  return new Promise((resolveServer) => server.listen(port, '127.0.0.1', () => resolveServer(server)));
}

function startWorker(port, mcpPort) {
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

  const child = spawn(
    'pnpm',
    ['exec', 'wrangler', 'dev', '-c', configPath, '--port', String(port), '--ip', '127.0.0.1'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = [];

  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

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
  const mcpServer = await startMockMcpServer(mcpPort);
  const { child, output, configDir } = startWorker(workerPort, mcpPort);
  const base = `http://127.0.0.1:${workerPort}`;
  let failure;

  try {
    await waitForWorker(base, child, output);
    log('Worker is serving requests');

    const response = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ action: 'add', name: 'smoke-mock', url: `http://127.0.0.1:${mcpPort}/mcp` }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    const server = body.server ?? {};
    const tools = Array.isArray(server.tools) ? server.tools.map((tool) => tool.name) : [];

    log(`POST /api/mcp (add) -> ${response.status} status=${server.status} code=${server.statusCode ?? 'none'}`);
    log(`tools: ${tools.join(', ') || 'none'}`);

    if (response.status !== 200) {
      failure = `expected HTTP 200 from /api/mcp, received ${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
    } else if (server.status !== 'connected') {
      failure = `the Worker could not connect to the mock MCP server: status=${server.status} code=${server.statusCode} message=${server.statusMessage}`;
    } else if (!tools.includes('get_page')) {
      failure = `the mock tool was not discovered: ${JSON.stringify(server).slice(0, 300)}`;
    } else {
      log(`MCP connect inside workerd works: status=connected tools=${tools.join(',')}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    child.kill('SIGTERM');
    mcpServer.close();
    setTimeout(() => process.exit(failure ? 1 : 0), 250).unref();
  }

  if (failure) {
    console.error(`[smoke] FAILED: ${failure}`);
    console.error(`[smoke] wrangler output tail:\n${output.join('').slice(-3000)}`);
    process.exitCode = 1;
  } else {
    console.log('[smoke] OK');
  }

  return configDir;
}

await main();
