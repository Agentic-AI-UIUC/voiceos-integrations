/**
 * src/client.ts against the loopback mock (tests/mock-composio.ts). No real network: every request goes to 127.0.0.1.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComposioClient,
  bool,
  int,
  parseData,
  photoDirectArgs,
  photoDraftArgs,
  videoDirectArgs,
  videoDraftArgs,
} from "../src/client.ts";
import { TIKTOK_TOOLKIT_VERSION, type Config } from "../src/config.ts";
import { TikTokError } from "../src/errors.ts";
import TKR from "../src/receiptCoreScript.ts";
import type { Clock, StagedFile } from "../src/types.ts";
import { reply, startMockComposio, tiktokBody } from "./mock-composio.ts";

const mock = startMockComposio();
const dir = mkdtempSync(join(tmpdir(), "tiktok-client-test-"));
afterAll(() => {
  mock.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => mock.reset());

/** Time under test control: sleeps resolve at once (recorded), and the tests move time forward. */
class FakeClock implements Clock {
  t = Date.UTC(2026, 10, 3, 12, 0, 0);
  sleeps: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    this.sleeps.push(ms);
    this.t += ms;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

function setup(over: Partial<Config> = {}, fetchImpl?: typeof fetch) {
  const clock = new FakeClock();
  const cfg: Config = {
    apiKey: mock.apiKey,
    userId: mock.userId,
    connectedAccountId: mock.connectedAccountId,
    baseUrl: mock.baseUrl,
    relayBase: "",
    stateDir: "/nonexistent-state",
    home: "/nonexistent-home",
    ...over,
  };
  const client = new ComposioClient(cfg, { clock, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { client, clock, cfg, soon: () => clock.now() + 20_000 };
}

const live = () => AbortSignal.timeout(10_000);

async function failure(p: Promise<unknown>): Promise<TikTokError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TikTokError) return e;
    throw new Error(`expected a TikTokError, got ${String(e)}`);
  }
  throw new Error("expected a rejection, but it resolved");
}

function failureSync(fn: () => unknown): TikTokError {
  try {
    fn();
  } catch (e) {
    if (e instanceof TikTokError) return e;
    throw new Error(`expected a TikTokError, got ${String(e)}`);
  }
  throw new Error("expected a throw");
}

async function captureLogs(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } catch {
    /* the lines are what's under test */
  } finally {
    console.error = original;
  }
  return lines;
}

/** Wraps the real fetch: scripted network failures for executes, and a record of every call's init. */
function scriptedFetch(script: Array<"reset" | "pass">) {
  const inits: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const f = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    inits.push({ url, init });
    if (url.includes("/tools/execute/") && (script[i++] ?? "pass") === "reset") {
      const e = new Error("The socket connection was closed unexpectedly.") as Error & { code: string };
      e.code = "ECONNRESET";
      throw e;
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { fetch: f, inits };
}

const staged: StagedFile = { name: "clip.mp4", mimetype: "video/mp4", s3key: "tiktok/TIKTOK_UPLOAD_VIDEO/abc/clip.mp4" };
const open = { comment_disabled: false, duet_disabled: false, stitch_disabled: false };

function tempVideo(name = "My Clip (final).mp4", size = 300_000) {
  const path = join(dir, name);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  writeFileSync(path, buf);
  return { path, size, md5: createHash("md5").update(buf).digest("hex") };
}

// ---------------------------------------------------------------------------

describe("parseData (plan §5.3 v3)", () => {
  test("unwraps the Composio envelope and TikTok's { data, error: ok } body", () => {
    const body = tiktokBody({ user: { follower_count: 5 } });
    expect(parseData({ successful: true, data: body, error: null, log_id: "log_1" })).toEqual({ user: { follower_count: 5 } });
    expect(parseData(body)).toEqual({ user: { follower_count: 5 } });
    expect(parseData({ data: { a: 1 }, error: { code: "ok", message: "", log_id: "x" } })).toEqual({ a: 1 });
  });

  test("re-parses nested JSON strings", () => {
    const inner = { videos: [{ id: "1" }], cursor: 5, has_more: false };
    expect(parseData(JSON.stringify(tiktokBody(inner)))).toEqual(inner);
    expect(parseData({ data: JSON.stringify({ data: JSON.stringify(inner) }) })).toEqual(inner);
    expect(parseData({ successful: true, data: JSON.stringify(tiktokBody(inner)), error: null })).toEqual(inner);
  });

  test("throws TikTok's error when error.code isn't ok, even inside HTTP 200 (creator info's spam_risk_*)", () => {
    const e = failureSync(() => parseData(tiktokBody({ creator_nickname: "x" }, { code: "spam_risk_too_many_posts", message: "cap" })));
    expect(e.code).toBe("POSTING_CAP");
    expect(e.detail.tiktok_code).toBe("spam_risk_too_many_posts");
    expect(String(e.detail.log_id)).toMatch(/^2026/);
    expect(failureSync(() => parseData(tiktokBody({}, { code: "reached_active_user_cap" }))).code).toBe("CREATOR_CANNOT_POST");
    expect(failureSync(() => parseData(tiktokBody({}, { code: "spam_risk_user_banned_from_posting" }))).code).toBe("CREATOR_CANNOT_POST");
    // inside a JSON string, and inside the Composio envelope
    expect(failureSync(() => parseData(JSON.stringify(tiktokBody({}, { code: "spam_risk_too_many_posts" })))).code).toBe("POSTING_CAP");
    expect(
      failureSync(() => parseData({ successful: true, data: tiktokBody({}, { code: "rate_limit_exceeded" }), error: null })).code,
    ).toBe("RATE_LIMITED");
  });

  test("keeps plain objects that merely contain a data field", () => {
    const plain = { data: [1, 2], cursor: 9, has_more: true };
    expect(parseData(plain)).toEqual(plain);
    const plain2 = { data: { x: 1 }, note: "keep me" };
    expect(parseData(plain2)).toEqual(plain2);
  });

  test("unwraps at most 4 levels", () => {
    const five = { data: { data: { data: { data: { data: { deep: true } } } } } };
    expect(parseData(five)).toEqual({ data: { deep: true } });
  });

  test("text that isn't JSON comes back as it is; null and undefined pass through", () => {
    expect(parseData("not json")).toBe("not json");
    expect(parseData(null)).toBe(null);
    expect(parseData(undefined)).toBe(undefined);
  });
});

describe("execute requests", () => {
  test("every execute pins the toolkit version and names the user and the connected account", async () => {
    const { client, soon } = setup();
    const stats = await client.exec<any>("TIKTOK_GET_USER_STATS", { fields: ["follower_count", "username"] }, { deadline: soon() });
    expect(stats).toEqual({ user: { follower_count: 12_873, username: "mock.creator" } });
    await client.exec("TIKTOK_LIST_VIDEOS", { max_count: 5 }, { deadline: soon() });
    await client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true });
    const ex = mock.executes();
    expect(ex.map((c) => c.slug)).toEqual(["TIKTOK_GET_USER_STATS", "TIKTOK_LIST_VIDEOS", "TIKTOK_UPLOAD_VIDEO"]);
    for (const c of ex) {
      expect(c.method).toBe("POST");
      expect(c.path).toBe(`/tools/execute/${c.slug}`);
      expect(Object.keys(c.body).sort()).toEqual(["arguments", "connected_account_id", "user_id", "version"]);
      expect(c.body.version).toBe(TIKTOK_TOOLKIT_VERSION);
      expect(c.body.version).toBe("20261101_00");
      expect(c.body.user_id).toBe(mock.userId);
      expect(c.body.connected_account_id).toBe(mock.connectedAccountId);
      expect(c.headers["x-api-key"]).toBe(mock.apiKey);
      expect(c.headers["content-type"]).toContain("application/json");
    }
    expect(ex[1].body.arguments).toEqual({ max_count: 5 });
    expect(ex[2].body.arguments).toEqual({ file_to_upload: staged, publish: false });
  });

  test("returns the unwrapped TikTok data (a publish id for a write)", async () => {
    const { client, soon } = setup();
    const out = await client.exec<any>("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true });
    expect(out.publish_id).toMatch(/^v_inbox_file~v2\.\d+$/);
    const list = await client.exec<any>("TIKTOK_LIST_VIDEOS", { max_count: 3 }, { deadline: soon() });
    expect(list.videos.length).toBe(3);
    expect(list.has_more).toBe(true);
    expect(typeof list.cursor).toBe("number");
  });

  test("user_id comes from the config", async () => {
    mock.account.user_id = "u_42";
    const { client, soon } = setup({ userId: "u_42" });
    await client.exec("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: soon() });
    expect(mock.calls[0].query.user_ids).toBe("u_42");
    expect(mock.executes()[0].body.user_id).toBe("u_42");
  });
});

describe("configuration", () => {
  test("no API key → NOT_CONFIGURED {field}, and nothing is sent", async () => {
    const { client, soon } = setup({ apiKey: undefined });
    const e = await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }));
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(e.detail.field).toBe("COMPOSIO_API_KEY");
    expect((await failure(client.assertAccount(live()))).code).toBe("NOT_CONFIGURED");
    expect(mock.calls.length).toBe(0);
  });

  test("no connected account id → NOT_CONFIGURED {field}", async () => {
    const { client, soon } = setup({ connectedAccountId: undefined });
    const e = await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }));
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(e.detail.field).toBe("COMPOSIO_CONNECTED_ACCOUNT_ID");
    expect(mock.calls.length).toBe(0);
  });

  test("stageFile without an API key → NOT_CONFIGURED, nothing sent", async () => {
    const f = tempVideo("nokey.mp4", 1_000);
    const { client, soon } = setup({ apiKey: undefined });
    const e = await failure(client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", soon()));
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(mock.calls.length).toBe(0);
  });

  test("Composio rejecting the key (401) on connected_accounts → NOT_CONFIGURED key_rejected, not retried", async () => {
    const { client } = setup({ apiKey: "wrong_key" });
    const e = await failure(client.assertAccount(live()));
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(e.detail.reason).toBe("key_rejected");
    expect(mock.calls.length).toBe(1);
  });

  test("403 on connected_accounts → NOT_CONFIGURED key_rejected", async () => {
    mock.onRoute("GET", "/connected_accounts", () => reply.composioError(403, "Forbidden", "This API key lacks connected_accounts:read"));
    const { client } = setup();
    const e = await failure(client.assertAccount(live()));
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(e.detail.reason).toBe("key_rejected");
  });
});

