/**
 * MCP tool-call harness for the workerd smoke test.
 *
 * `getMcpTools()` builds the tool objects the chat route hands to the AI SDK, and
 * `execute()` is the only place a tool is actually invoked - including the
 * write/destructive approval gate and the output cap. The chat route cannot be
 * used to reach that path without a Workers AI binding, so this tiny Worker calls
 * the real module directly and is deployed on demand by
 * `scripts/ci/workers-runtime-smoke.mjs` (which resolves the `~/` alias through a
 * generated tsconfig, exactly like the app build does).
 *
 * It is a test harness: it is not part of the app build and never serves traffic.
 */

// eslint-disable-next-line import/no-unresolved -- resolved through the generated tsconfig paths
import { getMcpTools, MCP_MAX_TOOL_OUTPUT } from '~/lib/.server/mcp';

type HarnessEnv = { APP_ENCRYPTION_SECRET?: string };

type ExecutableTool = {
  execute?: (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown>;
};

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const cookie = request.headers.get('x-mcp-cookie') ?? '';
    const toolName = request.headers.get('x-mcp-tool') ?? '';
    const args = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const origin = new URL(request.url).origin;
    const mcpRequest = new Request(`${origin}/api/chat`, { headers: { Cookie: cookie } });

    try {
      const tools = (await getMcpTools(mcpRequest, env)) as Record<string, ExecutableTool>;
      const names = Object.keys(tools);

      if (!toolName) {
        return Response.json({ names });
      }

      const tool = tools[toolName];

      if (!tool) {
        return Response.json({ names, error: `tool ${toolName} is not available` }, { status: 404 });
      }

      const result = await tool.execute?.(args, { toolCallId: 'harness-call-1', messages: [] });
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);

      return Response.json({ names, result: text.slice(0, MCP_MAX_TOOL_OUTPUT + 64), resultType: typeof result });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};
