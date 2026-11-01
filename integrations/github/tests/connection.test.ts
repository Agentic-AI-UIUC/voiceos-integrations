import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposioRest } from "../src/composio.ts";
import { AUTH_CONFIG_NAME, ConnectRequired, ConnectionManager, type ConnectionOptions } from "../src/connection.ts";
import { GithubError } from "../src/errors.ts";
import { StateStore } from "../src/state.ts";
import { startMockComposio, type MockComposio } from "./mockComposio.ts";

let mock: MockComposio;
let dir: string;
const managers: ConnectionManager[] = [];

beforeEach(() => {
  mock = startMockComposio();
  dir = mkdtempSync(join(tmpdir(), "gh-conn-"));
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop();
  mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

function manager(overrides: Partial<ConnectionOptions> = {}) {
  const m = new ConnectionManager({
    rest: new ComposioRest({ apiKey: mock.apiKey, baseUrl: mock.baseUrl }),
    apiKey: mock.apiKey,
    baseUrl: mock.baseUrl,
    store: new StateStore(dir),
    environment: "internal",
    connectionEnabled: true,
    poll: false,
    ...overrides,
  });
  managers.push(m);
  return m;
}

const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e) => e);
const linkPosts = () => mock.rest.filter((r) => r.method === "POST" && r.path.endsWith("/link")).length;