describe("assertAccount", () => {
  test("ACTIVE → the id; the list is filtered by account id, user id and toolkit", async () => {
    const { client } = setup();
    expect(await client.assertAccount(live())).toBe(mock.connectedAccountId);
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].method).toBe("GET");
    expect(mock.calls[0].path).toBe("/connected_accounts");
    expect(mock.calls[0].query).toEqual({
      connected_account_ids: mock.connectedAccountId,
      user_ids: mock.userId,
      toolkit_slugs: "tiktok",
    });
    expect(mock.calls[0].headers["x-api-key"]).toBe(mock.apiKey);
  });

  const statuses: Array<[string, string, string | undefined]> = [
    ["EXPIRED", "AUTH_EXPIRED", undefined],
    ["INITIATED", "NOT_CONNECTED", "connecting"],
    ["INITIALIZING", "NOT_CONNECTED", "connecting"],
    ["REVOKED", "AUTH_REVOKED", undefined],
    ["INACTIVE", "AUTH_REVOKED", undefined],
    ["FAILED", "AUTH_REVOKED", undefined],
    ["SOMETHING_NEW", "AUTH_REVOKED", undefined],
  ];
  for (const [status, code, reason] of statuses) {
    test(`${status} → ${code}${reason ? ` (${reason})` : ""}`, async () => {
      mock.account.status = status;
      const { client } = setup();
      const e = await failure(client.assertAccount(live()));
      expect(e.code).toBe(code);
      expect(e.detail.account_status).toBe(status);
      if (reason) expect(e.detail.reason).toBe(reason);
      if (reason === "connecting") expect(e.card).toContain("hasn't finished connecting");
    });
  }

  test("ACTIVE but disabled → AUTH_REVOKED", async () => {
    mock.account.is_disabled = true;
    const { client } = setup();
    const e = await failure(client.assertAccount(live()));
    expect(e.code).toBe("AUTH_REVOKED");
  });

  test("an id Composio doesn't list → NOT_CONNECTED (plain), after one diagnostic lookup without the user filter", async () => {
    const { client } = setup({ connectedAccountId: "ca_unknown999" });
    const e = await failure(client.assertAccount(live()));
    expect(e.code).toBe("NOT_CONNECTED");
    expect(e.detail.reason).not.toBe("other_user");
    expect(e.card).toContain("Connected accounts");
    expect(mock.calls.map((c) => c.query)).toEqual([
      { connected_account_ids: "ca_unknown999", user_ids: mock.userId, toolkit_slugs: "tiktok" },
      { connected_account_ids: "ca_unknown999", toolkit_slugs: "tiktok" },
    ]);
  });

  test("an explicit user id that doesn't own the connection → NOT_CONNECTED other_user, without that user id", async () => {
    mock.account.user_id = "someone-else-42";
    const { client, soon } = setup({ userId: "u_explicit" });
    const e = await failure(client.assertAccount(live()));
    expect(e.code).toBe("NOT_CONNECTED");
    expect(e.detail.reason).toBe("other_user");
    expect(JSON.stringify(e.detail)).not.toContain("someone-else-42");
    expect(JSON.stringify(e.toJSON())).not.toContain("someone-else-42");
    expect(e.card).toContain("different Composio user ID");
    expect(mock.calls.map((c) => c.query.user_ids)).toEqual(["u_explicit", undefined]);
    // and nothing ever runs on it
    expect((await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }))).detail.reason).toBe("other_user");
    expect(mock.executes().length).toBe(0);
  });

  test("user id left at default → adopts the connection's owner, and executes as that user", async () => {
    mock.account.user_id = "voiceos-tiktok";
    const { client, soon } = setup({ userId: "default" });
    expect(await client.assertAccount(live())).toBe(mock.connectedAccountId);
    expect(mock.calls.map((c) => c.query.user_ids)).toEqual(["default", undefined]);
    await client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() });
    expect(mock.executes()[0]!.body.user_id).toBe("voiceos-tiktok");
  });

  test("a connection of another toolkit → NOT_CONNECTED (plain)", async () => {
    mock.account.toolkit = "github";
    const { client } = setup();
    const e = await failure(client.assertAccount(live()));
    expect(e.code).toBe("NOT_CONNECTED");
    expect(e.detail.reason).not.toBe("other_user");
  });

  test("if the diagnostic lookup fails, plain NOT_CONNECTED", async () => {
    mock.account.user_id = "someone-else-42";
    mock.onRoute("GET", "/connected_accounts", (c) => (c.query.user_ids ? undefined : reply.composioError(500)));
    const { client } = setup();
    const e = await failure(client.assertAccount(live()));
    expect(e.code).toBe("NOT_CONNECTED");
    expect(e.detail.reason).not.toBe("other_user");
    expect(mock.calls.length).toBe(2);
  });

  test("the diagnostic lookup stays inside the deadline", async () => {
    mock.account.user_id = "someone-else-42";
    const { client, clock } = setup();
    const deadline = clock.now() + 20_000;
    mock.onRoute("GET", "/connected_accounts", (c) => {
      if (c.query.user_ids) clock.advance(19_500); // the first lookup "took" 19.5 s
      return undefined;
    });
    const e = await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline }));
    expect(e.code).toBe("NOT_CONNECTED");
    expect(e.detail.reason).not.toBe("other_user");
    expect(mock.calls.length).toBe(1);
  });

  test("an ACTIVE result is cached for 60 s; fresh bypasses the cache", async () => {
    const { client, clock } = setup();
    await client.assertAccount(live());
    await client.assertAccount(live());
    clock.advance(59_000);
    await client.assertAccount(live());
    expect(mock.calls.length).toBe(1);
    await client.assertAccount(live(), { fresh: true });
    expect(mock.calls.length).toBe(2);
    clock.advance(60_000);
    await client.assertAccount(live());
    expect(mock.calls.length).toBe(3);
  });

  test("execs reuse the cached check", async () => {
    const { client, soon } = setup();
    await client.exec("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: soon() });
    await client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() });
    expect(mock.calls.filter((c) => c.path === "/connected_accounts").length).toBe(1);
    expect(mock.executes().length).toBe(2);
  });

  test("a failed check isn't cached, and a failed fresh check drops the cached ACTIVE", async () => {
    mock.account.status = "EXPIRED";
    const { client } = setup();
    await failure(client.assertAccount(live()));
    mock.account.status = "ACTIVE";
    expect(await client.assertAccount(live())).toBe(mock.connectedAccountId);
    mock.account.status = "REVOKED";
    expect((await failure(client.assertAccount(live(), { fresh: true }))).code).toBe("AUTH_REVOKED");
    expect((await failure(client.assertAccount(live()))).code).toBe("AUTH_REVOKED");
    expect(mock.calls.length).toBe(4);
  });

  test("an exec on an account that isn't ACTIVE sends nothing to the tool", async () => {
    mock.account.status = "EXPIRED";
    const { client, soon } = setup();
    expect((await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }))).code).toBe(
      "AUTH_EXPIRED",
    );
    expect(mock.executes().length).toBe(0);
  });

  test("the connected-account lookup is retried once on a 5xx", async () => {
    let n = 0;
    mock.onRoute("GET", "/connected_accounts", () => (n++ === 0 ? reply.composioError(502) : undefined));
    const { client, clock } = setup();
    expect(await client.assertAccount(live())).toBe(mock.connectedAccountId);
    expect(mock.calls.length).toBe(2);
    expect(clock.sleeps.length).toBe(1);
  });
});

