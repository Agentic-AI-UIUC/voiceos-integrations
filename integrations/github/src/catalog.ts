/**
 * The approved tool catalog: exactly eight VoiceOS facades, each mapped to one
 * Composio GitHub tool. Nothing else is registered, forwarded, or reachable —
 * no generic slug argument, proxy, or meta tool exists anywhere in this server.
 *
 * Schemas are strict (unknown keys rejected) and deliberately narrower than
 * the upstream tools: no inline review comments, no milestones, no deprecated
 * singular `assignee`, no deprecated code-search sorting.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { receiptCore } from "./receiptCore.ts";

export const APPROVED = {
  create_issue: "GITHUB_CREATE_AN_ISSUE",
  update_issue: "GITHUB_UPDATE_AN_ISSUE",
  get_issue: "GITHUB_GET_AN_ISSUE",
  create_issue_comment: "GITHUB_CREATE_AN_ISSUE_COMMENT",
  list_pull_requests: "GITHUB_LIST_PULL_REQUESTS",
  create_pull_request_review: "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST",
  search_repositories: "GITHUB_SEARCH_REPOSITORIES",
  search_code: "GITHUB_SEARCH_CODE",
} as const;

/** SHA-256 of a JSON schema in canonical form (object keys sorted), so key order never counts as a change. */
export function schemaHash(schema: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") {
      const keys = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(schema)).digest("hex");
}

/**
 * The eight upstream input schemas this integration was built and reviewed
 * against (plan §3): captured from a live Composio session's tools/list on
 * 2026-10-24, when Composio's catalog reported version 20261023_00. Every new
 * session compares against these and records a change for review in the
 * audit log; changes that no longer fit what this integration sends make that
 * tool unavailable (composio.ts checkToolSchema).
 */
export interface UpstreamSnapshot {
  catalogVersion: string;
  recordedAt: string;
  inputSchemaSha256: Record<Slug, string>;
}

export const UPSTREAM_SNAPSHOT: UpstreamSnapshot = {
  catalogVersion: "20261023_00",
  recordedAt: "2026-10-24",
  inputSchemaSha256: {
    GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST: "f65b294a3a9c7545600143d266274426fa35dea797c101e1716f0a65c44763e0",
    GITHUB_CREATE_AN_ISSUE: "7f0428e7c2ec68a1bf507c673ea9b933fa3def240b38b95b8df2701371b0fe67",
    GITHUB_CREATE_AN_ISSUE_COMMENT: "df4d54806f0101d8f1f9c33175c071d3c814225ce89a2fb783ea9a90dd3def2c",
    GITHUB_GET_AN_ISSUE: "cd682da8b96b9242def575b52446dab6a683c2fd5220a3e59d7add6e9a2027eb",
    GITHUB_LIST_PULL_REQUESTS: "b9465f4cc4741ccc423ecc7b46168da8237da2d2d8cbd9a9742d8a10320d2f43",
    GITHUB_SEARCH_CODE: "a9cc75cbe87a88180ba00e1de2af9c2df45d3f085981bca088697e001a756e6e",
    GITHUB_SEARCH_REPOSITORIES: "093ebe0fe204a07e6b67c08eb2032d3e347ddb4d0eaff2db09af214ba7503b2d",
    GITHUB_UPDATE_AN_ISSUE: "7ddb64deb065ead255123ca67cab983cee90a5958d36491947a86f40cb0b834b",
  },
};

export type Facade = keyof typeof APPROVED;
export type Slug = (typeof APPROVED)[Facade];

export const FACADES = Object.keys(APPROVED) as Facade[];
export const WRITE_TOOLS: ReadonlySet<Facade> = new Set<Facade>([
  "create_issue",
  "update_issue",
  "create_issue_comment",
  "create_pull_request_review",
]);
export const isWriteTool = (tool: string): tool is Facade => WRITE_TOOLS.has(tool as Facade);

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_INT = 2_147_483_647;

const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);
const numeric = (v: unknown) => (typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v.trim()) : v);
const textOf = (v: unknown) => (typeof v === "string" ? receiptCore.normText(v) : v);
const bodyOf = (v: unknown) => (typeof v === "string" ? receiptCore.normBody(v) : v);

