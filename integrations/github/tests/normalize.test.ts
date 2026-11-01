import { describe, expect, test } from "bun:test";
import {
  normalizeCodeHit,
  normalizeComment,
  normalizeIssue,
  normalizePull,
  normalizeRepo,
  normalizeReview,
  safeGithubUrl,
} from "../src/normalize.ts";

describe("safeGithubUrl", () => {
  test("keeps only https github.com links inside the expected repository", () => {
    expect(safeGithubUrl("https://github.com/acme/desktop/issues/1", "acme", "desktop")).toBe("https://github.com/acme/desktop/issues/1");
    expect(safeGithubUrl("https://github.com/ACME/Desktop/pull/2", "acme", "desktop")).toBe("https://github.com/ACME/Desktop/pull/2");
    expect(safeGithubUrl("https://github.com/evil/desktop/issues/1", "acme", "desktop")).toBeUndefined();
    expect(safeGithubUrl("http://github.com/acme/desktop", "acme", "desktop")).toBeUndefined();
    expect(safeGithubUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeGithubUrl("https://github.com.evil.example/acme/desktop")).toBeUndefined();
    expect(safeGithubUrl("https://github.com/acme/desktop/issues/1#issuecomment-9", "acme", "desktop")).toBe(
      "https://github.com/acme/desktop/issues/1#issuecomment-9",
    );
    expect(safeGithubUrl("https://github.com/qdrant/qdrant")).toBe("https://github.com/qdrant/qdrant");
  });
});

const rawIssue = {
  id: 1, number: 123, title: "Sign-in window freezes", state: "closed", state_reason: "completed", locked: false, comments: 4,
  body: "x".repeat(2000),
  labels: [{ name: "bug", color: "d73a4a" }, { name: "p1", color: "not-a-color" }],
  assignees: [{ login: "hubot" }],
  user: { login: "octocat" },
  html_url: "https://github.com/acme/desktop/issues/123",
  created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-24T10:00:00Z", closed_at: "2026-10-24T10:00:00Z",
};

describe("normalizeIssue", () => {
  test("extracts what the model narrates and bounds the body", () => {
    expect(normalizeIssue(rawIssue, "acme", "desktop")).toEqual({
      number: 123, title: "Sign-in window freezes", state: "closed", state_reason: "completed", is_pull_request: false,
      author: "octocat", labels: [{ name: "bug", color: "d73a4a" }, { name: "p1" }], assignees: ["hubot"], comments: 4, locked: false,
      created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-24T10:00:00Z", closed_at: "2026-10-24T10:00:00Z",
      html_url: "https://github.com/acme/desktop/issues/123", body: "x".repeat(1500), body_truncated: true,
    });
  });

  test("marks pull request issue records", () => {
    const pr = { ...rawIssue, pull_request: { html_url: "https://github.com/acme/desktop/pull/123" }, html_url: "https://github.com/acme/desktop/pull/123" };
    expect(normalizeIssue(pr, "acme", "desktop").is_pull_request).toBe(true);
  });

  test("rejects a payload that isn't an issue", () => {
    expect(() => normalizeIssue({ title: "no number" }, "acme", "desktop")).toThrow("Composio returned an issue this integration could not read.");
  });
});

