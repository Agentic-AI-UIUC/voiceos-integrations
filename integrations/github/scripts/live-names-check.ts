/**
 * Read-only regressions for the 2026-10-28 error flicker, over the installed
 * stdio launcher: misheard and owner-less repository names, cards on calls
 * the agent fixes itself, and "show all my PRs". Reuses a private copy of
 * the existing binding; never links, disconnects or writes. Independent
 * comparisons use authenticated gh.
 * Run: bun scripts/live-names-check.ts
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(import.meta.dir, "..");
const keyFile = join(homedir(), ".voiceos-composio-key");
if ((statSync(keyFile).mode & 0o077) !== 0) throw new Error("The Composio key file must be private.");
const state = mkdtempSync(join(tmpdir(), "gh-names-regression-"));
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
const client = new Client({ name: "voiceos-names-regression", version: "2.5.2" });
let failures = 0;
const check = (ok: unknown, label: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures++; };
const gh = (args: string[]) => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
const call = async (tool: string, args: Record<string, unknown>) => {
  if (!["get_issue", "list_pull_requests", "search_code"].includes(tool)) throw new Error("This check allows reads only.");
  const started = performance.now();
  const result: any = await client.callTool({ name: tool, arguments: args });
  const json = JSON.parse(result.content[0].text);
  const ms = Math.round(performance.now() - started);
  console.log(JSON.stringify({ tool, args, ms, ok: json.ok, repository: json.repository, requested: json.repository_requested, error: json.error?.category, card: !!json._voiceos_glance }));
  return { json, ms };
};

try {
  await client.connect(transport);
  check((await client.listTools()).tools.length === 8, "exactly eight installed tools");
  const login = gh(["api", "user"]).login as string;

  // "What PRs do I have opened in my break-write repository?" (VoiceOS heard BrickWrite as break-write.)
  const brick = gh(["api", "search/repositories", "-X", "GET", "-f", `q=user:${login} brickwrite in:name`]).items.find((r: any) => r.name.toLowerCase() === "brickwrite");
  if (brick) {
    const heard = await call("list_pull_requests", { owner: login, repo: "break-write" });
    check(heard.json.ok && heard.json.repository === brick.full_name && heard.json._voiceos_glance, `'break-write' lists ${brick.full_name}, with its card, on the first call`);
    const open = gh(["api", `repos/${brick.full_name}/pulls`, "-X", "GET", "-f", "state=open", "-f", "per_page=100", "-f", "sort=updated", "-f", "direction=desc"]).map((p: any) => p.number);
    check(JSON.stringify(heard.json.pull_requests.map((p: any) => p.number)) === JSON.stringify(open.slice(0, 3)) && heard.json.total === open.length, `its first page is GitHub's newest three, of ${open.length}`);
    // "More" is the next page: the next three on the card, until the list ends (user, 2026-10-28).
    const [owner, repo] = brick.full_name.split("/");
    const paged: number[] = [...heard.json.pull_requests.map((p: any) => p.number)];
    let page = heard.json;
    while (page.next_page) {
      page = (await call("list_pull_requests", { owner, repo, page: page.next_page })).json;
      check(page.ok && page._voiceos_glance && page.pull_requests.length > 0, `page ${page.page} has rows and its card`);
      paged.push(...page.pull_requests.map((p: any) => p.number));
    }
    check(JSON.stringify(paged) === JSON.stringify(open), `"more" walks all ${open.length} in GitHub's order, three at a time`);
    const past = await call("list_pull_requests", { owner, repo, page: (page.page ?? 1) + 1 });
    check(past.json.ok && past.json.returned === 0 && !past.json._voiceos_glance, "a page past the end comes back without a card");
  } else console.log("SKIP no BrickWrite repository on this account");

  // "What's the latest pull request in QAgent about?" was refused for its missing owner.
  const bare = await call("list_pull_requests", { repo: "QAgent" });
  check(bare.json.ok && bare.json.repository === `${login}/QAgent`, "a repository of your own is found without its owner");

  // An issue in a repository that exists is never looked for in a lookalike, and the agent tells it, without a card.
  const missing = await call("get_issue", { owner: login, repo: "voiceos-github-live-check", issue_number: 999999 });
  check(!missing.json.ok && missing.json.error.category === "not_found" && !missing.json._voiceos_glance, "a missing issue is a not-found for the agent to tell, without an error card");

  // A code search scoped to the misheard name searches the repository meant.
  if (brick) {
    const code = await call("search_code", { q: `redactShareUrl repo:${login}/break-write`, per_page: 3 });
    check(code.json.ok && code.json.query === `redactShareUrl repo:${brick.full_name}` && code.json.results?.some((r: any) => r.repository === brick.full_name), `a code search in 'break-write' searches ${brick.full_name}`);
  }

  // A name nobody owns: a question for the agent, with no card to flash.
  const unknown = await call("get_issue", { repo: "zzqx-no-such-repository", issue_number: 1 });
  check(!unknown.json.ok && unknown.json.error.category === "invalid_input" && !unknown.json._voiceos_glance, "an unresolvable name comes back to the agent without an error card");

  // "list Prs i have open": every open PR the account authored in the repositories it owns.
  const mine = await call("list_pull_requests", {});
  const authored = gh(["search", "prs", "--author=@me", "--state=open", "--limit", "200", "--json", "repository,number"]) as Array<{ repository: { nameWithOwner: string }; number: number }>;
  const owned = authored.filter((p) => p.repository.nameWithOwner.toLowerCase().startsWith(`${login.toLowerCase()}/`)).map((p) => `${p.repository.nameWithOwner}#${p.number}`).sort();
  // Every page, three at a time, as "more" would show them.
  const all: any[] = [...(mine.json.pull_requests ?? [])];
  for (let next = mine.json.next_page; next; ) {
    const more = (await call("list_pull_requests", { page: next })).json;
    all.push(...(more.pull_requests ?? []));
    next = more.next_page;
  }
  const listed = all.map((p: any) => `${p.repository}#${p.number}`).sort();
  check(mine.json.ok && mine.json.matching === owned.length && JSON.stringify(listed) === JSON.stringify(owned), `all ${owned.length} of your open PRs in your own repositories are listed, page by page (GitHub search agrees)`);
  check(all.every((p: any) => p.author?.toLowerCase() === login.toLowerCase() && p.html_url?.startsWith("https://github.com/")), "each is yours and carries its link");
  check(typeof mine.json.scope_note === "string" && mine.json.repositories?.checked > 0, "the result says which repositories were read");
  check(mine.ms < 20_000, `listed in ${mine.ms} ms, inside VoiceOS's 60 s limit`);
  console.log(failures ? `${failures} live checks failed` : "All live name checks passed. No GitHub writes were dispatched.");
} finally {
  await client.close();
  rmSync(state, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