describe("reads: one retry on 5xx or a network error, inside the deadline", () => {
  test("retries once on a 5xx after ~500 ms of jitter, then succeeds", async () => {
    mock.once("TIKTOK_LIST_VIDEOS", () => reply.composioError(500));
    const { client, soon, clock } = setup();
    const out = await client.exec<any>("TIKTOK_LIST_VIDEOS", { max_count: 2 }, { deadline: soon() });
    expect(out.videos.length).toBe(2);
    expect(mock.executes("TIKTOK_LIST_VIDEOS").length).toBe(2);
    expect(clock.sleeps.length).toBe(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(750);
  });

  test("retries once on a network error, then succeeds", async () => {
    const s = scriptedFetch(["reset", "pass"]);
    const { client, soon, clock } = setup({}, s.fetch);
    const out = await client.exec<any>("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: soon() });
    expect(out.creator_nickname).toBe("Mock Creator");
    expect(s.inits.filter((c) => c.url.includes("/tools/execute/")).length).toBe(2);
    expect(mock.executes().length).toBe(1);
    expect(clock.sleeps.length).toBe(1);
  });

  test("a dropped read answer recovers", async () => {
    mock.once("TIKTOK_GET_USER_STATS", () => reply.drop());
    const { client, soon } = setup();
    const out = await client.exec<any>("TIKTOK_GET_USER_STATS", {}, { deadline: soon() });
    expect(out.user.follower_count).toBe(12_873);
  });

  test("gives up after the one retry: two 5xx → TIKTOK_SERVER", async () => {
    mock.on("TIKTOK_LIST_VIDEOS", () => reply.composioError(503));
    const { client, soon, clock } = setup();
    expect((await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() }))).code).toBe("TIKTOK_SERVER");
    expect(mock.executes().length).toBe(2);
    expect(clock.sleeps.length).toBe(1);
  });

  test("two network errors → TIKTOK_SERVER, two attempts", async () => {
    const s = scriptedFetch(["reset", "reset"]);
    const { client, soon } = setup({}, s.fetch);
    const e = await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() }));
    expect(e.code).toBe("TIKTOK_SERVER");
    expect(s.inits.filter((c) => c.url.includes("/tools/execute/")).length).toBe(2);
  });

  test("no retry when it would run past the deadline", async () => {
    mock.on("TIKTOK_LIST_VIDEOS", () => reply.composioError(500));
    const { client, clock } = setup();
    const e = await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: clock.now() + 1_200 }));
    expect(e.code).toBe("TIKTOK_SERVER");
    expect(mock.executes().length).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("a 4xx isn't retried", async () => {
    mock.on("TIKTOK_LIST_VIDEOS", () => reply.composioError(400, "BadRequest", "Invalid arguments"));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() }));
    expect(e.code).not.toBe("OUTCOME_UNKNOWN");
    expect(mock.executes().length).toBe(1);
  });

  test("a read that times out → TIMEOUT (not retried)", async () => {
    mock.on("TIKTOK_LIST_VIDEOS", (a, c) => ({ ...mock.defaultReply("TIKTOK_LIST_VIDEOS", a, c), delayMs: 600 }));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon(), timeoutMs: 150 }));
    expect(e.code).toBe("TIMEOUT");
    expect(mock.executes().length).toBe(1);
  });

  test("less than 1 s before the deadline → TIMEOUT, nothing sent", async () => {
    const { client, clock } = setup();
    const e = await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: clock.now() + 900 }));
    expect(e.code).toBe("TIMEOUT");
    expect(mock.calls.length).toBe(0);
  });

  test("an unreadable 200 is retried once for a read", async () => {
    mock.once("TIKTOK_LIST_VIDEOS", () => ({ status: 200, text: "<html>upstream</html>", headers: { "content-type": "text/html" } }));
    const { client, soon } = setup();
    const out = await client.exec<any>("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() });
    expect(Array.isArray(out.videos)).toBe(true);
    expect(mock.executes().length).toBe(2);
  });
});