const owner = () =>
  z
    .preprocess(
      trimmed,
      z
        .string()
        .min(1, "owner is required.")
        .refine((v) => !/[/:]/.test(v) && !/github\.com/i.test(v), "Pass only the owner name (e.g. 'acme'), not a URL or owner/repo.")
        .refine((v) => /[/:]/.test(v) || LOGIN.test(v), "owner must be a GitHub user or organization name."),
    )
    .describe("Repository owner: the user or organization, e.g. 'acme' in github.com/acme/desktop.");

const repo = () =>
  z
    .preprocess(
      trimmed,
      z
        .string()
        .min(1, "repo is required.")
        .refine((v) => !/\.git$/i.test(v), "Drop the .git suffix from repo.")
        .refine((v) => REPO.test(v) && v !== "." && v !== "..", "repo must be a repository name, e.g. 'desktop'."),
    )
    .describe("Repository name, e.g. 'desktop' in github.com/acme/desktop (no .git, no owner).");

/**
 * Reads take a repository as the user said it ("live check", "desktop"), with
 * or without its owner; the gateway resolves it against the repositories in
 * use and asks when it can't tell (gateway.resolveRepo). Writes keep the
 * exact owner and name, because the confirmation card shows and signs them.
 */
const saidOwner = () =>
  owner()
    .optional()
    .describe("Repository owner, e.g. 'acme'. Leave it out when the user named only the repository.");

const saidRepo = () =>
  z
    .preprocess(
      trimmed,
      z
        .string()
        .min(1, "repo is required.")
        .refine((v) => !/\.git$/i.test(v), "Drop the .git suffix from repo.")
        .refine((v) => /^[A-Za-z0-9._ -]{1,100}$/.test(v) && v !== "." && v !== "..", "repo must be a repository name, e.g. 'desktop'."),
    )
    .describe("The repository name as the user said it, e.g. 'desktop' or 'live check'. It is matched against the account's repositories, so a misheard or partial name works.");

const positiveInt = (description: string) =>
  z.preprocess(numeric, z.number().int().positive().max(MAX_INT)).describe(description);

const boundedInt = (min: number, max: number, fallback: number, description: string) =>
  z.preprocess(numeric, z.number().int().min(min).max(max)).default(fallback).describe(description);

const text = (max: number) => z.preprocess(textOf, z.string().max(max, `Keep it under ${max.toLocaleString("en-US")} characters.`));
// Markdown keeps its first line's indentation (an indented code block).
const markdown = (max: number) => z.preprocess(bodyOf, z.string().max(max, `Keep it under ${max.toLocaleString("en-US")} characters.`));

// Lists arrive as arrays from the model, or as comma-separated text when the
// user edits them on a confirmation card.
const list = (item: z.ZodString, maxItems: number) =>
  z
    .union([z.array(z.string()), z.string()])
    .transform((v) => receiptCore.normList(v))
    .pipe(z.array(item).max(maxItems, `At most ${maxItems} entries.`));

// A comma or line break inside one label would show as two labels on the card, where edits are comma text.
const labelList = () =>
  list(z.string().max(50, "Label names are at most 50 characters.").regex(/^[^,\r\n]*$/, "Label names can't contain commas or line breaks."), 20);
const loginList = () => list(z.string().regex(LOGIN, "Assignees must be GitHub logins."), 10);

const receipt = () =>
  z
    .string()
    .max(200)
    .optional()
    .describe("Leave empty. The confirmation card fills this in when the user approves; calls without it are refused.");

// ---------------------------------------------------------------------------
// Facade schemas
// ---------------------------------------------------------------------------

