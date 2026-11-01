import { describe, expect, test } from "bun:test";
import { APPROVED, FACADES, WRITE_TOOLS, schemaFor, semanticCheck, type Facade } from "../src/catalog.ts";

const ok = (tool: string, raw: unknown) => {
  const r = schemaFor(tool as Facade).safeParse(raw);
  if (!r.success) throw new Error(`${tool} rejected: ${r.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data as Record<string, unknown>;
};
const bad = (tool: string, raw: unknown) => schemaFor(tool as Facade).safeParse(raw).success === false;

describe("reviews name the PR they review (Dario, 2026-10-29)", () => {
  test("a review always carries the PR's title, so its card says which PR is approved", () => {
    const review = { owner: "acme", repo: "desktop", pull_number: 55, event: "APPROVE", commit_id: "ab".repeat(20) };
    expect(bad("create_pull_request_review", review)).toBe(true);
    expect(bad("create_pull_request_review", { ...review, pr_title: "   " })).toBe(true);
    expect(ok("create_pull_request_review", { ...review, pr_title: "Add GitHub linking" }).pr_title).toBe("Add GitHub linking");
  });
});

describe("PR summaries (live, 2026-10-28)", () => {
  test("a summary may name a repository; links and HTML are still refused", () => {
    const base = { owner: "acme", repo: "desktop", presentation_token: "a".repeat(36) };
    expect(semanticCheck("list_pull_requests", { ...base, summary: "There are 8 open pull requests in rishabhcli/QAgent, all from Dependabot." })).toEqual({ ok: true });
    for (const summary of ["See https://example.com", "Details on github.com/acme/desktop", "Use <b>this</b>"]) {
      expect(semanticCheck("list_pull_requests", { ...base, summary }).ok).toBe(false);
    }
  });
});

describe("approved catalog", () => {
  test("exactly the eight approved facades map to their Composio slugs", () => {
    expect(APPROVED).toEqual({
      create_issue: "GITHUB_CREATE_AN_ISSUE",
      update_issue: "GITHUB_UPDATE_AN_ISSUE",
      get_issue: "GITHUB_GET_AN_ISSUE",
      create_issue_comment: "GITHUB_CREATE_AN_ISSUE_COMMENT",
      list_pull_requests: "GITHUB_LIST_PULL_REQUESTS",
      create_pull_request_review: "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST",
      search_repositories: "GITHUB_SEARCH_REPOSITORIES",
      search_code: "GITHUB_SEARCH_CODE",
    });
    expect<string[]>([...FACADES].sort()).toEqual(Object.keys(APPROVED).sort());
    expect([...WRITE_TOOLS].sort()).toEqual(
      ["create_issue", "create_issue_comment", "create_pull_request_review", "update_issue"],
    );
  });
});

describe("shape validation (strict facades)", () => {
  test("extra fields are rejected on every facade", () => {
    expect(bad("get_issue", { owner: "acme", repo: "desktop", issue_number: 1, toolSlug: "GITHUB_DELETE_A_REPO" })).toBe(true);
    expect(bad("search_code", { q: "token", connected_account_id: "ca_x" })).toBe(true);
    expect(bad("create_pull_request_review", {
      owner: "a", repo: "b", pull_number: 1, event: "COMMENT", body: "x",
      commit_id: "a".repeat(40), comments: [{ path: "f", body: "x" }],
    })).toBe(true);
  });

  test("owner and repo must be names, not URLs or owner/repo pairs", () => {
    expect(bad("get_issue", { owner: "https://github.com/acme", repo: "desktop", issue_number: 1 })).toBe(true);
    expect(bad("get_issue", { owner: "acme/desktop", repo: "desktop", issue_number: 1 })).toBe(true);
    expect(bad("get_issue", { owner: "acme", repo: "desktop.git", issue_number: 1 })).toBe(true);
    expect(bad("get_issue", { owner: "acme", repo: "..", issue_number: 1 })).toBe(true);
    expect(bad("get_issue", { owner: "   ", repo: "desktop", issue_number: 1 })).toBe(true);
    expect(ok("get_issue", { owner: " my-org_x ", repo: "Desk.top-1_2", issue_number: 7 })).toEqual({
      owner: "my-org_x", repo: "Desk.top-1_2", issue_number: 7,
    });
  });

  test("numbers accept numeric strings (card edits arrive as text) but not junk", () => {
    expect(ok("get_issue", { owner: "a", repo: "b", issue_number: "0042" }).issue_number).toBe(42);
    for (const n of [0, -3, 1.5, "12a", "", null, 2 ** 40]) {
      expect(bad("get_issue", { owner: "a", repo: "b", issue_number: n })).toBe(true);
    }
  });

  test("label and assignee lists accept arrays or comma text and are normalized", () => {
    const a = ok("create_issue", {
      owner: "acme", repo: "desktop", title: "  Crash  ",
      labels: "bug, urgent,BUG", assignees: ["octocat", " hubot "],
    });
    expect(a.title).toBe("Crash");
    expect(a.labels).toEqual(["bug", "urgent"]);
    expect(a.assignees).toEqual(["octocat", "hubot"]);
    expect(bad("create_issue", { owner: "a", repo: "b", title: "t", labels: Array.from({ length: 21 }, (_, i) => `l${i}`) })).toBe(true);
    expect(bad("create_issue", { owner: "a", repo: "b", title: "t", labels: ["x".repeat(51)] })).toBe(true);
    expect(bad("create_issue", { owner: "a", repo: "b", title: "t", assignees: ["not a login!"] })).toBe(true);
  });

  test("a label name can't hold a comma or line break, which a card edit would split into two labels", () => {
    const named = schemaFor("create_issue").safeParse({ owner: "a", repo: "b", title: "t", labels: ["needs, triage"] });
    expect(named.success).toBe(false);
    expect(named.error!.issues[0].message).toBe("Label names can't contain commas or line breaks.");
    expect(bad("update_issue", { owner: "a", repo: "b", issue_number: 1, expected_updated_at: "2026-10-24T00:00:00Z", add_labels: ["a\nb"] })).toBe(true);
    expect(ok("create_issue", { owner: "a", repo: "b", title: "t", labels: "needs, triage" }).labels).toEqual(["needs", "triage"]);
  });

  test("text bodies are normalized and size-limited", () => {
    expect(ok("create_issue_comment", { owner: "a", repo: "b", issue_number: 1, body: "line1\r\nline2  " }).body).toBe("line1\nline2");
    expect(bad("create_issue_comment", { owner: "a", repo: "b", issue_number: 1, body: "x".repeat(20_001) })).toBe(true);
    expect(bad("create_issue", { owner: "a", repo: "b", title: "x".repeat(241) })).toBe(true);
  });

  test("review event is case-insensitive and commit must be a full SHA", () => {
    const r = ok("create_pull_request_review", {
      owner: "a", repo: "b", pull_number: "55", event: "request_changes", body: "Add a test.", pr_title: "Add linking",
      commit_id: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    });
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.commit_id).toBe("abcdef0123456789abcdef0123456789abcdef01");
    expect(bad("create_pull_request_review", { owner: "a", repo: "b", pull_number: 1, event: "COMMENT", body: "x", commit_id: "abc1234" })).toBe(true);
    expect(bad("create_pull_request_review", { owner: "a", repo: "b", pull_number: 1, event: "DISMISS", body: "x", commit_id: "a".repeat(40) })).toBe(true);
    expect(bad("create_pull_request_review", { owner: "a", repo: "b", pull_number: 1, body: "x", commit_id: "a".repeat(40) })).toBe(true);
  });

  test("read facades apply the plan's product defaults", () => {
    // A page is the card's three rows, so "more" shows the next ones (user, 2026-10-28).
    expect(ok("list_pull_requests", { owner: "acme", repo: "desktop" })).toEqual({
      owner: "acme", repo: "desktop", state: "open", sort: "updated", direction: "desc", page: 1, per_page: 3,
    });
    expect(ok("search_repositories", { q: "vector database" })).toEqual({ q: "vector database", page: 1, per_page: 5 });
    expect(bad("list_pull_requests", { owner: "a", repo: "b", per_page: 101 })).toBe(true);
    expect(bad("search_code", { q: "x", sort: "indexed" })).toBe(true);
  });
});

describe("semantic rules", () => {
  const base = { owner: "acme", repo: "desktop", issue_number: 123, expected_updated_at: "2026-10-24T20:11:03Z" };

  test("update_issue needs at least one explicit change", () => {
    expect(semanticCheck("update_issue", ok("update_issue", base))).toEqual({
      ok: false, field: "state", message: "Say what to change: title, body, state, labels, or assignees.",
    });
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, state: "closed" }))).toEqual({ ok: true });
  });

  test("state_reason must pair with a matching state", () => {
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, state_reason: "completed" }))).toMatchObject({ ok: false, modelOnly: true });
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, state: "open", state_reason: "completed" })).ok).toBe(false);
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, state: "closed", state_reason: "reopened" })).ok).toBe(false);
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, state: "closed", state_reason: "not_planned" })).ok).toBe(true);
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, state: "open", state_reason: "reopened" })).ok).toBe(true);
  });

  test("replacing and editing the same list in one call is ambiguous", () => {
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, labels: ["a"], add_labels: ["b"] }))).toEqual({
      ok: false, field: "labels", message: "Use either labels (replace all) or add_labels/remove_labels, not both.", modelOnly: true,
    });
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, assignees: [], remove_assignees: ["x"] }))).toMatchObject({ ok: false, modelOnly: true });
  });

  test("an update cannot blank the title, and a stale-check timestamp must be a date", () => {
    expect(semanticCheck("update_issue", ok("update_issue", { ...base, title: "   " }))).toEqual({
      ok: false, field: "title", message: "The new title can't be empty.",
    });
    expect(bad("update_issue", { ...base, expected_updated_at: "yesterday", state: "closed" })).toBe(true);
  });

  test("comments and change requests need text; approval may be silent", () => {
    expect(semanticCheck("create_issue_comment", ok("create_issue_comment", { owner: "a", repo: "b", issue_number: 1, body: "  " }))).toEqual({
      ok: false, field: "body", message: "The comment is empty.",
    });
    const review = { owner: "a", repo: "b", pull_number: 1, pr_title: "Fix", commit_id: "a".repeat(40) };
    expect(semanticCheck("create_pull_request_review", ok("create_pull_request_review", { ...review, event: "REQUEST_CHANGES", body: "" }))).toEqual({
      ok: false, field: "body", message: "Requesting changes needs review text.",
    });
    expect(semanticCheck("create_pull_request_review", ok("create_pull_request_review", { ...review, event: "COMMENT" }))).toMatchObject({ ok: false });
    expect(semanticCheck("create_pull_request_review", ok("create_pull_request_review", { ...review, event: "APPROVE" }))).toEqual({ ok: true });
  });

  test("create_issue needs a title the user didn't blank on the card", () => {
    expect(semanticCheck("create_issue", ok("create_issue", { owner: "a", repo: "b", title: " " }))).toEqual({
      ok: false, field: "title", message: "The issue needs a title.",
    });
  });

  test("code search needs a real search term, not only qualifiers", () => {
    expect(semanticCheck("search_code", ok("search_code", { q: "repo:acme/desktop language:ts" }))).toEqual({
      ok: false, field: "q", message: "Add a search term: qualifiers like repo: or language: alone can't be searched.",
    });
    expect(semanticCheck("search_code", ok("search_code", { q: "refreshToken repo:acme/desktop" }))).toEqual({ ok: true });
    expect(semanticCheck("search_code", ok("search_code", { q: '"exact phrase" path:src' }))).toEqual({ ok: true });
  });

  test("search pagination stays inside GitHub's 1,000-result window", () => {
    expect(semanticCheck("search_repositories", ok("search_repositories", { q: "x", page: 11, per_page: 100 }))).toEqual({
      ok: false, field: "page", message: "GitHub search returns at most 1,000 results; this page is past that.",
    });
    expect(semanticCheck("search_code", ok("search_code", { q: "x", page: 10, per_page: 100 }))).toEqual({ ok: true });
    // The last partial page (results 991–1,000) is still inside the window.
    expect(semanticCheck("search_code", ok("search_code", { q: "x", page: 34, per_page: 30 }))).toEqual({ ok: true });
    expect(semanticCheck("search_code", ok("search_code", { q: "x", page: 35, per_page: 30 })).ok).toBe(false);
  });
});

describe("receipt canonical form survives schema parsing", () => {
  const { receiptCore } = require("../src/receiptCore.ts");
  const cases: Array<[string, Record<string, unknown>]> = [
    ["create_issue", { owner: " Acme ", repo: "Desktop", title: " Crash on launch\r\n", body: "Steps:\r\n1. Open\r\n2. Café ✨  ", labels: "bug, Bug ,urgent", assignees: ["octocat"] }],
    ["update_issue", { owner: "acme", repo: "desktop", issue_number: "0123", expected_updated_at: " 2026-10-24T20:11:03Z ", state: "closed", state_reason: "completed", add_labels: "done" }],
    ["update_issue", { owner: "acme", repo: "desktop", issue_number: 9, expected_updated_at: "2026-10-24T20:11:03Z", body: "", labels: [] }],
    ["create_issue_comment", { owner: "acme", repo: "desktop", issue_number: 123, body: "  I can reproduce this on version 1.4.\r\n" }],
    ["create_pull_request_review", { owner: "acme", repo: "desktop", pull_number: "55", event: "request_changes", body: "Please add a test for token revocation.", commit_id: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", pr_title: "Add GitHub linking " }],
  ];
  for (const [tool, raw] of cases) {
    test(`${tool}: canonical(raw) === canonical(parsed)`, () => {
      const parsed = schemaFor(tool as Facade).parse(raw) as Record<string, unknown>;
      expect(receiptCore.canonical(tool, parsed)).toBe(receiptCore.canonical(tool, raw));
    });
  }
});