describe("writes: never retried; a lost answer is OUTCOME_UNKNOWN", () => {
  test("a dropped answer → OUTCOME_UNKNOWN after exactly one init, even on a reused connection", async () => {
    const { client, soon, clock } = setup();
    await client.exec("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: soon() }); // leaves a pooled keep-alive socket
    mock.once("TIKTOK_UPLOAD_VIDEO", () => reply.drop());
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect(e.code).toBe("OUTCOME_UNKNOWN");
    expect(e.card).toContain("before trying again");
    expect(mock.executes("TIKTOK_UPLOAD_VIDEO").length).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  for (const status of [502, 503, 504]) {
    test(`HTTP ${status} → OUTCOME_UNKNOWN, one init`, async () => {
      mock.on("TIKTOK_UPLOAD_VIDEO", () => reply.composioError(status));
      const { client, soon } = setup();
      const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
      expect(e.code).toBe("OUTCOME_UNKNOWN");
      expect(mock.executes().length).toBe(1);
    });
  }

  test("a timeout → OUTCOME_UNKNOWN, one init", async () => {
    mock.on("TIKTOK_UPLOAD_VIDEO", (a, c) => ({ ...mock.defaultReply("TIKTOK_UPLOAD_VIDEO", a, c), delayMs: 800 }));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true, timeoutMs: 200 }));
    expect(e.code).toBe("OUTCOME_UNKNOWN");
    expect(mock.executes().length).toBe(1);
  });

  test("HTTP 200 with an empty or unreadable body → OUTCOME_UNKNOWN", async () => {
    mock.once("TIKTOK_UPLOAD_VIDEO", () => ({ status: 200, text: "" }));
    mock.once("TIKTOK_UPLOAD_VIDEO", () => ({ status: 200, text: "<html>reset</html>", headers: { "content-type": "text/html" } }));
    const { client, soon } = setup();
    for (let i = 0; i < 2; i++) {
      const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
      expect(e.code).toBe("OUTCOME_UNKNOWN");
    }
    expect(mock.executes().length).toBe(2);
  });

  // Composio's backend can lose TikTok's answer too, and says so inside an HTTP 200 (successful:false).
  for (const [label, error] of [
    ["Python requests' read timeout", "HTTPSConnectionPool(host='open.tiktokapis.com', port=443): Read timed out. (read timeout=60)"],
    ["a dropped connection", "('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))"],
    ["an upstream 504", { message: "Gateway Timeout", status: 504 }],
  ] as const) {
    test(`successful:false with ${label} on a write → OUTCOME_UNKNOWN, one init`, async () => {
      mock.on("TIKTOK_UPLOAD_VIDEO", () => ({ json: { successful: false, error, data: null } }));
      const { client, soon } = setup();
      const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
      expect(e.code).toBe("OUTCOME_UNKNOWN");
      expect(mock.executes().length).toBe(1);
    });
  }

  // QA (PR 47): any app failure on a write without TikTok's own error code is unknown, not "failed". Composio's words
  // can't say whether TikTok already had the post, and a user told "it failed" sends it again: a duplicate post.
  for (const [label, error] of [
    ["a generic error", "Something went wrong while processing the request"],
    ["a failed upload step", "Failed to upload video chunk 2 of 3"],
    ["Composio's own slug and no TikTok code", { message: "Tool execution failed", slug: "ActionExecute_ToolExecutionFailed" }],
    ["no error text at all", null],
  ] as const) {
    test(`successful:false with ${label} on a write → OUTCOME_UNKNOWN, one init, and the next call checks the account afresh`, async () => {
      mock.on("TIKTOK_UPLOAD_VIDEO", () => ({ json: { successful: false, error, data: null } }));
      const { client, soon } = setup();
      const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
      expect(e.code).toBe("OUTCOME_UNKNOWN");
      expect(e.card).toContain("Check your drafts or profile before trying again");
      expect(mock.executes().length).toBe(1);
      const checks = () => mock.calls.filter((c) => c.path === "/connected_accounts").length;
      const before = checks();
      await client.assertAccount(new AbortController().signal);
      expect(checks()).toBe(before + 1); // not the 60 s cache: a lapsed connection is caught before the next send
    });
  }

  // Review of the QA fix: two kinds of app failure aren't unknown. TikTok's own error refused the write, listed in our
  // map or not, and Composio's own refusal by slug came before the tool reached TikTok (and has its own advice).
  test("TikTok's own error code on a write keeps its meaning even when our map doesn't list it", async () => {
    const unlisted = { code: "video_too_long_for_inbox", message: "The video is too long for the inbox." };
    mock.once("TIKTOK_UPLOAD_VIDEO", () => ({ json: { successful: false, error: "Request failed", data: tiktokBody({}, unlisted) } }));
    mock.once("TIKTOK_UPLOAD_VIDEO", () => ({ json: { successful: false, error: { ...unlisted, log_id: "202611120000AA" }, data: null } }));
    const { client, soon } = setup();
    for (let i = 0; i < 2; i++) {
      const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
      expect(e.code).toBe("UNKNOWN");
      expect(e.detail.tiktok_code).toBe("video_too_long_for_inbox");
      expect(e.card).toContain("The video is too long for the inbox.");
    }
    expect(mock.executes().length).toBe(2);
  });

  test("Composio's own refusal by slug inside an HTTP 200 keeps its advice (reconnect), not OUTCOME_UNKNOWN", async () => {
    mock.on("TIKTOK_UPLOAD_VIDEO", () => ({ json: { successful: false, error: { message: "Connected account expired", slug: "ConnectedAccountExpired" }, data: null } }));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect(e.code).toBe("AUTH_EXPIRED");
    expect(e.detail.source).toBe("composio");
    expect(mock.executes().length).toBe(1);
  });

  test("the same app failure on a read is an ordinary failure, not OUTCOME_UNKNOWN", async () => {
    mock.on("TIKTOK_GET_USER_STATS", () => ({ json: { successful: false, error: "Something went wrong while processing the request", data: null } }));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }));
    expect(e.code).toBe("UNKNOWN");
  });

  test("TikTok's own error on a write keeps its meaning, and a read's timeout isn't OUTCOME_UNKNOWN", async () => {
    mock.once("TIKTOK_UPLOAD_VIDEO", () => ({
      json: { successful: false, error: "internal_error", data: { data: {}, error: { code: "internal_error", message: "", log_id: "log_x" } } },
    }));
    mock.once("TIKTOK_UPLOAD_VIDEO", () => ({ json: { successful: false, error: { code: "spam_risk_too_many_pending_share", message: "" }, data: null } }));
    mock.on("TIKTOK_GET_USER_STATS", () => ({ json: { successful: false, error: "Read timed out. (read timeout=60)", data: null } }));
    const { client, soon } = setup();
    const write = () => failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect((await write()).code).toBe("TIKTOK_SERVER");
    expect((await write()).code).toBe("DRAFTS_CAP");
    expect((await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }))).code).not.toBe("OUTCOME_UNKNOWN");
  });

  test("a network error → OUTCOME_UNKNOWN, one attempt, sent on a fresh connection", async () => {
    const s = scriptedFetch(["reset", "pass"]);
    const { client, soon, clock } = setup({}, s.fetch);
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect(e.code).toBe("OUTCOME_UNKNOWN");
    const sent = s.inits.filter((c) => c.url.includes("/tools/execute/"));
    expect(sent.length).toBe(1);
    expect(sent[0].init?.keepalive).toBe(false);
    expect(sent[0].init?.redirect).toBe("error");
    expect(clock.sleeps).toEqual([]);
  });

  test("a clean 4xx is a normal failure, not unknown", async () => {
    mock.on("TIKTOK_UPLOAD_VIDEO", () => reply.composioError(429, "RateLimit_Exceeded", "Too many requests"));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect(e.code).toBe("RATE_LIMITED");
    expect(mock.executes().length).toBe(1);
  });

  test("successful:false with TikTok's code → the mapped code, one init", async () => {
    mock.on("TIKTOK_UPLOAD_VIDEO", () => reply.fail("spam_risk_too_many_pending_share"));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect(e.code).toBe("DRAFTS_CAP");
    expect(String(e.detail.log_id)).toMatch(/^2026/);
    expect(mock.executes().length).toBe(1);
  });

  // A Composio 500 can arrive after TikTok already accepted the init (e.g. Composio failing on TikTok's
  // answer), so on a write it is an unknown outcome, never "nothing was posted" (plan §5.3: unknown beats a duplicate).
  for (const status of [500, 501]) {
    test(`a ${status} on a write isn't retried and is OUTCOME_UNKNOWN`, async () => {
      mock.on("TIKTOK_UPLOAD_VIDEO", () => reply.composioError(status));
      const { client, soon, clock } = setup();
      const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
      expect(e.code).toBe("OUTCOME_UNKNOWN");
      expect(mock.executes().length).toBe(1);
      expect(clock.sleeps).toEqual([]);
    });
  }
});

