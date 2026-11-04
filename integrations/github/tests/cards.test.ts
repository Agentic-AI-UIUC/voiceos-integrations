import { describe, expect, test } from "bun:test";
import {
  codeSearchCard,
  commentPostedCard,
  connectCard,
  disconnectedCard,
  errorCard,
  glance,
  issueCard,
  issueCreatedCard,
  issueUpdatedCard,
  pullListCard,
  repoSearchCard,
  reviewSubmittedCard,
  type Widget,
} from "../src/cards.ts";
import { GithubError } from "../src/errors.ts";
import type { IssueFacts, PullFacts, RepoFacts } from "../src/normalize.ts";

const NOW = Date.parse("2026-10-24T20:00:00Z");
const HOSTILE = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;

const issue = (over: Partial<IssueFacts> = {}): IssueFacts => ({
  number: 123, title: "Sign-in window freezes", state: "open", state_reason: null, is_pull_request: false, author: "octocat",
  labels: [{ name: "bug", color: "d73a4a" }, { name: "p1" }], assignees: ["hubot"], comments: 4, locked: false,
  created_at: "2026-10-21T20:00:00Z", updated_at: "2026-10-24T18:00:00Z", closed_at: null,
  html_url: "https://github.com/acme/desktop/issues/123", body: "", body_truncated: false, ...over,
});
const pull = (n: number, over: Partial<PullFacts> = {}): PullFacts => {
  const p: PullFacts = {
    number: n, title: `PR number ${n}`, state: "open", status: "open", merged: false, draft: false, author: "octocat", head_ref: `feature-${n}`,
    head_sha: "a".repeat(40), base_ref: "main", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-24T18:00:00Z",
    html_url: `https://github.com/acme/desktop/pull/${n}`, ...over,
  };
  return { ...p, status: over.status ?? (p.merged ? "merged" : p.state === "closed" ? "closed" : p.draft ? "draft" : "open") };
};

