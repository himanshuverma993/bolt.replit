import { type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { json } from '@remix-run/cloudflare';
import {
  discoverMcpTools,
  getMcpErrorMessage,
  mcpStateHeaders,
  readMcpState,
  type McpServerConfig,
  validateServerUrl,
} from '~/lib/.server/mcp';

function getEnv(context: ActionFunctionArgs['context']): Env {
  return context.cloudflare.env as unknown as Env;
}

function createId(): string {
  return crypto.randomUUID();
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('MCP server name is required');
  }

  return value.trim().slice(0, 100);
}

function normalizeToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || value.length > 4096) {
    throw new Error('MCP bearer token must be a string of at most 4096 characters');
  }

  return value;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);

  try {
    const { servers } = await readMcpState(request, env);
    return json({ servers });
  } catch (error) {
    return json({ error: getMcpErrorMessage(error) }, { status: 400 });
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);

  if (request.method !== 'POST') {
    return json({ error: 'MCP endpoint accepts POST for connection management' }, { status: 405 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const operation = body.action;
    const state = await readMcpState(request, env);
    const servers = [...state.servers];
    const secrets = { ...state.secrets };

    if (operation === 'add') {
      const name = normalizeName(body.name);
      const url = validateServerUrl(typeof body.url === 'string' ? body.url.trim() : '');
      const token = normalizeToken(body.token);
      const id = createId();
      const server: McpServerConfig = {
        id,
        name,
        url,
        enabled: true,
        status: 'error',
        tools: [],
      };

      if (token) {
        secrets[id] = token;
      }

      try {
        server.tools = await discoverMcpTools(server, token);
        server.status = 'connected';
        server.statusMessage = undefined;
      } catch (error) {
        server.status = 'error';
        server.statusMessage = getMcpErrorMessage(error);
      }

      servers.push(server);

      const headers = await mcpStateHeaders(servers, secrets, env);

      return json({ server, servers }, { headers });
    }

    const id = typeof body.id === 'string' ? body.id : '';
    const serverIndex = servers.findIndex((server) => server.id === id);

    if (serverIndex < 0) {
      return json({ error: 'MCP server was not found' }, { status: 404 });
    }

    if (operation === 'toggle') {
      servers[serverIndex] = { ...servers[serverIndex], enabled: body.enabled === true };
    } else if (operation === 'remove') {
      servers.splice(serverIndex, 1);
      delete secrets[id];
    } else if (operation === 'refresh') {
      const server = servers[serverIndex];

      try {
        const tools = await discoverMcpTools(server, secrets[id]);
        servers[serverIndex] = { ...server, tools, status: 'connected', statusMessage: undefined };
      } catch (error) {
        servers[serverIndex] = { ...server, status: 'error', statusMessage: getMcpErrorMessage(error) };
      }
    } else {
      return json({ error: 'Unsupported MCP action' }, { status: 400 });
    }

    const headers = await mcpStateHeaders(servers, secrets, env);

    return json({ servers }, { headers });
  } catch (error) {
    return json({ error: getMcpErrorMessage(error) }, { status: 400 });
  }
}
