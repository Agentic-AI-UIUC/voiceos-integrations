/**
 * src/covers.ts: TikTok CDN pictures for the result cards. A fake fetch stands in for the network and a fake
 * Runner for sips (CI is ubuntu and Windows); one darwin-only test runs the real sips. Nothing here reaches TikTok.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { TIKTOK_IMAGE_HOSTS, loadConfig } from "../src/config.ts";
import { createDeps } from "../src/mcpServer.ts";
import { DATA_URI_RE, IMAGE_CACHE_MS, IMAGE_PX, IMAGE_WAIT_MS, JPEG_QUALITY, MAX_DATA_URI, RemoteImages, SMALL_DATA_URI, allowedImageUrl, hostMatches, type FetchLike } from "../src/covers.ts";
import { run } from "../src/proc.ts";
import type { Runner } from "../src/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "tiktok-covers-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// Hosts TikTok has handed out (avatar_url_100, cover_image_url, the mocks modeled on real responses, the API docs).
const HOST = "p16-common-sign.tiktokcdn-us.com";
const URL1 = `https://${HOST}/tos-useast5-p-0068-tx/abc~tplv-noop.image?x-expires=1762500000&x-signature=sig%3D`;
const URL2 = `https://p19-common-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar~c5_100x100.jpeg?x-expires=1&x-signature=s`;
const URL3 = `https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar~c5_168x168.jpeg?x-expires=1&x-signature=s`;

/** A tiny but valid-looking JPEG: SOI + filler + EOI. */
const jpeg = (n = 200) => {
  const b = new Uint8Array(n).fill(0x11);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], n - 2);
  return b;
};
const png = (n = 120) => {
  const b = new Uint8Array(n).fill(0x22);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
};
const tagged = (n: number, at0: string, at8: string, at4 = "") => {
  const b = new Uint8Array(n).fill(0x33);
  b.set(new TextEncoder().encode(at0), 0);
  if (at4) b.set(new TextEncoder().encode(at4), 4);
  b.set(new TextEncoder().encode(at8), 8);
  return b;
};
const webp = (n = 300) => tagged(n, "RIFF", "WEBPVP8 ");
const avif = (n = 300) => tagged(n, "\0\0\0\x1c", "avif", "ftyp");
const heic = (n = 300) => tagged(n, "\0\0\0\x1c", "heic", "ftyp");

function fakeClock(start = Date.UTC(2026, 10, 5, 12)) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

type Reply = { status?: number; type?: string | null; body?: Uint8Array | ReadableStream<Uint8Array>; length?: number | null; hang?: boolean; gate?: Promise<void> };

