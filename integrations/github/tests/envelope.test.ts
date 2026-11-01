import { describe, expect, test } from "bun:test";
import noConnection from "./fixtures/composio-mcp-no-connection.json";
import { parseUpstream } from "../src/envelope.ts";
import { classifyUpstreamFailure, sanitizeDetail } from "../src/errors.ts";

const text = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
});

describe("parseUpstream", () => {
  test("live 'no active connection' envelope is a failure carrying Composio's message", () => {
    expect(parseUpstream(noConnection)).toEqual({
      ok: false,
      message: "No active connection found for toolkit(s) 'github' in this session.",
    });
  });

  test("a successful envelope yields its data", () => {
    const data = { number: 123, html_url: "https://github.com/acme/desktop/issues/123" };
    expect(parseUpstream(text({ successful: true, data, error: null, log_id: "log_1" }))).toEqual({
      ok: true, data, logId: "log_1",
    });
  });

  test("successful:false is a failure even when the transport said OK", () => {
    expect(parseUpstream(text({ successful: false, data: {}, error: "Validation Failed" }))).toEqual({
      ok: false, message: "Validation Failed",
    });
  });

  test("isError wins over a success-shaped body", () => {
    expect(parseUpstream(text({ successful: true, data: { id: 1 } }, true)).ok).toBe(false);
  });

  test("plain-text MCP errors are failures", () => {
    expect(parseUpstream(text("MCP error -32602: Tool COMPOSIO_SEARCH_TOOLS not found", true))).toEqual({
      ok: false, message: "MCP error -32602: Tool COMPOSIO_SEARCH_TOOLS not found",
    });
  });

  test("an unparseable success body is a contract failure, not data", () => {
    expect(parseUpstream(text("<html>404</html>"))).toEqual({
      ok: false, message: "Composio returned a response this integration could not read.", contract: true,
    });
    expect(parseUpstream({ content: [] })).toEqual({
      ok: false, message: "Composio returned a response this integration could not read.", contract: true,
    });
  });

  test("structuredContent is preferred over text when present", () => {
    const result = {
      structuredContent: { successful: true, data: { from: "structured" } },
      content: [{ type: "text", text: JSON.stringify({ successful: true, data: { from: "text" } }) }],
    };
    expect(parseUpstream(result)).toEqual({ ok: true, data: { from: "structured" } });
  });

  test("a success envelope without data is a contract failure", () => {
    expect(parseUpstream(text({ successful: true, error: null }))).toEqual({
      ok: false, message: "Composio returned a response this integration could not read.", contract: true,
    });
  });
});