describe("TikTok's failures map to our codes", () => {
  const cases: Array<[string, string]> = [
    ["rate_limit_exceeded", "RATE_LIMITED"],
    ["spam_risk_too_many_posts", "POSTING_CAP"],
    ["spam_risk_too_many_pending_share", "DRAFTS_CAP"],
    ["reached_active_user_cap", "CREATOR_CANNOT_POST"],
    ["unaudited_client_can_only_post_to_private_accounts", "PRIVATE_ACCOUNT_REQUIRED"],
    ["privacy_level_option_mismatch", "PRIVACY_MISMATCH"],
    ["url_ownership_unverified", "URL_OWNERSHIP_UNVERIFIED"],
    ["invalid_file_upload", "UPLOAD_FAILED"],
    ["invalid_params", "INVALID_PARAM"],
    ["invalid_publish_id", "INVALID_PARAM"],
    ["app_version_check_failed", "APP_VERSION_TOO_OLD"],
    ["internal_error", "TIKTOK_SERVER"],
  ];
  for (const [tiktok, ours] of cases) {
    test(`successful:false naming ${tiktok} → ${ours}`, async () => {
      mock.on("TIKTOK_FETCH_PUBLISH_STATUS", () => reply.fail(tiktok));
      const { client, soon } = setup();
      const e = await failure(client.exec("TIKTOK_FETCH_PUBLISH_STATUS", { publish_id: "v_pub_file~v2.1" }, { deadline: soon() }));
      expect(e.code).toBe(ours);
      expect(mock.executes().length).toBe(1);
    });
  }

  test("scope_not_authorized names the missing scope", async () => {
    mock.on("TIKTOK_LIST_VIDEOS", () => reply.fail("scope_not_authorized", "The user did not authorize the scope video.list."));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() }));
    expect(e.code).toBe("SCOPE_MISSING");
    expect(e.detail.scope).toBe("video.list");
  });

  test("creator info's HTTP-200 error (the v2 parseData regression) → POSTING_CAP, not a successful lookup", async () => {
    mock.on("TIKTOK_QUERY_CREATOR_INFO", () => reply.tiktokError("spam_risk_too_many_posts"));
    const { client, soon } = setup();
    expect((await failure(client.exec("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: soon() }))).code).toBe("POSTING_CAP");
  });

  test("a generic error text with TikTok's code only in data still maps", async () => {
    mock.on("TIKTOK_UPLOAD_VIDEO", () => ({
      json: { successful: false, error: "Request failed", data: tiktokBody({}, { code: "spam_risk_too_many_pending_share" }) },
    }));
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect(e.code).toBe("DRAFTS_CAP");
  });

  test("Composio's unknown-account error → NOT_CONNECTED", async () => {
    mock.on("TIKTOK_LIST_VIDEOS", () => reply.composioError(404, "ActionExecute_ConnectedAccountNotFound", "No connected account"));
    const { client, soon } = setup();
    expect((await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() }))).code).toBe("NOT_CONNECTED");
  });
});