describe("normalizePull", () => {
  test("a PR description is a short excerpt, like an issue's (Dario: trim payloads to what matters)", () => {
    const p = normalizePull({ number: 55, title: "Retry stalled requests", state: "open", body: "Retry failed requests twice, then show an error.\n" + "x".repeat(6500) }, "acme", "desktop");
    expect(p.body).toStartWith("Retry failed requests twice");
    expect(p.body!.length).toBe(1500);
    expect(p.body_truncated).toBe(true);
  });
  test("captures the head SHA reviews are pinned to", () => {
    expect(normalizePull({
      number: 55, title: "Add GitHub linking", state: "open", draft: true, user: { login: "octocat" },
      head: { ref: "feature-55", sha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" }, base: { ref: "main" }, merged_at: null,
      html_url: "https://github.com/acme/desktop/pull/55", created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-24T00:00:00Z",
    }, "acme", "desktop")).toEqual({
      number: 55, title: "Add GitHub linking", state: "open", status: "draft", merged: false, draft: true, author: "octocat",
      head_ref: "feature-55", head_sha: "abcdef0123456789abcdef0123456789abcdef01", base_ref: "main",
      created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-24T00:00:00Z", html_url: "https://github.com/acme/desktop/pull/55",
    });
  });

  test("a merged PR reads as merged; a missing head SHA stays missing rather than invented", () => {
    const merged = normalizePull({ number: 9, title: "t", state: "closed", user: { login: "a" }, merged_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/acme/desktop/pull/9", created_at: "x", updated_at: "y" }, "acme", "desktop");
    expect(merged.merged).toBe(true);
    expect(merged.head_sha).toBeUndefined();
  });

  test("says when a PR was merged or closed, so 'when was it merged?' needs no web search", () => {
    const merged = normalizePull({ number: 9, title: "t", state: "closed", merged_at: "2026-05-05T12:00:00Z", closed_at: "2026-05-05T12:00:00Z" }, "acme", "desktop");
    expect(merged).toMatchObject({ merged_at: "2026-05-05T12:00:00Z", closed_at: "2026-05-05T12:00:00Z" });
    const closed = normalizePull({ number: 8, title: "t", state: "closed", merged_at: null, closed_at: "2026-05-04T00:00:00Z" }, "acme", "desktop");
    expect(closed).toMatchObject({ closed_at: "2026-05-04T00:00:00Z" });
    expect(closed).not.toHaveProperty("merged_at");
  });

  test("status names the one state people ask about first: open, draft, merged or closed", () => {
    const status = (raw: Record<string, unknown>) => normalizePull({ number: 1, title: "t", ...raw }, "acme", "desktop").status;
    expect(status({ state: "open" })).toBe("open");
    expect(status({ state: "open", draft: true })).toBe("draft");
    expect(status({ state: "closed", merged_at: "2026-10-01T00:00:00Z" })).toBe("merged");
    expect(status({ state: "closed", draft: true, merged_at: null })).toBe("closed");
  });
});

describe("pull request people and labels", () => {
  test("keeps who's asked to review, labels and assignees, as names; absent stays absent", () => {
    const pr = normalizePull({
      number: 7, title: "t", state: "open", user: { login: "a" }, requested_reviewers: [{ login: "alice" }], requested_teams: [{ slug: "core", name: "Core" }],
      labels: [{ name: "bug" }], assignees: [{ login: "bob" }], head: { ref: "x" }, html_url: "https://github.com/acme/desktop/pull/7",
    }, "acme", "desktop");
    expect(pr).toMatchObject({ requested_reviewers: ["alice"], requested_teams: ["core"], labels: ["bug"], assignees: ["bob"] });
    expect(normalizePull({ number: 8, title: "t", state: "open" }, "acme", "desktop")).not.toHaveProperty("requested_reviewers");
  });
});

describe("text that hides from people", () => {
  test("zero-width, direction-override and tag characters are removed from titles, bodies, fragments and descriptions", () => {
    const sneaky = "Fix\u200B login\u202E\u2066 now\uFEFF\u{E0049}\u{E0047}\u{E004E}";
    const issue = normalizeIssue({ ...rawIssue, title: sneaky, body: "Steps\u200B\u{E0041}" }, "acme", "desktop");
    expect(issue.title).toBe("Fix login now");
    expect(issue.body).toBe("Steps");
    expect(normalizePull({ number: 1, title: sneaky, state: "open" }, "acme", "desktop").title).toBe("Fix login now");
    expect(normalizeCodeHit({ path: "a.ts", repository: { full_name: "acme/desktop" }, text_matches: [{ fragment: "x\u200By" }] }).fragment).toBe("xy");
    expect(normalizeRepo({ full_name: "a/b", description: "d\u202Ee" }).description).toBe("de");
    // Joiners that shape real words and emoji stay.
    expect(normalizeIssue({ ...rawIssue, title: "👩\u200D💻 fix" }, "acme", "desktop").title).toBe("👩\u200D💻 fix");
  });

  test("soft hyphens, invisible letter marks, Hangul fillers and supplementary variation selectors go too; subdivision flags stay", () => {
    expect(normalizeIssue({ ...rawIssue, title: "Ship\u00AD it\u061C\u180E\u115F\u1160\u3164\uFFA0\u{E0100}\u{E01EF}" }, "acme", "desktop").title).toBe("Ship it");
    const england = "Go \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(normalizeIssue({ ...rawIssue, title: england }, "acme", "desktop").title).toBe(england);
    expect(normalizeIssue({ ...rawIssue, title: "Hi\u{E0049}\u{E0047}\u{E007F}" }, "acme", "desktop").title).toBe("Hi");
  });
});

describe("normalizeRepo / normalizeCodeHit", () => {
  test("repository facts", () => {
    expect(normalizeRepo({
      full_name: "qdrant/qdrant", description: "Vector search engine", stargazers_count: 21400, forks_count: 1500, language: "Rust",
      private: false, archived: false, fork: false, pushed_at: "2026-10-24T00:00:00Z", html_url: "https://github.com/qdrant/qdrant",
    })).toEqual({
      full_name: "qdrant/qdrant", description: "Vector search engine", stars: 21400, forks: 1500, language: "Rust",
      private: false, archived: false, fork: false, pushed_at: "2026-10-24T00:00:00Z", updated_at: undefined, html_url: "https://github.com/qdrant/qdrant",
    });
  });

  test("code hits keep only fragments GitHub actually returned", () => {
    const hit = { name: "session.ts", path: "src/auth/session.ts", html_url: "https://github.com/acme/desktop/blob/main/src/auth/session.ts", repository: { full_name: "acme/desktop" } };
    expect(normalizeCodeHit(hit)).toEqual({ repository: "acme/desktop", path: "src/auth/session.ts", html_url: "https://github.com/acme/desktop/blob/main/src/auth/session.ts" });
    expect(normalizeCodeHit({ ...hit, text_matches: [{ fragment: "const refreshToken = await rotate()" }] }).fragment).toBe("const refreshToken = await rotate()");
  });

  test("only explicitly public results with a matching immutable URL get a source link", () => {
    const sha = "a".repeat(40);
    const hit = { repository: { full_name: "acme/desktop", private: false }, path: "src/main.ts", html_url: `https://github.com/acme/desktop/blob/${sha}/src/main.ts` };
    expect(normalizeCodeHit(hit).source_url).toBe(`https://raw.githubusercontent.com/acme/desktop/${sha}/src/main.ts`);
    for (const bad of [
      { ...hit, repository: { full_name: "acme/desktop", private: true } },
      { ...hit, repository: { full_name: "acme/desktop" } },
      { ...hit, html_url: "https://github.com/another/repo/blob/" + sha + "/src/main.ts" },
      { ...hit, html_url: "https://github.com/acme/desktop/blob/main/src/main.ts" },
      { ...hit, path: "src/other.ts" },
    ]) expect(normalizeCodeHit(bad).source_url).toBeUndefined();
  });

  test("update and push timestamps keep their distinct GitHub meanings", () => {
    const repo = normalizeRepo({ full_name: "acme/desktop", updated_at: "2026-08-11T00:00:00Z", pushed_at: "2026-10-19T00:00:00Z" });
    expect(repo.updated_at).toBe("2026-08-11T00:00:00Z");
    expect(repo.pushed_at).toBe("2026-10-19T00:00:00Z");
  });

  test("all bounded content excerpts survive and a handler is preferred to an import", () => {
    const imported = "import { app, ipcMain } from 'electron'";
    const handler = "ipcMain.handle('qagent:request', async (event, input) => {\n  assertMainFrame(event);\n  const request = WorkerRequestSchema.parse(input);\n})";
    const hit = normalizeCodeHit({ repository: { full_name: "rishabhcli/QAgent" }, path: "apps/desktop/src/main.ts", text_matches: [{ property: "path", fragment: "main.ts" }, { property: "content", fragment: imported }, { property: "content", fragment: handler }, { fragment: handler }] });
    expect(hit.fragments).toEqual([imported, handler]);
    expect(hit.fragment).toBe(handler);
    expect(hit.fragments_truncated).toBe(false);
    const huge = normalizeCodeHit({ repository: { full_name: "a/b" }, path: "big.ts", text_matches: Array.from({ length: 6 }, (_, n) => ({ fragment: String(n) + "x".repeat(3000) })) });
    expect(huge.fragments).toHaveLength(4);
    expect(huge.fragments!.every((f) => f.length <= 1500)).toBe(true);
    expect(huge.fragments_truncated).toBe(true);
  });
});

describe("write results", () => {
  test("a comment needs an id and a link inside the repo", () => {
    expect(normalizeComment({ id: 9001, html_url: "https://github.com/acme/desktop/issues/123#issuecomment-9001", created_at: "t", user: { login: "me" } }, "acme", "desktop")).toEqual({
      id: 9001, html_url: "https://github.com/acme/desktop/issues/123#issuecomment-9001", created_at: "t", author: "me",
    });
    expect(() => normalizeComment({ html_url: "x" }, "acme", "desktop")).toThrow();
  });

  test("a review reports GitHub's state and the commit it was made at", () => {
    expect(normalizeReview({ id: 88, state: "CHANGES_REQUESTED", commit_id: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", submitted_at: "t", html_url: "https://github.com/acme/desktop/pull/55#pullrequestreview-88", user: { login: "me" } }, "acme", "desktop")).toEqual({
      id: 88, state: "CHANGES_REQUESTED", commit_id: "abcdef0123456789abcdef0123456789abcdef01", submitted_at: "t",
      html_url: "https://github.com/acme/desktop/pull/55#pullrequestreview-88", author: "me",
    });
  });
});