describe("classifyUpstreamFailure", () => {
  const cases: Array<[string, string, string]> = [
    ["No active connection found for toolkit(s) 'github' in this session.", "not_connected", "GitHub isn't connected yet."],
    ["401 Client Error: Bad credentials", "reauth_required", "GitHub access expired or was revoked. Reconnect to continue."],
    ["Invalid API key: ak_**abcd", "composio_auth", "Composio rejected the project API key. Check it in VoiceOS → Integrations → GitHub → Configure."],
    ["403: Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions", "sso_required", "Your organization may need to approve this OAuth app or renew SSO access."],
    ["Resource protected by organization SAML enforcement. You must grant your OAuth token access", "sso_required", "Your organization may need to approve this OAuth app or renew SSO access."],
    ["API rate limit exceeded for user ID 1.", "rate_limited", "GitHub is limiting requests. Try again in a few minutes."],
    ["404 Client Error: Not Found for url: https://api.github.com/repos/acme/nope", "not_found", "This GitHub account cannot access that repository, or it no longer exists."],
    ["Issues has been disabled in this repository.", "issues_disabled", "Issues are turned off for this repository."],
    ["Repository was archived so is read-only.", "archived", "This repository is archived, so it's read-only."],
    ["422 Unprocessable Entity: Can not approve your own pull request", "self_review", "GitHub doesn't allow approving or requesting changes on your own pull request. You can post a review comment instead."],
    ["Validation Failed: User can only have one pending review per pull request", "pending_review", "You already have a pending review on this pull request. Submit or discard it on GitHub, then try again."],
    ["403 Forbidden: Resource not accessible by integration", "permission", "This GitHub account doesn't have permission to do that in this repository."],
    ["502 Bad Gateway", "upstream_unavailable", "GitHub or Composio is temporarily unavailable. Try again shortly."],
    ["Validation Failed: invalid assignees: ghost-user", "validation", "GitHub rejected part of this request: Validation Failed: invalid assignees: ghost-user"],
  ];
  for (const [raw, category, message] of cases) {
    test(`${category}: ${raw.slice(0, 48)}`, () => {
      const e = classifyUpstreamFailure(raw, { tool: "create_issue" });
      expect<string>(e.category).toBe(category);
      expect(e.message).toBe(message);
    });
  }

  test("an issue-level 404 uses issue wording without revealing whether a private repo exists", () => {
    const e = classifyUpstreamFailure("404 Not Found", { tool: "get_issue" });
    expect(e.message).toBe("That issue could not be found or this account cannot access it.");
  });

  test("rate limits name a retry time only when GitHub supplied one", () => {
    const e = classifyUpstreamFailure("API rate limit exceeded. Retry-After: 120", { tool: "search_code" });
    expect(e.category).toBe("rate_limited");
    expect(e.message).toBe("GitHub is limiting requests. Try again in 2 minutes.");
    expect(e.retryAfterSeconds).toBe(120);
  });

  test("names and numbers inside URLs never decide the category", () => {
    const cases: Array<[string, string, string]> = [
      ["502 Server Error: Bad Gateway for url: https://api.github.com/repos/acme/permissions-service/issues/12/comments", "create_issue_comment", "upstream_unavailable"],
      ["504 Server Error: Gateway Timeout for url: https://api.github.com/repos/acme/desktop/issues/404/comments", "create_issue_comment", "upstream_unavailable"],
      ["502 Server Error: Bad Gateway for url: https://api.github.com/repos/acme/archived-notes/issues", "create_issue", "upstream_unavailable"],
      ["503 Server Error: Service Unavailable for url: https://api.github.com/repos/acme/sso-gateway/pulls", "list_pull_requests", "upstream_unavailable"],
      ["422 Client Error: Unprocessable Entity for url: https://api.github.com/repos/acme/desktop/issues/429", "update_issue", "validation"],
      ["404 Client Error: Not Found for url: https://api.github.com/repos/acme/desktop/issues/401", "get_issue", "not_found"],
      ["404 Client Error: Not Found for url: https://api.github.com/repos/acme/token-revoked-expired/issues/3", "get_issue", "not_found"],
      ["403 Client Error: Forbidden for url: https://api.github.com/repos/acme/rate-limit-tests/issues", "create_issue", "permission"],
      ["Error executing GITHUB_CREATE_AN_ISSUE: 500 Server Error: Internal Server Error for url: https://api.github.com/repos/acme/permission-denied/issues", "create_issue", "upstream_unavailable"],
    ];
    for (const [raw, tool, category] of cases) expect([raw, classifyUpstreamFailure(raw, { tool }).category]).toEqual([raw, category]);
  });

  test("a server error is never read as a definite answer, whatever words it carries", () => {
    expect(classifyUpstreamFailure("502 Bad Gateway: permission check upstream failed", { tool: "create_issue" }).category).toBe("upstream_unavailable");
    expect(classifyUpstreamFailure("503 Service Unavailable: rate limit service down", { tool: "create_issue" }).category).toBe("upstream_unavailable");
  });

  test("transient failures are retryable only for reads", () => {
    expect(classifyUpstreamFailure("503 Service Unavailable", { tool: "get_issue" }).retryable).toBe(true);
    expect(classifyUpstreamFailure("503 Service Unavailable", { tool: "create_issue" }).retryable).toBe(false);
  });
});

describe("sanitizeDetail", () => {
  test("redacts credentials and URL query strings, and clips", () => {
    const raw =
      "Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789 Bearer eyJhbGciOi.secret x-api-key: ak_live_123 " +
      "see https://connect.composio.dev/link/lk_123?token=abc&state=xyz";
    const out = sanitizeDetail(raw);
    expect(out).not.toContain("ghp_abc");
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).not.toContain("ak_live_123");
    expect(out).not.toContain("token=abc");
    expect(out).toContain("https://connect.composio.dev/link/lk_123");
    expect(sanitizeDetail("x".repeat(1000)).length).toBeLessThanOrEqual(240);
  });
});

describe("catalog drift at call time", () => {
  test("an upstream 'tool not found' or invalid-params error is drift, not a GitHub 404", () => {
    for (const raw of [
      "MCP error -32602: Tool GITHUB_CREATE_AN_ISSUE not found",
      "MCP error -32602: Invalid arguments for tool GITHUB_UPDATE_AN_ISSUE: issue_number expected string",
    ]) {
      const e = classifyUpstreamFailure(raw, { tool: "create_issue" });
      expect(e.category).toBe("catalog_drift");
      expect(e.message).toBe("GitHub actions are temporarily unavailable because Composio's tool catalog changed. Nothing was sent to GitHub.");
    }
  });
});
