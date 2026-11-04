import { describe, expect, test } from "bun:test";

/** Lines that explain the system instead of showing the change. */
const FILLER = /connected GitHub account|not a review|Saying yes|Click <b>|to send it|notify people|@mention|fetched the PR diff|inline comments|checked for duplicates|Issues only|nothing is sent|shorten it|required unless/i;
import { schemaFor, WRITE_TOOLS } from "../src/catalog.ts";
import { CONFIRM_LOGIC_JS, RECEIPT_CORE_JS, buildConfirmation, type WriteTool } from "../src/confirmations.ts";

const GHC = new Function(`${CONFIRM_LOGIC_JS}\nreturn GHC;`)() as {
  headline(tool: string, args: Record<string, unknown>): string;
  changes(args: Record<string, unknown>): Array<{ field: string; text: string; tone?: string }>;
  problems(tool: string, args: Record<string, unknown>): string[];
};

describe("confirmation headline names the consequence", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["create_pull_request_review", { pull_number: 55, event: "REQUEST_CHANGES" }, "Request changes on #55"],
    ["create_pull_request_review", { pull_number: 55, event: "APPROVE" }, "Approve PR #55"],
    ["create_pull_request_review", { pull_number: 55, event: "COMMENT" }, "Post review comment on #55"],
    ["create_pull_request_review", { pull_number: 55 }, "Choose a review outcome for #55"],
    ["update_issue", { issue_number: 123, state: "closed", state_reason: "completed" }, "Close issue #123 as completed"],
    ["update_issue", { issue_number: 123, state: "closed", state_reason: "not_planned" }, "Close issue #123 as not planned"],
    ["update_issue", { issue_number: 123, state: "closed" }, "Close issue #123"],
    ["update_issue", { issue_number: 123, state: "open" }, "Reopen issue #123"],
    ["update_issue", { issue_number: 123, add_labels: ["urgent"] }, "Update issue #123"],
    ["create_issue", { owner: "acme", repo: "desktop" }, "New issue in acme/desktop"],
    ["create_issue_comment", { issue_number: 123 }, "Comment on #123"],
  ];
  for (const [tool, args, want] of cases) {
    test(`${tool} → ${want}`, () => expect(GHC.headline(tool, args)).toBe(want));
  }
});

describe("update_issue change list shows exactly what will change", () => {
  test("label deltas, replacements and removals", () => {
    expect(GHC.changes({ add_labels: ["urgent"], remove_labels: "wontfix" })).toEqual([{ field: "Labels", text: "Add urgent. Remove wontfix." }]);
    expect(GHC.changes({ labels: ["bug", "urgent"] })).toEqual([{ field: "Labels", text: "Set to exactly: bug, urgent" }]);
    expect(GHC.changes({ labels: [] })).toEqual([{ field: "Labels", text: "Remove every label", tone: "danger" }]);
    expect(GHC.changes({ labels: "" })).toEqual([{ field: "Labels", text: "Remove every label", tone: "danger" }]);
  });

  test("state, assignees, title and body", () => {
    expect(GHC.changes({ state: "closed", state_reason: "not_planned", assignees: [], title: "New", body: "" })).toEqual([
      { field: "State", text: "Closed as not planned" },
      { field: "Assignees", text: "Unassign everyone", tone: "danger" },
      { field: "Title", text: "Rename" },
      { field: "Body", text: "Clear the description", tone: "danger" },
    ]);
    expect(GHC.changes({ add_assignees: ["hubot"] })).toEqual([{ field: "Assignees", text: "Assign hubot." }]);
    expect(GHC.changes({ state: "open" })).toEqual([{ field: "State", text: "Reopened" }]);
  });
});

describe("inline problems the card shows before the user approves", () => {
  test("missing required text", () => {
    expect(GHC.problems("create_issue", { title: "  " })).toEqual(["Add a title before creating the issue."]);
    expect(GHC.problems("create_issue_comment", { body: "" })).toEqual(["Write the comment before posting."]);
    const titled = { pr_title: "Add GitHub linking" };
    expect(GHC.problems("create_pull_request_review", { ...titled, event: "REQUEST_CHANGES", body: " " })).toEqual(["Write the review text first."]);
    expect(GHC.problems("create_pull_request_review", { ...titled, event: "APPROVE" })).toEqual([]);
    expect(GHC.problems("create_pull_request_review", titled)).toEqual(["Choose Comment, Approve, or Request changes."]);
    // A review card always says which PR it's for (Dario, 2026-10-29).
    expect(GHC.problems("create_pull_request_review", { event: "APPROVE", pr_title: " " })).toEqual(["The pull request's title is missing."]);
    expect(GHC.problems("update_issue", { title: "" })).toEqual(["The new title can't be empty."]);
  });

  test("a label named with a comma or line break, which the card would show as two", () => {
    const why = "Label names can't contain commas or line breaks.";
    expect(GHC.problems("create_issue", { title: "t", labels: ["needs, triage"] })).toEqual([why]);
    expect(GHC.problems("update_issue", { add_labels: ["a\nb"] })).toEqual([why]);
    expect(GHC.problems("update_issue", { remove_labels: ["ok"], labels: ["x,y"] })).toEqual([why]);
    expect(GHC.problems("create_issue", { title: "t", labels: "needs, triage" })).toEqual([]);
  });
});