describe("expiry detection (plan §5.6)", () => {
  test("access_token_invalid while Composio says ACTIVE → AUTH_REVOKED, after a fresh check", async () => {
    mock.tiktokTokenInvalid = true;
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }));
    expect(e.code).toBe("AUTH_REVOKED");
    expect(mock.calls.map((c) => c.path)).toEqual(["/connected_accounts", "/tools/execute/TIKTOK_GET_USER_STATS", "/connected_accounts"]);
  });

  test("access_token_invalid after Composio marked the account EXPIRED → AUTH_EXPIRED", async () => {
    mock.on("TIKTOK_GET_USER_STATS", () => {
      mock.account.status = "EXPIRED"; // a failed (rotating) refresh, mid-call
      return reply.fail("access_token_invalid");
    });
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }));
    expect(e.code).toBe("AUTH_EXPIRED");
    expect(e.card).toContain("Reconnect");
  });

  test("access_token_invalid inside an HTTP-200 TikTok body is handled the same way", async () => {
    mock.on("TIKTOK_LIST_VIDEOS", () => reply.tiktokError("access_token_invalid"));
    const { client, soon } = setup();
    expect((await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() }))).code).toBe("AUTH_REVOKED");
  });

  test("Composio's expired-account error inside the cache window → fresh check → AUTH_EXPIRED", async () => {
    const { client, soon } = setup();
    await client.exec("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: soon() }); // caches ACTIVE
    mock.account.status = "EXPIRED";
    const e = await failure(client.exec("TIKTOK_LIST_VIDEOS", {}, { deadline: soon() }));
    expect(e.code).toBe("AUTH_EXPIRED");
    expect(mock.calls.filter((c) => c.path === "/connected_accounts").length).toBe(2);
  });

  test("a write answered with an auth error is re-checked too: a disabled account → AUTH_REVOKED", async () => {
    const { client, soon } = setup();
    await client.assertAccount(live());
    mock.account.is_disabled = true;
    const e = await failure(client.exec("TIKTOK_UPLOAD_VIDEO", videoDraftArgs(staged), { deadline: soon(), write: true }));
    expect(e.code).toBe("AUTH_REVOKED");
    expect(mock.executes().length).toBe(1);
  });

  test("if the fresh re-check can't run, what TikTok said stands", async () => {
    let n = 0;
    mock.onRoute("GET", "/connected_accounts", () => (n++ === 0 ? undefined : reply.composioError(503)));
    mock.tiktokTokenInvalid = true;
    const { client, soon } = setup();
    const e = await failure(client.exec("TIKTOK_GET_USER_STATS", {}, { deadline: soon() }));
    expect(e.code).toBe("AUTH_EXPIRED");
    expect(e.detail.tiktok_code).toBe("access_token_invalid");
  });
});

describe("stageFile (plan §5.3–5.4)", () => {
  test("streams the MD5, asks Composio for an upload, and PUTs the bytes with the content-type and no API key", async () => {
    const f = tempVideo();
    const { client, clock } = setup();
    const out = await client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000);
    const req = mock.calls.find((c) => c.path === "/files/upload/request")!;
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe(mock.apiKey);
    expect(req.body).toEqual({
      toolkit_slug: "tiktok",
      tool_slug: "TIKTOK_UPLOAD_VIDEO",
      filename: "My Clip (final).mp4",
      mimetype: "video/mp4",
      md5: f.md5,
    });
    expect(mock.presigned.puts.length).toBe(1);
    const put = mock.presigned.puts[0];
    expect(put.headers["content-type"]).toBe("video/mp4");
    expect(put.headers["x-api-key"]).toBeUndefined();
    expect(put.headers["x-ms-blob-type"]).toBeUndefined();
    expect(put.headers["content-length"]).toBe(String(f.size));
    expect(put.bytes).toBe(f.size);
    expect(put.md5).toBe(f.md5);
    expect(out).toEqual({ name: "My Clip (final).mp4", mimetype: "video/mp4", s3key: put.key });
    expect(out.s3key.startsWith(`tiktok/TIKTOK_UPLOAD_VIDEO/${f.md5}/`)).toBe(true);
    // staging never runs a tool
    expect(mock.executes().length).toBe(0);
  });

  test("Azure storage gets x-ms-blob-type: BlockBlob", async () => {
    mock.presigned.storageBackend = "azure_blob_storage";
    const f = tempVideo("azure.mov", 4_096);
    const { client, clock } = setup();
    const out = await client.stageFile(f.path, "video/quicktime", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000);
    expect(mock.presigned.puts.length).toBe(1);
    expect(mock.presigned.puts[0].headers["x-ms-blob-type"]).toBe("BlockBlob");
    expect(mock.presigned.puts[0].headers["content-type"]).toBe("video/quicktime");
    expect(out.mimetype).toBe("video/quicktime");
  });

  test("MD5 dedup (no presigned URL) skips the PUT and still returns the key", async () => {
    mock.presigned.dedup = true;
    const f = tempVideo("dedup.mp4", 2_048);
    const { client, clock } = setup();
    const out = await client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000);
    expect(mock.presigned.puts.length).toBe(0);
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(out.s3key.startsWith(`tiktok/TIKTOK_UPLOAD_VIDEO/${f.md5}/`)).toBe(true);
  });

  test("the staged descriptor is what TIKTOK_UPLOAD_VIDEO takes", async () => {
    const f = tempVideo("e2e.mp4", 10_000);
    const { client, clock } = setup();
    const deadline = clock.now() + 60_000;
    const file = await client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", deadline);
    const out = await client.exec<any>("TIKTOK_UPLOAD_VIDEO", videoDirectArgs(file, { privacy_level: "SELF_ONLY" }, open), {
      deadline,
      write: true,
    });
    expect(out.publish_id).toMatch(/^v_pub_file~v2\./);
    const s1 = await client.exec<any>("TIKTOK_FETCH_PUBLISH_STATUS", { publish_id: out.publish_id }, { deadline });
    const s2 = await client.exec<any>("TIKTOK_FETCH_PUBLISH_STATUS", { publish_id: out.publish_id }, { deadline });
    expect([s1.status, s2.status]).toEqual(["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"]);
    expect(s2.uploaded_bytes).toBe(10_000);
  });

  test("a rejected PUT → UPLOAD_FAILED, nothing reached TikTok", async () => {
    mock.onRoute("PUT", /^\/presigned\//, () => ({ status: 403, text: "<Error><Code>AccessDenied</Code></Error>" }));
    const f = tempVideo("rejected.mp4", 1_000);
    const { client, clock } = setup();
    const e = await failure(client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000));
    expect(e.code).toBe("UPLOAD_FAILED");
    expect(e.detail.nothing_sent).toBe(true);
    expect(e.detail.status).toBe(403);
    expect(mock.executes().length).toBe(0);
  });

  test("a dropped PUT → UPLOAD_FAILED", async () => {
    mock.onRoute("PUT", /^\/presigned\//, () => reply.drop());
    const f = tempVideo("dropped.mp4", 1_000);
    const { client, clock } = setup();
    expect((await failure(client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000))).code).toBe("UPLOAD_FAILED");
  });

  test("the upload request failing → UPLOAD_FAILED; a 401 there → NOT_CONFIGURED key_rejected", async () => {
    const f = tempVideo("reqfail.mp4", 1_000);
    const { client, clock } = setup();
    mock.onRoute("POST", "/files/upload/request", () => reply.composioError(500));
    expect((await failure(client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000))).code).toBe("UPLOAD_FAILED");
    mock.reset();
    mock.onRoute("POST", "/files/upload/request", () => ({ json: { id: "f1", type: "new" } })); // no key
    expect((await failure(client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000))).code).toBe("UPLOAD_FAILED");
    mock.reset();
    const bad = setup({ apiKey: "wrong_key" });
    const e = await failure(bad.client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000));
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(e.detail.reason).toBe("key_rejected");
  });

  test("a presigned URL that is plain http on a non-loopback host is refused before any byte is sent", async () => {
    mock.onRoute("POST", "/files/upload/request", () => ({
      json: { id: "f1", key: "k1", type: "new", new_presigned_url: "http://storage.example.com/k1?sig=abc", metadata: { storage_backend: "s3" } },
    }));
    const f = tempVideo("insecure.mp4", 1_000);
    const { client, clock } = setup();
    const e = await failure(client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000));
    expect(e.code).toBe("UPLOAD_FAILED");
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a missing file → UPLOAD_FAILED, nothing sent", async () => {
    const { client, clock } = setup();
    const e = await failure(client.stageFile(join(dir, "gone.mp4"), "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000));
    expect(e.code).toBe("UPLOAD_FAILED");
    expect(mock.calls.length).toBe(0);
  });

  test("past the deadline → UPLOAD_FAILED, nothing sent", async () => {
    const f = tempVideo("late.mp4", 1_000);
    const { client, clock } = setup();
    const e = await failure(client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 500));
    expect(e.code).toBe("UPLOAD_FAILED");
    expect(mock.calls.length).toBe(0);
  });
});

