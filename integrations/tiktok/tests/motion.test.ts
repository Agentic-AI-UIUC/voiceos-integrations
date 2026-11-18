/**
 * src/preview.ts: the video playing on the result cards (videoMotion) and the posters under it. A fake Runner plays
 * ffmpeg (its encoder and muxer lists, SVT-AV1 writing an AVIF whose size follows the CRF and the pixels) and
 * img2webp, so this runs on CI (ubuntu, Windows); the darwin suite encodes a real loop when ffmpeg has SVT-AV1.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP_TILES, galleryCell, imageSize } from "../src/cards.ts";
import {
  AVIF_LOOP,
  MAX_MOTION_URI,
  MAX_POSTER_URI,
  STRIP_LOOP,
  WEBP_LOOP,
  clearPreviewCache,
  ffmpegAvif,
  findFfmpeg,
  isAvif,
  loopGraph,
  loopPlan,
  motionWindow,
  nextRung,
  videoMotion,
  videoPreview,
} from "../src/preview.ts";
import { run } from "../src/proc.ts";
import { CANDIDATE_POSTER_WIDTH, galleryPosterWidth } from "../src/tools/helpers.ts";
import type { RunOptions, RunResult, Runner } from "../src/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "tiktok-motion-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => clearPreviewCache());

let n = 0;
function setup(name = "clip.mp4") {
  const dir = join(ROOT, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array(1024).fill(n));
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  return { path, tmp, dir };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const PORTRAIT = { duration_sec: 62.3, width: 1080, height: 1920 };
const LANDSCAPE = { duration_sec: 82, width: 1920, height: 1080 };

/** An ISO-BMFF file with AVIF's sequence brand, `bytes` long. */
function avifBytes(bytes: number): Uint8Array {
  const b = new Uint8Array(Math.max(32, Math.round(bytes)));
  b.set([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73], 0);
  return b;
}
function riff(bytes: number): Uint8Array {
  const b = new Uint8Array(Math.max(32, Math.round(bytes)));
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
  return b;
}
function jpegBytes(bytes: number): Uint8Array {
  const b = new Uint8Array(Math.max(16, Math.round(bytes))).fill(0x33);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return b;
}
const chars = (bytes: number, mime: string) => `data:${mime};base64,`.length + Math.ceil(bytes / 3) * 4;

/**
 * Plays ffmpeg and img2webp. The AVIF a CRF makes is `k` × pixels^0.9 × 2^-(crf-36)/10 bytes (how real clips behave,
 * roughly); WebP and the filmstrip take their sizes from the quality.
 */
function fakeTools(o: { svt?: boolean; k?: number; webp?: (q: number) => number; strip?: (q: number) => number; noAvifOut?: boolean; hang?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ cmd: string[]; opts?: RunOptions }> = [];
  const runner: Runner = async (cmd, opts) => {
    calls.push({ cmd: [...cmd], opts });
    if (o.throws) throw new Error("spawn failed");
    if (o.hang && !cmd.includes("-encoders") && !cmd.includes("-muxers")) return await new Promise<RunResult>(() => {});
    if (cmd[0] === "/fake/ffmpeg") {
      if (cmd.includes("-encoders")) return ok(` V..... libx264              H.264\n${o.svt === false ? "" : " V....D libsvtav1            SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)\n"}`);
      if (cmd.includes("-muxers")) return ok(" D. = Demuxing supported\n .E = Muxing supported\n ---\n  E  avi             AVI\n  E  avif            AVIF\n  E  mp4             MP4\n");
      const out = cmd.at(-1)!;
      const graph = cmd[cmd.indexOf("-filter_complex") + 1] ?? "";
      const [w, h] = (graph.match(/crop=(\d+):(\d+)/) ?? []).slice(1).map(Number);
      if (cmd.includes("libsvtav1")) {
        if (o.noAvifOut) return { code: 1, stdout: "", stderr: "Unknown encoder", timedOut: false };
        const crf = Number(cmd[cmd.indexOf("-crf") + 1]);
        writeFileSync(out, avifBytes((o.k ?? 1.2) * (w * h) ** 0.9 * 2 ** (-(crf - 36) / 10)));
      } else if (cmd.includes("ppm")) {
        for (let i = 1; i <= 18; i++) writeFileSync(out.replace("%03d", String(i).padStart(3, "0")), new Uint8Array(64));
      } else if (cmd.includes("mjpeg")) {
        writeFileSync(out, jpegBytes((o.strip ?? (() => 50_000))(Number(cmd[cmd.indexOf("-q:v") + 1]))));
      }
      return ok();
    }
    if (cmd[0] === "/fake/img2webp") {
      writeFileSync(cmd.at(-1)!, riff((o.webp ?? (() => 60_000))(Number(cmd[cmd.indexOf("-q") + 1]))));
      return ok();
    }
    return { code: 127, stdout: "", stderr: "", timedOut: false };
  };
  const encodes = () => calls.filter((c) => c.cmd.includes("libsvtav1"));
  const sizeOf = (c: { cmd: string[] }) => (c.cmd[c.cmd.indexOf("-filter_complex") + 1].match(/crop=(\d+:\d+)/) ?? [])[1];
  return { runner, calls, encodes, sizeOf };
}

