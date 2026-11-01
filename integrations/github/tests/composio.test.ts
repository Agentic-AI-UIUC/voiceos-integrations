import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVED, UPSTREAM_SNAPSHOT, schemaHash } from "../src/catalog.ts";
import {
  ComposioHttpError,
  ComposioRest,
  DEFAULT_BASE_URL,
  UpstreamCallError,
  UpstreamMcp,
  resolveBaseUrl,
  sessionBody,
} from "../src/composio.ts";
import { parseUpstream } from "../src/envelope.ts";
import { startMockComposio, makeRepo, type MockComposio } from "./mockComposio.ts";

const SLUGS = Object.values(APPROVED);
let mock: MockComposio;
beforeEach(() => {
  mock = startMockComposio();
});
afterEach(() => mock.stop());

const rest = () => new ComposioRest({ apiKey: mock.apiKey, baseUrl: mock.baseUrl });

async function openUpstream() {
  const session = await rest().createSession(sessionBody({ userId: "u1" }));
  const upstream = new UpstreamMcp({ url: session.mcp.url, apiKey: mock.apiKey, baseUrl: mock.baseUrl });
  await upstream.connect();
  return { session, upstream };
}

describe("resolveBaseUrl", () => {
  test("defaults to Composio and only accepts loopback overrides", () => {
    expect(DEFAULT_BASE_URL).toBe("https://backend.composio.dev");
    expect(resolveBaseUrl(undefined)).toBe("https://backend.composio.dev");
    expect(resolveBaseUrl("http://127.0.0.1:4321")).toBe("http://127.0.0.1:4321");
    expect(resolveBaseUrl("http://localhost:4321/")).toBe("http://localhost:4321");
    expect(resolveBaseUrl("https://evil.example")).toBe("https://backend.composio.dev");
    expect(resolveBaseUrl("http://10.0.0.5:80")).toBe("https://backend.composio.dev");
  });
});

describe("sessionBody", () => {
  test("is the direct-tools policy: eight tools, no meta tools, sandbox, proxy, instant, search or multi-execute", () => {
    expect(sessionBody({ userId: "voiceos-github-internal-x", authConfigId: "ac_1", accountId: "ca_9" })).toEqual({
      user_id: "voiceos-github-internal-x",
      toolkits: { enable: ["github"] },
      tools: {
        github: {
          enable: [
            "GITHUB_CREATE_AN_ISSUE",
            "GITHUB_UPDATE_AN_ISSUE",
            "GITHUB_GET_AN_ISSUE",
            "GITHUB_CREATE_AN_ISSUE_COMMENT",
            "GITHUB_LIST_PULL_REQUESTS",
            "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST",
            "GITHUB_SEARCH_REPOSITORIES",
            "GITHUB_SEARCH_CODE",
          ],
        },
      },
      manage_connections: { enable: false },
      workbench: { enable: false },
      proxy_execute: { enable: false },
      instant: false,
      preload: { tools: "all" },
      search: { enable: false },
      execute: { enable_multi_execute: false },
      auth_configs: { github: "ac_1" },
      connected_accounts: { github: ["ca_9"] },
    });
    const unbound = sessionBody({ userId: "u" });
    expect("connected_accounts" in unbound).toBe(false);
    expect("auth_configs" in unbound).toBe(false);
  });
});

describe("ComposioRest", () => {
  test("creates a session with the policy body and returns its MCP endpoint", async () => {
    const session = await rest().createSession(sessionBody({ userId: "u1" }));
    expect(session.session_id).toStartWith("trs_");
    expect(session.mcp.url).toBe(`${mock.baseUrl}/tool_router/${session.session_id}/mcp`);
    expect(mock.rest.at(-1)?.body).toEqual(sessionBody({ userId: "u1" }));
  });

  test("a rejected key surfaces as a 401 without echoing the key", async () => {
    const wrong = new ComposioRest({ apiKey: "ak_wrong_secret_value", baseUrl: mock.baseUrl });
    const error = await wrong.createSession(sessionBody({ userId: "u" })).catch((e) => e);
    expect(error).toBeInstanceOf(ComposioHttpError);
    expect(error.status).toBe(401);
    expect(String(error.message)).not.toContain("wrong_secret_value");
  });

  test("an unreachable host is a network failure, not a crash", async () => {
    const down = new ComposioRest({ apiKey: mock.apiKey, baseUrl: "http://127.0.0.1:9", timeoutMs: 2000 });
    const error = await down.getAccount("ca_x").catch((e) => e);
    expect(error).toBeInstanceOf(ComposioHttpError);
    expect(error.status).toBe(0);
  });

  test("account reads never return the OAuth token Composio keeps in state", async () => {
    const session = await rest().createSession(sessionBody({ userId: "u1" }));
    const link = await rest().createLink(session.session_id);
    const account = await rest().getAccount(link.connected_account_id);
    expect(JSON.stringify(account)).not.toContain("gho_secret_should_never_leak");
    expect(account).toEqual({
      id: link.connected_account_id, status: "INITIALIZING", userId: "u1", authConfigId: expect.stringMatching(/^ac_/),
      requestedScopes: ["repo", "user", "gist", "notifications", "project", "workflow", "codespace"], displayName: undefined,
      createdAt: expect.stringMatching(/^2026-/),
    });
  });
});

