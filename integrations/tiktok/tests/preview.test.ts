/**
 * src/preview.ts: a local video's poster frame and micro preview. A fake Runner plays ffmpeg, qlmanage and
 * sips (writing the files they would), so this runs on CI; the darwin suites run the real tools on a video
 * ffmpeg makes on the spot (skipped when ffmpeg isn't installed).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW2_RE, STACK2_RE, decodeFrame, splitMicroPreview, splitPhotoStack } from "../src/microPreview.ts";
import {
  clearPhotoPreviewCache,
  clearPreviewCache,
  findFfmpeg,
  frameTimes,
  parseBmp,
  parsePpm,
  photoPreview,
  photoThumbScript,
  videoPreview,
} from "../src/preview.ts";
import { run } from "../src/proc.ts";
import type { RunOptions, RunResult, Runner } from "../src/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "tiktok-preview-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  clearPreviewCache();
  clearPhotoPreviewCache();
});

let n = 0;
/** A stand-in video file (its bytes don't matter to the fakes) and a fresh temp root to check cleanup. */
function setup(name = "clip.mp4") {
  const dir = join(ROOT, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array(1024).fill(n));
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  return { path, tmp };
}

const JPEG = (() => {
  const b = new Uint8Array(600).fill(0x33);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], 598);
  return b;
})();

function ppm(w: number, h: number, seed = 1): Uint8Array {
  const head = new TextEncoder().encode(`P6\n${w} ${h}\n255\n`);
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + seed * 91) & 0xff;
  const out = new Uint8Array(head.length + px.length);
  out.set(head);
  out.set(px, head.length);
  return out;
}

/** A BMP as sips writes it: BITMAPV5HEADER, 32 bpp BI_BITFIELDS, top-down. */
function bmp32(w: number, h: number, color: [number, number, number]): Uint8Array {
  const offset = 14 + 124;
  const size = offset + w * h * 4;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  b.set([0x42, 0x4d]);
  dv.setUint32(2, size, true);
  dv.setUint32(10, offset, true);
  dv.setUint32(14, 124, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, -h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 32, true);
  dv.setUint32(30, 3, true);
  dv.setUint32(54, 0x00ff0000, true);
  dv.setUint32(58, 0x0000ff00, true);
  dv.setUint32(62, 0x000000ff, true);
  dv.setUint32(66, 0xff000000, true);
  for (let i = 0; i < w * h; i++) dv.setUint32(offset + i * 4, (0xff << 24) | (color[0] << 16) | (color[1] << 8) | color[2], true);
  return b;
}

/** A 24-bit bottom-up BI_RGB BMP (rows padded to 4 bytes): row y gets red = y * 10. */
function bmp24(w: number, h: number): Uint8Array {
  const stride = Math.floor((24 * w + 31) / 32) * 4;
  const offset = 54;
  const b = new Uint8Array(offset + stride * h);
  const dv = new DataView(b.buffer);
  b.set([0x42, 0x4d]);
  dv.setUint32(10, offset, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(28, 24, true);
  for (let y = 0; y < h; y++) {
    const row = offset + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) b.set([5, 7, y * 10], row + x * 3); // B, G, R
  }
  return b;
}

