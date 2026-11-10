import { expect, test } from "bun:test";
import { ComposioError, createComposio, isConnectionError } from "../server.ts";

/** A fetch that always answers with this status and JSON body, and records the last request. */
function fakeFetch(status: number, body: unknown) {
  const seen: { url?: string; init?: RequestInit } = {};
  const fn = (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const client = (status: number, body: unknown) => {
  const f = fakeFetch(status, body);
  return { ...createComposio({ apiKey: "ak_test", userId: "u1", fetch: f.fn }), seen: f.seen };
};

const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e) => e);

test("execute posts the user and arguments to the tool's v3.1 endpoint and returns its data", async () => {
  const c = client(200, { successful: true, data: { rowCount: 0 }, error: null });
  expect(await c.execute("GOOGLE_ANALYTICS_RUN_REPORT", { property: "properties/1" })).toEqual({ rowCount: 0 });
  expect(c.seen.url).toBe("https://backend.composio.dev/api/v3.1/tools/execute/GOOGLE_ANALYTICS_RUN_REPORT");
  expect(JSON.parse(String(c.seen.init?.body))).toEqual({ user_id: "u1", arguments: { property: "properties/1" } });
});

test("no connected account is a connection error", async () => {
  const c = client(404, {
    error: { message: "No connected account found for user ID u1 for toolkit google_analytics", slug: "ActionExecute_ConnectedAccountNotFound", status: 404 },
  });
  const err = await failure(c.execute("GOOGLE_ANALYTICS_RUN_REPORT", {}));
  expect(err).toBeInstanceOf(ComposioError);
  expect(isConnectionError(err)).toBe(true);
});

test("Google rejecting the stored token (tool-level 401) is a connection error", async () => {
  const c = client(200, { successful: false, data: { status_code: 401 }, error: "API request failed with status 401." });
  expect(isConnectionError(await failure(c.execute("GOOGLE_ANALYTICS_RUN_REPORT", {})))).toBe(true);
});

test("a bad Composio API key or a GA 403/400 is not a connection error", async () => {
  const badKey = client(401, { error: { message: "Invalid API key", slug: "APIKey_InvalidAPIKey", status: 401 } });
  expect(isConnectionError(await failure(badKey.execute("X", {})))).toBe(false);

  // Real GA response: the account is connected but can't see this property.
  const noAccess = client(200, { successful: false, data: { status_code: 403 }, error: "API request failed with status 403. User does not have sufficient permissions for this property." });
  const err = await failure(noAccess.execute("X", {}));
  expect(isConnectionError(err)).toBe(false);
  expect(err.status).toBe(403);
});

test("a missing API key fails before any network call", async () => {
  const f = fakeFetch(200, {});
  const c = createComposio({ userId: "u1", fetch: f.fn });
  expect((await failure(c.request("GET", "/connected_accounts"))).message).toContain("Missing Composio API key");
  expect(f.seen.url).toBeUndefined();
});