function fakeFetch(replies: Record<string, Reply | (() => Reply)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r0 = replies[url];
    const r = typeof r0 === "function" ? r0() : r0;
    if (!r) return new Response("nope", { status: 404 });
    if (r.hang) {
      return await new Promise<Response>((_, reject) => {
        const s = init.signal!;
        if (s.aborted) return reject(s.reason);
        s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    }
    if (r.gate) await r.gate;
    const headers: Record<string, string> = {};
    if (r.type !== null) headers["content-type"] = r.type ?? "image/jpeg";
    const body = r.body ?? jpeg();
    if (r.length !== null && body instanceof Uint8Array) headers["content-length"] = String(r.length ?? body.byteLength);
    return new Response(body as BodyInit, { status: r.status ?? 200, headers });
  };
  return { fetchImpl, calls };
}

const noTools: Runner = async () => ({ code: 127, stdout: "", stderr: "no sips in this test", timedOut: false });

/** A sips stand-in: reports w × h, writes `out` (a JPEG of `outBytes`, or per quality) for every convert. */
function fakeSips(w: number, h: number, out: (quality: number) => Uint8Array = () => jpeg(500)) {
  const ran: string[][] = [];
  let active = 0;
  let peak = 0;
  const runner: Runner = async (cmd) => {
    ran.push(cmd);
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(2);
    active--;
    if (cmd.includes("-g")) return { code: 0, stdout: `${cmd.at(-1)}\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n`, stderr: "", timedOut: false };
    const q = Number(cmd[cmd.indexOf("formatOptions") + 1]);
    writeFileSync(cmd[cmd.indexOf("--out") + 1]!, out(q));
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { runner, ran, peak: () => peak, converts: () => ran.filter((c) => !c.includes("-g")) };
}

function images(
  replies: Record<string, Reply | (() => Reply)>,
  o: { runner?: Runner; fetchTimeoutMs?: number; waitMs?: number; maxBytes?: number; offline?: boolean } = {},
) {
  const clock = fakeClock();
  const f = fakeFetch(replies);
  const tmp = mkdtempSync(join(ROOT, "run-"));
  const imgs = new RemoteImages({ runner: o.runner ?? noTools, clock, fetch: f.fetchImpl, tmpRoot: tmp, fetchTimeoutMs: o.fetchTimeoutMs, waitMs: o.waitMs, maxBytes: o.maxBytes, offline: o.offline });
  return { imgs, clock, calls: f.calls, tmp };
}

/** Everything the module logged during fn (console.error is the log sink). */
async function logsOf(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

const gated = () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { gate, open };
};

describe("allowedImageUrl", () => {
  test("the config lists TikTok's three CDN families as one-label wildcards (the manifest gets the same)", () => {
    expect([...TIKTOK_IMAGE_HOSTS]).toEqual(["*.tiktokcdn-us.com", "*.tiktokcdn.com", "*.tiktokcdn-eu.com", "*.tiktokv.us", "*.tiktokv.com", "*.tiktokv.eu"]);
  });

  test("any one-label host on TikTok's tiktokcdn and tiktokv domains, over https on 443", () => {
    for (const host of [HOST, "image.tiktokv.us", "p0-pu-private-useast8.tiktokv.us", "p19-common-sign.tiktokcdn-us.com", "p16-sign.tiktokcdn-us.com", "sf16-va.tiktokcdn.com", "p16-sign-va.tiktokcdn.com", "p16-sign.tiktokcdn-eu.com", "p77-pu-sign-useast8.tiktokcdn-us.com"]) {
      expect(allowedImageUrl(`https://${host}/obj/x.jpeg?x-expires=1&x-signature=s`)?.hostname).toBe(host);
    }
    expect(allowedImageUrl(`https://${HOST.toUpperCase()}/x.jpeg`)?.hostname).toBe(HOST);
    expect(allowedImageUrl(`https://${HOST}:443/x.jpeg`)).toBeDefined();
    // A backslash is a path separator in an https URL: the host is still TikTok's, and that's where it goes.
    expect(allowedImageUrl(`https://${HOST}\\@evil.example/x.jpeg`)?.hostname).toBe(HOST);
  });

  test("lookalikes, deeper names, the bare domain, IPs, other schemes, ports, user info and junk are refused", () => {
    for (const bad of [
      `http://${HOST}/x.jpeg`,
      `https://${HOST}.evil.example/x.jpeg`,
      "https://x.tiktokcdn-us.com.evil.com/x.jpeg",
      "https://eviltiktokcdn-us.com/x.jpeg",
      `https://evil${HOST}x/x.jpeg`,
      "https://tiktokcdn-us.com/x.jpeg",
      "https://a.b.tiktokcdn-us.com/x.jpeg",
      "https://-p16.tiktokcdn-us.com/x.jpeg",
      "https://p16.tiktokcdn-us.com./x.jpeg",
      "https://p16.tiktokcdn-us.co/x.jpeg",
      "https://p16.tiktokcdn-us.org/x.jpeg",
      "https://p16.tiktokcdn-asia.com/x.jpeg",
      "https://www.tiktok.com/x.jpeg",
      "https://1.2.3.4/x.jpeg",
      "https://[::1]/x.jpeg",
      `https://evil.example\\@${HOST}/x.jpeg`,
      `https://${HOST}@evil.example/x.jpeg`,
      `https://user:pw@${HOST}/x.jpeg`,
      `https://${HOST}:8443/x.jpeg`,
      `https://${HOST}/x y.jpeg`,
      `data:image/jpeg;base64,/9j/`,
      `file:///etc/passwd`,
      "",
      42,
      undefined,
      { href: URL1 },
    ]) {
      expect({ bad, ok: allowedImageUrl(bad) !== undefined }).toEqual({ bad, ok: false });
    }
  });

  test("hostMatches: exact names, or exactly one label under a wildcard", () => {
    expect(hostMatches("p16.tiktokcdn.com", "*.tiktokcdn.com")).toBe(true);
    expect(hostMatches("P16.TikTokCDN.com", "*.tiktokcdn.com")).toBe(true);
    expect(hostMatches("tiktokcdn.com", "*.tiktokcdn.com")).toBe(false);
    expect(hostMatches(".tiktokcdn.com", "*.tiktokcdn.com")).toBe(false);
    expect(hostMatches("a.b.tiktokcdn.com", "*.tiktokcdn.com")).toBe(false);
    expect(hostMatches("p16.tiktokcdn-us.com", "*.tiktokcdn.com")).toBe(false);
    expect(hostMatches("backend.composio.dev", "backend.composio.dev")).toBe(true);
    expect(hostMatches("x.backend.composio.dev", "backend.composio.dev")).toBe(false);
  });
});

describe("RemoteImages", () => {
  test("a small JPEG, PNG, WebP or AVIF goes into the card as it is: no sips, a data URI the cards accept", async () => {
    const ran: string[][] = [];
    const t = images(
      { [URL1]: { body: jpeg(300) }, [URL2]: { body: png(90), type: "image/png" }, [URL3]: { body: webp(400), type: "image/webp" }, [`${URL1}&f=avif`]: { body: avif(400), type: "image/avif" } },
      { runner: async (c) => (ran.push(c), { code: 0, stdout: "", stderr: "", timedOut: false }) },
    );
    const a = await t.imgs.dataUri(URL1);
    expect(a).toMatch(DATA_URI_RE);
    expect(a!.startsWith("data:image/jpeg;base64,/9j/")).toBe(true);
    expect((await t.imgs.dataUri(URL2))!.startsWith("data:image/png;base64,")).toBe(true);
    expect((await t.imgs.dataUri(URL3))!.startsWith("data:image/webp;base64,UklGR")).toBe(true);
    expect((await t.imgs.dataUri(`${URL1}&f=avif`))!.startsWith("data:image/avif;base64,")).toBe(true);
    expect(ran).toEqual([]);
    // Fetched as an image (JPEG first), without following redirects, with its own abort signal (the 8 s timeout).
    expect(t.calls[0].init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((t.calls[0].init.headers as Record<string, string>).accept.startsWith("image/jpeg")).toBe(true);
    expect(t.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("anything off the allowlist is never fetched", async () => {
    const t = images({});
    for (const u of ["https://p16-sign.tiktokcdn-us.com.evil.example/a.jpeg", `http://${HOST}/a.jpeg`, "https://example.com/a.jpeg", undefined]) {
      expect(await t.imgs.dataUri(u)).toBeUndefined();
    }
    expect(await t.imgs.many({ a: "https://example.com/a.jpeg" })).toEqual({});
    expect(t.calls).toHaveLength(0);
  });

  test("offline (a test server against a loopback Composio): nothing is fetched, not even TikTok's hosts", async () => {
    const t = images({ [URL1]: { body: jpeg() } }, { offline: true });
    expect(await t.imgs.dataUri(URL1)).toBeUndefined();
    expect(await t.imgs.many({ a: URL1 })).toEqual({});
    expect(t.calls).toHaveLength(0);
  });

  test("the server goes offline for pictures exactly when Composio is a loopback test base (e2e, verify.ts, the build)", () => {
    const dir = mkdtempSync(join(ROOT, "deps-"));
    const offline = (argv: string[]) => (createDeps(loadConfig({}, [...argv, `--state-dir=${dir}`, `--home=${dir}`])).images as unknown as { o: { offline?: boolean } }).o.offline;
    expect(offline(["--composio-base-url=http://127.0.0.1:9/api/v3.1"])).toBe(true);
    expect(offline([])).toBe(false);
  });

  test("cached by URL for 2 hours; the same URL asked twice at once is fetched once", async () => {
    expect(IMAGE_CACHE_MS).toBe(2 * 3_600_000);
    const t = images({ [URL1]: { body: jpeg() } });
    const [x, y] = await Promise.all([t.imgs.dataUri(URL1), t.imgs.dataUri(URL1)]);
    expect(x).toBe(y!);
    expect(t.calls).toHaveLength(1);
    t.clock.advance(IMAGE_CACHE_MS - 1);
    expect(await t.imgs.dataUri(URL1)).toBe(x!);
    expect(t.calls).toHaveLength(1);
    t.clock.advance(2);
    await t.imgs.dataUri(URL1);
    expect(t.calls).toHaveLength(2);
  });

  test("redirects, errors, non-images, oversized and empty bodies are 'no picture' (and aren't cached)", async () => {
    const big = new Uint8Array(4096).fill(1);
    const streamed = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(1024).fill(1));
        c.close();
      },
    });
    const t = images(
      {
        [`${URL1}&r=302`]: { status: 302 },
        [`${URL1}&r=500`]: { status: 500 },
        [`${URL1}&r=html`]: { type: "text/html", body: new TextEncoder().encode("<script>alert(1)</script>") },
        [`${URL1}&r=declared`]: { body: big },
        [`${URL1}&r=streamed`]: { body: streamed, length: null },
        [`${URL1}&r=empty`]: { body: new Uint8Array(0) },
        [`${URL1}&r=svg`]: { type: "image/svg+xml", body: new TextEncoder().encode("<svg onload='x'/>") },
        [`${URL1}&r=heic`]: { type: "image/heic", body: heic() },
      },
      { maxBytes: 2048 },
    );
    for (const r of ["302", "500", "html", "declared", "streamed", "empty", "svg", "heic"]) {
      expect({ r, uri: await t.imgs.dataUri(`${URL1}&r=${r}`) }).toEqual({ r, uri: undefined });
    }
    const n = t.calls.length;
    await t.imgs.dataUri(`${URL1}&r=500`);
    expect(t.calls.length).toBe(n + 1);
  });

  test("a CDN that doesn't answer within the fetch timeout is skipped", async () => {
    const t = images({ [URL1]: { hang: true } }, { fetchTimeoutMs: 40 });
    const started = Date.now();
    expect(await t.imgs.dataUri(URL1)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the card stops waiting after its wait; the fetch runs on into the cache, so the next card has it", async () => {
    expect(IMAGE_WAIT_MS).toBe(2_500);
    const g = gated();
    const t = images({ [URL1]: { body: jpeg(), gate: g.gate } }, { waitMs: 30 });
    const started = Date.now();
    let first: string | undefined = "unset";
    const logs = await logsOf(async () => {
      first = await t.imgs.dataUri(URL1);
      expect(Date.now() - started).toBeLessThan(1_000);
      g.open();
      await Bun.sleep(10);
    });
    expect(first).toBeUndefined();
    expect(logs).toContain("image wait");
    expect(logs).toMatch(/image late ok \d+ms/);
    expect(await t.imgs.dataUri(URL1)).toMatch(DATA_URI_RE);
    expect(t.calls).toHaveLength(1);
  });

  test("a caller's signal ends its own wait, never the shared fetch another card is waiting on", async () => {
    const g = gated();
    const t = images({ [URL1]: { body: jpeg(), gate: g.gate } }, { waitMs: 2_000 });
    const quit = new AbortController();
    const leaving = t.imgs.dataUri(URL1, { signal: quit.signal });
    const staying = t.imgs.dataUri(URL1);
    quit.abort();
    expect(await leaving).toBeUndefined();
    g.open();
    expect(await staying).toMatch(DATA_URI_RE);
    expect(t.calls).toHaveLength(1);
    // A signal that's already aborted doesn't wait at all; a cached picture still comes back.
    const gone = AbortSignal.abort();
    expect(await t.imgs.dataUri(URL1, { signal: gone })).toMatch(DATA_URI_RE);
    expect(await t.imgs.dataUri(`${URL1}&other=1`, { signal: gone })).toBeUndefined();
  });

  test("a large picture is scaled so its longest side is 120 px (2× the row tile and the avatar), JPEG quality 82", async () => {
    expect(IMAGE_PX).toBe(120);
    expect(JPEG_QUALITY).toBe(82);
    const portrait = fakeSips(720, 1280);
    const t = images({ [URL1]: { body: jpeg(40_000) } }, { runner: portrait.runner });
    const uri = await t.imgs.dataUri(URL1);
    expect(uri).toBe(`data:image/jpeg;base64,${Buffer.from(jpeg(500)).toString("base64")}`);
    expect(portrait.ran[0]!.slice(0, 5)).toEqual(["sips", "-g", "pixelWidth", "-g", "pixelHeight"]);
    const convert = portrait.converts()[0]!;
    expect(convert.slice(0, 7)).toEqual(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "82"]);
    // 720 × 1280 → 67 × 119: the height stays within 120 too.
    expect(convert[convert.indexOf("--resampleWidth") + 1]).toBe("67");
    expect(readdirSync(t.tmp)).toEqual([]);
    // Landscape: the width is the long side.
    const landscape = fakeSips(1280, 720);
    const l = images({ [URL1]: { body: jpeg(40_000) } }, { runner: landscape.runner });
    expect(await l.imgs.dataUri(URL1)).toMatch(DATA_URI_RE);
    expect(landscape.converts()[0]![landscape.converts()[0]!.indexOf("--resampleWidth") + 1]).toBe("120");
    // Already small: converted to JPEG but never upscaled.
    const narrow = fakeSips(100, 100);
    const n = images({ [URL1]: { body: png(40_000), type: "image/webp" } }, { runner: narrow.runner });
    expect(await n.imgs.dataUri(URL1)).toMatch(DATA_URI_RE);
    expect(narrow.converts()[0]).not.toContain("--resampleWidth");
  });

  test("a lone post's cover asks for 312 px (2× the hero tile's 156) and may be bigger than a row's", async () => {
    const sips = fakeSips(720, 1280, () => jpeg(30_000));
    const t = images({ [URL1]: { body: jpeg(200_000) } }, { runner: sips.runner });
    const hero = await t.imgs.dataUri(URL1, { width: 312 });
    expect(hero).toMatch(DATA_URI_RE);
    const c = sips.converts()[0]!;
    expect(c[c.indexOf("--resampleWidth") + 1]).toBe("175");
    // Sizes are cached apart: the same cover at row size is its own (smaller) picture, and 30 KB is too big for a row.
    expect(await t.imgs.dataUri(URL1)).toBeUndefined();
    expect(t.calls).toHaveLength(2);
  });

  test("too big at quality 82: one more try at a lower quality, then no picture", async () => {
    const sips = fakeSips(720, 1280, (q) => jpeg(q >= 80 ? 40_000 : 8_000));
    const t = images({ [URL1]: { body: jpeg(100_000) } }, { runner: sips.runner });
    expect(await t.imgs.dataUri(URL1)).toBe(`data:image/jpeg;base64,${Buffer.from(jpeg(8_000)).toString("base64")}`);
    expect(sips.converts().map((c) => c[c.indexOf("formatOptions") + 1])).toEqual(["82", "62"]);
    const huge = fakeSips(720, 1280, () => jpeg(60_000));
    const h = images({ [URL1]: { body: jpeg(100_000) } }, { runner: huge.runner });
    expect(await h.imgs.dataUri(URL1)).toBeUndefined();
  });

  test("no sips, or one that can't read it (Windows without the codec): as it is when it fits the size's cap", async () => {
    expect(SMALL_DATA_URI).toBeLessThan(MAX_DATA_URI);
    const failing: Runner = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false });
    const cover = webp(30_000); // ≈ 40,000 characters as a data URI
    const t = images({ [URL1]: { body: cover, type: "image/webp" }, [URL2]: { body: jpeg(60_000) } }, { runner: failing });
    // A row or an avatar: too big for its cap, so no picture.
    expect(await t.imgs.dataUri(URL1)).toBeUndefined();
    // The hero's cap takes it, WebP and all.
    const hero = await t.imgs.dataUri(URL1, { width: 312 });
    expect(hero!.startsWith("data:image/webp;base64,")).toBe(true);
    expect(hero!.length).toBeLessThanOrEqual(MAX_DATA_URI);
    // Bigger than any cap: no picture.
    expect(await t.imgs.dataUri(URL2, { width: 312 })).toBeUndefined();
    // No sips at all (CI): the same.
    const none = images({ [URL1]: { body: jpeg(40_000) } });
    expect(await none.imgs.dataUri(URL1)).toBeUndefined();
  });

  test("at most three pictures are scaled at once (six covers would start twelve PowerShells on Windows)", async () => {
    const sips = fakeSips(720, 1280);
    const urls = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), `${URL1}&n=${i}`]));
    const t = images(Object.fromEntries(Object.values(urls).map((u) => [u, { body: jpeg(40_000) }])), { runner: sips.runner });
    const got = await t.imgs.many(urls, { budgetMs: 5_000 });
    expect(Object.keys(got).sort()).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(sips.peak()).toBeLessThanOrEqual(3);
    expect(sips.peak()).toBeGreaterThan(1);
  });

  test("many(): parallel, keyed as given; what misses the budget is left out now and cached for later", async () => {
    const g = gated();
    const slowUrl = `${URL1}&slow=1`;
    const t = images({ [URL1]: { body: jpeg() }, [URL2]: { body: jpeg(220) }, [slowUrl]: { body: jpeg(240), gate: g.gate } });
    const got = await t.imgs.many({ "1": URL1, "2": URL2, "3": slowUrl, "4": "https://example.com/x.jpeg" }, { budgetMs: 50 });
    expect(Object.keys(got).sort()).toEqual(["1", "2"]);
    g.open();
    await Bun.sleep(5);
    expect(got["3"]).toBeUndefined();
    const again = await t.imgs.many({ "3": slowUrl }, { budgetMs: 50 });
    expect(again["3"]).toMatch(DATA_URI_RE);
    expect(t.calls.filter((c) => c.url === slowUrl)).toHaveLength(1);
  });

  test("logs say counts, outcomes, time and a refused host's name (once), never a URL, path or query", async () => {
    const t = images({ [URL1]: { body: jpeg() }, [URL2]: { status: 403 } });
    const logs = await logsOf(async () => {
      await t.imgs.dataUri(URL1);
      await t.imgs.many({ a: URL1, b: URL2, c: "https://evil.example/x?x-signature=s", d: "https://evil.example/y" });
      await t.imgs.dataUri("http://plain.example/z");
      await t.imgs.dataUri(`https://user:pw@${HOST}/u`);
    });
    expect(logs).toContain("images 1/4");
    expect(logs.match(/image refused domain evil\.example/g)).toHaveLength(1);
    expect(logs).toContain("image refused scheme plain.example");
    expect(logs).toContain(`image refused userinfo ${HOST}`);
    expect(logs).not.toMatch(/https?:|x-signature|\/x|\/y|\/z|\/u|pw|user:/);
  });
});

/** A noisy RGB PNG (stored deflate of random rows), big enough that it has to go through sips. */
function noisePng(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : (Math.random() * 256) | 0;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

describe("real sips (macOS)", () => {
  test.skipIf(process.platform !== "darwin")("a 300 × 533 cover comes out a JPEG data URI whose longest side is ≤ 120 px", async () => {
    const t = images({ [URL1]: { body: noisePng(300, 533), type: "image/png" } }, { runner: run });
    const uri = await t.imgs.dataUri(URL1);
    expect(uri).toMatch(DATA_URI_RE);
    expect(uri!.startsWith("data:image/jpeg;base64,")).toBe(true);
    const out = join(ROOT, "check.jpg");
    writeFileSync(out, Buffer.from(uri!.split(",")[1]!, "base64"));
    const meta = await run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out]);
    expect(meta.stdout).toContain("pixelWidth: 67");
    const h = Number(/pixelHeight: (\d+)/.exec(meta.stdout)?.[1]);
    expect(h).toBeGreaterThanOrEqual(118);
    expect(h).toBeLessThanOrEqual(120);
    expect(uri!.length).toBeLessThanOrEqual(SMALL_DATA_URI);
    expect(readdirSync(t.tmp)).toEqual([]);
  });
});