describe("the loop's window and filtergraph", () => {
  test("3 s from a fifth of the way in, plus a 0.4 s cross-fade of source; shorter videos give what they have", () => {
    expect(motionWindow(62.3)).toEqual({ start: 12.46, seconds: 3, fade: 0.4 });
    // Near the end: it starts early enough to leave room.
    expect(motionWindow(4)).toEqual({ start: 0.5, seconds: 3, fade: 0.4 });
    // Shorter than the window: all of it, a quarter-second fade; under a second, no fade at all.
    expect(motionWindow(2)).toEqual({ start: 0, seconds: 1.65, fade: 0.25 });
    expect(motionWindow(0.6)).toEqual({ start: 0, seconds: 0.5, fade: 0 });
    expect(motionWindow(0.05)).toEqual({ start: 0, seconds: 0.1, fade: 0 });
    // Unknown length: from the start, no fade (the second half of a cross-fade might not exist).
    expect(motionWindow(undefined)).toEqual({ start: 0, seconds: 3, fade: 0 });
    expect(motionWindow(Number.NaN)).toEqual({ start: 0, seconds: 3, fade: 0 });
    expect(motionWindow(30, WEBP_LOOP)).toEqual({ start: 6, seconds: 1.5, fade: 0.25 });
    expect(motionWindow(30, STRIP_LOOP)).toEqual({ start: 6, seconds: 2, fade: 0.3 });
  });

  test("the cross-fade: the tail fades into the head, so the last frame leads straight back to the first", () => {
    const g = loopGraph(216, 384, 24, { seconds: 3, fade: 0.4 }, { format: "yuv420p" });
    expect(g).toBe(
      "[0:v:0]fps=24,scale=216:384:force_original_aspect_ratio=increase:flags=lanczos,crop=216:384,format=yuv420p,split[a][b];" +
        "[a]trim=0.4:3.4,setpts=PTS-STARTPTS[x];[b]trim=0:0.4,setpts=PTS-STARTPTS[y];[x][y]xfade=transition=fade:duration=0.4:offset=2.6[v]",
    );
    // No fade: just the window. A tail (the filmstrip's tiling) runs on the result.
    expect(loopGraph(144, 256, 8, { seconds: 0.5, fade: 0 }, { then: "tile=4x1" })).toBe(
      "[0:v:0]fps=8,scale=144:256:force_original_aspect_ratio=increase:flags=lanczos,crop=144:256,trim=duration=0.5,tile=4x1[v]",
    );
  });
});

