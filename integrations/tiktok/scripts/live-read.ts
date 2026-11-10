/**
 * Live read smoke (spikes S3/S4): launches server.ts on VoiceOS's bundled Bun against REAL Composio and
 * calls read and local-helper tools only. Writes are refused here: they go through VoiceOS so a real
 * confirmation card stages the receipt.
 *
 *   COMPOSIO_API_KEY=… COMPOSIO_USER_ID=… COMPOSIO_CONNECTED_ACCOUNT_ID=… \
 *     bun scripts/live-read.ts get_user_stats '{"include_profile":true}' [more tool/args pairs …]
 *
 * Prints each result's JSON (minus the glance widget HTML, which is summarised) and the server's stderr.
 * Never commit output: it carries TikTok account data.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITES = new Set(["upload_video", "publish_video", "upload_photos", "post_photos"]);
const pairs: [string, Record<string, unknown>][] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const name = argv[i]!;
  let args: Record<string, unknown> = {};
  if (argv[i + 1]?.trim().startsWith("{")) args = JSON.parse(argv[++i]!);
  if (WRITES.has(name)) {
    console.error(`${name} is a write: run it from VoiceOS so its confirmation card stages the receipt.`);
    process.exit(2);
  }
  pairs.push([name, args]);
}
if (!pairs.length) pairs.push(["get_user_stats", {}]);
for (const name of ["COMPOSIO_API_KEY", "COMPOSIO_CONNECTED_ACCOUNT_ID"]) {
  if (!process.env[name]?.trim()) {
    console.error(`Set ${name}.`);
    process.exit(2);
  }
}

const VOICEOS_BUN = "/Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun";
const env: Record<string, string> = {};
for (const name of ["HOME", "LOGNAME", "SHELL", "TERM", "USER", "COMPOSIO_API_KEY", "COMPOSIO_USER_ID", "COMPOSIO_CONNECTED_ACCOUNT_ID"]) {
  const value = process.env[name];
  if (value !== undefined) env[name] = value;
}
env.BUN_JSC_useJIT = "false";
env.PATH = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

const transport = new StdioClientTransport({
  command: existsSync(VOICEOS_BUN) ? VOICEOS_BUN : "bun",
  args: ["server.ts"],
  cwd: root,
  env,
  stderr: "pipe",
});
const stderr: string[] = [];
transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
const client = new Client({ name: "live-read", version: "1.0.0" });
await client.connect(transport);

for (const [name, args] of pairs) {
  const started = Date.now();
  const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const text = res.content?.find((c: any) => c.type === "text")?.text ?? "";
  let body: any = text;
  try {
    body = JSON.parse(text);
    const glance = body._voiceos_glance;
    if (glance) {
      body._voiceos_glance = (glance.blocks ?? []).map((b: any) => (b.type === "widget" ? `widget(${String(b.html ?? "").length} chars, h=${b.height ?? "?"})` : b.type));
    }
  } catch {}
  console.log(`\n=== ${name} ${JSON.stringify(args)} → ${res.isError ? "ERROR" : "ok"} in ${Date.now() - started} ms`);
  console.log(JSON.stringify(body, null, 2));
}
await client.close();
console.log("\n--- server stderr ---\n" + stderr.join(""));