const schemas = {
  get_issue: z
    .object({
      owner: saidOwner(),
      repo: saidRepo(),
      issue_number: positiveInt("Issue number, e.g. 123 for github.com/acme/desktop/issues/123."),
    })
    .strict(),

  list_pull_requests: z
    .object({
      owner: saidOwner(),
      repo: saidRepo()
        .optional()
        .describe("The repository name as the user said it, e.g. 'desktop' or 'live check'. It is matched against the account's repositories, so a misheard or partial name works. Leave it out, with owner, for the account's own open pull requests across its repositories."),
      pull_number: positiveInt("One pull request number: returns just that PR, in any state, with its head_sha. Use it before reviewing.")
        .optional()
        .describe("One pull request number: returns just that PR, in any state, with its head_sha. Use it before reviewing."),
      presentation_token: z.string().regex(/^[0-9a-f]{36}$/).optional().describe("Copy summary_request.arguments.presentation_token from the preceding result to add your summary beneath its PR card. Reuses those exact facts without another GitHub request."),
      summary: text(280).optional().describe("Your one or two short sentences answering the user's question from the returned PR description and metadata. Plain language, no links or file paths. Requires presentation_token; never invent diff details or claim tests passed unless the description says so."),
      state: z.enum(["open", "closed", "all"]).default("open").describe("open (default), closed, or all."),
      base: z
        .preprocess(trimmed, z.string().min(1).max(255).regex(/^[^\s~^:?*[\\]+$/, "base must be a branch name."))
        .optional()
        .describe("Only PRs merging into this branch, e.g. 'main'."),
      head: z
        .preprocess(trimmed, z.string().min(1).max(255).regex(/^[^\s~^?*[\\]+$/, "head must be a branch, or user:branch."))
        .optional()
        .describe("Only PRs from this branch, as 'user:branch' or 'branch'."),
      sort: z
        .enum(["created", "updated", "popularity", "long-running"])
        .default("updated")
        .describe("updated (default), created, popularity, or long-running."),
      direction: z.enum(["asc", "desc"]).default("desc").describe("desc (default) or asc."),
      page: boundedInt(1, 100, 1, "Page number, starting at 1. Each page is the PRs on the card; for more, repeat the call with page+1."),
      // A page is the card's rows (PULL_ROWS in cards.ts), whatever is asked, so the next page is the next rows on it.
      per_page: boundedInt(1, 100, 3, "PRs per page: up to 3, the rows the card shows (default 3). Larger values give 3."),
      author: z
        .preprocess(trimmed, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}(\[bot\])?$/, "author must be a GitHub login."))
        .optional()
        .describe("Optional GitHub login. Keeps only this person's PRs, looking through the 300 most recent that match the other filters. Use only when the user named the author."),
    })
    .strict(),

  search_repositories: z
    .object({
      q: z
        .preprocess(textOf, z.string().min(1, "Search for something.").max(256))
        .optional()
        .describe("New search only: preserve owner, language and visibility qualifiers. For 'my repositories', reuse the known GitHub owner; ask if unknown. Omit q when using cursor."),
      cursor: z.string().regex(/^[0-9a-f]{36}$/).optional().describe("For 'next five' or 'next page', copy next.arguments.cursor from the preceding result. Send cursor alone; it preserves the exact query, filters, sort and displayed position."),
      include_forks: z.boolean().optional().describe("Set true when the user asks to include forks (adds fork:true), false to exclude them. Leave visibility unfiltered to include both public and private repositories."),
      sort: z
        .enum(["stars", "forks", "help-wanted-issues", "updated", "created"])
        .optional()
        .describe("Sort by stars, forks, help-wanted-issues, updated, or created. Omit for best match."),
      order: z.enum(["desc", "asc"]).optional().describe("desc or asc; only used with sort."),
      page: boundedInt(1, 100, 1, "Page number, starting at 1."),
      per_page: boundedInt(1, 100, 5, "Page size, 1-100 (default 5). Use the requested count, e.g. 5 for 'five'. The card and result show at most five at a time; next preserves the undisplayed rows."),
    })
    .strict(),

  search_code: z
    .object({
      q: z
        .preprocess(textOf, z.string().min(1, "Search for something.").max(256))
        .optional()
        .describe(
          "Search terms plus repo:owner/name for the intended repository. This is REST code search: use literal terms, not symbol: or content:. Fork search may miss files even on the default branch. Omit q when using cursor.",
        ),
      cursor: z.string().regex(/^[0-9a-f]{36}$/).optional().describe("For more results, copy next.arguments.cursor and send cursor alone. Preserves the query and displayed position."),
      intent: z.enum(["locate", "explain"]).optional().describe("Use explain for implementation questions or requested code snippets. Use returned fragments, or read a returned public source_url with VoiceOS's web reader. Never infer behavior from names. Private source without fragments is unavailable. At most one search refinement."),
      page: boundedInt(1, 100, 1, "Page number, starting at 1."),
      per_page: boundedInt(1, 100, 5, "Page size, 1-100 (default 5). Use the requested count; the result and card show at most five rows together."),
    })
    .strict(),

  create_issue: z
    .object({
      owner: owner(),
      repo: repo(),
      title: text(240).describe("Issue title in the user's words."),
      body: markdown(20_000).optional().describe("Issue description (Markdown). Only what the user said or asked for."),
      labels: labelList().optional().describe("Labels to apply, e.g. ['bug']. Only if the user asked; never invent labels."),
      assignees: loginList().optional().describe("GitHub logins to assign. Only if the user asked."),
      confirmation_receipt: receipt(),
    })
    .strict(),

  update_issue: z
    .object({
      owner: owner(),
      repo: repo(),
      issue_number: positiveInt("Issue number to change."),
      expected_updated_at: z
        .preprocess(
          trimmed,
          z
            .string()
            .max(40)
            .refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)), "expected_updated_at must be the updated_at value from get_issue."),
        )
        .describe("updated_at from get_issue for this issue, copied unchanged. Detects edits made while the user was reviewing."),
      issue_title: text(256).optional().describe("The issue's current title from get_issue. Shown on the card and checked before sending."),
      title: text(240).optional().describe("New title, only if the user asked to rename the issue."),
      body: markdown(20_000).optional().describe('New description replacing the old one ("" clears it). Only if the user asked.'),
      state: z.enum(["open", "closed"]).optional().describe("'closed' to close the issue, 'open' to reopen it."),
      state_reason: z
        .enum(["completed", "not_planned", "reopened"])
        .optional()
        .describe("With state 'closed': completed or not_planned. With state 'open': reopened."),
      labels: labelList().optional().describe("Replace ALL labels with exactly this list ([] removes every label)."),
      add_labels: labelList().optional().describe("Labels to add, keeping the existing ones."),
      remove_labels: labelList().optional().describe("Labels to remove, keeping the rest."),
      assignees: loginList().optional().describe("Replace ALL assignees with exactly these logins ([] unassigns everyone)."),
      add_assignees: loginList().optional().describe("Logins to assign, keeping current assignees."),
      remove_assignees: loginList().optional().describe("Logins to unassign, keeping the rest."),
      confirmation_receipt: receipt(),
    })
    .strict(),

  create_issue_comment: z
    .object({
      owner: owner(),
      repo: repo(),
      issue_number: positiveInt("Issue or pull request number to comment on."),
      issue_title: text(256).optional().describe("The issue or PR title from get_issue, shown on the card and checked before sending."),
      body: markdown(20_000).describe("Exact comment text (Markdown), as the user said it."),
      confirmation_receipt: receipt(),
    })
    .strict(),

  create_pull_request_review: z
    .object({
      owner: owner(),
      repo: repo(),
      pull_number: positiveInt("Pull request number."),
      event: z
        .preprocess(
          (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
          z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
        )
        .describe("COMMENT, APPROVE, or REQUEST_CHANGES: exactly what the user asked for. Never assume APPROVE."),
      body: markdown(20_000).optional().describe("Review text written or dictated by the user. Required for COMMENT and REQUEST_CHANGES."),
      commit_id: z
        .preprocess(
          (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
          z.string().regex(SHA, "commit_id must be the PR's full head_sha from list_pull_requests (40 hex characters)."),
        )
        .describe("head_sha of this pull request from list_pull_requests, copied unchanged."),
      // Required: the card names the PR it reviews, so nobody approves the wrong one (Dario, 2026-10-29).
      pr_title: z
        .preprocess(textOf, z.string().min(1, "Look up the PR with list_pull_requests and pass its title.").max(256))
        .describe("The PR title from list_pull_requests. Shown on the card and checked against GitHub before sending."),
      confirmation_receipt: receipt(),
    })
    .strict(),
} satisfies Record<Facade, z.ZodTypeAny>;

export type FacadeArgs = { [K in Facade]: z.infer<(typeof schemas)[K]> };

export function schemaFor<T extends Facade>(tool: T): (typeof schemas)[T] {
  return schemas[tool];
}

// ---------------------------------------------------------------------------
// Semantic rules — checked in the handler so the user gets a card explaining
// what to fix, instead of a schema error only the model sees.
// ---------------------------------------------------------------------------

/** `modelOnly` marks a malformed call the model fixes itself, which the user never needs to hear about. */
export type SemanticResult = { ok: true } | { ok: false; field: string; message: string; modelOnly?: true };

const OK: SemanticResult = { ok: true };
const fail = (field: string, message: string): SemanticResult => ({ ok: false, field, message });
const malformed = (field: string, message: string): SemanticResult => ({ ok: false, field, message, modelOnly: true });
const present = (v: unknown) => v !== undefined && v !== null;

/** True when a code search query has at least one term that isn't a qualifier. */
function hasSearchTerm(q: string): boolean {
  const tokens = q.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.some((token) => {
    if (/^"[^"]*"$/.test(token)) return token.length > 2;
    if (/^(AND|OR|NOT)$/.test(token)) return false;
    return !/^-?[A-Za-z_]+:/.test(token);
  });
}

export function semanticCheck(tool: Facade, args: Record<string, any>): SemanticResult {
  if (tool === "list_pull_requests" && (args.presentation_token !== undefined || args.summary !== undefined)) {
    if (!args.presentation_token || !args.summary) return malformed("summary", "A card summary needs both presentation_token and summary. First read the PR, then copy summary_request.arguments and add your summary. Nothing changes on GitHub.");
    // owner/repo is fine on the card; links and markup aren't.
    if (/https?:|github\.com|<[^>]+>/.test(args.summary)) return malformed("summary", "Rewrite the summary as one or two plain-language sentences, without links or HTML. Keep the same presentation token.");
  }
  // No repository: the account's own open pull requests, across the repositories it owns.
  if (tool === "list_pull_requests" && args.repo === undefined && !args.presentation_token) {
    if (present(args.owner)) return malformed("repo", "Name the repository too. Without owner and repo, this lists the account's own open pull requests across the repositories it owns.");
    if (present(args.pull_number)) return malformed("repo", "A pull request number needs its repository: pass owner and repo.");
    if (args.state !== "open") return malformed("state", "Across repositories only open pull requests are listed. For closed ones, name the repository.");
  }
  if (tool === "search_code" || tool === "search_repositories") {
    if (args.cursor) {
      return ["q", "sort", "order", "include_forks", "intent"].some((key) => present(args[key]))
        ? malformed("cursor", "Send only cursor for a continuation. To change filters, start a new search with q; that starts at the first result.")
        : OK;
    }
    if (!args.q) return malformed("q", "A new search needs q. For a continuation, use the previous result's next.arguments unchanged.");
  }
  switch (tool) {
    case "create_issue":
      return args.title ? OK : fail("title", "The issue needs a title.");

    case "update_issue": {
      // A reason without the state change it belongs to is the model's slip, not a question for the user.
      if (present(args.state_reason)) {
        if (!present(args.state)) return malformed("state_reason", `state_reason '${args.state_reason}' needs a state change too.`);
        const wants = args.state_reason === "reopened" ? "open" : "closed";
        if (args.state !== wants) return malformed("state_reason", `state_reason '${args.state_reason}' only applies with state '${wants}'.`);
      }
      const changeFields = ["title", "body", "state", "labels", "add_labels", "remove_labels", "assignees", "add_assignees", "remove_assignees"];
      if (!changeFields.some((f) => present(args[f]))) {
        return fail("state", "Say what to change: title, body, state, labels, or assignees.");
      }
      if (present(args.title) && !args.title) return fail("title", "The new title can't be empty.");
      if (present(args.labels) && (present(args.add_labels) || present(args.remove_labels))) {
        return malformed("labels", "Use either labels (replace all) or add_labels/remove_labels, not both.");
      }
      if (present(args.assignees) && (present(args.add_assignees) || present(args.remove_assignees))) {
        return malformed("assignees", "Use either assignees (replace all) or add_assignees/remove_assignees, not both.");
      }
      return OK;
    }

    case "create_issue_comment":
      return args.body ? OK : fail("body", "The comment is empty.");

    case "create_pull_request_review":
      if (args.event === "REQUEST_CHANGES" && !args.body) return fail("body", "Requesting changes needs review text.");
      if (args.event === "COMMENT" && !args.body) return fail("body", "A review comment needs text.");
      return OK;

    case "search_code":
      if (/(?:^|\s)(?:symbol|content):/i.test(args.q)) {
        return malformed("q", "This integration uses GitHub's REST code search, which doesn't support symbol: or content:. Search for the literal name with the same repo qualifier. This was rejected locally; no GitHub request was made.");
      }
      if (!hasSearchTerm(args.q)) {
        return fail("q", "Add a search term: qualifiers like repo: or language: alone can't be searched.");
      }
      return withinSearchWindow(args);

    case "search_repositories":
      return withinSearchWindow(args);

    default:
      return OK;
  }
}

/** GitHub search serves the first 1,000 results; a page that starts inside them is fine, even if it ends past. */
function withinSearchWindow(args: Record<string, any>): SemanticResult {
  return (args.page - 1) * args.per_page >= 1000
    ? fail("page", "GitHub search returns at most 1,000 results; this page is past that.")
    : OK;
}

// ---------------------------------------------------------------------------
// Titles and descriptions — the model's routing rules. Each says what the tool
// does, when to use it, and the neighbouring actions it can't do.
// ---------------------------------------------------------------------------

/**
 * Ends every description. VoiceOS shows the agent only tool descriptions and
 * results (never MCP server instructions), so how to answer aloud, and that
 * GitHub connects on this app's own card, has to be said here. Reads answer
 * the question; changes report what happened and stop.
 */
// Descriptions say what each tool does, when it fits, and what comes back.
// VoiceOS's share review rejects descriptions that steer the agent (how to
// phrase its reply, which other tools to avoid), so the facts the agent needs
// are stated as facts about the result.
const READ_RESULT = " Returns the facts as data, each item with its GitHub link, and a card.";
const WRITE_RESULT =
  " VoiceOS shows a confirmation card first and sends the change only when its button is clicked. Returns what was created or changed, with its GitHub link.";
const CONNECT = " If GitHub isn't connected, the result is a Connect GitHub card.";

const META: Record<Facade, { title: string; description: string }> = {
  get_issue: {
    title: "Get issue",
    description:
      "Look up one GitHub issue by number: its title, state, labels, assignees, comments and latest activity. Use when the user asks about an issue, e.g. 'what's issue 12 in the desktop repo?' or 'is 34 still open?'. It reads one issue at a time and can't list or search issues, or find the newest one. Also supplies the updated_at and title that update_issue and create_issue_comment take.",
  },
  list_pull_requests: {
    title: "List pull requests",
    description:
      "List pull requests in any GitHub repository the account can reach, or one by pull_number: state, author, requested reviewers, description. With no owner or repo: your own open PRs across your repositories. Use when asked about PRs, e.g. 'open PRs in octocat/Hello-World', 'show all my PRs', or what a PR does. Returns descriptions, not diffs. summary_request lets a follow-up add a summary under the card. pull_number also returns head_sha and title, for reviews.",
  },
  search_repositories: {
    title: "Search repositories",
    description:
      "Find GitHub repositories, public and private. Use when the user asks to find repositories, e.g. 'my Python repos'. Owner, language, visibility and sort carry through, include_forks true adds forks, and per_page sets the count. Returns the total and up to five rows at a time, exactly the card's rows in its order; next.arguments continues the same search.",
  },
  search_code: {
    title: "Search code",
    description:
      "Find code in GitHub repositories. Use when asked where code lives or how it behaves. With repo:owner/name in q it searches that repository; without it, every repository the account can see, private ones included. intent explain returns code excerpts for implementation questions. next.arguments continues the search.",
  },
  create_issue: {
    title: "Create issue",
    description:
      "File a new GitHub issue. Use when the user asks to file or log a bug, task or idea, e.g. 'file a bug in the desktop repo: sign-in freezes after sleep'. The title is the user's words, tidied; body, labels and assignees are optional and come from what they said.",
  },
  update_issue: {
    title: "Update issue",
    description:
      "Close, reopen, rename or relabel an issue, rewrite its description, or change its assignees. Use when the user asks to; 'close it' means the issue just discussed. Takes expected_updated_at and issue_title from get_issue. Issues only, not pull requests.",
  },
  create_issue_comment: {
    title: "Comment on issue or PR",
    description:
      "Post a comment on an issue or a pull request's conversation. Use when the user asks to comment or reply, e.g. 'reply to issue 12 that I can reproduce it on 1.4'. Posts the user's exact words; issue_title comes from get_issue. A conversation comment, not a review or approval.",
  },
  create_pull_request_review: {
    title: "Review pull request",
    description:
      "Approve a pull request, request changes, or leave a review comment. Use when the user asks for one of those; event is exactly the one they asked for. Takes commit_id (head_sha) and pr_title from list_pull_requests with pull_number. It can't read the diff, so the review text comes from the user.",
  },
};

export const TOOL_META = Object.fromEntries(
  Object.entries(META).map(([name, meta]) => [
    name,
    { ...meta, description: meta.description + (WRITE_TOOLS.has(name as Facade) ? WRITE_RESULT : READ_RESULT) + CONNECT },
  ]),
) as Record<Facade, { title: string; description: string }>;