describe("loop sizes: twice the CSS size of the tile they play in", () => {
  test("the hero (108 × 192) and the posting-as card's across tile (358 × 201)", () => {
    expect(LOOP_TILES).toEqual({ hero: { w: 108, h: 192 }, across: { w: 358, h: 201 } });
    const tall = loopPlan(false);
    expect(tall.avif).toEqual([[216, 384], [162, 288]]);
    expect(tall.webp).toEqual([216, 384]);
    expect(tall.strip).toEqual([144, 256]);
    expect(tall.cap).toBe(MAX_MOTION_URI);
    const wide = loopPlan(true);
    expect(wide.avif).toEqual([[716, 402], [538, 302], [384, 216]]);
    expect(wide.webp).toEqual([384, 216]);
    expect(wide.strip).toEqual([256, 144]);
  });

  test("a gallery cell: twice the cell for 2-6 videos, and its share of the card's pictures", () => {
    const sizes = [2, 3, 4, 5, 6].map((k) => loopPlan(false, k));
    expect(sizes.map((p) => p.avif[0])).toEqual([[224, 398], [204, 362], [166, 296], [138, 246], [138, 246]]);
    for (const k of [2, 3, 4, 5, 6]) {
      const cell = galleryCell(k, true);
      const p = loopPlan(false, k);
      // Covers the 3:4 box at 2×: as wide as twice the box, at least as tall.
      expect(p.avif[0][0]).toBe(2 * cell.w);
      expect(p.avif[0][1]).toBeGreaterThanOrEqual(2 * cell.h);
      expect(p.strip).toBeUndefined();
      // Every cell's loop together fits the card's 200,000-character picture budget.
      expect(p.cap * k).toBeLessThanOrEqual(200_000);
    }
    expect(loopPlan(true, 2).avif[0]).toEqual([350, 196]);
    // find_recent_videos asks for posters the same width as its gallery's loops, and 2× the hero for a lone lead.
    expect([2, 3, 4, 5, 6].map(galleryPosterWidth)).toEqual([2, 3, 4, 5, 6].map((k) => loopPlan(false, k).avif[0][0]));
    expect(CANDIDATE_POSTER_WIDTH).toBe(2 * LOOP_TILES.hero.w);
  });

  test("the CRF ladder: a step big enough to fit, then smaller frames rather than past CRF 50", () => {
    const tall = loopPlan(false).avif;
    // 7 % over: a few steps up, never fewer than three.
    expect(nextRung(tall, 0, 36, 133_000, 125_000)).toEqual({ i: 0, crf: 39 });
    // Twice the cap: ~12 steps per halving.
    expect(nextRung(tall, 0, 36, 250_000, 125_000)).toEqual({ i: 0, crf: 49 });
    // A busy landscape clip ~6× over at 716 × 402: straight to the size that fits by CRF 54.
    const wide = loopPlan(true).avif;
    expect(nextRung(wide, 0, 36, 800_000, 125_000)).toEqual({ i: 2, crf: 50 });
    // Nothing predicted to fit: the smallest at CRF 54, once; then give up.
    expect(nextRung(wide, 0, 36, 9_000_000, 125_000)).toEqual({ i: 2, crf: 54 });
    expect(nextRung(wide, 2, 50, 200_000, 125_000)).toEqual({ i: 2, crf: 54 });
    expect(nextRung(wide, 2, 54, 200_000, 125_000)).toBeUndefined();
  });
});

