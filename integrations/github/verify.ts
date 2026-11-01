/**
 * bun verify.ts — the VoiceOS smoke test.
 *
 * Launches the integration exactly the way VoiceOS does (its bundled Bun on
 * server.ts, per the manifest's runtime, with the environment VoiceOS builds;
 * `--package` runs only the shared files, in an empty folder with an empty Bun
 * cache, the way a teammate's first launch does) and
 * speaks real MCP over stdio: handshake, tools/list (must match the manifest
 * both ways), model-facing descriptions, then every preview fixture, which
 * must return text and 1–3 glance blocks. Composio is a local fake
 * (tests/mockComposio.ts), so writes are signed the way their confirmation
 * card signs them and never reach a real GitHub account.
 *
 * Exits non-zero on any failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { receiptCore } from "./src/receiptCore.ts";
import { makeRepo, startMockComposio } from "./tests/mockComposio.ts";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "voiceos.integration.json"), "utf8"));
const preview = JSON.parse(readFileSync(join(root, "voiceos.integration.preview.json"), "utf8"));
const WRITES = new Set(["create_issue", "update_issue", "create_issue_comment", "create_pull_request_review"]);

let failures = 0;
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

check(manifest.schemaVersion === 1, "manifest schema version is v1");
check(preview.schemaVersion === 1, "preview fixture schema version is v1");

// A fake Composio holding everything the fixtures touch.
const mock = startMockComposio();
const hello = mock.addRepo(makeRepo("octocat", "Hello-World", { description: "My first repository on GitHub!" }));
mock.addIssue(hello, { number: 1, title: "Found a bug" });
mock.addPull(hello, { number: 2, title: "Update README" });
mock.addRepo(makeRepo("voice-labs", "voice-assistant", { description: "An open voice assistant in TypeScript", stars: 4200 }));
const jquery = mock.addRepo(makeRepo("jquery", "jquery"));
jquery.files.push({ path: "src/attributes/classes.js", content: "jQuery.fn.extend( { addClass: function( value ) {" });
const sandbox = mock.addRepo(makeRepo("voiceos-test", "sandbox"));
mock.addIssue(sandbox, { number: 1, title: "Preview target" });
mock.addPull(sandbox, { number: 2, title: "Preview PR", head: { ref: "preview", sha: "2b".repeat(20) } });

// The environment VoiceOS gives the process (its main process's
// buildMcpProcessEnv): the MCP SDK's default inherited variables, the JIT
// turned off, its bundled Bun as VOICEOS_BUN, the stored setup values, and
// Homebrew/Bun bins in front of a Dock-launched app's PATH (launchd's, not
// the user's shell PATH).
const VOICEOS_BUN = "/Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun";
function hostEnvironment(setupValues: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["HOME", "LOGNAME", "SHELL", "TERM", "USER"]) {
    const value = process.env[name];
    if (value !== undefined && !value.startsWith("()")) env[name] = value;
  }
  const bun = existsSync(VOICEOS_BUN) ? VOICEOS_BUN : undefined;
  const path = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...(bun ? [dirname(bun)] : [])];
  return { ...env, BUN_JSC_useJIT: "false", ...setupValues, ...(bun ? { VOICEOS_BUN: bun } : {}), PATH: [...new Set(path)].join(":") };
}
// --package: a teammate's first launch. Only the five files the share service
// packages, in an empty folder, with an empty Bun cache, so every dependency
// is downloaded at the version server.ts pins.
const asPackage = process.argv.includes("--package");
const SHARED_FILES = ["icon.png", "package.json", "server.ts", "voiceos.integration.json", "widgetKit.ts"];
const launchDir = asPackage ? mkdtempSync(join(tmpdir(), "voiceos-github-package-")) : root;
const bunCache = asPackage ? mkdtempSync(join(tmpdir(), "voiceos-github-bun-cache-")) : undefined;
if (asPackage) for (const f of SHARED_FILES) copyFileSync(join(root, f), join(launchDir, f));
console.log(
  asPackage
    ? "· launching the shared package alone, with an empty Bun cache (a teammate's first launch)"
    : existsSync(VOICEOS_BUN)
      ? "· launching on VoiceOS's bundled Bun with the JIT off, as VoiceOS does"
      : "· VoiceOS isn't installed here; launching on this machine's Bun",
);

const state = mkdtempSync(join(tmpdir(), "voiceos-github-verify-"));
const transport = new StdioClientTransport({
  command: existsSync(VOICEOS_BUN) ? VOICEOS_BUN : "bun",
  args: ["server.ts", `--composio-base-url=${mock.baseUrl}`, `--state-dir=${state}`],
  cwd: launchDir,
  env: hostEnvironment({
    COMPOSIO_PROJECT_API_KEY: mock.apiKey,
    // Reload keeps values stored for fields the earlier manifest declared and
    // still passes them; they must be ignored (the kill switch and user ID
    // fields too, removed in 2.4.1). Fields added since arrive unset until
    // Configure is saved.
    COMPOSIO_API_KEY: "stale-consumer-key-from-v1",
    COMPOSIO_ENTITY_ID: "default",
    GITHUB_TEST_REPOSITORIES: "voiceos-test/sandbox",
    GITHUB_KILL_SWITCH: "true",
    COMPOSIO_USER_ID: "stale-user-id",
    ...(bunCache ? { BUN_INSTALL_CACHE_DIR: bunCache } : {}),
    GITHUB_ENVIRONMENT: "internal",
  }),
  stderr: "ignore",
});
const client = new Client({ name: "voiceos-verify", version: "1.0.0" });

// VoiceOS gives every tool call the MCP SDK's default 60 s. Against a local
// fake Composio, anything near that is a bug in this server.
let slowest = { name: "", ms: 0 };
try {
  const started = Date.now();
  await client.connect(transport);
  check(true, `initialize handshake (${Date.now() - started} ms)`);

  const { tools } = await client.listTools();
  const served = tools.map((t) => t.name).sort();
  const declared = manifest.tools.map((t: any) => t.name).sort();
  check(JSON.stringify(served) === JSON.stringify(declared), `tools match voiceos.integration.json — ${served.join(", ")}`);
  for (const t of tools) check((t.description ?? "").length > 40 && /Use when/.test(t.description ?? ""), `${t.name} has a model-facing description`);

  const call = async (name: string, args: Record<string, unknown>) => {
    const started = Date.now();
    const res: any = await client.callTool({ name, arguments: args });
    const ms = Date.now() - started;
    if (ms > slowest.ms) slowest = { name, ms };
    const text = res.content?.find((c: any) => c.type === "text")?.text ?? "";
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { res, text, json };
  };

  // Connect GitHub the way a user would: the first call returns the Connect
  // card, the user approves in the browser (simulated), the next call works.
  const first = await call("search_repositories", { q: "voice" });
  check(first.json?.error?.category === "not_connected" && /connect\.composio\.dev/.test(first.text), "first call asks to connect GitHub with a Connect card");
  mock.activate([...mock.accounts.keys()].at(-1)!, { displayName: "voiceos-preview" });

  const cards = manifest.tools.filter((t: any) => t.confirmation);
  check(cards.length === 4 && cards.every((t: any) => t.confirmation.root.html.includes('"voiceos-github-receipt-v2\\n"')), "the four confirmation cards stage a receipt digest");
  for (const [name, fixture] of Object.entries(preview.tools) as Array<[string, any]>) {
    let args = { ...fixture.args };
    if (name === "update_issue") {
      const issue = (await call("get_issue", { owner: args.owner, repo: args.repo, issue_number: args.issue_number })).json?.issue;
      args = { ...args, expected_updated_at: issue?.updated_at, issue_title: issue?.title };
    }
    if (name === "create_pull_request_review") {
      const pr = (await call("list_pull_requests", { owner: args.owner, repo: args.repo, pull_number: args.pull_number })).json?.pull_request;
      args = { ...args, commit_id: pr?.head_sha, pr_title: pr?.title };
    }
    if (WRITES.has(name)) {
      args.confirmation_receipt = receiptCore.mint(name, args, Date.now(), crypto.randomUUID().replace(/-/g, ""));
    }
    const { res, text, json } = await call(name, args);
    check(text.length > 0 && json, `${name} preview call returns text`);
    const blocks = json?._voiceos_glance?.blocks ?? [];
    check(blocks.length >= 1 && blocks.length <= 3 && (fixture.expectedGlanceBlocks ?? blocks.length) === blocks.length, `${name} preview call returns 1-3 glance blocks`);
    check(!res.isError && json?.ok === true, `${name} preview call succeeds${res.isError ? ` (${json?.error?.message ?? text.slice(0, 120)})` : ""}`);
  }
  check(slowest.ms < 10_000, `every call finished well inside VoiceOS's 60 s limit (slowest: ${slowest.name}, ${slowest.ms} ms)`);
  if (bunCache) {
    const fetched = readdirSync(bunCache);
    check(fetched.length === 0, `first launch downloaded nothing; server.ts carries its dependencies${fetched.length ? ` (fetched: ${fetched.join(", ")})` : ""}`);
    check(!existsSync(join(launchDir, "node_modules")), "the shared package ran without node_modules");
  }
} catch (error) {
  check(false, `verification crashed: ${(error as Error).message}`);
} finally {
  await client.close().catch(() => {});
  mock.stop();
  rmSync(state, { recursive: true, force: true });
  if (asPackage) rmSync(launchDir, { recursive: true, force: true });
  if (bunCache) rmSync(bunCache, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