/** Anchors in the rendered markup — not text inside the kit's runtime script. */
function hrefs(w: Widget): string[] {
  const markup = w.html.slice(w.html.indexOf("<body>"), w.html.lastIndexOf("<script>"));
  return [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
function visibleText(w: Widget): string {
  const body = w.html.slice(w.html.indexOf("<body>"), w.html.lastIndexOf("<script>"));
  return body
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
function expectValid(w: Widget) {
  expect(w.type).toBe("widget");
  expect(w.html.length).toBeLessThan(120_000);
  expect(w.height).toBeGreaterThanOrEqual(60);
  expect(w.height).toBeLessThanOrEqual(420);
  expect(w.label.length).toBeLessThanOrEqual(60);
  expect(w.html).toContain('<div class="gh-soc2" role="note">⚠️ SOC 2 review pending</div>');
  for (const h of hrefs(w)) expect(h).toMatch(/^https:\/\/(github\.com\/|connect\.composio\.dev\/)/);
}

describe("issue card", () => {
  test("shows state, number, title, labels and assignees like GitHub", () => {
    const w = issueCard(issue(), "acme", "desktop", NOW);
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["Open", "Sign-in window freezes", "#123", "bug", "p1", "Opened 3 days ago by octocat", "4 comments", "Assigned to hubot"]) {
      expect(text).toContain(s);
    }
    expect(hrefs(w)).toEqual(["https://github.com/acme/desktop/issues/123"]);
  });

  test("closed-as-not-planned and pull request records read differently", () => {
    expect(visibleText(issueCard(issue({ state: "closed", state_reason: "not_planned", closed_at: "2026-10-24T19:00:00Z" }), "acme", "desktop", NOW))).toContain("Not planned");
    const pr = visibleText(issueCard(issue({ is_pull_request: true }), "acme", "desktop", NOW));
    expect(pr).toContain("Open");
    expect(pr.replace("⚠️ SOC 2 review pending", "")).not.toMatch(/diff|review|code changes/i);
  });

  test("hostile titles are escaped and unsafe links are dropped", () => {
    const w = issueCard(issue({ title: HOSTILE, labels: [{ name: HOSTILE }], html_url: undefined }), "acme", "desktop", NOW);
    expect(w.html).not.toContain("<script>alert(1)");
    expect(w.html).not.toContain("<img src=x");
    expect(hrefs(w)).toEqual([]);
    expect(visibleText(w)).toContain("<script>alert(1)</script>");
  });
});

describe("pull request list card", () => {
  test("VoiceOS's short summary appears below the PR details, without a label or a repeated heading", () => {
    const summary = "Retries stalled requests twice, then shows an error instead of leaving the request waiting forever.";
    const w = pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 1, pulls: [pull(55, { title: "Recover stalled requests", body: "Retry twice, then fail." })], title: "Pull request #55", summary, now: NOW });
    expectValid(w);
    const text = visibleText(w);
    expect(text).not.toContain("VoiceOS summary");
    expect(text).not.toContain("Pull request #55");
    expect(text).toContain(summary);
    expect(text.indexOf(summary)).toBeGreaterThan(text.indexOf("Recover stalled requests"));
    expect(w.html).toContain('aria-label="VoiceOS summary"');
    expect(w.html).not.toContain('class="gh-summary-text"><script>');
  });

  test("the first card shows no raw description, so the summary arrives below it instead of replacing text (user, 2026-10-28)", () => {
    const body = "## Fix\nRetries [stalled requests](https://github.com/acme/desktop/pull/55) twice before showing an error.";
    const card = (summary?: string) => pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 1, pulls: [pull(55, { body })], title: "Pull request #55", summary, now: NOW });
    const first = visibleText(card());
    expect(first).not.toContain("Retries stalled requests");
    expect(first).not.toContain("PR description");
    const second = visibleText(card("Retries twice, then shows an error."));
    // Everything on the first card is still there, in the same place, with the summary added after it.
    expect(second).toStartWith(first.replace(/ ⚠️ SOC 2 review pending$/, ""));
    expect(second).toEndWith("⚠️ SOC 2 review pending");
    expect(second.replace(/ ⚠️ SOC 2 review pending$/, "")).toEndWith("Retries twice, then shows an error.");
    expectValid(card());
  });
  test("shows at most three rows, counts the rest of the list, and states the page", () => {
    const pulls = [pull(55, { draft: true }), pull(54, { state: "closed", merged: true }), pull(53), pull(52)];
    const w = pullListCard({ owner: "acme", repo: "desktop", state: "all", page: 1, perPage: 3, pulls, rest: { count: 13 }, now: NOW });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("#55 by octocat, updated 2 hours ago");
    expect(text).toContain("Draft");
    expect(text).toContain("Merged");
    expect(text).not.toContain("#52");
    expect(text).toContain("13 more");
    expect(text).not.toContain("on this page");
    expect(text).toContain("Page 1");
    expect(text).not.toContain("per page");
    expect(hrefs(w)).toHaveLength(3);
    // Before the end of the list has been read, the count is a floor.
    expect(visibleText(pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 3, pulls, rest: { count: 17, atLeast: true }, now: NOW }))).toContain("17+ more");
    // The last rows say nothing about more.
    expect(visibleText(pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 6, perPage: 3, pulls: [pull(1)], rest: { count: 0 }, now: NOW }))).not.toMatch(/\d+\+? more/);
  });

  test("on a list, the summary arrives below the same rows instead of replacing any (user, 2026-10-28)", () => {
    const pulls = [pull(55), pull(54), pull(53), pull(52), pull(51), pull(50)];
    const summary = "Six open pull requests, all small fixes from octocat.";
    const card = (s?: string) => visibleText(pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 20, pulls, summary: s, now: NOW }));
    const first = card();
    const second = card(summary);
    expect(second).toContain(summary);
    // Every row and the count of the rest stay put; the summary is only added.
    expect(second.replace(` ${summary}`, "")).toBe(first);
    expectValid(pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 20, pulls, summary: "x".repeat(280), now: NOW }));
  });

  test("one PR's card leads with its state, and its row is the one link to the PR", () => {
    const one = (over: Partial<PullFacts>) => pullListCard({ owner: "acme", repo: "desktop", state: "all", page: 1, perPage: 1, pulls: [pull(55, over)], title: "Pull request #55", now: NOW });
    const cases: [Partial<PullFacts>, string, string][] = [
      [{}, "s-open", "Open"],
      [{ draft: true }, "s-muted", "Draft"],
      [{ state: "closed", merged: true }, "s-done", "Merged"],
      [{ state: "closed" }, "s-closed", "Closed"],
    ];
    for (const [over, cls, label] of cases) {
      const w = one(over);
      expectValid(w);
      expect(w.html).toContain(`<span class="gh-pill ${cls}">`);
      expect(visibleText(w)).toStartWith(`GitHub acme/desktop ${label} PR number 55 #55 by octocat`);
      expect(visibleText(w)).not.toContain("Open on GitHub");
      expect(hrefs(w)).toEqual(["https://github.com/acme/desktop/pull/55"]);
    }
  });

  test("one PR's card names who is asked to review it", () => {
    const one = (over: Partial<PullFacts>) => visibleText(pullListCard({ owner: "acme", repo: "desktop", state: "all", page: 1, perPage: 1, pulls: [pull(55, over)], title: "Pull request #55", now: NOW }));
    expect(one({ requested_reviewers: ["alice", "bob"], requested_teams: ["core"] })).toContain("Review requested from alice, bob and core");
    expect(one({ requested_reviewers: ["alice"] })).toContain("Review requested from alice");
    expect(one({ requested_reviewers: [], requested_teams: [] })).not.toContain("Review requested");
  });

  test("every row says its state, except plain open rows under an open-only heading", () => {
    const first = [pull(55), pull(54, { draft: true }), pull(53, { state: "closed", merged: true })];
    const rest = [pull(52, { state: "closed" })];
    const tags = (state: "open" | "all", pulls: PullFacts[]) => [...pullListCard({ owner: "acme", repo: "desktop", state, page: 1, perPage: 20, pulls, now: NOW }).html.matchAll(/class="gh-tag">([^<]+)</g)].map((m) => m[1]);
    expect([...tags("all", first), ...tags("all", rest)]).toEqual(["Open", "Draft", "Merged", "Closed"]);
    expect([...tags("open", first), ...tags("open", rest)]).toEqual(["Draft", "Merged", "Closed"]);
  });

  test("an author filter discloses its coverage", () => {
    const w = pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 20, pulls: [pull(3)], author: "octocat", scanned: 150, now: NOW });
    expect(visibleText(w)).toContain("From the 150 most recent");
  });

  test("a list across your repositories names each PR's repository and how many repositories were read", () => {
    const mine = (n: number, repo: string) => ({ ...pull(n, { author: "voiceos-tester", html_url: `https://github.com/voiceos-tester/${repo}/pull/${n}` }), repository: `voiceos-tester/${repo}` });
    const w = pullListCard({ state: "open", page: 1, perPage: 3, pulls: [mine(9, "beta"), mine(3, "alpha")], across: { repositories: 2, account: "voiceos-tester" }, rest: { count: 0 }, now: NOW });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("Your open pull requests");
    expect(text).toContain("voiceos-tester/beta #9, updated 2 hours ago");
    expect(text).toContain("2 of your repositories");
    expect(text).not.toContain("by voiceos-tester");
    expect(hrefs(w)).toEqual(["https://github.com/voiceos-tester/beta/pull/9", "https://github.com/voiceos-tester/alpha/pull/3"]);
    const none = visibleText(pullListCard({ state: "open", page: 1, perPage: 3, pulls: [], across: { repositories: 3 }, now: NOW }));
    expect(none).toContain("No open pull requests of yours in your repositories.");
    // The rest are counted across every repository read.
    const many = Array.from({ length: 3 }, (_, i) => mine(20 - i, "beta"));
    const long = visibleText(pullListCard({ state: "open", page: 1, perPage: 3, pulls: many, across: { repositories: 4 }, rest: { count: 24 }, now: NOW }));
    expect(long).toContain("24 more");
    expect(long).not.toContain("on this page");
  });

  test("an empty list says what was looked at and what to say next", () => {
    const text = (state: "open" | "closed" | "all", page = 1) => visibleText(pullListCard({ owner: "acme", repo: "desktop", state, page, perPage: 20, pulls: [], now: NOW }));
    expect(text("open")).toContain("No open pull requests in acme/desktop.");
    expect(text("open")).not.toContain("Say");
    expect(text("closed")).toContain("No closed pull requests in acme/desktop.");
    expect(text("open", 2)).toContain("No more open pull requests in acme/desktop.");
  });
});

