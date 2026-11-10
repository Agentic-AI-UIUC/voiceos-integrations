/**
 * GitHub for VoiceOS, through Composio — the MCP server VoiceOS launches.
 *
 * Eight approved GitHub actions, each routed through the gateway:
 * confirmation receipts for writes, a verified repo-only GitHub
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

// VoiceOS closes an integration by ending stdin, then kills it 2 s later. On
// Windows that kill ends the process without running any handler, so stdin
// closing is the only notice there; SIGTERM still covers macOS.
let stopping: Promise<void> | undefined;
const shutdown = () => {
  stopping ??= gateway.stop().finally(() => process.exit(0));
};
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
