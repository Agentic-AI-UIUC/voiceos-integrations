/**
 * Read-only regressions from issue_run.md, over the installed stdio launcher.
 * Reuses a private copy of the existing binding; never links, disconnects or
 * dispatches GitHub writes. Independent comparisons use authenticated gh.
 * Run: bun scripts/live-search-check.ts [--owner=rishabhcli]
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dir, "..");
const owner = process.argv.find((a) => a.startsWith("--owner="))?.slice(8) ?? "rishabhcli";
if (!/^[a-z0-9_-]+$/i.test(owner)) throw new Error("Invalid test owner.");
const keyFile = join(homedir(), ".voiceos-composio-key");
if ((statSync(keyFile).mode & 0o077) !== 0) throw new Error("The Composio key file must be private.");
const state = mkdtempSync(join(tmpdir(), "gh-search-regression-"));
chmodSync(state, 0o700);
cpSync(join(root, ".state/state.json"), join(state, "state.json"));
chmodSync(join(state, "state.json"), 0o600);
const bundledBun = "/Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun";
const base: Record<string, string> = {};
for (const name of ["HOME", "LOGNAME", "SHELL", "TERM", "USER"]) if (process.env[name]) base[name] = process.env[name]!;
const transport = new StdioClientTransport({
  command: existsSync(bundledBun) ? bundledBun : "bun", args: ["server.ts", `--state-dir=${state}`], cwd: root, stderr: "ignore",
  env: { ...base, COMPOSIO_PROJECT_API_KEY: readFileSync(keyFile, "utf8").trim(), BUN_JSC_useJIT: "false", ...(existsSync(bundledBun) ? { VOICEOS_BUN: bundledBun } : {}), PATH: ["/opt/homebrew/bin", join(homedir(), ".bun/bin"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", dirname(bundledBun)].join(":") },
});
const client = new Client({ name: "voiceos-search-regression", version: "2.3.0" });
let failures = 0;
const check = (ok: unknown, label: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures++; };
const gh = (endpoint: string, args: Record<string, string | number> = {}, headers: string[] = []) => JSON.parse(execFileSync("gh", ["api", "-X", "GET", endpoint, ...Object.entries(args).flatMap(([k, v]) => ["-f", `${k}=${v}`]), ...headers.flatMap((h) => ["-H", h])], { encoding: "utf8" }));
const call = async (tool: string, args: Record<string, unknown>) => {
  if (!["search_repositories", "search_code"].includes(tool)) throw new Error("This check allows search reads only.");
  const started = performance.now();
  const result: any = await client.callTool({ name: tool, arguments: args });
  const json = JSON.parse(result.content[0].text);
  console.log(JSON.stringify({ tool, ms: Math.round(performance.now() - started), ok: json.ok, query: json.query, display: json.display, total: json.total_count, source_context: json.source_context }));
  return json;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

try {
  await client.connect(transport);
  check((await client.listTools()).tools.length === 8, "exactly eight installed tools");
  const q = `user:${owner} language:python`;
  const first = await call("search_repositories", { q, include_forks: true, sort: "updated", order: "desc", per_page: 5 });
  if (!first.ok) throw new Error(`Search connection unavailable: ${first.error?.category}`);
  const expected = gh("search/repositories", { q: `${q} fork:true`, sort: "updated", order: "desc", page: 1, per_page: 5 });
  check(same(first.repositories.map((r: any) => r.full_name), expected.items.map((r: any) => r.full_name)), "first five match independent GitHub search, including fork intent");
  check(first.repositories.length === first.display.count && first.display.start === 1, "returned rows are exactly the displayed slice");
  check(first.repositories.every((r: any, n: number) => r.updated_at === expected.items[n].updated_at && r.pushed_at === expected.items[n].pushed_at), "update and push dates retain their separate meanings");
  if (first.next) {
    const next = await call(first.next.tool, first.next.arguments);
    const expectedNext = gh("search/repositories", { q: `${q} fork:true`, sort: "updated", order: "desc", page: 2, per_page: 5 });
    check(same(next.repositories.map((r: any) => r.full_name), expectedNext.items.map((r: any) => r.full_name)), "next five advance to independent page two");
    check(next.display.start === 6 && next.query === first.query && next.sort === first.sort && next.order === first.order, "continuation preserves the scope and sort");
  }
  const code = await call("search_code", { q: `ipcMain repo:${owner}/QAgent`, per_page: 3, intent: "explain" });
  check(code.ok && code.results.some((r: any) => r.path === "apps/desktop/src/main.ts"), "QAgent handler file is located through real Composio");
  const codeExpected = gh("search/code", { q: `ipcMain repo:${owner}/QAgent`, per_page: 3 });
  check(same(code.results.map((r: any) => r.path), codeExpected.items.map((r: any) => r.path)), "code file locations agree with independent GitHub search");
  check(code.source_context.status === "unavailable" ? code.source_context.can_read_full_files === false : code.results.some((r: any) => r.fragments?.length || r.source_url?.startsWith("https://raw.githubusercontent.com/")), "code context carries real excerpts or an exact public source URL; missing private context is explicit");
  check(!("spoken" in code) && !JSON.stringify(code).includes("MAP_NOT_FOUND"), "plain results: no integration-written narration and no internal marker");
  const planning = await call("search_code", { q: `argparse repo:${owner}/planning`, per_page: 3 });
  check(planning.ok && planning.returned > 0 && planning.results.every((r: any) => r.repository === `${owner}/planning`), "private planning search still works");
  const fork = await call("search_code", { q: `voice-preflight repo:${owner}/awesome-phone-call-agents`, per_page: 3 });
  check(fork.ok && (fork.returned > 0 || /even on the default branch/.test(fork.scope_note)), "empty fork search explains indexing uncertainty on the default branch");
  const invalid = await call("search_code", { q: `symbol:registerIpc repo:${owner}/QAgent` });
  check(!invalid.ok && invalid.error.origin === "local_validation" && invalid.error.request_sent === false, "REST syntax rejection is attributed locally");
  console.log(failures ? `${failures} live checks failed` : "All live search checks passed. No GitHub writes were dispatched.");
} finally {
  await client.close();
  rmSync(state, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