describe("search cards", () => {
  const repo: RepoFacts = { full_name: "qdrant/qdrant", description: "Vector search engine", stars: 21400, forks: 1, language: "Rust", private: false, archived: false, fork: false, html_url: "https://github.com/qdrant/qdrant" };

  test("repository search shows the query, matches and star counts", () => {
    const w = repoSearchCard({ query: "vector database language:rust", total: 1234, incomplete: false, page: 1, perPage: 20, repos: [repo] });
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["vector database language:rust", "1,234 matches", "qdrant/qdrant", "Vector search engine", "21.4k"]) expect(text).toContain(s);
  });

  test("zero and partial results are honest", () => {
    expect(visibleText(repoSearchCard({ query: "zzz", total: 0, incomplete: false, page: 1, perPage: 20, repos: [] }))).toContain("No matches returned for this query.");
    expect(visibleText(repoSearchCard({ query: "x", total: 5, incomplete: true, page: 1, perPage: 20, repos: [repo] }))).toContain("GitHub returned partial results for this search.");
  });

  test("code search shows paths and the default-branch caveat", () => {
    const w = codeSearchCard({
      query: "refreshToken repo:acme/desktop", total: 2, incomplete: false, page: 1, perPage: 20,
      hits: [
        { repository: "acme/desktop", path: "src/auth/session.ts", html_url: "https://github.com/acme/desktop/blob/main/src/auth/session.ts" },
        { repository: "acme/desktop", path: "src/auth/refresh.ts", html_url: "https://github.com/acme/desktop/blob/main/src/auth/refresh.ts", fragment: "const refreshToken = rotate()" },
      ],
    });
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["2 files", "session.ts", "src/auth/", "const refreshToken = rotate()", "No code excerpt"]) {
      expect(text).toContain(s);
    }
  });

  test("a long path gives way in its folders, never in the file name", () => {
    const path = "packages/desktop-app/src/integrations/github/oauth/refresh.ts";
    const w = codeSearchCard({ query: "x", total: 1, incomplete: false, page: 1, perPage: 20, hits: [{ repository: "acme/desktop", path, html_url: "https://github.com/acme/desktop/blob/main/x" }] });
    // The folder part is the only shrinkable piece; the file name sits outside it, whole.
    expect(w.html).toContain('<span class="gh-dir">packages/desktop-app/src/integrations/github/oauth/</span><b>refresh.ts</b>');
    expect(w.html).toMatch(/\.gh-path\{[^}]*display:flex/);
    expect(w.html).toMatch(/\.gh-path b\{[^}]*flex:none/);
  });
});

