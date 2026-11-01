/**
 * Live check: the integration, launched the way VoiceOS
 * launches it, against real Composio and real GitHub, in the one sandbox
 * repository the user approved. It reuses the GitHub connection the user
 * already made (a COPY of the folder's .state, so VoiceOS's own state is
 * untouched) and never disconnects: disconnecting would revoke the user's
 * GitHub grant and break VoiceOS's connection.
 *
 *   bun scripts/live-check.ts
 *
 * The Composio project key is read from ~/.voiceos-composio-key and never printed.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const { Client } = await import(`${ROOT}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { StdioClientTransport } = await import(`${ROOT}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
const { receiptCore } = await import(`${ROOT}/src/receiptCore.ts`);

const OWNER = "rishabhcli";
const REPO = "voiceos-github-live-check";
const FULL = `${OWNER}/${REPO}`;

const keyFile = join(homedir(), ".voiceos-composio-key");
if ((statSync(keyFile).mode & 0o077) !== 0) throw new Error(`${keyFile} must be private (chmod 600).`);
const KEY = readFileSync(keyFile, "utf8").trim();

let failures = 0;
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};
const gh = (...args: string[]) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
/** Dario's shape: facts for Agent Mode to answer from, no narration written by the integration. */
const plain = (json: any) => !!json && !("spoken" in json);

const VOICEOS_BUN = "/Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun";
const base: Record<string, string> = {};
for (const k of ["HOME", "LOGNAME", "SHELL", "TERM", "USER"]) if (process.env[k]) base[k] = process.env[k]!;
const state = mkdtempSync(join(tmpdir(), "gh-live3-"));
cpSync(join(ROOT, ".state", "state.json"), join(state, "state.json"));
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));

const transport = new StdioClientTransport({
  command: existsSync(VOICEOS_BUN) ? VOICEOS_BUN : "bun",
  args: ["server.ts", `--state-dir=${state}`],
  cwd: ROOT,
  env: {
    ...base,
    BUN_JSC_useJIT: "false",
    COMPOSIO_PROJECT_API_KEY: KEY,
    ...(existsSync(VOICEOS_BUN) ? { VOICEOS_BUN } : {}),
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin", dirname(VOICEOS_BUN)].join(":"),
  },
  stderr: "ignore",
});
const client = new Client({ name: "voiceos-live-check-3", version: "1.0.0" });
const launchedAt = Date.now();
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const started = Date.now();
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  const ms = Date.now() - started;
  console.log(`  · ${name} ${ms} ms → ${json?.log ?? json?.error?.message ?? (json?.ok ? "ok" : text.slice(0, 160))}`);
  return { json, ms, isError: res.isError === true };
};
const sign = (tool: string, args: Record<string, unknown>) => ({
  ...args,
  confirmation_receipt: receiptCore.mint(tool, args, Date.now(), crypto.randomUUID().replace(/-/g, "")),
});