describe("logging (contract rule 2)", () => {
  test("logs the presigned host once per process, never the URL, the key or the account id", async () => {
    const other = startMockComposio(); // a host this process hasn't logged yet
    try {
      const f = tempVideo("logged.mp4", 2_000);
      const clock = new FakeClock();
      const client = new ComposioClient(
        { apiKey: other.apiKey, userId: other.userId, connectedAccountId: other.connectedAccountId, baseUrl: other.baseUrl, relayBase: "", stateDir: "/x", home: "/x" },
        { clock },
      );
      const lines = await captureLogs(async () => {
        await client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000);
        await client.stageFile(f.path, "video/mp4", "TIKTOK_UPLOAD_VIDEO", clock.now() + 60_000);
      });
      const host = new URL(other.origin).host;
      expect(lines.filter((l) => l.includes(host)).length).toBe(1);
      const all = lines.join("\n");
      expect(all).not.toContain("X-Amz-Signature");
      expect(all).not.toContain("/presigned/");
      expect(all).not.toContain(other.apiKey);
      expect(all).not.toContain(other.connectedAccountId);
      expect(all).not.toContain(dir);
      expect(all).toContain("stage TIKTOK_UPLOAD_VIDEO");
    } finally {
      other.stop();
    }
  });

  test("each execute logs slug, duration, our code and the log ids — nothing else", async () => {
    const { client, soon } = setup();
    mock.once("TIKTOK_UPLOAD_VIDEO", () => reply.fail("spam_risk_too_many_pending_share"));
    const lines = await captureLogs(async () => {
      await client.exec("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: soon() });
      await client.exec("TIKTOK_UPLOAD_VIDEO", videoDirectArgs(staged, { caption: "my secret caption #x", privacy_level: "SELF_ONLY" }, open), {
        deadline: soon(),
        write: true,
      });
    });
    const ok = lines.find((l) => l.includes("TIKTOK_QUERY_CREATOR_INFO"))!;
    expect(ok).toMatch(/^\[tiktok\] exec TIKTOK_QUERY_CREATOR_INFO \d+ms ok log_id=log_[0-9a-f]+ tiktok_log_id=2026[0-9A-F]+$/);
    const bad = lines.find((l) => l.includes("TIKTOK_UPLOAD_VIDEO"))!;
    expect(bad).toMatch(/^\[tiktok\] exec TIKTOK_UPLOAD_VIDEO \d+ms DRAFTS_CAP log_id=log_[0-9a-f]+ tiktok_log_id=2026[0-9A-F]+$/);
    const all = lines.join("\n");
    for (const secret of [mock.apiKey, mock.connectedAccountId, "Mock Creator", "secret caption", "act.mock-secret", "clip.mp4"]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("argument builders", () => {
  const urls = ["https://media.example.com/b/1.jpg", "https://media.example.com/b/2.jpg"];

  test("bool and int normalize what the widget bridge sends", () => {
    expect([true, "true", false, "false", "TRUE", 1, undefined, null].map(bool)).toEqual([true, true, false, false, false, false, false, false]);
    expect(int(3000)).toBe(3000);
    expect(int("3000")).toBe(3000);
    expect(int("0")).toBe(0);
    expect(int("03000")).toBe(3000);
    expect(int(" 42 ")).toBe(42);
    for (const v of ["-1", "1.5", "", "abc", undefined, null, Number.NaN, Number.POSITIVE_INFINITY, true]) expect(int(v)).toBeUndefined();
  });

  test("videoDraftArgs: the file and publish:false, nothing else", () => {
    expect(videoDraftArgs({ ...staged, extra: "x" } as StagedFile)).toEqual({ file_to_upload: staged, publish: false });
  });

  test("videoDirectArgs inverts allow_* into disable_*", () => {
    const a = videoDirectArgs(staged, { caption: "hi", privacy_level: "SELF_ONLY", allow_comment: true, allow_duet: false, allow_stitch: true }, open);
    expect(a).toEqual({
      file_to_upload: staged,
      publish: true,
      caption: "hi",
      privacy_level: "SELF_ONLY",
      disable_comment: false,
      disable_duet: true,
      disable_stitch: false,
      brand_organic_toggle: false,
      brand_content_toggle: false,
      is_aigc: false,
    });
    // toggles left out are off, so everything is disabled
    expect(videoDirectArgs(staged, { privacy_level: "SELF_ONLY" }, open)).toMatchObject({
      disable_comment: true,
      disable_duet: true,
      disable_stitch: true,
    });
  });

  test("creator-disabled flags force disable_* even when the card allows them", () => {
    const all = { privacy_level: "SELF_ONLY", allow_comment: true, allow_duet: true, allow_stitch: true };
    expect(videoDirectArgs(staged, all, { comment_disabled: true, duet_disabled: true, stitch_disabled: true })).toMatchObject({
      disable_comment: true,
      disable_duet: true,
      disable_stitch: true,
    });
    expect(videoDirectArgs(staged, all, { comment_disabled: false, duet_disabled: true, stitch_disabled: false })).toMatchObject({
      disable_comment: false,
      disable_duet: true,
      disable_stitch: false,
    });
  });

  test("both brand toggles are always sent, and false unless commercial disclosure is on", () => {
    const off = videoDirectArgs(staged, { privacy_level: "SELF_ONLY", brand_organic: true, brand_content: true }, open);
    expect(off).toMatchObject({ brand_organic_toggle: false, brand_content_toggle: false });
    expect("brand_organic_toggle" in videoDirectArgs(staged, {}, open) && "brand_content_toggle" in videoDirectArgs(staged, {}, open)).toBe(true);
    expect(videoDirectArgs(staged, { commercial_disclosure: true, brand_organic: true }, open)).toMatchObject({
      brand_organic_toggle: true,
      brand_content_toggle: false,
    });
    expect(videoDirectArgs(staged, { commercial_disclosure: "true", brand_content: "true" }, open)).toMatchObject({
      brand_organic_toggle: false,
      brand_content_toggle: true,
    });
    expect(videoDirectArgs(staged, { commercial_disclosure: "false", brand_content: "true" }, open).brand_content_toggle).toBe(false);
  });

  test("card strings are normalized: \"true\"/\"false\", \"3000\", privacy case, CRLF captions", () => {
    const a = videoDirectArgs(
      staged,
      {
        caption: "line one\r\nline two\r\n#tag",
        privacy_level: " self_only ",
        allow_comment: "true",
        allow_duet: "false",
        allow_stitch: "true",
        is_aigc: "true",
        cover_ms: "3000",
      },
      open,
    );
    expect(a).toMatchObject({
      caption: "line one\nline two\n#tag",
      privacy_level: "SELF_ONLY",
      disable_comment: false,
      disable_duet: true,
      disable_stitch: false,
      is_aigc: true,
      video_cover_timestamp_ms: 3000,
    });
    expect(videoDirectArgs(staged, { cover_ms: 1500 }, open).video_cover_timestamp_ms).toBe(1500);
    expect("video_cover_timestamp_ms" in videoDirectArgs(staged, { cover_ms: "" }, open)).toBe(false);
    expect("video_cover_timestamp_ms" in videoDirectArgs(staged, {}, open)).toBe(false);
    expect(videoDirectArgs(staged, {}, open).caption).toBe("");
  });

  test("what the builders send is what the receipt signed", () => {
    const args = { caption: "a\r\nb  ", privacy_level: " self_only", cover_ms: "0300", allow_comment: "true" };
    const sent = videoDirectArgs(staged, args, open);
    expect(sent.caption).toBe(TKR.normCaption(args.caption));
    expect(sent.privacy_level).toBe(TKR.normUpper(args.privacy_level));
    expect(String(sent.video_cover_timestamp_ms)).toBe(TKR.normInt(args.cover_ms));
    expect(String(!sent.disable_comment)).toBe(TKR.normBool(args.allow_comment));
  });

  test("photoDraftArgs: MEDIA_UPLOAD; empty title and description are left out; CRLF → LF", () => {
    expect(photoDraftArgs(urls, 1, {})).toEqual({ post_mode: "MEDIA_UPLOAD", photo_images: urls, photo_cover_index: 1 });
    expect(photoDraftArgs(urls, 0, { title: "", description: "" })).toEqual({ post_mode: "MEDIA_UPLOAD", photo_images: urls, photo_cover_index: 0 });
    expect(photoDraftArgs(urls, 0, { title: "Trip", description: "Day 1\r\nDay 2" })).toEqual({
      post_mode: "MEDIA_UPLOAD",
      photo_images: urls,
      photo_cover_index: 0,
      title: "Trip",
      description: "Day 1\nDay 2",
    });
    expect(photoDraftArgs(urls, 0, {}).photo_images).not.toBe(urls);
  });

  test("photoDirectArgs: DIRECT_POST with every field, creator flags enforced, no is_aigc", () => {
    expect(photoDirectArgs(urls, 0, { privacy_level: "self_only", allow_comment: "true", auto_add_music: "true" }, { comment_disabled: false })).toEqual({
      post_mode: "DIRECT_POST",
      photo_images: urls,
      photo_cover_index: 0,
      title: "",
      description: "",
      privacy_level: "SELF_ONLY",
      disable_comment: false,
      auto_add_music: true,
      brand_organic_toggle: false,
      brand_content_toggle: false,
    });
    const forced = photoDirectArgs(urls, 1, { privacy_level: "SELF_ONLY", allow_comment: true, title: "T\r\n", commercial_disclosure: "true", brand_organic: "true" }, { comment_disabled: true });
    expect(forced).toMatchObject({ disable_comment: true, title: "T\n", brand_organic_toggle: true, brand_content_toggle: false, auto_add_music: false });
    expect("is_aigc" in forced).toBe(false);
  });

  test("the photo builders' output is what TIKTOK_POST_PHOTO accepts", async () => {
    const { client, soon } = setup();
    const draft = await client.exec<any>("TIKTOK_POST_PHOTO", photoDraftArgs(urls, 1, { title: "Trip" }), { deadline: soon(), write: true });
    expect(draft.publish_id).toMatch(/^p_pub_url~v2\./);
    const direct = await client.exec<any>("TIKTOK_POST_PHOTO", photoDirectArgs(urls, 0, { privacy_level: "SELF_ONLY" }, { comment_disabled: false }), {
      deadline: soon(),
      write: true,
    });
    expect(direct.publish_id).toMatch(/^p_pub_url~v2\./);
    expect(mock.issued.get(direct.publish_id)?.mode).toBe("direct");
  });
});
