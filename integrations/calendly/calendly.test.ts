/**
 * Tests for the Calendly VoiceOS integration.
 *
 * Every test spawns the real server.ts over stdio (exactly how VoiceOS runs
 * it) and talks to it with the official MCP client. Nothing is mocked.
 *
 *  - "contract" tests need no credentials and run everywhere, including CI.
 *  - "live" tests hit the real Calendly API with CALENDLY_API_KEY (Bun loads
 *    it from a local, gitignored .env) and cross-check every tool result
 *    against a direct Calendly API call. They skip when no key is present,
 *    e.g. in CI on a fork PR, where repository secrets are unavailable.
 *  - The cancel test is destructive, so it only runs when you also set
 *    CALENDLY_CANCEL_TEST_UUID to a throwaway booking you made for this.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import manifest from "./voiceos.integration.json";

const API_KEY = process.env.CALENDLY_API_KEY?.trim() || "";
const CANCEL_UUID = process.env.CALENDLY_CANCEL_TEST_UUID?.trim() || "";
const TIMEOUT = 30_000;

const clients: Client[] = [];

async function startServer(env: Record<string, string>): Promise<Client> {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CALENDLY_API_KEY") baseEnv[k] = v;
  }
  const transport = new StdioClientTransport({
    command: process.execPath, // the bun running these tests
    args: ["server.ts"],
    cwd: import.meta.dir,
    env: { ...baseEnv, ...env },
    stderr: "inherit",
  });
  const client = new Client({ name: "calendly-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

function expectGlance(payload: any) {
  const blocks = payload._voiceos_glance?.blocks;
  expect(Array.isArray(blocks)).toBe(true);
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.length).toBeLessThanOrEqual(3);
  for (const b of blocks) {
    if (b.type === "widget") {
      expect(b.html.length).toBeLessThanOrEqual(300_000);
      expect(b.height).toBeGreaterThanOrEqual(60);
      expect(b.height).toBeLessThanOrEqual(420);
    }
  }
}

async function calendly(path: string) {
  const res = await fetch(`https://api.calendly.com${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`Calendly ${path} -> ${res.status}`);
  return res.json() as Promise<any>;
}

const uuidOf = (uri: string) => uri.split("/").filter(Boolean).pop()!;

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
});

// ---------------------------------------------------------------------------
describe("contract (no credentials)", () => {
  test("manifest tools and server registrations match exactly", async () => {
    const client = await startServer({});
    const { tools } = await client.listTools();
    const served = tools.map((t) => t.name).sort();
    const declared = manifest.tools.map((t: any) => t.name).sort();
    expect(served).toEqual(declared);
  }, TIMEOUT);

  test("only the acting tool declares a confirmation card", () => {
    const withConfirm = manifest.tools.filter((t: any) => t.confirmation).map((t: any) => t.name);
    expect(withConfirm).toEqual(["cancel_event"]);
  });

  test("network permission covers the API host the code calls", () => {
    const net = manifest.permissions.find((p: any) => p.kind === "network") as any;
    expect(net.domains).toContain("api.calendly.com");
  });

  test("missing token returns an error, not data", async () => {
    // Explicit empty value: bun would otherwise load the key from a local .env.
    const client = await startServer({ CALENDLY_API_KEY: "" });
    for (const name of ["upcoming_events", "event_types"]) {
      const payload = await call(client, name);
      expect(payload.error).toBeTruthy();
      expect(payload.events).toBeUndefined();
      expectGlance(payload);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
describe.skipIf(!API_KEY)("live Calendly API", () => {
  let client: Client;
  let userUri = "";

  test("server starts with the real token", async () => {
    client = await startServer({ CALENDLY_API_KEY: API_KEY });
    userUri = (await calendly("/users/me")).resource.uri;
    expect(userUri).toStartWith("https://api.calendly.com/users/");
  }, TIMEOUT);

  test("upcoming_events(count: 10) returns every meeting Calendly returns", async () => {
    const now = encodeURIComponent(new Date().toISOString());
    const direct = await calendly(
      `/scheduled_events?user=${encodeURIComponent(userUri)}&status=active&min_start_time=${now}&sort=start_time:asc&count=10`
    );
    const payload = await call(client, "upcoming_events", { count: 10 });
    console.log("upcoming_events ->", JSON.stringify(
      payload.events.map((e: any) => ({ name: e.name, start: e.start_time, invitees: e.invitees?.length })), null, 2));

    expect(payload.error).toBeUndefined();
    expectGlance(payload);
    expect(payload.total_events).toBe(direct.collection.length);
    expect(payload.events.length).toBe(direct.collection.length); // the 4-meeting cap is gone
    expect(payload.events.map((e: any) => e.uuid)).toEqual(direct.collection.map((e: any) => uuidOf(e.uri)));
    for (const e of payload.events) expect(Array.isArray(e.invitees)).toBe(true);
  }, TIMEOUT);

  test("event_types matches the account's active event types", async () => {
    const direct = await calendly(`/event_types?user=${encodeURIComponent(userUri)}&active=true`);
    const payload = await call(client, "event_types");
    console.log("event_types ->", payload.event_types.map((t: any) => `${t.name} ${t.scheduling_url}`));

    expect(payload.error).toBeUndefined();
    expectGlance(payload);
    expect(payload.event_types.map((t: any) => t.scheduling_url).sort())
      .toEqual(direct.collection.map((t: any) => t.scheduling_url).sort());
  }, TIMEOUT);

  test("event_details matches the real meeting", async () => {
    const upcoming = await call(client, "upcoming_events", { count: 1 });
    if (upcoming.events.length === 0) {
      console.log("event_details: no upcoming meetings on this account, nothing to inspect");
      return;
    }
    const uuid = upcoming.events[0].uuid;
    const direct = (await calendly(`/scheduled_events/${uuid}`)).resource;
    const payload = await call(client, "event_details", { event_uuid: uuid });
    console.log("event_details ->", JSON.stringify({ name: payload.name, status: payload.status, start: payload.start_time, invitee: payload.invitee }));

    expect(payload.error).toBeUndefined();
    expectGlance(payload);
    expect(payload.name).toBe(direct.name);
    expect(payload.start_time).toBe(direct.start_time);
    expect(payload.status).toBe(direct.status);
  }, TIMEOUT);

  test("event_details on a bogus UUID reports an error", async () => {
    const payload = await call(client, "event_details", { event_uuid: "00000000-0000-0000-0000-000000000000" });
    expect(payload.error).toBeTruthy();
  }, TIMEOUT);

  test.skipIf(!CANCEL_UUID)("cancel_event really cancels the throwaway booking", async () => {
    const payload = await call(client, "cancel_event", {
      event_uuid: CANCEL_UUID,
      reason: "Automated integration test",
    });
    console.log("cancel_event ->", JSON.stringify({ canceled: payload.canceled, uuid: payload.uuid }));
    expect(payload.error).toBeUndefined();
    expect(payload.canceled).toBe(true);

    const after = (await calendly(`/scheduled_events/${CANCEL_UUID}`)).resource;
    expect(after.status).toBe("canceled");
  }, TIMEOUT);
});