describe("videoMotion: animated AVIF first", () => {
  test("a portrait video: one SVT-AV1 run at 216 × 384, 24 fps, 3 s with the cross-fade; a data:image/avif under the cap", async () => {
    const { path, tmp } = setup();
    const f = fakeTools();
    const m = await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp });
    expect(m?.src).toMatch(/^data:image\/avif;base64,/);
    expect(m?.frames).toBeUndefined();
    expect(m!.src.length).toBeLessThanOrEqual(MAX_MOTION_URI);
    // Asked once what this ffmpeg can do, then one encode.
    expect(f.calls.map((c) => c.cmd[1])).toEqual(["-hide_banner", "-hide_banner", "-nostdin"]);
    const cmd = f.encodes()[0].cmd;
    expect(cmd.slice(cmd.indexOf("-ss"), cmd.indexOf("-ss") + 4)).toEqual(["-ss", "12.46", "-t", "3.55"]);
    expect(cmd[cmd.indexOf("-i") + 1]).toBe(`file:${path}`);
    expect(cmd).toContain("-an");
    expect(cmd[cmd.indexOf("-filter_complex") + 1]).toBe(loopGraph(216, 384, AVIF_LOOP.fps, { seconds: 3, fade: 0.4 }, { format: "yuv420p" }));
    for (const [flag, value] of [["-map", "[v]"], ["-c:v", "libsvtav1"], ["-preset", "6"], ["-crf", "36"], ["-g", "999"], ["-f", "avif"], ["-loop", "0"]]) {
      expect(cmd[cmd.indexOf(flag) + 1]).toBe(value);
    }
    expect(f.encodes()[0].opts?.timeoutMs).toBeGreaterThan(4_000);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("over the cap: the CRF steps up until it fits", async () => {
    const { path, tmp } = setup();
    // 216 × 384 at CRF 36 comes out ~134K characters.
    const f = fakeTools({ k: 3.76 });
    const m = await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp });
    expect(f.encodes().map((c) => c.cmd[c.cmd.indexOf("-crf") + 1])).toEqual(["36", "39"]);
    expect(f.encodes().map(f.sizeOf)).toEqual(["216:384", "216:384"]);
    expect(m!.src.length).toBeLessThanOrEqual(MAX_MOTION_URI);
  });

  test("a busy landscape clip: 716 × 402 for the across tile, then straight to the size that fits", async () => {
    const { path, tmp } = setup();
    const f = fakeTools({ k: 5.7 });
    const m = await videoMotion(path, LANDSCAPE, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp });
    expect(f.encodes().map((c) => `${f.sizeOf(c)}@${c.cmd[c.cmd.indexOf("-crf") + 1]}`)).toEqual(["716:402@36", "384:216@46"]);
    // The big frames take SVT-AV1's faster preset.
    expect(f.encodes()[0].cmd[f.encodes()[0].cmd.indexOf("-preset") + 1]).toBe("8");
    expect(m?.src).toMatch(/^data:image\/avif;base64,/);
  });

  test("a gallery cell's loop: twice the cell, under its share of the card", async () => {
    const { path, tmp } = setup();
    const f = fakeTools();
    const m = await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp, small: true, cells: 6 });
    expect(f.encodes().map(f.sizeOf)[0]).toBe("138:246");
    expect(m!.src.length).toBeLessThanOrEqual(galleryCell(6, true).chars);
    // Another gallery size is another loop; the same one is cached.
    await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp, small: true, cells: 2 });
    const before = f.calls.length;
    await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp, small: true, cells: 2 });
    expect(f.calls.length).toBe(before);
    expect(f.encodes().map(f.sizeOf)).toContain("224:398");
  });

  test("cached per file; two cards asking at once share one encode; the encoder list is asked once", async () => {
    const { path, tmp } = setup();
    const f = fakeTools();
    const opts = { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp };
    const [a, b] = await Promise.all([videoMotion(path, PORTRAIT, f.runner, opts), videoMotion(path, PORTRAIT, f.runner, opts)]);
    expect(a).toEqual(b!);
    expect(f.encodes()).toHaveLength(1);
    expect(await videoMotion(path, PORTRAIT, f.runner, opts)).toEqual(a!);
    expect(f.encodes()).toHaveLength(1);
    const other = setup("other.mov");
    await videoMotion(other.path, PORTRAIT, f.runner, { ...opts, tmpRoot: other.tmp });
    expect(f.calls.filter((c) => c.cmd.includes("-encoders"))).toHaveLength(1);
  });

  test("the encoder probe: SVT-AV1 and the avif muxer both needed; an unanswered probe is asked again", async () => {
    expect(await ffmpegAvif("/fake/ffmpeg", fakeTools().runner)).toBe(true);
    clearPreviewCache();
    expect(await ffmpegAvif("/fake/ffmpeg", fakeTools({ svt: false }).runner)).toBe(false);
    clearPreviewCache();
    const noMux: Runner = async (cmd) => ok(cmd.includes("-encoders") ? " V..... libsvtav1  SVT-AV1\n" : "  E  mp4  MP4\n");
    expect(await ffmpegAvif("/fake/ffmpeg", noMux)).toBe(false);
    clearPreviewCache();
    let asked = 0;
    const flaky: Runner = async () => (asked++, { code: 124, stdout: "", stderr: "", timedOut: true });
    expect(await ffmpegAvif("/fake/ffmpeg", flaky)).toBe(false);
    expect(await ffmpegAvif("/fake/ffmpeg", flaky)).toBe(false);
    expect(asked).toBe(4);
  });

  test("isAvif reads the ftyp brand", () => {
    expect(isAvif(avifBytes(64))).toBe(true);
    const still = avifBytes(64);
    still[11] = 0x66; // "avif"
    expect(isAvif(still)).toBe(true);
    expect(isAvif(riff(64))).toBe(false);
    expect(isAvif(jpegBytes(64))).toBe(false);
    expect(isAvif(new Uint8Array(8))).toBe(false);
  });
});