describe("first connection (AUTH-01)", () => {
  test("without a GitHub account the call stops with a repo-only Connect Link", async () => {
    const m = manager();
    const error = await caught(m.ensureReady());
    expect(error).toBeInstanceOf(ConnectRequired);
    expect(error.category).toBe("not_connected");
    expect(error.connectUrl).toStartWith("https://connect.composio.dev/link/");
    expect(error.scopes).toEqual(["repo"]);

    const configs = [...mock.authConfigs.values()];
    expect(configs.map((c) => [c.name, c.scopes, c.is_composio_managed])).toEqual([[AUTH_CONFIG_NAME, ["repo"], true]]);
    const pending = [...mock.accounts.values()];
    expect(pending.map((a) => [a.status, a.requested_scopes, a.user_id])).toEqual([["INITIALIZING", ["repo"], m.userId]]);
    expect(m.userId).toMatch(/^voiceos-github-internal-[0-9a-f]{20}$/);
  });

  test("asking again before consent reuses the pending link instead of starting another flow", async () => {
    const m = manager();
    const first = await caught(m.ensureReady());
    const second = await caught(m.ensureReady());
    expect(second.category).toBe("connecting");
    expect(second.connectUrl).toBe(first.connectUrl);
    expect(linkPosts()).toBe(1);
  });

  test("after consent the account is verified, bound, and the session is pinned to it", async () => {
    const m = manager();
    await caught(m.ensureReady());
    const pendingId = [...mock.accounts.keys()][0];
    mock.activate(pendingId, { displayName: "octo-dev" });
    const ready = await m.ensureReady();
    expect(ready.accountId).toBe(pendingId);
    expect(ready.displayName).toBe("octo-dev");
    expect(ready.generation).toBe(1);
    const pinnedSession = [...mock.sessions.values()].find((s) => s.pinned === pendingId);
    expect(pinnedSession?.body.connected_accounts).toEqual({ github: [pendingId] });
  });

  test("a restart keeps the verified binding without a new link", async () => {
    const first = manager();
    await caught(first.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    await first.ensureReady();
    await first.stop();
    const restarted = manager();
    const ready = await restarted.ensureReady();
    expect(ready.generation).toBe(1);
    expect(linkPosts()).toBe(1);
  });

  test("an already-active account for this user and auth config is reused if local state was lost", async () => {
    const m = manager();
    await caught(m.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    rmSync(join(dir, "state.json"));
    const fresh = manager({ userIdOverride: m.userId });
    const ready = await fresh.ensureReady();
    expect(ready.accountId).toBe([...mock.accounts.keys()][0]);
    expect(linkPosts()).toBe(1);
  });
});

describe("failure and refusal paths (AUTH-02 / AUTH-03 / AUTH-04)", () => {
  test("a failed or expired attempt is cleaned up and replaced with a fresh link", async () => {
    const m = manager();
    await caught(m.ensureReady());
    const oldId = [...mock.accounts.keys()][0];
    mock.setAccountStatus(oldId, "FAILED");
    const error = await caught(m.ensureReady());
    expect(error.category).toBe("not_connected");
    expect(mock.accounts.has(oldId)).toBe(false);
    expect(linkPosts()).toBe(2);
  });

  test("an attempt that went stale past ten minutes is not trusted", async () => {
    let t = Date.parse("2026-10-24T20:00:00Z");
    const m = manager({ now: () => t });
    await caught(m.ensureReady());
    t += 11 * 60_000;
    const error = await caught(m.ensureReady());
    expect(error.category).toBe("not_connected");
    expect(linkPosts()).toBe(2);
  });

  test("an account bound to a different auth config is never adopted", async () => {
    const m = manager();
    await caught(m.ensureReady());
    const id = [...mock.accounts.keys()][0];
    mock.accounts.get(id)!.auth_config_id = "ac_someone_else";
    mock.activate(id);
    const error = await caught(m.ensureReady());
    expect(error).toBeInstanceOf(GithubError);
    expect(error.category).toBe("not_connected");
  });

  test("a pinned auth config with broader scopes is refused before any link is made", async () => {
    const m0 = manager();
    await caught(m0.ensureReady());
    const broad = [...mock.authConfigs.values()][0];
    broad.scopes = ["repo", "workflow", "gist"];
    const m = manager({ authConfigPin: broad.id, userIdOverride: "someone-new" });
    const before = linkPosts();
    const error = await caught(m.ensureReady());
    expect(error.category).toBe("permission");
    expect(error.message).toBe(
      "The GitHub auth config asks for more access (workflow, gist) than this integration allows. Use one limited to the repo scope.",
    );
    expect(linkPosts()).toBe(before);
  });

  test("a key that can't create auth configs gets a specific fix, not a broad default", async () => {
    mock.forbidAuthConfigCreate();
    const error = await caught(manager().ensureReady());
    expect(error.category).toBe("composio_auth");
    expect(error.message).toBe(
      "This Composio API key can't create the repo-only GitHub auth config. Use a full-access project key, or set GitHub auth config ID in Configure to one limited to the repo scope.",
    );
    expect(linkPosts()).toBe(0);
  });

  test("a rejected project key is an operational error, not a GitHub reconnect", async () => {
    const m = new ConnectionManager({
      rest: new ComposioRest({ apiKey: "ak_bad", baseUrl: mock.baseUrl }),
      apiKey: "ak_bad", baseUrl: mock.baseUrl, store: new StateStore(dir), environment: "internal", connectionEnabled: true, poll: false,
    });
    managers.push(m);
    const error = await caught(m.ensureReady());
    expect(error.category).toBe("composio_auth");
  });

  test("revoked access is marked for reconnect, and the replacement account retires the old one", async () => {
    const m = manager();
    await caught(m.ensureReady());
    const oldId = [...mock.accounts.keys()][0];
    mock.activate(oldId);
    await m.ensureReady();
    await m.markReauthRequired();
    const error = await caught(m.ensureReady());
    expect(error.category).toBe("reauth_required");
    expect(error.message).toBe("GitHub access expired or was revoked. Reconnect to continue.");
    const newId = [...mock.accounts.keys()].find((id) => id !== oldId)!;
    mock.activate(newId);
    const ready = await m.ensureReady();
    expect(ready.accountId).toBe(newId);
    expect(ready.generation).toBe(2);
    expect(mock.accounts.has(oldId)).toBe(false);
  });
});

describe("disconnect (AUTH-05)", () => {
  test("turning the connection off revokes, deletes, bumps the generation, and blocks calls", async () => {
    const m = manager();
    await caught(m.ensureReady());
    const id = [...mock.accounts.keys()][0];
    mock.activate(id);
    await m.ensureReady();
    await m.stop();

    const off = manager({ connectionEnabled: false });
    const error = await caught(off.ensureReady());
    expect(error.category).toBe("disconnected");
    expect(error.message).toBe(
      "GitHub is disconnected. VoiceOS stopped using this account; changes already sent to GitHub remain. Turn on “Use my GitHub connection” in Configure to connect again.",
    );
    expect(mock.accounts.has(id)).toBe(false);
    const record = new StateStore(dir).snapshot();
    const account = Object.values(record.accounts)[0];
    expect(account.bound).toBeUndefined();
    expect(account.generation).toBe(2);
    expect(account.disconnect).toMatchObject({ revocation: "revoked", deleted: true });

    const revokes = mock.rest.filter((r) => r.path.endsWith("/revoke")).length;
    await caught(off.ensureReady());
    expect(mock.rest.filter((r) => r.path.endsWith("/revoke")).length).toBe(revokes);
  });

  test("turning it back on starts a fresh connection", async () => {
    const off = manager({ connectionEnabled: false });
    await caught(off.ensureReady());
    const on = manager();
    const error = await caught(on.ensureReady());
    expect(error.category).toBe("not_connected");
  });
});

describe("upstream connections", () => {
  test("a late failure on a replaced connection never retires the live one", async () => {
    const m = manager();
    await caught(m.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    const first = await m.ensureReady();
    await m.dropUpstream(first.upstream);
    const second = await m.ensureReady();
    expect(second.upstream).not.toBe(first.upstream);
    // A call that was still in flight on the first connection fails now.
    await m.dropUpstream(first.upstream);
    expect(second.upstream.accepting).toBe(true);
    expect((await m.ensureReady()).upstream).toBe(second.upstream);
  });

  test("a project key that can't run tools gets a specific fix, not 'temporarily unavailable'", async () => {
    const m = manager();
    await caught(m.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    mock.forbidMcp();
    const error = await caught(m.ensureReady());
    expect(error.category).toBe("composio_auth");
    expect(error.message).toBe(
      "This Composio API key can't run GitHub actions. Use a full-access project key, or a scoped one that also allows Session tool execution (write).",
    );
  });
});

describe("catalog gate", () => {
  test("a session exposing tools beyond the approved eight is rejected entirely", async () => {
    const m = manager();
    await caught(m.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    mock.addExtraTool("COMPOSIO_MULTI_EXECUTE_TOOL");
    const error = await caught(m.ensureReady());
    expect(error.category).toBe("catalog_drift");
  });

  test("drift on one tool disables only that tool", async () => {
    const m = manager();
    await caught(m.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    mock.mutateToolSchema("GITHUB_SEARCH_CODE", (s) => {
      s.properties.q.type = "integer";
    });
    const ready = await m.ensureReady();
    expect([...ready.unavailable.keys()]).toEqual(["GITHUB_SEARCH_CODE"]);
  });
});

describe("status polling", () => {
  test("a background poll binds the account as soon as consent completes", async () => {
    const m = manager({ poll: { fastMs: 20, fastForMs: 200, slowMs: 50, giveUpMs: 2000 } });
    await caught(m.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    await Bun.sleep(150);
    const bound = Object.values(new StateStore(dir).snapshot().accounts)[0].bound;
    expect(bound?.status).toBe("active");
  });
});

describe("acting identity changes", () => {
  test("a first binding is not an identity change; replacing the account is", async () => {
    const m = manager();
    await caught(m.ensureReady());
    const first = [...mock.accounts.keys()][0];
    mock.activate(first);
    const ready = await m.ensureReady();
    expect(ready.identityChangedAt).toBeUndefined();
    await m.markReauthRequired();
    await caught(m.ensureReady());
    const second = [...mock.accounts.keys()].find((id) => id !== first)!;
    mock.activate(second);
    const replaced = await m.ensureReady();
    expect(replaced.identityChangedAt).toBe(replaced.boundAt);
  });

  test("reconnecting after a disconnect counts as an identity change", async () => {
    const m = manager();
    await caught(m.ensureReady());
    mock.activate([...mock.accounts.keys()][0]);
    await m.ensureReady();
    await m.stop();
    await caught(manager({ connectionEnabled: false }).ensureReady());
    const again = manager();
    await caught(again.ensureReady());
    mock.activate([...mock.accounts.keys()].at(-1)!);
    const ready = await again.ensureReady();
    expect(ready.identityChangedAt).toBe(ready.boundAt);
  });
});