describe("write result cards", () => {
  test("created issue uses the plan's success copy and shows warnings", () => {
    const w = issueCreatedCard({ owner: "acme", repo: "desktop", issue: issue(), warnings: ["Labels weren't applied. This account may not have push access."], now: NOW });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("Created acme/desktop#123.");
    expect(text).toContain("Labels weren't applied. This account may not have push access.");
  });

  test("updated issue shows each change before and after", () => {
    const w = issueUpdatedCard({
      owner: "acme", repo: "desktop", headline: "Closed acme/desktop#123.",
      changes: [{ field: "State", before: "Open", after: "Closed (completed)" }, { field: "Labels", before: "bug", after: "bug, urgent" }],
      issue: issue({ state: "closed", state_reason: "completed" }), warnings: [], now: NOW,
    });
    const text = visibleText(w);
    for (const s of ["Closed acme/desktop#123.", "State", "Open", "Closed (completed)", "Labels", "bug, urgent"]) expect(text).toContain(s);
  });

  test("comment on a pull request is called a comment, not a review", () => {
    const text = visibleText(commentPostedCard({ owner: "acme", repo: "desktop", number: 55, isPullRequest: true, body: "Looks good to me", url: "https://github.com/acme/desktop/pull/55#issuecomment-1" }));
    expect(text).toContain("Comment posted on acme/desktop#55.");
    expect(text).not.toContain("review status");
  });

  test("review results use the plan's consequence copy", () => {
    const base = { owner: "acme", repo: "desktop", number: 55, prTitle: "Add GitHub linking", commit: "abc1234def5678901234567890abcdef12345678", body: "Please add a test.", url: "https://github.com/acme/desktop/pull/55#pullrequestreview-88" };
    expect(visibleText(reviewSubmittedCard({ ...base, state: "CHANGES_REQUESTED" }))).toContain("Requested changes on acme/desktop#55.");
    expect(visibleText(reviewSubmittedCard({ ...base, state: "APPROVED" }))).toContain("Approved acme/desktop#55 at abc1234.");
    expect(visibleText(reviewSubmittedCard({ ...base, state: "COMMENTED" }))).toContain("Review comment posted on PR #55.");
    expect(visibleText(reviewSubmittedCard({ ...base, state: "APPROVED" }))).not.toContain("diff");
  });
});