describe("videoMotion falls back cleanly", () => {
  test("no SVT-AV1: an animated WebP at 216 × 384, 12 fps, stepping its quality down until it fits", async () => {
    const { path, tmp } = setup();
    const f = fakeTools({ svt: false, webp: (q) => (q > 20 ? 120_000 : 80_000) });
    const m = await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: "/fake/img2webp", tmpRoot: tmp });
    expect(m?.src).toMatch(/^data:image\/webp;base64,/);
    const frames = f.calls.find((c) => c.cmd.includes("ppm"))!.cmd;
    expect(frames[frames.indexOf("-filter_complex") + 1]).toBe(loopGraph(216, 384, 12, { seconds: 1.5, fade: 0.25 }));
    const webps = f.calls.filter((c) => c.cmd[0] === "/fake/img2webp");
    expect(webps.map((c) => c.cmd[c.cmd.indexOf("-q") + 1])).toEqual(["45", "28", "14"]);
    expect(webps[0].cmd.slice(1, 9)).toEqual(["-loop", "0", "-lossy", "-q", "45", "-m", "4", "-d"]);
    expect(webps[0].cmd[webps[0].cmd.indexOf("-d") + 1]).toBe("83");
    expect(webps[0].cmd.filter((a) => a.endsWith(".ppm"))).toHaveLength(18);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("an encoder that writes nothing counts as no AVIF: WebP next", async () => {
    const { path, tmp } = setup();
    const f = fakeTools({ noAvifOut: true });
    const m = await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: "/fake/img2webp", tmpRoot: tmp });
    expect(m?.src).toMatch(/^data:image\/webp;base64,/);
  });

  test("neither: a seam-proof JPEG filmstrip (2 px smeared border per frame) for hero tiles; nothing for a gallery cell", async () => {
    const { path, tmp } = setup();
    const f = fakeTools({ svt: false, strip: (q) => (q < 12 ? 100_000 : 60_000) });
    const m = await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp });
    expect(m).toMatchObject({ frames: 16, fps: 8, edge: 0.013889 });
    expect(m?.src).toMatch(/^data:image\/jpeg;base64,/);
    const strips = f.calls.filter((c) => c.cmd.includes("mjpeg"));
    expect(strips.map((c) => c.cmd[c.cmd.indexOf("-q:v") + 1])).toEqual(["9", "13"]);
    expect(strips[0].cmd[strips[0].cmd.indexOf("-filter_complex") + 1]).toBe(
      loopGraph(144, 256, 8, { seconds: 2, fade: 0.3 }, { then: "pad=148:256:2:0,fillborders=left=2:right=2:mode=smear,tile=16x1" }),
    );
    clearPreviewCache();
    const g = fakeTools({ svt: false });
    expect(await videoMotion(path, PORTRAIT, g.runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp, small: true, cells: 3 })).toBeUndefined();
    expect(g.calls.some((c) => c.cmd.includes("mjpeg"))).toBe(false);
  });

  test("an AVIF that can't fit even small is not retried as WebP (it would be bigger still)", async () => {
    const { path, tmp } = setup();
    const f = fakeTools({ k: 60 });
    const m = await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: "/fake/ffmpeg", img2webp: "/fake/img2webp", tmpRoot: tmp, small: true, cells: 4 });
    expect(m).toBeUndefined();
    expect(f.calls.some((c) => c.cmd[0] === "/fake/img2webp")).toBe(false);
    expect(f.encodes().length).toBeLessThanOrEqual(3);
  });

  test("no ffmpeg at all (many Windows computers): no loop, no error, no process started", async () => {
    const { path, tmp } = setup();
    const f = fakeTools();
    expect(await videoMotion(path, PORTRAIT, f.runner, { ffmpeg: null, img2webp: "/fake/img2webp", tmpRoot: tmp })).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  test("never throws, and gives up on time: a missing file, a throwing runner, an aborted call, a hang", async () => {
    const { path, tmp } = setup();
    const opts = { ffmpeg: "/fake/ffmpeg", img2webp: "/fake/img2webp", tmpRoot: tmp };
    expect(await videoMotion(join(ROOT, "nope.mp4"), PORTRAIT, fakeTools().runner, opts)).toBeUndefined();
    expect(await videoMotion(path, PORTRAIT, fakeTools({ throws: true }).runner, opts)).toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    expect(await videoMotion(path, PORTRAIT, fakeTools().runner, { ...opts, signal: ac.signal })).toBeUndefined();
    clearPreviewCache();
    const started = Date.now();
    const hung = fakeTools({ hang: true }).runner;
    // Two callers for the same file: the second waits on the first's work, within its own budget.
    const both = await Promise.all([videoMotion(path, PORTRAIT, hung, { ...opts, budgetMs: 500 }), videoMotion(path, PORTRAIT, hung, { ...opts, budgetMs: 500 })]);
    expect(both).toEqual([undefined, undefined]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("logs carry the format, size, CRF and time, never the path or name", async () => {
    const { path, tmp } = setup("Secret Project Final.mp4");
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await videoMotion(path, PORTRAIT, fakeTools().runner, { ffmpeg: "/fake/ffmpeg", img2webp: null, tmpRoot: tmp });
    } finally {
      console.error = original;
    }
    expect(lines.join("\n")).toMatch(/motion avif 216x384 crf36 chars=\d+ tries=1 \d+ms/);
    expect(lines.join("\n")).not.toMatch(/Secret|case-|\//);
  });
});

describe("posters at twice the tile", () => {
  const JPEG = jpegBytes(600);
  function fakePosters(o: { big?: boolean } = {}) {
    const calls: string[][] = [];
    const runner: Runner = async (cmd) => {
      calls.push([...cmd]);
      cmd.forEach((a, i) => {
        if (cmd[i - 1] !== "-y") return;
        // The high-quality poster over the cap (a busy frame) when asked; its safe copy always fits.
        if (a.endsWith("poster.jpg")) writeFileSync(a, o.big ? jpegBytes(MAX_POSTER_URI) : JPEG);
        if (a.endsWith("poster-safe.jpg")) writeFileSync(a, jpegBytes(900));
      });
      return ok();
    };
    return { runner, calls };
  }

  test("a landscape video can ask for its own width (716 for the across tile); a portrait one keeps its 9:16 box", async () => {
    const { path, tmp } = setup();
    const f = fakePosters();
    await videoPreview(path, LANDSCAPE, f.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, posterWidth: 240, posterWide: 716, micro: false });
    expect(f.calls[0]).toContain("scale=716:716:force_original_aspect_ratio=decrease:flags=lanczos");
    const g = fakePosters();
    await videoPreview(path, PORTRAIT, g.runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, posterWidth: 240, posterWide: 716, micro: false });
    expect(g.calls[0]).toContain("scale=427:427:force_original_aspect_ratio=decrease:flags=lanczos");
  });

  test("a poster over the cap gives way to its coarser copy, never to no poster", async () => {
    const { path, tmp } = setup();
    const p = await videoPreview(path, PORTRAIT, fakePosters({ big: true }).runner, { ffmpeg: "/fake/ffmpeg", tmpRoot: tmp, posterWidth: 216, micro: false });
    expect(p.poster).toBe(`data:image/jpeg;base64,${Buffer.from(jpegBytes(900)).toString("base64")}`);
    expect(chars(MAX_POSTER_URI, "image/jpeg")).toBeGreaterThan(MAX_POSTER_URI);
    // Under the card's per-image cap (64,000) and the posting-as card's poster budget (60,000).
    expect(MAX_POSTER_URI).toBeLessThanOrEqual(60_000);
  });
});

describe("findFfmpeg", () => {
  test("Windows: ffmpeg.exe on PATH (spelled Path, quoted entries too), else where winget, Scoop or Chocolatey put it", () => {
    const { dir } = setup();
    const bin = join(dir, "ffmpeg bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ffmpeg.exe"), "MZ");
    writeFileSync(join(bin, "ffmpeg"), "#!");
    expect(findFfmpeg({ Path: `"${bin}"` }, "win32")).toBe(join(bin, "ffmpeg.exe"));
    clearPreviewCache();
    // Not on PATH: winget's Links folder under LOCALAPPDATA.
    const links = join(dir, "local", "Microsoft", "WinGet", "Links");
    mkdirSync(links, { recursive: true });
    writeFileSync(join(links, "ffmpeg.exe"), "MZ");
    expect(findFfmpeg({ PATH: join(dir, "empty"), LOCALAPPDATA: join(dir, "local") }, "win32")).toBe(join(links, "ffmpeg.exe"));
    clearPreviewCache();
    const shims = join(dir, "home", "scoop", "shims");
    mkdirSync(shims, { recursive: true });
    writeFileSync(join(shims, "ffmpeg.exe"), "MZ");
    expect(findFfmpeg({ USERPROFILE: join(dir, "home") }, "win32")).toBe(join(shims, "ffmpeg.exe"));
    clearPreviewCache();
    // None: undefined (posters come from elsewhere, and there's simply no loop).
    expect(findFfmpeg({ PATH: join(dir, "empty") }, "win32")).toBeUndefined();
    clearPreviewCache();
    // Elsewhere the plain name (Homebrew's paths first on a Mac that has them); a relative PATH entry is ignored.
    if (process.platform !== "win32") expect(findFfmpeg({ PATH: `relative:${bin}` }, "linux")).toMatch(/ffmpeg$/);
  });
});