describe("built confirmation views", () => {
  const LABELS: Record<string, string> = {
    create_issue: "Create issue",
    update_issue: "Update issue",
    create_issue_comment: "Post comment",
    create_pull_request_review: "Submit review",
  };
  for (const tool of WRITE_TOOLS) {
    test(`${tool}: a single widget that stages a receipt and only edits real arguments`, () => {
      const view = buildConfirmation(tool as WriteTool);
      expect(view.schemaVersion).toBe(1);
      expect(view.root.type).toBe("widget");
      expect(view.root.confirmLabel).toBe(LABELS[tool]);
      expect(view.root.height).toBeGreaterThanOrEqual(60);
      expect(view.root.height).toBeLessThanOrEqual(420);
      expect(view.root.html.length).toBeLessThan(300_000);
      expect(view.root.html).not.toContain("GH_KEY");
      expect(view.root.html).toContain(RECEIPT_CORE_JS);
      const props = Object.keys((schemaFor(tool).shape as Record<string, unknown>));
      const keys = [...view.root.html.matchAll(/data-gh-key="([^"]+)"/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(props).toContain(key);
      expect(view.root.html).toContain('<div class="gh-soc2" role="note">⚠️ SOC 2 review pending</div>');
      expect(view.root.html).not.toContain("test repositor");
    });
  }

  test("cards show the change and required review warning without explanatory notes", () => {
    for (const tool of WRITE_TOOLS) {
      const html = buildConfirmation(tool as WriteTool).root.html;
      const markup = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
      expect({ tool, filler: markup.match(FILLER)?.[0] ?? null }).toEqual({ tool, filler: null });
      // The script writes text too (headline, change list, problems).
      expect({ tool, filler: html.match(/Saying yes|nothing is sent|edit below|If it changed since|Read the issue first/i)?.[0] ?? null }).toEqual({ tool, filler: null });
    }
  });

  test("every card can point to content below the fold, away from the confirm button", () => {
    for (const tool of WRITE_TOOLS) {
      const html = buildConfirmation(tool as WriteTool).root.html;
      expect(html).toMatch(/<button type="button" class="gh-morehint" id="gh-more" hidden>[\s\S]*?More below<\/button>/);
      expect(html).toMatch(/\.gh-morehint\{[^}]*position:fixed;left:/);
    }
  });

  test("text the user approves is never clipped: every field wraps and grows with its content", () => {
    for (const tool of WRITE_TOOLS) {
      const html = buildConfirmation(tool as WriteTool).root.html;
      expect(html).not.toMatch(/<input class="gh-in"/);
      const fields = [...html.matchAll(/<textarea class="gh-in"[^>]*>/g)].map((m) => m[0]);
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) expect(f).toContain("data-gh-grow");
    }
    const create = buildConfirmation("create_issue").root.html;
    expect(create).toMatch(/<textarea class="gh-in" data-gh-key="title" rows="1" maxlength="240" data-gh-grow data-gh-line>/);
  });

  test("no field takes more than VoiceOS carries as an edit (16,384 characters), and titles stop at 240", () => {
    for (const tool of WRITE_TOOLS) {
      const html = buildConfirmation(tool as never).root.html;
      for (const m of html.matchAll(/<textarea[^>]*data-gh-key="([^"]+)"[^>]*>/g)) {
        const max = m[0].match(/maxlength="(\d+)"/)?.[1];
        expect(max).toBe(m[1] === "title" ? "240" : "16384");
      }
      expect(html).toContain("var EDIT_MAX = 16384;");
    }
  });

  test("the review card names the commit it reviews", () => {
    expect(buildConfirmation("create_pull_request_review").root.html).toContain('<span class="gh-mono" id="gh-sha"></span>');
  });
});
