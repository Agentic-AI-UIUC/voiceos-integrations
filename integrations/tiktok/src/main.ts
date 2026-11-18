/**
 * TikTok for VoiceOS — the MCP server VoiceOS launches (`bun server.ts`, the
 * bundle of this file). Configuration comes from VoiceOS's preferences
 * (process.env); test seams only from command-line arguments, and only for
 * loopback mocks (src/config.ts).
 *
 *   --poll-schedule=<ms,ms,…>   status-poll waits, honoured only with a loopback
 *                               --composio-base-url (verify.ts), so tests don't
 *                               wait 5 s per poll
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { argument, loadConfig } from "./config.ts";
import { sweepStaleWorkDirs } from "./images.ts";
import { createDeps, createServer, type Deps } from "./mcpServer.ts";
import { log } from "./proc.ts";

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

/** The --poll-schedule seam: positive whole milliseconds, comma-separated, and only against a loopback Composio. */
export function pollScheduleFrom(argv: string[], baseUrl: string): number[] | undefined {
  const raw = argument(argv, "poll-schedule");
  if (!raw || !LOOPBACK.test(baseUrl)) return undefined;
  const ms = raw.split(",").map((s) => Number(s.trim()));
  return ms.length > 0 && ms.every((n) => Number.isInteger(n) && n >= 0 && n <= 600_000) ? ms : undefined;
}

/** Our code for something that escaped every handler: its name or code, never its message (it may carry a path). */
const escapeCode = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : ((e as Error)?.name ?? typeof e);
};

/**
 * Nothing that escapes a handler may end the server: Bun's default for an unhandled rejection is to exit, and an
 * exit drops every TikTok tool until the user reloads the integration (and kills any upload still running).
 * Logged by code only; the server keeps serving.
 */
export function keepRunning(proc: Pick<NodeJS.Process, "on"> = process): void {
  proc.on("unhandledRejection", (e: unknown) => log(`unhandled rejection ${escapeCode(e)}; still running`));
  proc.on("uncaughtException", (e: unknown) => log(`uncaught exception ${escapeCode(e)}; still running`));
}

export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<void> {
  keepRunning();
  const cfg = loadConfig(env, argv);
  const overrides: Partial<Deps> = {};
  const schedule = pollScheduleFrom(argv, cfg.baseUrl);
  if (schedule) overrides.pollScheduleMs = schedule;
  try {
    // Converted photos from a run that never finished (crash, kill) are deleted after 2 hours.
    sweepStaleWorkDirs();
  } catch {
    log("startup: couldn't sweep old photo work folders");
  }
  const server = createServer(createDeps(cfg, overrides));
  // When stdin ends the server exits once idle, and VoiceOS marks the integration "error" (no TikTok tools until a
  // Reload). VoiceOS shows the last stderr line as the reason, so say it: a VoiceOS timeout or a runtime bug such
  // as Bun 1.3.13's file-stream one (src/client.ts md5Of) look the same from here.
  process.stdin.on("end", () => log("stdin ended (VoiceOS closed the connection, or a runtime bug); exiting when idle"));
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only when run directly (`bun server.ts` / `bun src/main.ts`), so tests and the build can import this file.
if (import.meta.main) await main();