/** Just enough PNG for preview.ts to read its size from IHDR. */
function pngHead(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** Plays ffmpeg: writes each output file named after "-y" (a JPEG for .jpg, a PPM for .ppm). */
function fakeFfmpeg(o: { micro?: [number, number]; fail?: boolean; hang?: boolean } = {}) {
  const calls: Array<{ cmd: string[]; opts?: RunOptions }> = [];
  const runner: Runner = async (cmd, opts) => {
    calls.push({ cmd: [...cmd], opts });
    if (o.hang) return await new Promise<RunResult>(() => {});
    if (cmd[0] !== "/fake/ffmpeg" || o.fail) return { code: 1, stdout: "", stderr: "fail", timedOut: false };
    cmd.forEach((a, i) => {
      if (cmd[i - 1] !== "-y") return;
      if (a.endsWith(".jpg")) writeFileSync(a, JPEG);
      if (a.endsWith(".ppm")) writeFileSync(a, ppm(...(o.micro ?? [45, 80]), i));
    });
    return ok();
  };
  return { runner, calls };
}

/** Plays qlmanage (a PNG thumbnail in -o) and sips (the poster JPEG, the micro BMP). */
function fakeQuickLook(o: { png?: [number, number]; noThumb?: boolean } = {}) {
  const calls: string[][] = [];
  const runner: Runner = async (cmd) => {
    calls.push([...cmd]);
    if (cmd[0] === "qlmanage") {
      if (!o.noThumb) writeFileSync(join(cmd[cmd.indexOf("-o") + 1]!, "clip.mp4.png"), pngHead(...(o.png ?? [270, 480])));
      return ok("* produced one thumbnail");
    }
    if (cmd[0] === "sips") {
      const out = cmd[cmd.indexOf("--out") + 1]!;
      if (out.endsWith(".jpg")) writeFileSync(out, JPEG);
      if (out.endsWith(".bmp")) writeFileSync(out, bmp32(Number(cmd[cmd.indexOf("-z") + 2]), Number(cmd[cmd.indexOf("-z") + 1]), [200, 40, 90]));
      return ok();
    }
    return { code: 127, stdout: "", stderr: "", timedOut: false };
  };
  return { runner, calls };
}

describe("pixel formats", () => {
  test("parsePpm reads ffmpeg's P6 (comments allowed) and refuses anything else", () => {
    const p = parsePpm(ppm(18, 32))!;
    expect([p.w, p.h, p.rgb.length]).toEqual([18, 32, 18 * 32 * 3]);
    const withComment = new Uint8Array([...new TextEncoder().encode("P6\n# made by a test\n2 1\n255\n"), 1, 2, 3, 4, 5, 6]);
    expect(Array.from(parsePpm(withComment)!.rgb)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parsePpm(new TextEncoder().encode("P3\n1 1\n255\n0 0 0"))).toBeUndefined();
    expect(parsePpm(new TextEncoder().encode("P6\n2 2\n65535\n"))).toBeUndefined();
    expect(parsePpm(ppm(18, 32).slice(0, 100))).toBeUndefined(); // truncated
    expect(parsePpm(ppm(300, 300))).toBeUndefined(); // not a micro frame
  });

  test("parseBmp reads sips' 32-bit top-down bitfields and plain 24-bit bottom-up rows", () => {
    const a = parseBmp(bmp32(18, 32, [200, 40, 90]))!;
    expect([a.w, a.h]).toEqual([18, 32]);
    expect(Array.from(a.rgb.slice(0, 3))).toEqual([200, 40, 90]);
    const b = parseBmp(bmp24(3, 4))!;
    expect([b.w, b.h]).toEqual([3, 4]);
    // Top row first: row y has red y*10, after the bottom-up flip and the 3-byte-per-pixel padding.
    expect([0, 1, 2, 3].map((y) => b.rgb[y * 9])).toEqual([0, 10, 20, 30]);
    expect(Array.from(b.rgb.slice(0, 3))).toEqual([0, 7, 5]);
    expect(parseBmp(new Uint8Array(10))).toBeUndefined();
  });
});

describe("frameTimes", () => {
  test("~15 %, ~50 % and ~85 % in; 1 s in when the length is unknown", () => {
    expect(frameTimes(37.2)).toEqual([5.58, 18.6, 31.62]);
    expect(frameTimes(0.05)).toEqual([0, 0, 0]);
    expect(frameTimes(undefined)).toEqual([1]);
    expect(frameTimes(Number.NaN)).toEqual([1]);
  });
});

describe("videoPreview with ffmpeg (fake)", () => {
  test("three fast seeks in parallel: the poster from the middle one, micro frames from all three", async () => {
    const { path, tmp } = setup();
    const f = fakeFfmpeg();
    const p = await videoPreview(path, { duration_sec: 37.2, width: 1080, height: 1920 }, f.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, posterWidth: 240 });
    expect(f.calls).toHaveLength(3);
    expect(f.calls.map((c) => c.cmd[c.cmd.indexOf("-ss") + 1])).toEqual(["5.58", "18.6", "31.62"]);
    for (const c of f.calls) {
      expect(c.cmd.slice(0, 5)).toEqual(["/fake/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]);
      expect(c.cmd[c.cmd.indexOf("-i") + 1]).toBe(`file:${path}`);
      expect(c.cmd).toContain("scale=80:80:force_original_aspect_ratio=decrease:flags=area");
      expect(c.opts?.timeoutMs).toBe(2_500);
    }
    // Only the middle run writes the poster, fitted into a 427 px square (240 × 427 for 9:16).
    expect(f.calls.map((c) => c.cmd.some((a) => a.endsWith("poster.jpg")))).toEqual([false, true, false]);
    expect(f.calls[1].cmd).toContain("scale=427:427:force_original_aspect_ratio=decrease:flags=bicubic");
    expect(p.poster).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}`);
    expect(p.micro).toMatch(PREVIEW2_RE);
    expect(p.micro!.length).toBeLessThanOrEqual(1_100);
    const parts = splitMicroPreview(p.micro)!;
    expect(parts.durationSec).toBe(37);
    expect(parts.frames).toHaveLength(3);
    expect(decodeFrame(parts.frames[0])).toMatchObject({ w: 45, h: 80 });
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("landscape frames are 80 × 45; no poster asked → no poster output; micro off → no frames", async () => {
    const { path, tmp } = setup();
    const f = fakeFfmpeg({ micro: [80, 45] });
    const p = await videoPreview(path, { duration_sec: 10 }, f.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, posterWidth: 0 });
    expect(p.poster).toBeUndefined();
    expect(decodeFrame(splitMicroPreview(p.micro)!.frames[2])).toMatchObject({ w: 80, h: 45 });
    expect(f.calls.some((c) => c.cmd.some((a) => a.endsWith(".jpg")))).toBe(false);
    clearPreviewCache();
    const g = fakeFfmpeg();
    const q = await videoPreview(path, { duration_sec: 10 }, g.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, micro: false });
    expect(g.calls).toHaveLength(1);
    expect(q.micro).toBeUndefined();
    expect(q.poster).toMatch(/^data:image\/jpeg;base64,/);
  });

  test("the same file again comes from the cache; a changed file is read again", async () => {
    const { path, tmp } = setup();
    const f = fakeFfmpeg();
    const a = await videoPreview(path, { duration_sec: 9 }, f.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp });
    const b = await videoPreview(path, { duration_sec: 9 }, f.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp });
    expect(b).toEqual(a);
    expect(f.calls).toHaveLength(3);
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    await videoPreview(path, { duration_sec: 9 }, f.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp });
    expect(f.calls).toHaveLength(6);
  });
});

describe("videoPreview without ffmpeg (Quick Look + sips, fake)", () => {
  test("qlmanage's thumbnail gives the poster (resized by sips) and a one-frame micro preview", async () => {
    const { path, tmp } = setup();
    const q = fakeQuickLook();
    const p = await videoPreview(path, { duration_sec: 23.4 }, q.runner, { ffmpeg: null, tmpRoot: tmp, posterWidth: 160 });
    expect(q.calls[0]!.slice(0, 4)).toEqual(["qlmanage", "-t", "-s", "480"]);
    expect(q.calls[0]!.at(-1)).toBe(path);
    const poster = q.calls.find((c) => c.includes("jpeg"))!;
    expect(poster[poster.indexOf("--resampleWidth") + 1]).toBe("160");
    const micro = q.calls.find((c) => c.includes("bmp"))!;
    expect(micro.slice(micro.indexOf("-z"), micro.indexOf("-z") + 3)).toEqual(["-z", "80", "45"]);
    expect(p.poster).toMatch(/^data:image\/jpeg;base64,/);
    const parts = splitMicroPreview(p.micro)!;
    expect(parts).toMatchObject({ durationSec: 23 });
    expect(parts.frames).toHaveLength(1);
    const d = decodeFrame(parts.frames[0])!;
    expect([d.w, d.h]).toEqual([45, 80]);
    // The colour survives the encode (soft, but the right hue).
    expect(d.rgba[0]).toBeGreaterThan(d.rgba[1]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("ffmpeg that produces nothing falls back to Quick Look; nothing anywhere is {}", async () => {
    const { path, tmp } = setup();
    const ql = fakeQuickLook();
    const both: Runner = async (cmd, opts) => (cmd[0] === "/fake/ffmpeg" ? { code: 1, stdout: "", stderr: "", timedOut: false } : ql.runner(cmd, opts));
    const p = await videoPreview(path, { duration_sec: 5 }, both, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp });
    expect(p.poster).toBeDefined();
    expect(ql.calls[0]![0]).toBe("qlmanage");
    clearPreviewCache();
    const none = fakeQuickLook({ noThumb: true });
    expect(await videoPreview(path, { duration_sec: 5 }, none.runner, { ffmpeg: null, tmpRoot: tmp })).toEqual({});
  });
});

describe("videoPreview is best effort", () => {
  test("a missing file, a throwing runner or an aborted call is {}, never an exception", async () => {
    const { path, tmp } = setup();
    expect(await videoPreview(join(ROOT, "nope.mp4"), {}, fakeFfmpeg().runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp })).toEqual({});
    const boom: Runner = async () => {
      throw new Error("spawn failed");
    };
    expect(await videoPreview(path, { duration_sec: 3 }, boom, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp })).toEqual({});
    const ac = new AbortController();
    ac.abort();
    expect(await videoPreview(path, {}, fakeFfmpeg().runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, signal: ac.signal })).toEqual({});
  });

  test("a tool that hangs: the call gives up after its budget", async () => {
    const { path, tmp } = setup();
    const started = Date.now();
    const p = await videoPreview(path, { duration_sec: 3 }, fakeFfmpeg({ hang: true }).runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, budgetMs: 300 });
    expect(p).toEqual({});
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("logs carry the source, counts and time, never the path or name", async () => {
    const { path, tmp } = setup("Secret Project Final.mp4");
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await videoPreview(path, { duration_sec: 3 }, fakeFfmpeg().runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp });
    } finally {
      console.error = original;
    }
    expect(lines.join("\n")).toMatch(/preview ffmpeg poster=1 frames=3 \d+ms/);
    expect(lines.join("\n")).not.toMatch(/Secret|case-|\//);
  });
});

// ---------------------------------------------------------------------------
// The real tools (macOS, with ffmpeg installed)
// ---------------------------------------------------------------------------

const ffmpeg = process.platform === "darwin" ? findFfmpeg() : undefined;

describe("real tools", () => {
  let video = "";
  test.skipIf(!ffmpeg)("ffmpeg: a 9:16 test video gives a 240-wide poster and three 45 × 80 frames, fast", async () => {
    video = join(ROOT, "real", "testsrc.mp4");
    mkdirSync(join(ROOT, "real"), { recursive: true });
    const made = await run([ffmpeg!, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=270x480:rate=10:duration=3", "-pix_fmt", "yuv420p", "-y", video], { timeoutMs: 20_000 });
    expect(made.code).toBe(0);
    const started = Date.now();
    const p = await videoPreview(video, { duration_sec: 3, width: 270, height: 480 }, run, { posterWidth: 240 });
    expect(Date.now() - started).toBeLessThan(2_600);
    expect(p.poster).toMatch(/^data:image\/jpeg;base64,/);
    expect(p.poster!.length).toBeLessThan(45 * 1024);
    const out = join(ROOT, "real", "poster.jpg");
    writeFileSync(out, Buffer.from(p.poster!.split(",")[1]!, "base64"));
    const meta = await run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out]);
    expect(meta.stdout).toContain("pixelWidth: 240");
    const parts = splitMicroPreview(p.micro)!;
    expect(parts.frames).toHaveLength(3);
    for (const f of parts.frames) expect(decodeFrame(f)).toMatchObject({ w: 45, h: 80 });
    // testsrc moves: the three frames differ.
    expect(new Set(parts.frames).size).toBe(3);
  });

  test.skipIf(!ffmpeg)("Quick Look + sips (as on a Mac without ffmpeg): a poster and one frame", async () => {
    expect(existsSync(video)).toBe(true);
    const p = await videoPreview(video, { duration_sec: 3 }, run, { posterWidth: 160, ffmpeg: null });
    expect(p.poster).toMatch(/^data:image\/jpeg;base64,/);
    const parts = splitMicroPreview(p.micro)!;
    expect(parts.frames).toHaveLength(1);
    expect(decodeFrame(parts.frames[0])).toMatchObject({ w: 45, h: 80 });
  });
});

// ---------------------------------------------------------------------------
// Photos: the carousel's stack and thumbnails (sips, fake)
// ---------------------------------------------------------------------------

/** Plays sips: the canvas script (one <index>.jpg per decodable input), the sRGB pass and the BMP pass. */
function fakeSips(o: { undecodable?: string; noMatch?: boolean; throws?: boolean } = {}) {
  const calls: string[][] = [];
  const runner: Runner = async (cmd) => {
    calls.push([...cmd]);
    if (o.throws) throw new Error("spawn failed");
    if (cmd[0] !== "/usr/bin/sips") return { code: 127, stdout: "", stderr: "", timedOut: false };
    if (cmd[1] === "-j") {
      const out = cmd[cmd.indexOf("-o") + 1]!;
      cmd.slice(3, cmd.indexOf("-o")).forEach((input, i) => {
        if (o.undecodable && input.includes(o.undecodable)) return;
        writeFileSync(join(out, `${i}.jpg`), JPEG);
      });
      return ok();
    }
    const out = cmd[cmd.indexOf("--out") + 1]!;
    const inputs = cmd.slice(0, cmd.indexOf("--out")).filter((a) => a.endsWith(".jpg"));
    if (cmd[1] === "--matchTo") {
      if (!o.noMatch) for (const f of inputs) writeFileSync(join(out, f.split("/").pop()!), JPEG);
      return ok();
    }
    if (cmd.includes("bmp")) {
      inputs.forEach((f, i) => writeFileSync(join(out, f.split("/").pop()!.replace(/\.jpg$/, ".bmp")), bmp32(Number(cmd[cmd.indexOf("-z") + 2]), Number(cmd[cmd.indexOf("-z") + 1]), [40 + i * 40, 120, 200 - i * 30])));
      return ok();
    }
    return { code: 1, stdout: "", stderr: "", timedOut: false };
  };
  return { runner, calls };
}

function photos(count: number) {
  const dir = join(ROOT, `photos-${++n}`);
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const paths = Array.from({ length: count }, (_, i) => {
    const p = join(dir, `IMG_${1000 + i}.HEIC`);
    writeFileSync(p, new Uint8Array(64).fill(i));
    return p;
  });
  return { paths, tmp: join(dir, "tmp") };
}

describe("photoPreview (fake sips)", () => {
  test("three photos: a stack of three 48 × 64 frames with the count and cover, and three thumbnails", async () => {
    const { paths, tmp } = photos(3);
    const { runner, calls } = fakeSips();
    const p = await photoPreview(paths, runner, { count: 3, cover: 1, tmpRoot: tmp });
    expect(STACK2_RE.test(p.stack!)).toBe(true);
    const parts = splitPhotoStack(p.stack)!;
    expect(parts).toMatchObject({ count: 3, cover: 1 });
    expect(parts.frames).toHaveLength(3);
    for (const f of parts.frames) expect(decodeFrame(f)).toMatchObject({ w: 48, h: 64 });
    // Each photo its own colour, in order.
    expect(new Set(parts.frames).size).toBe(3);
    expect(p.thumbs).toHaveLength(3);
    for (const t of p.thumbs!) expect(t).toMatch(/^data:image\/jpeg;base64,/);
    // One canvas pass over the photos in carousel order, one sRGB pass, one BMP pass; the temp folder is gone.
    expect(calls.map((c) => c[1])).toEqual(["-j", "--matchTo", "-s"]);
    expect(calls[0].slice(3, 6)).toEqual(paths);
    expect(calls[1]).toContain("60");
    expect(calls[2].slice(1, 7)).toEqual(["-s", "format", "bmp", "-z", "128", "96"]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("a long carousel: the first five photos, the post's own count in the header", async () => {
    const { paths, tmp } = photos(8);
    const { runner, calls } = fakeSips();
    const p = await photoPreview(paths, runner, { count: 8, cover: 6, tmpRoot: tmp });
    expect(calls[0].slice(3, calls[0].indexOf("-o"))).toEqual(paths.slice(0, 5));
    expect(splitPhotoStack(p.stack)).toMatchObject({ count: 8, cover: 6 });
    expect(splitPhotoStack(p.stack)!.frames).toHaveLength(5);
    expect(p.thumbs).toHaveLength(5);
  });

  test("thumbnails only (the candidates card): no frames, the asked size, up to six", async () => {
    const { paths, tmp } = photos(7);
    const { runner, calls } = fakeSips();
    const p = await photoPreview(paths, runner, { frames: false, thumbWidth: 96, max: 6, tmpRoot: tmp });
    expect(p.stack).toBeUndefined();
    expect(p.thumbs).toHaveLength(6);
    expect(calls.map((c) => c[1])).toEqual(["-j", "--matchTo"]);
  });

  test("all or nothing: a photo sips can't read means no stack and no thumbnails (they'd show the wrong order)", async () => {
    const { paths, tmp } = photos(3);
    expect(await photoPreview(paths, fakeSips({ undecodable: "IMG_1001" }).runner, { tmpRoot: tmp })).toEqual({});
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("without the sRGB pass the canvas JPEGs still make the stack", async () => {
    const { paths, tmp } = photos(2);
    const p = await photoPreview(paths, fakeSips({ noMatch: true }).runner, { tmpRoot: tmp });
    expect(splitPhotoStack(p.stack)!.frames).toHaveLength(2);
    expect(p.thumbs).toHaveLength(2);
  });

  test("the same photos again come from the cache; a changed photo is read again", async () => {
    const { paths, tmp } = photos(2);
    const fake = fakeSips();
    const a = await photoPreview(paths, fake.runner, { tmpRoot: tmp });
    const b = await photoPreview(paths, fake.runner, { tmpRoot: tmp });
    expect(b).toEqual(a);
    expect(fake.calls).toHaveLength(3);
    writeFileSync(paths[1], new Uint8Array(80).fill(9));
    await photoPreview(paths, fake.runner, { tmpRoot: tmp });
    expect(fake.calls).toHaveLength(6);
  });

  test("never throws: no photos, a missing file, a runner that throws, an aborted call", async () => {
    const { paths, tmp } = photos(2);
    expect(await photoPreview([], fakeSips().runner, { tmpRoot: tmp })).toEqual({});
    expect(await photoPreview([join(tmp, "gone.jpg")], fakeSips().runner, { tmpRoot: tmp })).toEqual({});
    expect(await photoPreview(paths, fakeSips({ throws: true }).runner, { tmpRoot: tmp })).toEqual({});
    const ac = new AbortController();
    ac.abort();
    expect(await photoPreview(paths, fakeSips().runner, { tmpRoot: tmp, signal: ac.signal })).toEqual({});
  });

  test("the canvas script is data with the size baked in: orient, cover-crop, white under transparency", () => {
    const js = photoThumbScript(150, 200);
    expect(js).toContain("new Canvas(150, 200)");
    expect(js).toContain("Orientation");
    expect(js).toContain('c.fillStyle = "white"');
    expect(js).toContain('new Output(c, k + ".jpg")');
    expect(js).not.toMatch(/\beval\b|new Function|require\(|import\(/);
  });
});

// ---------------------------------------------------------------------------
// The real sips (macOS)
// ---------------------------------------------------------------------------

describe("real sips", () => {
  test.skipIf(process.platform !== "darwin")("two stills (one portrait, one wide): a two-card stack and 150 × 200 thumbnails, fast", async () => {
    const dir = join(ROOT, "real-photos");
    mkdirSync(join(dir, "tmp"), { recursive: true });
    const fixtures = new URL("./fixtures/cards/", import.meta.url);
    const paths = ["photo-3.jpg", "poster-wide.jpg"].map((name) => {
      const p = join(dir, name);
      writeFileSync(p, new Uint8Array(readFileSync(new URL(name, fixtures))));
      return p;
    });
    const started = Date.now();
    const p = await photoPreview(paths, run, { count: 2, cover: 0, tmpRoot: join(dir, "tmp") });
    expect(Date.now() - started).toBeLessThan(4_000);
    const parts = splitPhotoStack(p.stack)!;
    expect(parts).toMatchObject({ count: 2, cover: 0 });
    for (const f of parts.frames) expect(decodeFrame(f)).toMatchObject({ w: 48, h: 64 });
    expect(p.thumbs).toHaveLength(2);
    const out = join(dir, "thumb.jpg");
    writeFileSync(out, Buffer.from(p.thumbs![1].split(",")[1]!, "base64"));
    const meta = await run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out]);
    expect(meta.stdout).toContain("pixelWidth: 150");
    expect(meta.stdout).toContain("pixelHeight: 200");
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });
});
