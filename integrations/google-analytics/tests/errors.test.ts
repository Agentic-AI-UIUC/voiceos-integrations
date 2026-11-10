import { expect, test } from "bun:test";
import { ComposioError, describeError, gaLinkStatus, gaReconnectUrl } from "../server.ts";
import type { ComposioRequest } from "../server.ts";

const linkStatus = (status: string) => async () => status;
const notConnected = new ComposioError("No connected account", "composio", 404, "ActionExecute_ConnectedAccountNotFound");

test("a missing link says so and that reconnecting is the fix", async () => {
  const { error, reconnect } = await describeError(notConnected, linkStatus("NONE"));
  expect(error).toStartWith("Google Analytics isn't connected yet.");
  expect(reconnect).toBe(true);
});

test("an expired link and a revoked token are told apart", async () => {
  expect((await describeError(notConnected, linkStatus("EXPIRED"))).error).toStartWith("The Google Analytics connection has expired.");
  const revoked = new ComposioError("API request failed with status 401.", "tool", 401);
  expect((await describeError(revoked, linkStatus("ACTIVE"))).error).toStartWith("Google Analytics access was revoked.");
});

test("a 403 means the connected Google account can't see that property", async () => {
  const noAccess = new ComposioError("User does not have sufficient permissions for this property.", "tool", 403);
  expect(await describeError(noAccess, linkStatus("ACTIVE"))).toEqual({
    error: "The connected Google account can't access this GA4 property. Check the property ID, or ask for at least Viewer access to it.",
    reconnect: false,
  });
});

test("a 400 keeps GA's message and points the agent at get_metadata, not at GA's guess", async () => {
  const badField = new ComposioError("API request failed with status 400. Did you mean itemsViewed? Field pageViews is not a valid metric.", "tool", 400);
  const { error, reconnect } = await describeError(badField, linkStatus("ACTIVE"));
  expect(error).toContain("Field pageViews is not a valid metric.");
  expect(error).toContain("get_metadata");
  expect(reconnect).toBe(false);
});

test("a rejected Composio API key points at the key, not at reconnecting", async () => {
  const badKey = new ComposioError("Invalid API key", "composio", 401, "APIKey_InvalidAPIKey");
  expect(await describeError(badKey, linkStatus("ACTIVE"))).toEqual({
    error: "The Composio API key was rejected. Check COMPOSIO_API_KEY in this integration's .env.",
    reconnect: false,
  });
});

test("a GA quota error says to wait", async () => {
  const quota = new ComposioError("API request failed with status 429. Exhausted property tokens.", "tool", 429);
  expect((await describeError(quota, linkStatus("ACTIVE"))).error).toStartWith("Google Analytics' query quota for this property is used up.");
});

test("gaLinkStatus: ACTIVE wins; otherwise the newest account's status; NONE when there is none", async () => {
  const api = (items: object[]) => {
    const calls: string[] = [];
    const request: ComposioRequest = async (method, path) => (calls.push(`${method} ${path}`), { items });
    return { request, calls };
  };
  const a = api([{ status: "EXPIRED" }, { status: "ACTIVE" }]);
  expect(await gaLinkStatus(a.request, "default")).toBe("ACTIVE");
  expect(a.calls).toEqual(["GET /connected_accounts?toolkit_slugs=google_analytics&user_ids=default"]);
  expect(await gaLinkStatus(api([{ status: "INITIATED", created_at: "2026-01-01" }, { status: "EXPIRED", created_at: "2026-10-01" }]).request, "u")).toBe("EXPIRED");
  expect(await gaLinkStatus(api([]).request, "u")).toBe("NONE");
});

test("when reconnecting is the fix and a link is available, the user gets the link instead of a dashboard", async () => {
  const revoked = new ComposioError("API request failed with status 401.", "tool", 401);
  const out = await describeError(revoked, linkStatus("ACTIVE"), async () => "https://connect.example/abc");
  expect(out).toEqual({
    error: "Google Analytics access was revoked. Open the reconnect link to sign in to Google again.",
    reconnect: true,
    reconnect_url: "https://connect.example/abc",
  });
});

test("if no reconnect link can be made, the message falls back to where the developer reconnects", async () => {
  const out = await describeError(notConnected, linkStatus("NONE"), async () => { throw new Error("Composio down"); });
  expect(out.error).toBe("Google Analytics isn't connected yet. Reconnect the Google account in platform.composio.dev → Connected accounts.");
  expect(out).not.toHaveProperty("reconnect_url");
});

test("errors that reconnecting won't fix never ask Composio for a link", async () => {
  let asked = false;
  const noAccess = new ComposioError("no access", "tool", 403);
  await describeError(noAccess, linkStatus("ACTIVE"), async () => ((asked = true), "x"));
  expect(asked).toBe(false);
});

/** A fake Composio REST API: answers by path, records the calls. */
function api(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const request: ComposioRequest = async (method, path, body) => {
    calls.push(`${method} ${path}${body ? " " + JSON.stringify(body) : ""}`);
    const key = Object.keys(answers).find((k) => `${method} ${path}`.startsWith(k));
    return key ? answers[key] : {};
  };
  return { request, calls };
}

test("gaReconnectUrl re-authorizes the newest existing account, so the user never ends up with two", async () => {
  const a = api({
    "GET /connected_accounts": { items: [{ id: "ca_old", created_at: "2026-01-01" }, { id: "ca_new", created_at: "2026-11-01" }] },
    "POST /connected_accounts/ca_new/refresh": { redirect_url: "https://connect/re" },
  });
  expect(await gaReconnectUrl(a.request, "default")).toBe("https://connect/re");
  expect(a.calls).toEqual([
    "GET /connected_accounts?toolkit_slugs=google_analytics&user_ids=default",
    "POST /connected_accounts/ca_new/refresh {}",
  ]);
});

test("gaReconnectUrl starts a first connection through the project's enabled auth config", async () => {
  const a = api({
    "GET /connected_accounts": { items: [] },
    "GET /auth_configs": { items: [{ id: "ac_off", status: "DISABLED" }, { id: "ac_on", status: "ENABLED" }] },
    "POST /connected_accounts/link": { redirect_url: "https://connect/new" },
  });
  expect(await gaReconnectUrl(a.request, "u1")).toBe("https://connect/new");
  expect(a.calls.at(-1)).toBe('POST /connected_accounts/link {"auth_config_id":"ac_on","user_id":"u1"}');
});

test("gaReconnectUrl fails clearly when the project has no Google Analytics auth config", async () => {
  const a = api({ "GET /connected_accounts": { items: [] }, "GET /auth_configs": { items: [] } });
  await expect(gaReconnectUrl(a.request, "u1")).rejects.toThrow(/auth config/);
});
