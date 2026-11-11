import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asanaConnectUrl, errorCard, resolveUserId } from "../server.ts";
import type { ComposioRequest } from "../server.ts";

const stateFile = () => join(mkdtempSync(join(tmpdir(), "asana-user-")), ".composio-user.json");

test("a Setup / .env COMPOSIO_USER_ID wins and nothing is written (e.g. testers already connected as `default`)", () => {
  const file = stateFile();
  expect(resolveUserId("default", file)).toBe("default");
  expect(() => readFileSync(file)).toThrow();
});

test("without one, each install gets its own voiceos-<id>, kept across restarts", () => {
  const file = stateFile();
  const first = resolveUserId(undefined, file);
  expect(first).toMatch(/^voiceos-[0-9a-f-]{36}$/);
  expect(resolveUserId("  ", file)).toBe(first);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ userId: first });
});

test("a damaged state file is an error, not a silent new identity (which would orphan the connection)", () => {
  const file = stateFile();
  writeFileSync(file, '{"userId":"someone-else"}');
  expect(() => resolveUserId(undefined, file)).toThrow(/\.composio-user\.json/);
});

/** A fake Composio REST API: answers by path prefix, records the calls. */
function api(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const request: ComposioRequest = async (method, path, body) => {
    calls.push(`${method} ${path}${body ? " " + JSON.stringify(body) : ""}`);
    const key = Object.keys(answers).find((k) => `${method} ${path}`.startsWith(k));
    return key ? answers[key] : {};
  };
  return { request, calls };
}

test("asanaConnectUrl re-authorizes the newest existing account, so no dead account sits next to a new one", async () => {
  const a = api({
    "GET /connected_accounts": { items: [{ id: "ca_old", created_at: "2026-01-01" }, { id: "ca_new", created_at: "2026-11-01" }] },
    "POST /connected_accounts/ca_new/refresh": { redirect_url: "https://connect/re" },
  });
  expect(await asanaConnectUrl(a.request, "voiceos-1")).toBe("https://connect/re");
  expect(a.calls[0]).toBe("GET /connected_accounts?toolkit_slugs=asana&user_ids=voiceos-1");
});

test("asanaConnectUrl starts a first connection through the project's enabled Asana auth config", async () => {
  const a = api({
    "GET /connected_accounts": { items: [] },
    "GET /auth_configs": { items: [{ id: "ac_off", status: "DISABLED" }, { id: "ac_on", status: "ENABLED" }] },
    "POST /connected_accounts/link": { redirect_url: "https://connect/new" },
  });
  expect(await asanaConnectUrl(a.request, "voiceos-1")).toBe("https://connect/new");
  expect(a.calls).toContain("GET /auth_configs?toolkit_slug=asana");
  expect(a.calls.at(-1)).toBe('POST /connected_accounts/link {"auth_config_id":"ac_on","user_id":"voiceos-1"}');
});

test("asanaConnectUrl fails clearly when the project has no Asana auth config", async () => {
  const a = api({ "GET /connected_accounts": { items: [] }, "GET /auth_configs": { items: [] } });
  await expect(asanaConnectUrl(a.request, "u")).rejects.toThrow(/auth config/);
});

test("an error card with a connect link shows a Connect Asana link the user can open", () => {
  const card = errorCard("Create task", "Asana isn't connected yet.", "MY TASKS", "https://connect.example/abc");
  expect(card.html).toContain('href="https://connect.example/abc"');
  expect(card.html).toContain("Connect Asana");
  expect(errorCard("Create task", "Quota.", "MY TASKS").html).not.toContain("Connect Asana");
});