describe("one way to link (user, 2026-10-28)", () => {
  test("every card links through the item's own title or headline, never a separate Open button", () => {
    const issueUrl = "https://github.com/acme/desktop/issues/123";
    const cards: [string, Widget, string][] = [
      ["issue", issueCard(issue(), "acme", "desktop", NOW), issueUrl],
      ["created issue", issueCreatedCard({ owner: "acme", repo: "desktop", issue: issue(), warnings: [], now: NOW }), issueUrl],
      ["updated issue", issueUpdatedCard({ owner: "acme", repo: "desktop", headline: "Closed acme/desktop#123.", changes: [], issue: issue(), warnings: [], now: NOW }), issueUrl],
      ["comment", commentPostedCard({ owner: "acme", repo: "desktop", number: 55, isPullRequest: true, body: "hi", url: "https://github.com/acme/desktop/pull/55#issuecomment-1" }), "https://github.com/acme/desktop/pull/55#issuecomment-1"],
      ["review", reviewSubmittedCard({ owner: "acme", repo: "desktop", number: 55, prTitle: "t", commit: "a".repeat(40), body: "b", state: "APPROVED", url: "https://github.com/acme/desktop/pull/55#pullrequestreview-1" }), "https://github.com/acme/desktop/pull/55#pullrequestreview-1"],
      ["unknown outcome", errorCard(new GithubError({ category: "unknown_outcome", message: "m" }), { target: "acme/desktop#123", openUrl: issueUrl }), issueUrl],
      ["single PR", pullListCard({ owner: "acme", repo: "desktop", state: "all", page: 1, perPage: 1, pulls: [pull(55)], title: "Pull request #55", now: NOW }), "https://github.com/acme/desktop/pull/55"],
    ];
    for (const [name, w, url] of cards) {
      expect({ name, links: hrefs(w) }).toEqual({ name, links: [url] });
      expect({ name, open: visibleText(w).match(/\bOpen (on GitHub|GitHub|comment|review)\b/)?.[0] ?? null }).toEqual({ name, open: null });
      // The link wraps the title, so it reads as the title, not as a button.
      expect(w.html).not.toMatch(/class="gh-(link|btn)[^"]*" href/);
    }
  });
});

describe("no filler on result cards (user, 2026-10-28)", () => {
  test("cards show facts and real warnings, never how-it-works lines or what to say next", () => {
    const FILLER = /Say “|Say "|issue details|code changes aren't|Indexed default|prove absence|conversation comment|review status|reading the diff|can't fetch|sent again|the service VoiceOS|limits itself|keep logs|will ask you|Use my GitHub connection|per page/i;
    const cards: [string, Widget][] = [
      ["pr issue record", issueCard(issue({ is_pull_request: true }), "acme", "desktop", NOW)],
      ["pr list", pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 2, pulls: [pull(1), pull(2)], now: NOW })],
      ["empty pr list", pullListCard({ owner: "acme", repo: "desktop", state: "open", page: 1, perPage: 20, pulls: [], now: NOW })],
      ["repo search", repoSearchCard({ query: "q", total: 9, incomplete: false, page: 1, perPage: 5, repos: [], hasNext: true })],
      ["code search", codeSearchCard({ query: "q", total: 0, incomplete: false, page: 1, perPage: 5, hits: [], hasNext: true })],
      ["comment", commentPostedCard({ owner: "acme", repo: "desktop", number: 55, isPullRequest: true, body: "hi", url: "https://github.com/acme/desktop/pull/55#issuecomment-1" })],
      ["review", reviewSubmittedCard({ owner: "acme", repo: "desktop", number: 55, prTitle: "t", commit: "a".repeat(40), body: "b", state: "APPROVED", url: "https://github.com/acme/desktop/pull/55#pullrequestreview-1" })],
      ["connect", connectCard({ stage: "not_connected", connectUrl: "https://connect.composio.dev/link/lk_abc", scopes: ["repo"] })],
      ["disconnected", disconnectedCard({ requestedAt: "t", completedAt: "t", revocation: "revoked", deleted: true })],
    ];
    for (const [name, w] of cards) expect({ name, filler: visibleText(w).match(FILLER)?.[0] ?? null }).toEqual({ name, filler: null });
  });
});