try {
  // Let the start-up warm-up open the session, the way VoiceOS starts the server long before anyone asks.
  await new Promise((r) => setTimeout(r, Math.max(0, 8_000 - (Date.now() - launchedAt))));

  const issue = await call("get_issue", { owner: OWNER, repo: REPO, issue_number: 1 });
  check(issue.json?.ok && issue.json.issue?.title === gh(`repos/${FULL}/issues/1`).title, "get_issue matches GitHub");
  check(issue.ms < 3_000, `first read after start-up is warm (${issue.ms} ms; was 5.3–6.9 s)`);
  check(plain(issue.json) && issue.json.issue?.html_url === gh(`repos/${FULL}/issues/1`).html_url, "get_issue returns plain facts with the issue's link");

  const bare = await call("get_issue", { repo: "live check", issue_number: 1 });
  check(bare.json?.repository === FULL, "a repository said without its owner resolves to the test repository");

  const pr = await call("list_pull_requests", { owner: OWNER, repo: REPO, pull_number: 2 });
  const livePr = gh(`repos/${FULL}/pulls/2`);
  const head = livePr.head.sha;
  check(pr.json?.pull_request?.head_sha === head, "pull_number lookup returns the live head SHA");
  check(pr.json?.pull_request?.title === "Live check PR" && pr.json.pull_request.author === "rishabhcli", "single PR facts");
  const prCard: string = pr.json?._voiceos_glance?.blocks?.[0]?.html ?? "";
  check(pr.json?.pull_request?.status === "open" && prCard.includes('<span class="gh-pill s-open">'), "single PR card leads with its state");
  check(pr.json?.pull_request?.html_url === livePr.html_url && prCard.includes(`href="${livePr.html_url}"`), "single PR result and card link to the PR");
  check(pr.json?.review_state === "not_available", "single PR says review verdicts aren't available instead of guessing");

  const list = await call("list_pull_requests", { repo: REPO });
  check(list.json?.ok && plain(list.json) && list.json.pull_requests.every((p: any) => p.html_url?.startsWith(`https://github.com/${FULL}/pull/`)), "PR list returns plain facts with each PR's link");

  const repos = await call("search_repositories", { q: `${REPO} user:${OWNER}` });
  check(repos.json?.total_count >= 1 && repos.json.repositories?.some((r: any) => r.full_name === FULL && r.private && r.html_url === `https://github.com/${FULL}`), "repository search finds the private sandbox, with its link and the total count");

  const code = await call("search_code", { q: `Live repo:${FULL}` });
  check(code.json?.ok !== undefined && plain(code.json) && typeof code.json.total_count === "number", "code search returns plain facts with the total count");

  // A spoken "yes": the card's receipt never arrives.
  const commentArgs = { owner: OWNER, repo: REPO, issue_number: 1, issue_title: "Live check target", body: `Pass 3 live check ${new Date().toISOString()}` };
  const before = gh(`repos/${FULL}/issues/1`).comments;
  const voiceYes = await call("create_issue_comment", commentArgs);
  check(voiceYes.json?.error?.category === "confirmation_required" && voiceYes.json?.draft?.tool === "create_issue_comment", "a receipt-less change is refused and handed back to re-show the card");
  const again = await call("create_issue_comment", commentArgs);
  check(again.json?.error?.category === "confirmation_required" && !again.json?.draft && !again.json?.card_request, "a second receipt-less try is refused with no card loop");
  check(gh(`repos/${FULL}/issues/1`).comments === before, "nothing was posted by the refused tries");

  // A click: the card's receipt comes with it.
  const posted = await call("create_issue_comment", sign("create_issue_comment", commentArgs));
  const comments = gh(`repos/${FULL}/issues/1/comments?per_page=100`);
  check(posted.json?.log === `Comment posted on ${FULL}#1.` && comments.some((c: any) => c.body === commentArgs.body), "the signed comment posted exactly once, as approved");
  check(comments.filter((c: any) => c.body === commentArgs.body).length === 1, "exactly one copy on GitHub");
  check(comments.some((c: any) => c.html_url === posted.json?.comment?.html_url), "the comment result links to the new comment");

  const fresh = (await call("get_issue", { owner: OWNER, repo: REPO, issue_number: 1 })).json.issue;
  const labelArgs = { owner: OWNER, repo: REPO, issue_number: 1, expected_updated_at: fresh.updated_at, issue_title: fresh.title, add_labels: ["voiceos-check"] };
  const labeled = await call("update_issue", sign("update_issue", labelArgs));
  check(labeled.json?.log === `Updated ${FULL}#1.` && labeled.json.changes?.some((c: any) => c.field === "Labels") && gh(`repos/${FULL}/issues/1`).labels.some((l: any) => l.name === "voiceos-check"), "label added, reported as a change");
  const fresh2 = (await call("get_issue", { owner: OWNER, repo: REPO, issue_number: 1 })).json.issue;
  const { add_labels: _added, ...rest } = labelArgs;
  const unlabeled = await call("update_issue", sign("update_issue", { ...rest, expected_updated_at: fresh2.updated_at, remove_labels: ["voiceos-check"] }));
  check(unlabeled.json?.ok && !gh(`repos/${FULL}/issues/1`).labels.some((l: any) => l.name === "voiceos-check"), "label removed again");

  const reviewArgs = { owner: OWNER, repo: REPO, pull_number: 2, event: "COMMENT", body: `Pass 3 review ${new Date().toISOString()}`, commit_id: head, pr_title: "Live check PR" };
  const reviewed = await call("create_pull_request_review", sign("create_pull_request_review", reviewArgs));
  const reviews = gh(`repos/${FULL}/pulls/2/reviews?per_page=100`);
  check(reviewed.json?.ok && plain(reviewed.json) && reviews.some((r: any) => r.body === reviewArgs.body && r.commit_id === head), "review posted at the pinned commit");
  check(reviews.some((r: any) => r.html_url === reviewed.json?.review?.html_url), "the review result links to the new review");

  // A new issue, closed again straight after so the sandbox stays tidy.
  const createArgs = { owner: OWNER, repo: REPO, title: `Live check issue ${new Date().toISOString()}`, body: "Opened by scripts/live-check.ts and closed again by it." };
  const created = await call("create_issue", sign("create_issue", createArgs));
  const n = created.json?.issue?.number;
  const opened = Number.isInteger(n) ? gh(`repos/${FULL}/issues/${n}`) : undefined;
  check(opened?.title === createArgs.title && created.json.issue.html_url === opened.html_url && created.json.log === `Created ${FULL}#${n}.`, "create_issue opened the approved issue and returned its link");
  if (opened) {
    const current = (await call("get_issue", { owner: OWNER, repo: REPO, issue_number: n })).json.issue;
    const closed = await call("update_issue", sign("update_issue", { owner: OWNER, repo: REPO, issue_number: n, expected_updated_at: current.updated_at, issue_title: current.title, state: "closed", state_reason: "completed" }));
    check(closed.json?.ok && gh(`repos/${FULL}/issues/${n}`).state === "closed", "update_issue closed it again");
  }
} catch (error) {
  check(false, `live check crashed: ${(error as Error).message}`);
} finally {
  await client.close().catch(() => {});
  rmSync(state, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} live check(s) failed` : "\nALL LIVE CHECKS PASSED");
process.exit(failures ? 1 : 0);
