/**
 * GitHub for VoiceOS, through Composio — the MCP server VoiceOS launches.
 *
 * Eight approved GitHub actions, each routed through the gateway: release
 * gate, confirmation receipts for writes, a verified repo-only GitHub
 * connection, and exactly one Composio tool call per action.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { createServer } from "./mcpServer.ts";

// The integration folder: where this file lives when bundled to server.ts,
// or one level up when run from src/ during development.
const here = dirname(fileURLToPath(import.meta.url));
const folder = existsSync(join(here, "voiceos.integration.json")) ? here : dirname(here);

const gateway = new Gateway(loadConfig(process.env, folder, process.argv.slice(2)));
await createServer(gateway).connect(new StdioServerTransport());
// Not awaited: settings-driven cleanup (a disconnect) mustn't hold up the handshake.
void gateway.start();

const shutdown = async () => {
  await gateway.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