describe("error, connect and policy cards", () => {
  test("an unknown write outcome sends the user to GitHub, not to retry", () => {
    const err = new GithubError({ category: "unknown_outcome", message: "GitHub may have received this action. Check GitHub before trying again." });
    const w = errorCard(err, { target: "acme/desktop#123", openUrl: "https://github.com/acme/desktop/issues/123" });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("GitHub may have received this action. Check GitHub before trying again.");
    expect(hrefs(w)).toEqual(["https://github.com/acme/desktop/issues/123"]);
    expect(text).not.toMatch(/retry|Open GitHub/i);
  });

  test("the connect card discloses the real scope and the eight actions", () => {
    const w = connectCard({ stage: "not_connected", connectUrl: "https://connect.composio.dev/link/lk_abc", scopes: ["repo"] });
    expectValid(w);
    const text = visibleText(w);
    expect(hrefs(w)).toEqual(["https://connect.composio.dev/link/lk_abc"]);
    for (const s of [
      "Connect GitHub",
      "Repo access: your public and private repositories",
    ]) expect(text).toContain(s);
    expect(text).not.toMatch(/Search code|Composio|limits itself|keep logs/);
    expect(text).toContain("⚠️ SOC 2 review pending");
  });

  test("waiting and reconnect stages change the call to action", () => {
    expect(visibleText(connectCard({ stage: "connecting", connectUrl: "https://connect.composio.dev/link/lk_abc", scopes: ["repo"] }))).toContain("Open sign-in again");
    expect(visibleText(connectCard({ stage: "reauth_required", connectUrl: "https://connect.composio.dev/link/lk_abc", scopes: ["repo"] }))).toContain("Reconnect GitHub");
  });

  test("reconnect promises a saved draft only when there is one", () => {
    const base = { stage: "reauth_required" as const, connectUrl: "https://connect.composio.dev/link/lk_abc", scopes: ["repo"] };
    const read = visibleText(connectCard(base));
    expect(read).toContain("GitHub access expired or was revoked.");
    expect(read).not.toContain("draft");
    expect(visibleText(connectCard({ ...base, draftSaved: true }))).toContain("GitHub access expired or was revoked. Your draft is saved.");
  });

  test("a connect link that isn't Composio's is never rendered", () => {
    const w = connectCard({ stage: "not_connected", connectUrl: "https://evil.example/link", scopes: ["repo"] });
    expect(hrefs(w)).toEqual([]);
  });

  test("disconnect without confirmed revocation points to GitHub's authorized apps", () => {
    const w = disconnectedCard({ requestedAt: "t", completedAt: "t", revocation: "failed", deleted: true });
    expect(visibleText(w)).toContain("VoiceOS couldn't confirm GitHub revoked the token.");
    expect(hrefs(w)).toEqual(["https://github.com/settings/applications"]);
    expect(hrefs(disconnectedCard({ requestedAt: "t", completedAt: "t", revocation: "revoked", deleted: true }))).toEqual([]);
  });

  test("disconnecting with no account connected doesn't claim a revocation problem", () => {
    const w = disconnectedCard({ requestedAt: "t", completedAt: "t", revocation: "not_attempted", deleted: false });
    expect(visibleText(w)).toContain("No GitHub account was connected.");
    expect(visibleText(w)).not.toContain("couldn't confirm");
    expect(visibleText(w)).not.toContain("stopped using this account");
    expect(hrefs(w)).toEqual([]);
  });
});

describe("glance envelope", () => {
  test("wraps one widget block within the host's serialized budget", () => {
    const g = glance(issueCard(issue(), "acme", "desktop", NOW));
    expect(g._voiceos_glance.blocks).toHaveLength(1);
    expect(g._voiceos_glance.blocks[0].type).toBe("widget");
    expect(JSON.stringify(g._voiceos_glance).length).toBeLessThan(300_000);
  });
});
