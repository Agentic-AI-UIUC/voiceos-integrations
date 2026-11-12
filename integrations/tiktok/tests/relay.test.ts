/**
 * Media relay client (src/relay.ts) against the loopback mock relay, plus the
 * `pool` helper. No real network: every request goes to 127.0.0.1.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TikTokError } from "../src/errors.ts";
import { RelayClient, pool, type RelayBatch } from "../src/relay.ts";
import type { Clock } from "../src/types.ts";
import { startMockRelay, type MockRelay } from "./mock-relay.ts";

const jpeg = (n: number, size = 64) => {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  b[size - 1] = n; // distinguishable payloads
  return b;
};
const files = (count: number) => Array.from({ length: count }, (_, i) => ({ bytes: jpeg(i), mime: "image/jpeg" as const }));

function fakeClock() {
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => Date.now(),
    sleep: async (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      if (signal?.aborted) throw signal.reason;
    },
  };
  return { clock, sleeps };
}

async function caught(p: Promise<unknown>): Promise<TikTokError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TikTokError);
    return e as TikTokError;
  }
  throw new Error("expected a rejection");
}

// A fresh relay per test. When a PUT fails, the client aborts the PUTs still in flight, but an aborted
// request can reach the server after the test has ended; a shared relay recorded it in the next test
// (the 409 test saw the network-error test's aborted PUT of item 0 as a second PUT).
let relay: MockRelay;
beforeEach(() => {
  relay = startMockRelay({ token: "tok-SECRET-123" });
});
afterEach(() => relay.stop());

// ---------------------------------------------------------------------------
// pool
// ---------------------------------------------------------------------------

describe("pool", () => {
  test("runs at most `limit` tasks at once and keeps results in task order", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5 + ((i * 7) % 11)); // finish out of order
      active--;
      return i * 10;
    });
    const out = await pool(4, tasks);
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(peak).toBe(4);
  });

  test("a limit above the task count runs everything at once; limit 0 still makes progress", async () => {
    let active = 0;
    let peak = 0;
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active--;
        return i;
      });
    expect(await pool(10, mk(3))).toEqual([0, 1, 2]);
    expect(peak).toBe(3);
    peak = 0;
    expect(await pool(0, mk(3))).toEqual([0, 1, 2]);
    expect(peak).toBe(1);
    expect(await pool(4, [])).toEqual([]);
  });

  test("after a failure no new task starts, in-flight ones settle, and the first error is thrown", async () => {
    const started: number[] = [];
    let settled = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      started.push(i);
      if (i === 1) throw new Error("boom-1");
      await Bun.sleep(20);
      settled++;
      if (i === 2) throw new Error("boom-2");
      return i;
    });
    await expect(pool(3, tasks)).rejects.toThrow("boom-1");
    expect(started).toEqual([0, 1, 2]); // nothing after the failure
    expect(settled).toBe(2); // 0 and 2 finished before pool returned
  });

  test("a task that throws synchronously is a failure, not a crash", async () => {
    const tasks: Array<() => Promise<number>> = [
      async () => 1,
      () => {
        throw new Error("sync");
      },
    ];
    await expect(pool(2, tasks)).rejects.toThrow("sync");
  });
});

// ---------------------------------------------------------------------------
// RelayClient
// ---------------------------------------------------------------------------

describe("RelayClient: not configured", () => {
  test("empty base or token → configured false; every call refuses before any network call", async () => {
    let fetches = 0;
    const spy = ((...args: Parameters<typeof fetch>) => {
      fetches++;
      return fetch(...args);
    }) as typeof fetch;
    const { clock } = fakeClock();
    const batch: RelayBatch = {
      batch_id: "b_abcdefghijklmnopqrstuv",
      expires_at: new Date().toISOString(),
      items: [{ index: 0, put_path: "/v1/batches/b_abcdefghijklmnopqrstuv/0", public_url: `${relay.baseUrl}/p/x/0.jpg` }],
    };
    for (const [base, token] of [
      ["", relay.token],
      [relay.baseUrl, ""],
      [relay.baseUrl, undefined],
      [relay.baseUrl, "   "],
      ["", undefined],
    ] as Array<[string, string | undefined]>) {
      const c = new RelayClient(base, token, { fetch: spy, clock });
      expect(c.configured).toBe(false);
      expect((await caught(c.createBatch(2))).code).toBe("RELAY_NOT_CONFIGURED");
      expect((await caught(c.putImages(batch, files(1)))).code).toBe("RELAY_NOT_CONFIGURED");
      await c.deleteBatch(batch.batch_id); // just returns
    }
    expect(fetches).toBe(0);
    expect(relay.calls).toHaveLength(0);
  });

  test("a non-https base (other than loopback) or a malformed one isn't configured", () => {
    const { clock } = fakeClock();
    expect(new RelayClient("http://tiktok-media.example.com", "t", { clock }).configured).toBe(false);
    expect(new RelayClient("tiktok-media.example.com", "t", { clock }).configured).toBe(false);
    expect(new RelayClient("ftp://tiktok-media.example.com", "t", { clock }).configured).toBe(false);
    expect(new RelayClient("https://tiktok-media.example.com/", "t", { clock }).configured).toBe(true);
    expect(new RelayClient("http://127.0.0.1:9", "t", { clock }).configured).toBe(true);
    expect(new RelayClient("http://localhost:9", "t", { clock }).configured).toBe(true);
  });
});

describe("RelayClient against the mock relay", () => {
  const client = (opts: { fetch?: typeof fetch; token?: string } = {}) => {
    const fc = fakeClock();
    return { c: new RelayClient(relay.baseUrl, opts.token ?? relay.token, { fetch: opts.fetch, clock: fc.clock }), ...fc };
  };

  test("the batch POST goes out on a fresh connection (Bun can silently re-send a POST on a dropped reused socket)", async () => {
    const inits: RequestInit[] = [];
    const recording = ((url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return fetch(url, init);
    }) as typeof fetch;
    const { c } = client({ fetch: recording });
    await c.createBatch(2);
    const post = inits.find((i) => i.method === "POST");
    expect(post?.keepalive).toBe(false);
  });

  test("create → 8 PUTs, 4 in parallel → public URLs in carousel order, bearer on every call", async () => {
    relay.putDelayMs = 40;
    relay.shuffleItems = true; // the relay may list items in any order
    const { c } = client();
    expect(c.configured).toBe(true);
    const batch = await c.createBatch(8);
    expect(batch.batch_id).toMatch(/^b_/);
    expect(batch.items).toHaveLength(8);
    const progress: number[] = [];
    const urls = await c.putImages(batch, files(8), undefined, (done) => progress.push(done));

    expect(urls).toEqual(Array.from({ length: 8 }, (_, i) => `${relay.baseUrl}/p/${batch.batch_id}/${i}.jpg`));
    expect(relay.maxInFlight).toBe(4);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Each object landed at its own index with its own bytes and type.
    const stored = relay.batches.get(batch.batch_id)!;
    for (let i = 0; i < 8; i++) {
      expect(stored.objects.get(i)!.bytes[63]).toBe(i);
      expect(stored.objects.get(i)!.contentType).toBe("image/jpeg");
    }
    expect(relay.calls.length).toBe(9);
    for (const call of relay.calls) expect(call.headers.authorization).toBe(`Bearer ${relay.token}`);
    expect(relay.calls[0]).toMatchObject({ method: "POST", path: "/v1/batches", status: 201 });
  });

  test("a PUT that answers 503 once is retried once, then succeeds", async () => {
    relay.failPutOnce.add(2);
    const { c, sleeps } = client();
    const batch = await c.createBatch(3);
    const urls = await c.putImages(batch, files(3));
    expect(urls).toHaveLength(3);
    expect(relay.puts(2).map((p) => p.status)).toEqual([503, 201]);
    expect(relay.puts(0)).toHaveLength(1);
    expect(sleeps).toHaveLength(1); // a short pause before the retry
  });

  test("a PUT that keeps answering 503 fails after exactly one retry → RELAY_UNAVAILABLE", async () => {
    relay.failPutAlways.add(1);
    const { c } = client();
    const batch = await c.createBatch(2);
    const e = await caught(c.putImages(batch, files(2)));
    expect(e.code).toBe("RELAY_UNAVAILABLE");
    expect(e.detail.status).toBe(503);
    expect(relay.puts(1)).toHaveLength(2);
  });

  test("a network error is retried once; two in a row → RELAY_UNAVAILABLE", async () => {
    let failures = 1;
    const flaky = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.endsWith("/1") && failures > 0) {
        failures--;
        return Promise.reject(new TypeError("socket closed"));
      }
      return fetch(input, init);
    }) as typeof fetch;
    const { c } = client({ fetch: flaky });
    const batch = await c.createBatch(2);
    expect(await c.putImages(batch, files(2))).toHaveLength(2);
    expect(relay.puts(1)).toHaveLength(1); // the first attempt never reached the relay

    failures = 2;
    const batch2 = await c.createBatch(2);
    const e = await caught(c.putImages(batch2, files(2)));
    expect(e.code).toBe("RELAY_UNAVAILABLE");
    expect(e.detail.reason).toBe("network");
  });

  test("409 (already uploaded) counts as done, with no retry", async () => {
    relay.putStatus.set(0, 409);
    const { c, sleeps } = client();
    const batch = await c.createBatch(2);
    expect(await c.putImages(batch, files(2))).toHaveLength(2);
    expect(relay.puts(0)).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  test("403 → RELAY_UNAVAILABLE without a retry, and no new PUT starts after it", async () => {
    relay.putStatus.set(0, 403);
    relay.putDelayMs = 10;
    const { c } = client();
    const batch = await c.createBatch(8);
    const e = await caught(c.putImages(batch, files(8)));
    expect(e.code).toBe("RELAY_UNAVAILABLE");
    expect(e.detail.status).toBe(403);
    expect(relay.puts(0)).toHaveLength(1);
    expect(relay.puts().length).toBeLessThan(8);
  });

  test("other 4xx answers (400, 413, 410) fail without a retry", async () => {
    for (const status of [400, 410, 413]) {
      relay.reset();
      relay.putStatus.set(0, status);
      const { c } = client();
      const batch = await c.createBatch(1);
      const e = await caught(c.putImages(batch, files(1)));
      expect(e.code).toBe("RELAY_UNAVAILABLE");
      expect(e.detail.status).toBe(status);
      expect(relay.puts(0)).toHaveLength(1);
    }
  });

  test("createBatch failures → RELAY_UNAVAILABLE (5xx, rejected token, malformed answer, relay down)", async () => {
    relay.createStatus = 500;
    expect((await caught(client().c.createBatch(2))).code).toBe("RELAY_UNAVAILABLE");
    relay.createStatus = undefined;

    const wrongToken = await caught(client({ token: "nope" }).c.createBatch(2));
    expect(wrongToken.code).toBe("RELAY_UNAVAILABLE");
    expect(wrongToken.detail.status).toBe(401);

    const malformed: unknown[] = [
      { batch_id: "b_x", expires_at: "2026-11-03T00:00:00Z" }, // no items
      { batch_id: "b_x", expires_at: "2026-11-03T00:00:00Z", items: [{ index: 0, put_path: "/v1/batches/b_x/0", public_url: `${relay.baseUrl}/p/b_x/0.jpg` }] }, // 1 item for count 2
      {
        batch_id: "b_x",
        expires_at: "2026-11-03T00:00:00Z",
        items: [
          { index: 0, put_path: "v1/batches/b_x/0", public_url: `${relay.baseUrl}/p/b_x/0.jpg` }, // relative path
          { index: 1, put_path: "/v1/batches/b_x/1", public_url: `${relay.baseUrl}/p/b_x/1.jpg` },
        ],
      },
      {
        batch_id: "b_x",
        expires_at: "2026-11-03T00:00:00Z",
        items: [
          { index: 0, put_path: "/v1/batches/b_x/0", public_url: `${relay.baseUrl}/p/b_x/0.jpg` },
          { index: 0, put_path: "/v1/batches/b_x/1", public_url: `${relay.baseUrl}/p/b_x/1.jpg` }, // duplicate index
        ],
      },
      {
        batch_id: "b_x/../../etc",
        expires_at: "2026-11-03T00:00:00Z",
        items: [
          { index: 0, put_path: "/v1/batches/b_x/0", public_url: `${relay.baseUrl}/p/b_x/0.jpg` },
          { index: 1, put_path: "/v1/batches/b_x/1", public_url: `${relay.baseUrl}/p/b_x/1.jpg` },
        ],
      },
      {
        batch_id: "b_x",
        expires_at: "2026-11-03T00:00:00Z",
        items: [
          { index: 0, put_path: "/v1/batches/b_x/0", public_url: "javascript:alert(1)" },
          { index: 1, put_path: "/v1/batches/b_x/1", public_url: `${relay.baseUrl}/p/b_x/1.jpg` },
        ],
      },
      "not json at all",
    ];
    for (const body of malformed) {
      relay.createBody = body;
      const e = await caught(client().c.createBatch(2));
      expect(e.code).toBe("RELAY_UNAVAILABLE");
    }
    relay.createBody = undefined;

    const down = startMockRelay();
    const base = down.baseUrl;
    down.stop();
    const { clock } = fakeClock();
    const e = await caught(new RelayClient(base, "t", { clock }).createBatch(2));
    expect(e.code).toBe("RELAY_UNAVAILABLE");
  });

  test("counts outside 1–35 are refused locally", async () => {
    const { c } = client();
    expect((await caught(c.createBatch(0))).code).toBe("NO_PHOTOS");
    const tooMany = await caught(c.createBatch(36));
    expect(tooMany.code).toBe("TOO_MANY_PHOTOS");
    expect(tooMany.detail.n).toBe(36);
    expect(relay.calls).toHaveLength(0);
  });

  test("files that don't match the batch are refused before any PUT", async () => {
    const { c } = client();
    const batch = await c.createBatch(3);
    const e = await caught(c.putImages(batch, files(2)));
    expect(e.detail.nothing_sent).toBe(true);
    expect(relay.puts()).toHaveLength(0);
  });

  test("deleteBatch removes the batch, is idempotent and never throws", async () => {
    const { c } = client();
    const batch = await c.createBatch(2);
    await c.putImages(batch, files(2));
    await c.deleteBatch(batch.batch_id);
    expect(relay.deletes).toEqual([batch.batch_id]);
    expect(relay.batches.get(batch.batch_id)!.deleted).toBe(true);
    expect((await fetch(`${relay.baseUrl}/p/${batch.batch_id}/0.jpg`)).status).toBe(404);
    await c.deleteBatch(batch.batch_id); // again: fine
    expect(relay.deletes).toEqual([batch.batch_id, batch.batch_id]);
    const del = relay.calls.filter((x) => x.method === "DELETE");
    expect(del.every((x) => x.headers.authorization === `Bearer ${relay.token}`)).toBe(true);

    // Relay down, or a rejected token: still resolves.
    const down = startMockRelay();
    const base = down.baseUrl;
    down.stop();
    const { clock } = fakeClock();
    await new RelayClient(base, "t", { clock }).deleteBatch("b_abc");
    await client({ token: "wrong" }).c.deleteBatch(batch.batch_id);
    // Garbage ids never reach the network.
    const before = relay.calls.length;
    await c.deleteBatch("");
    await c.deleteBatch("../v1/batches");
    expect(relay.calls.length).toBe(before);
  });

  test("an abort from the caller → CANCELLED, and no PUT starts afterwards", async () => {
    relay.putDelayMs = 60;
    const { c } = client();
    const batch = await c.createBatch(8);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const e = await caught(c.putImages(batch, files(8), ac.signal));
    expect(e.code).toBe("CANCELLED");
    const putsAtAbort = relay.puts().length;
    await Bun.sleep(120);
    expect(relay.puts().length).toBe(putsAtAbort);
    expect(putsAtAbort).toBeLessThanOrEqual(4);
  });

  test("logs carry the batch id prefix only: no token, URLs or paths", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      relay.failPutOnce.add(0);
      const { c } = client();
      const batch = await c.createBatch(2);
      await c.putImages(batch, files(2));
      await c.deleteBatch(batch.batch_id);
      relay.putStatus.set(0, 403);
      const b2 = await c.createBatch(1);
      await caught(c.putImages(b2, files(1)));
      await caught(client({ token: "wrong-token" }).c.createBatch(1));
      const text = lines.join("\n");
      expect(lines.length).toBeGreaterThan(0);
      expect(text).toContain(batch.batch_id.slice(0, 6));
      expect(text).not.toContain(batch.batch_id);
      expect(text).not.toContain(relay.token);
      expect(text).not.toContain("wrong-token");
      expect(text).not.toContain("http");
      expect(text).not.toContain("127.0.0.1");
      expect(text).not.toContain("/v1/");
    } finally {
      spy.mockRestore();
    }
  });
});
