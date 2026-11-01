/**
 * The MCP surface VoiceOS talks to: exactly the eight approved facades, each
 * with its strict schema, routed through the gateway.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FACADES, TOOL_META, WRITE_TOOLS, schemaFor } from "./catalog.ts";
import { CLIENT_VERSION } from "./composio.ts";
import type { Gateway } from "./gateway.ts";

export const CAPABILITY_GUIDANCE =
  "GitHub through Composio, limited to eight actions: get an issue, create an issue, update an issue, comment on an issue or pull request, list pull requests, review a pull request, search repositories, and search code. It cannot create, merge, close or edit pull requests, read pull request diffs or files, list or search issues, manage repositories, or make inline review comments. Every change is shown to the user on a confirmation card first. A change that comes back with `draft` was not sent; calling the same tool with draft.arguments shows its card again.";

export function createServer(gateway: Gateway): McpServer {
  const server = new McpServer({ name: "github-composio", version: CLIENT_VERSION }, { instructions: CAPABILITY_GUIDANCE });
  for (const tool of FACADES) {
    const write = WRITE_TOOLS.has(tool);
    server.registerTool(
      tool,
      {
        title: TOOL_META[tool].title,
        description: TOOL_META[tool].description,
        inputSchema: schemaFor(tool) as any,
        annotations: { title: TOOL_META[tool].title, readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: true },
      },
      (args: any, extra: { signal?: AbortSignal }) => gateway.handle(tool, args, { signal: extra?.signal }),
    );
  }
  return server;
}
