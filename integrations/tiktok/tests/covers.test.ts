/**
 * src/covers.ts: TikTok CDN pictures for the result cards. A fake fetch stands in for the network and a fake
 * Runner for sips (CI is ubuntu); one darwin-only test runs the real sips. Nothing here reaches TikTok.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { TIKTOK_IMAGE_HOSTS } from "../src/config.ts";
import { DATA_URI_RE, IMAGE_CACHE_MS, RemoteImages, allowedImageUrl, type FetchLike } from "../src/covers.ts";
import { run } from "../src/proc.ts";
import type { Runner } from "../src/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "tiktok-covers-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const HOST = TIKTOK_IMAGE_HOSTS[0];
const URL1 = `https://${HOST}/tos-useast5-p-0068-tx/abc~tplv-noop.image?x-expires=1762500000&x-signature=sig%3D`;
const URL2 = `https://${TIKTOK_IMAGE_HOSTS[1]}/tos-useast5-avt-0068-tx/avatar~c5_100x100.jpeg?x-expires=1&x-signature=s`;

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

function fakeClock(start = Date.UTC(2026, 10, 5, 12)) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

type Reply = { status?: number; type?: string | null; body?: Uint8Array | ReadableStream<Uint8Array>; length?: number | null; hang?: boolean };

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
    const headers: Record<string, string> = {};
    if (r.type !== null) headers["content-type"] = r.type ?? "image/jpeg";
    const body = r.body ?? jpeg();
    if (r.length !== null && body instanceof Uint8Array) headers["content-length"] = String(r.length ?? body.byteLength);
    return new Response(body as BodyInit, { status: r.status ?? 200, headers });
  };
  return { fetchImpl, calls };
}

const noTools: Runner = async () => ({ code: 127, stdout: "", stderr: "no sips in this test", timedOut: false });

function images(replies: Record<string, Reply | (() => Reply)>, o: { runner?: Runner; timeoutMs?: number; maxBytes?: number } = {}) {
  const clock = fakeClock();
  const f = fakeFetch(replies);
  const tmp = mkdtempSync(join(ROOT, "run-"));
  const imgs = new RemoteImages({ runner: o.runner ?? noTools, clock, fetch: f.fetchImpl, tmpRoot: tmp, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes });
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

describe("allowedImageUrl", () => {
  test("exact TikTok CDN hosts over https only", () => {
    expect(allowedImageUrl(URL1)?.hostname).toBe(HOST);
    expect(allowedImageUrl(URL2)?.hostname).toBe(TIKTOK_IMAGE_HOSTS[1]);
    expect(allowedImageUrl(`https://${HOST.toUpperCase()}/x.jpeg`)?.hostname).toBe(HOST);
    expect(allowedImageUrl(`https://${HOST}:443/x.jpeg`)).toBeDefined();
    for (const bad of [
      `http://${HOST}/x.jpeg`,
      `https://${HOST}.evil.example/x.jpeg`,
      `https://evil${HOST}/x.jpeg`,
      `https://p16-sign.tiktokcdn-us.com/x.jpeg`,
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
      expect(allowedImageUrl(bad)).toBeUndefined();
    }
  });
});

describe("RemoteImages", () => {
  test("a small JPEG or PNG goes into the card as it is: no sips, a data URI the cards accept", async () => {
    const ran: string[][] = [];
    const t = images({ [URL1]: { body: jpeg(300) }, [URL2]: { body: png(90), type: "image/png" } }, { runner: async (c) => (ran.push(c), { code: 0, stdout: "", stderr: "", timedOut: false }) });
    const a = await t.imgs.dataUri(URL1);
    const b = await t.imgs.dataUri(URL2);
    expect(a).toMatch(DATA_URI_RE);
    expect(a!.startsWith("data:image/jpeg;base64,/9j/")).toBe(true);
    expect(b!.startsWith("data:image/png;base64,")).toBe(true);
    expect(ran).toEqual([]);
    // Fetched as an image, without following redirects, with an abort signal (the 1.5 s timeout).
    expect(t.calls[0].init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(t.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("anything off the allowlist is never fetched", async () => {
    const t = images({});
    for (const u of ["https://p16-sign.tiktokcdn-us.com/a.jpeg", `http://${HOST}/a.jpeg`, "https://example.com/a.jpeg", undefined]) {
      expect(await t.imgs.dataUri(u)).toBeUndefined();
    }
    expect(await t.imgs.many({ a: "https://example.com/a.jpeg" })).toEqual({});
    expect(t.calls).toHaveLength(0);
  });

  test("cached by URL for 30 minutes; the same URL asked twice at once is fetched once", async () => {
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
      },
      { maxBytes: 2048 },
    );
    for (const r of ["302", "500", "html", "declared", "streamed", "empty", "svg"]) {
      expect(await t.imgs.dataUri(`${URL1}&r=${r}`)).toBeUndefined();
    }
    const n = t.calls.length;
    await t.imgs.dataUri(`${URL1}&r=500`);
    expect(t.calls.length).toBe(n + 1);
  });

  test("a CDN that doesn't answer in time is skipped", async () => {
    const t = images({ [URL1]: { hang: true } }, { timeoutMs: 40 });
    const started = Date.now();
    expect(await t.imgs.dataUri(URL1)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a large picture is scaled to ≤ 120 px wide by sips (never upscaled); without sips it's skipped", async () => {
    const ran: string[][] = [];
    const small = jpeg(500);
    const runner: Runner = async (cmd) => {
      ran.push(cmd);
      if (cmd.includes("-g")) return { code: 0, stdout: `${cmd.at(-1)}\n  pixelWidth: 720\n  pixelHeight: 1280\n`, stderr: "", timedOut: false };
      writeFileSync(cmd[cmd.indexOf("--out") + 1]!, small);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const t = images({ [URL1]: { body: jpeg(40_000) } }, { runner });
    const uri = await t.imgs.dataUri(URL1);
    expect(uri).toBe(`data:image/jpeg;base64,${Buffer.from(small).toString("base64")}`);
    expect(ran[0]!.slice(0, 5)).toEqual(["sips", "-g", "pixelWidth", "-g", "pixelHeight"]);
    expect(ran[1]).toContain("--resampleWidth");
    expect(ran[1]![ran[1]!.indexOf("--resampleWidth") + 1]).toBe("120");
    expect(ran[1]!.slice(0, 5)).toEqual(["sips", "-s", "format", "jpeg", "-s"]);
    // Its temp folder is gone.
    expect(readdirSync(t.tmp)).toEqual([]);
    // Already narrow: converted to JPEG but not resized.
    const narrow: Runner = async (cmd) => {
      ran.push(cmd);
      if (cmd.includes("-g")) return { code: 0, stdout: "  pixelWidth: 100\n  pixelHeight: 100\n", stderr: "", timedOut: false };
      writeFileSync(cmd[cmd.indexOf("--out") + 1]!, small);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const n = images({ [URL1]: { body: png(40_000), type: "image/webp" } }, { runner: narrow });
    expect(await n.imgs.dataUri(URL1)).toMatch(DATA_URI_RE);
    expect(ran.at(-1)).not.toContain("--resampleWidth");
    // No sips (CI): a big picture is no picture.
    const none = images({ [URL1]: { body: jpeg(40_000) } });
    expect(await none.imgs.dataUri(URL1)).toBeUndefined();
  });

  test("many(): parallel, keyed as given; what misses the budget is left out now and cached for later", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowUrl = `${URL1}&slow=1`;
    const t = images({ [URL1]: { body: jpeg() }, [URL2]: { body: jpeg(220) }, [slowUrl]: { body: jpeg(240) } });
    const inner = (t.imgs as unknown as { fetchImpl: FetchLike });
    const real = inner.fetchImpl;
    inner.fetchImpl = async (url, init) => {
      if (url === slowUrl) await gate;
      return real(url, init);
    };
    const got = await t.imgs.many({ "1": URL1, "2": URL2, "3": slowUrl, "4": "https://example.com/x.jpeg" }, { budgetMs: 50 });
    expect(Object.keys(got).sort()).toEqual(["1", "2"]);
    release();
    await Bun.sleep(5);
    const again = await t.imgs.many({ "3": slowUrl }, { budgetMs: 50 });
    expect(again["3"]).toMatch(DATA_URI_RE);
    expect(t.calls.filter((c) => c.url === slowUrl)).toHaveLength(1);
  });

  test("logs say counts, outcomes and time, never a URL", async () => {
    const t = images({ [URL1]: { body: jpeg() }, [URL2]: { status: 403 } });
    const logs = await logsOf(async () => {
      await t.imgs.dataUri(URL1);
      await t.imgs.many({ a: URL1, b: URL2, c: "https://evil.example/x" });
    });
    expect(logs).toContain("images 1/3");
    expect(logs).not.toMatch(/tiktokcdn|https?:|x-signature|evil/);
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
  test.skipIf(process.platform !== "darwin")("a 300 × 533 cover comes out a ≤ 120 px wide JPEG data URI", async () => {
    const t = images({ [URL1]: { body: noisePng(300, 533), type: "image/png" } }, { runner: run });
    const uri = await t.imgs.dataUri(URL1);
    expect(uri).toMatch(DATA_URI_RE);
    expect(uri!.startsWith("data:image/jpeg;base64,")).toBe(true);
    const out = join(ROOT, "check.jpg");
    writeFileSync(out, Buffer.from(uri!.split(",")[1]!, "base64"));
    const meta = await run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out]);
    expect(meta.stdout).toContain("pixelWidth: 120");
    expect(meta.stdout).toContain("pixelHeight: 213");
    expect(uri!.length).toBeLessThan(45 * 1024);
    expect(readdirSync(t.tmp)).toEqual([]);
  });
});