describe("UpstreamMcp catalog verification (CAT-01)", () => {
  test("a direct-tools session exposes exactly the eight approved tools", async () => {
    const { upstream } = await openUpstream();
    expect(await upstream.verifyCatalog(SLUGS)).toEqual({ ok: true, missing: [], unexpected: [], drift: {}, changed: [] });
    await upstream.close();
  });

  test("the recorded snapshot is the eight upstream input schemas captured from a live session (plan §3)", () => {
    const live: Array<{ name: string; inputSchema: unknown }> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/composio-mcp-tools-list.json"), "utf8")).tools;
    expect(Object.keys(UPSTREAM_SNAPSHOT.inputSchemaSha256).sort()).toEqual([...SLUGS].sort());
    for (const tool of live) expect(schemaHash(tool.inputSchema)).toBe(UPSTREAM_SNAPSHOT.inputSchemaSha256[tool.name as keyof typeof UPSTREAM_SNAPSHOT.inputSchemaSha256]);
    expect(UPSTREAM_SNAPSHOT.catalogVersion).toBe("20261023_00");
    expect(schemaHash({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(schemaHash({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });

  test("an upstream schema that changed but still fits is reported for review, not refused", async () => {
    mock.mutateToolSchema("GITHUB_SEARCH_CODE", (s) => {
      s.properties.q.description = "Reworded by Composio.";
    });
    const { upstream } = await openUpstream();
    expect(await upstream.verifyCatalog(SLUGS)).toEqual({ ok: true, missing: [], unexpected: [], drift: {}, changed: ["GITHUB_SEARCH_CODE"] });
    await upstream.close();
  });

  test("an extra meta tool fails the catalog closed", async () => {
    mock.addExtraTool("COMPOSIO_SEARCH_TOOLS");
    const { upstream } = await openUpstream();
    const check = await upstream.verifyCatalog(SLUGS);
    expect(check.ok).toBe(false);
    expect(check.unexpected).toEqual(["COMPOSIO_SEARCH_TOOLS"]);
    await upstream.close();
  });

  test("a missing approved tool is reported", async () => {
    mock.removeTool("GITHUB_SEARCH_CODE");
    const { upstream } = await openUpstream();
    expect(await upstream.verifyCatalog(SLUGS)).toEqual({ ok: false, missing: ["GITHUB_SEARCH_CODE"], unexpected: [], drift: {}, changed: [] });
    await upstream.close();
  });

  test("schema drift on a field we send flags that tool", async () => {
    mock.mutateToolSchema("GITHUB_UPDATE_AN_ISSUE", (s) => {
      s.properties.issue_number.type = "string";
    });
    mock.mutateToolSchema("GITHUB_CREATE_AN_ISSUE", (s) => {
      s.required = [...s.required, "milestone"];
    });
    mock.mutateToolSchema("GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST", (s) => {
      s.properties.event.enum = ["APPROVE", "REQUEST_CHANGES"];
    });
    const { upstream } = await openUpstream();
    const check = await upstream.verifyCatalog(SLUGS);
    expect(check.ok).toBe(false);
    expect(Object.keys(check.drift).sort()).toEqual([
      "GITHUB_CREATE_AN_ISSUE",
      "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST",
      "GITHUB_UPDATE_AN_ISSUE",
    ]);
    expect(check.drift.GITHUB_UPDATE_AN_ISSUE).toBe("issue_number changed type (expected integer)");
    expect(check.drift.GITHUB_CREATE_AN_ISSUE).toBe("now requires milestone, which this integration never sends");
    expect(check.drift.GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST).toBe("event no longer accepts COMMENT");
    await upstream.close();
  });

  test("an MCP URL on another origin is refused before any credentialed request", async () => {
    const before = mock.rest.length;
    const upstream = new UpstreamMcp({ url: "https://evil.example/tool_router/trs_x/mcp", apiKey: mock.apiKey, baseUrl: mock.baseUrl });
    const error = await upstream.connect().catch((e) => e);
    expect(error.category).toBe("contract");
    expect(mock.rest.length).toBe(before);
  });
});

describe("UpstreamMcp calls", () => {
  test("returns Composio's raw envelope for parseUpstream", async () => {
    const repo = mock.addRepo(makeRepo("acme", "desktop"));
    mock.addIssue(repo, { number: 123, title: "Sign-in window freezes" });
    const session = await rest().createSession(sessionBody({ userId: "u1" }));
    const link = await rest().createLink(session.session_id);
    mock.activate(link.connected_account_id);
    const pinned = await rest().createSession(sessionBody({ userId: "u1", accountId: link.connected_account_id }));
    const upstream = new UpstreamMcp({ url: pinned.mcp.url, apiKey: mock.apiKey, baseUrl: mock.baseUrl });
    await upstream.connect();
    const raw = await upstream.call("GITHUB_GET_AN_ISSUE", { owner: "acme", repo: "desktop", issue_number: 123 }, 5000);
    const parsed = parseUpstream(raw);
    expect(parsed.ok && (parsed.data as any).title).toBe("Sign-in window freezes");
    await upstream.close();
  });

  test("a call that outlives its deadline is a timeout, distinguishable from other failures", async () => {
    const { upstream } = await openUpstream();
    mock.failNext("GITHUB_SEARCH_CODE", "hang");
    const started = Date.now();
    const error = (await upstream.call("GITHUB_SEARCH_CODE", { q: "x" }, 300).catch((e: unknown) => e)) as UpstreamCallError;
    expect(error).toBeInstanceOf(UpstreamCallError);
    expect(error.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    mock.releaseHangs();
    await upstream.close();
  });
});