// ---------------------------------------------------------------------------
// The real thing (macOS with Homebrew's ffmpeg, which has SVT-AV1)
// ---------------------------------------------------------------------------

const ffmpeg = process.platform === "darwin" ? findFfmpeg() : undefined;
const svt = ffmpeg ? await ffmpegAvif(ffmpeg, run) : false;

describe("real ffmpeg", () => {
  test.skipIf(!svt)("a 9:16 test video becomes a 216 × 384 animated AVIF under the cap, fast", async () => {
    const dir = join(ROOT, "real");
    mkdirSync(join(dir, "tmp"), { recursive: true });
    const video = join(dir, "testsrc.mp4");
    const made = await run([ffmpeg!, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=540x960:rate=30:duration=6", "-pix_fmt", "yuv420p", "-y", video], { timeoutMs: 30_000 });
    expect(made.code).toBe(0);
    const started = Date.now();
    const m = await videoMotion(video, { duration_sec: 6, width: 540, height: 960 }, run, { tmpRoot: join(dir, "tmp") });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(m?.src).toMatch(/^data:image\/avif;base64,/);
    expect(m!.src.length).toBeLessThanOrEqual(MAX_MOTION_URI);
    const bytes = new Uint8Array(Buffer.from(m!.src.split(",")[1]!, "base64"));
    expect(isAvif(bytes)).toBe(true);
    // ftyp avis: an image sequence, not a still.
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("avis");
    expect(imageSize(m!.src)).toEqual({ w: 216, h: 384 });
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });
});
