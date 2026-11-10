import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import {
  MICRO_PREVIEW_DECODER_JS,
  MICRO_PREVIEW_RE,
  PHOTO_FRAME,
  PHOTO_STACK_RE,
  PREVIEW2_RE,
  STACK2_RE,
  STACK_FRAME,
  STACK_FRAME_CHARS,
  STACK_FRAME_TALL,
  VIDEO_FRAME_CHARS,
  decodeAnyFrame,
  decodeFrame,
  decodeMicroFrame,
  encodeFrame,
  encodeMicroFrame,
  encodePhotoFrame,
  encodeStackFrame,
  encodeVideoFrame,
  joinMicroPreview,
  joinPhotoStack,
  joinStack,
  joinVideoPreview,
  sameFrame,
  splitMicroPreview,
  splitPhotoStack,
} from "../src/microPreview.ts";

/**
 * Tiny AI Lab frames: 18×32 (and one 32×18) rgb24 stills made with
 * `ffmpeg -ss <t> -i ep.mp4 -frames:v 1 -vf scale=18:32 -f rawvideo -pix_fmt rgb24 -`
 * from ~/claude-shorts/out. 1,728 bytes each.
 */
const DIR = new URL("./fixtures/micro/", import.meta.url);
const FRAMES = readdirSync(DIR)
  .filter((f) => f.endsWith(".rgb") && !f.startsWith("photo-") && !f.startsWith("v2-"))
  .sort()
  .map((name) => {
    const [w, h] = /\.(\d+)x(\d+)\.rgb$/.exec(name)!.slice(1).map(Number);
    return { name, w, h, rgb: new Uint8Array(readFileSync(new URL(name, DIR))) };
  });

type Decoded = { w: number; h: number; rgba: Uint8ClampedArray } | null;
const TKP = vm.runInNewContext(`${MICRO_PREVIEW_DECODER_JS}\n;TKP`) as {
  decode(frame: unknown, scale?: number): Decoded;
  decode2(frame: unknown): Decoded;
  frame(frame: unknown, version: number, scale?: number): Decoded;
  split(preview: unknown): { version: number; seconds: number | null; frames: string[] } | null;
  splitStack(stack: unknown): { version: number; count: number | null; cover: number | null; frames: string[] } | null;
};

/** Mean absolute error per channel (0-255) between the source and a scale-1 decode. */
function pixelError(rgb: Uint8Array, d: NonNullable<Decoded>): number {
  let e = 0;
  for (let i = 0; i < d.w * d.h; i++) for (let j = 0; j < 3; j++) e += Math.abs(d.rgba[i * 4 + j] - rgb[i * 3 + j]);
  return e / (d.w * d.h * 3);
}

/** The worst channel error of the frame's average colour. */
function meanColourError(rgb: Uint8Array, d: NonNullable<Decoded>): number {
  const n = d.w * d.h;
  let worst = 0;
  for (let j = 0; j < 3; j++) {
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      a += rgb[i * 3 + j];
      b += d.rgba[i * 4 + j];
    }
    worst = Math.max(worst, Math.abs(a - b) / n);
  }
  return worst;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("micro frames: round trip on real Tiny AI Lab frames", () => {
  test("fixtures are present and tiny", () => {
    expect(FRAMES.length).toBeGreaterThanOrEqual(8);
    for (const f of FRAMES) expect(f.rgb.length).toBe(f.w * f.h * 3);
  });

  for (const f of FRAMES) {
    test(`${f.name}: ≤ 100 base64url chars, colour-accurate and soft`, () => {
      const frame = encodeMicroFrame(f.rgb, f.w, f.h);
      expect(frame).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
      expect(frame.length).toBeGreaterThanOrEqual(90); // the budget is used, not wasted
      expect(encodeMicroFrame(f.rgb, f.w, f.h)).toBe(frame); // deterministic
      const d = decodeMicroFrame(frame)!;
      expect([d.w, d.h, d.rgba.length]).toEqual([f.w, f.h, f.w * f.h * 4]);
      expect(pixelError(f.rgb, d)).toBeLessThan(22);
      expect(meanColourError(f.rgb, d)).toBeLessThan(2);
      for (let i = 3; i < d.rgba.length; i += 4) expect(d.rgba[i]).toBe(255);
    });
  }

  test("across the set: mean pixel error under 14/255 (measured 12.6 when tuned)", () => {
    const errs = FRAMES.map((f) => pixelError(f.rgb, decodeMicroFrame(encodeMicroFrame(f.rgb, f.w, f.h))!));
    expect(errs.reduce((a, b) => a + b, 0) / errs.length).toBeLessThan(14);
  });

  test("a flat colour comes back exact (to the DC quantum)", () => {
    for (const [r, g, b] of [[254, 44, 85], [24, 25, 28], [255, 255, 255], [0, 0, 0], [37, 244, 238]]) {
      const rgb = new Uint8Array(18 * 32 * 3);
      for (let i = 0; i < 18 * 32; i++) rgb.set([r, g, b], i * 3);
      const d = decodeMicroFrame(encodeMicroFrame(rgb, 18, 32))!;
      expect(pixelError(rgb, d)).toBeLessThanOrEqual(2.5);
    }
  });

  test("a smaller budget still decodes, with more error", () => {
    const f = FRAMES.find((x) => x.name.startsWith("strawberry"))!;
    const small = encodeMicroFrame(f.rgb, f.w, f.h, 40);
    expect(small.length).toBeLessThanOrEqual(40);
    const full = pixelError(f.rgb, decodeMicroFrame(encodeMicroFrame(f.rgb, f.w, f.h))!);
    expect(pixelError(f.rgb, decodeMicroFrame(small)!)).toBeGreaterThan(full);
  });

  test("decoding at a larger scale is a smooth upscale of the same picture", () => {
    const f = FRAMES[0];
    const frame = encodeMicroFrame(f.rgb, f.w, f.h);
    const one = decodeMicroFrame(frame, 1)!, four = decodeMicroFrame(frame, 4)!;
    expect([four.w, four.h]).toEqual([f.w * 4, f.h * 4]);
    // Same average colour at both scales.
    const avg = (d: NonNullable<Decoded>, j: number) => {
      let s = 0;
      for (let i = 0; i < d.w * d.h; i++) s += d.rgba[i * 4 + j];
      return s / (d.w * d.h);
    };
    for (let j = 0; j < 3; j++) expect(Math.abs(avg(one, j) - avg(four, j))).toBeLessThan(1.5);
    expect(decodeMicroFrame(frame, 99)!.w).toBe(f.w * 8); // clamped to 8×
  });
});

describe("the card's ES5 decoder", () => {
  test("gives byte-identical pixels to the TypeScript decoder", () => {
    for (const f of FRAMES) {
      const frame = encodeMicroFrame(f.rgb, f.w, f.h);
      for (const scale of [1, 4]) {
        const ts = decodeMicroFrame(frame, scale)!, es5 = TKP.decode(frame, scale)!;
        expect([es5.w, es5.h]).toEqual([ts.w, ts.h]);
        expect(Buffer.from(es5.rgba).equals(Buffer.from(ts.rgba))).toBe(true);
      }
    }
  });

  test("agrees on random frames of every size up to 40×40", () => {
    const rnd = lcg(7);
    for (let k = 0; k < 30; k++) {
      const w = 1 + Math.floor(rnd() * 40), h = 1 + Math.floor(rnd() * 40);
      const rgb = new Uint8Array(w * h * 3);
      // Smooth-ish content (gradients plus noise), like a downscaled frame.
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          for (let j = 0; j < 3; j++) rgb[(y * w + x) * 3 + j] = Math.max(0, Math.min(255, Math.round(((x / w) * 180 + (y / h) * 60 * j + rnd() * 50) % 256)));
        }
      }
      const frame = encodeMicroFrame(rgb, w, h);
      expect(frame.length).toBeLessThanOrEqual(100);
      const ts = decodeMicroFrame(frame, 2)!, es5 = TKP.decode(frame, 2)!;
      expect([ts.w, ts.h]).toEqual([w * 2, h * 2]);
      expect(Buffer.from(es5.rgba).equals(Buffer.from(ts.rgba))).toBe(true);
    }
  });

  test("splits a preview exactly like splitMicroPreview", () => {
    const frames = FRAMES.slice(0, 3).map((f) => encodeMicroFrame(f.rgb, f.w, f.h));
    const p = joinMicroPreview(frames, { durationSec: 42.4 });
    expect(TKP.split(p)).toEqual({ version: 1, seconds: 42, frames });
    expect(splitMicroPreview(p)).toEqual({ durationSec: 42, frames });
    const bare = joinMicroPreview(frames.slice(0, 1));
    expect(TKP.split(bare)).toEqual({ version: 1, seconds: null, frames: frames.slice(0, 1) });
    expect(splitMicroPreview(bare)).toEqual({ frames: frames.slice(0, 1) });
    for (const bad of ["", "p1", "p3~AAAAAAAA", `p1~${frames.join("~")}~${frames[0]}`, "p1.123456~AAAAAAAA", " p1~AAAAAAAA", 42, null, undefined]) {
      expect(TKP.split(bad)).toBeNull();
      expect(splitMicroPreview(bad)).toBeNull();
    }
  });

  test("never throws, and turns anything that isn't a frame into null (the card shows its fallback tile)", () => {
    const good = encodeMicroFrame(FRAMES[0].rgb, FRAMES[0].w, FRAMES[0].h);
    // One character changed: the 6-bit check catches it.
    const flipped = good.slice(0, 40) + (good[40] === "A" ? "B" : "A") + good.slice(41);
    for (const bad of [undefined, null, 7, {}, "", "short", "AAAAAAA", "x".repeat(101), "has space here", "émoji🎉frame", flipped, "_".repeat(60)]) {
      expect(TKP.decode(bad)).toBeNull();
      expect(decodeMicroFrame(bad as string)).toBeNull();
    }
    const rnd = lcg(11);
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let decoded = 0;
    for (let k = 0; k < 400; k++) {
      const s = Array.from({ length: 8 + Math.floor(rnd() * 93) }, () => A[Math.floor(rnd() * 64)]).join("");
      const a = TKP.decode(s, 1), b = decodeMicroFrame(s, 1);
      expect(a === null).toBe(b === null);
      if (a && b) {
        decoded++;
        expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
      }
    }
    expect(decoded).toBeLessThan(40); // random text mostly fails the check (~1 in 64 passes, plus oversize sides)
  });

  test("is plain ES5 that can be inlined in a <script>", () => {
    new vm.Script(MICRO_PREVIEW_DECODER_JS);
    const code = MICRO_PREVIEW_DECODER_JS.replace(/\/\/[^\n]*/g, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    expect(code).not.toMatch(/=>|`|\blet\b|\bconst\b|\bclass\b|\.\.\.|\basync\b|\bawait\b|for\s*\([^)]*\bof\b/);
    expect(MICRO_PREVIEW_DECODER_JS).not.toMatch(/(?<![\w$])eval\s*\(|new\s+Function\b|(?<![\w.$])Function\s*\(|set(?:Timeout|Interval)\s*\(/);
    expect(MICRO_PREVIEW_DECODER_JS).not.toMatch(/<\/script|<!--|innerHTML|fetch\s*\(|XMLHttpRequest/i);
    expect(MICRO_PREVIEW_DECODER_JS.startsWith("var TKP = (function () {")).toBe(true);
    expect(MICRO_PREVIEW_DECODER_JS.endsWith("})();")).toBe(true);
  });
});

describe("preview strings", () => {
  const frames = FRAMES.slice(0, 4).map((f) => encodeMicroFrame(f.rgb, f.w, f.h));

  test("join keeps at most three valid frames and the whole-second duration", () => {
    const p = joinMicroPreview(frames, { durationSec: 42.45 });
    expect(p).toBe(`p1.42~${frames.slice(0, 3).join("~")}`);
    expect(MICRO_PREVIEW_RE.test(p)).toBe(true);
    expect(p.length).toBeLessThanOrEqual(320);
    expect(joinMicroPreview(frames.slice(0, 2))).toBe(`p1~${frames[0]}~${frames[1]}`);
    expect(joinMicroPreview(["bad frame", frames[0], "", "x"])).toBe(`p1~${frames[0]}`);
    expect(joinMicroPreview([])).toBe("");
    expect(joinMicroPreview(["nope"])).toBe("");
    expect(joinMicroPreview([frames[0]], { durationSec: Number.NaN })).toBe(`p1~${frames[0]}`);
    expect(joinMicroPreview([frames[0]], { durationSec: -3 })).toBe(`p1~${frames[0]}`);
    expect(joinMicroPreview([frames[0]], { durationSec: 1e9 })).toBe(`p1.99999~${frames[0]}`);
  });

  test("MICRO_PREVIEW_RE takes one to three frames and nothing else", () => {
    expect(MICRO_PREVIEW_RE.test(`p1~${frames[0]}`)).toBe(true);
    expect(MICRO_PREVIEW_RE.test(`p1.0~${frames[0]}`)).toBe(true);
    for (const bad of ["p1", `p1~${frames.join("~")}`, `p1.~${frames[0]}`, `P1~${frames[0]}`, `p1~${frames[0]}~`, `p1~${frames[0]}\n`, `p1~${frames[0]}=`]) {
      expect(MICRO_PREVIEW_RE.test(bad)).toBe(false);
    }
  });

  test("the encoder refuses frames it can't represent", () => {
    expect(() => encodeMicroFrame(new Uint8Array(41 * 3), 41, 1)).toThrow(RangeError);
    expect(() => encodeMicroFrame(new Uint8Array(0), 0, 0)).toThrow(RangeError);
    expect(() => encodeMicroFrame(new Uint8Array(10), 18, 32)).toThrow(RangeError);
    expect(encodeMicroFrame(new Uint8Array([200, 30, 60]), 1, 1)).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// Photo stacks (prepare_photo_post → the photo cards)
// ---------------------------------------------------------------------------

/** Tiny AI Lab stills at 48 × 64, as sips hands them over (tests/fixtures/cards/photo-N.jpg, area-scaled). */
const PHOTOS = [1, 2, 3, 4, 5, 6].map((i) => new Uint8Array(readFileSync(new URL(`photo-${i}.48x64.rgb`, DIR))));

describe("photo stacks", () => {
  const frames = PHOTOS.map((rgb) => encodePhotoFrame(rgb, 48, 64));

  test("a photo frame is 24 × 32 (the card's 3:4) in at most 140 characters, and decodes close to the photo", () => {
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].length).toBeLessThanOrEqual(140);
      const d = decodeMicroFrame(frames[i])!;
      expect(d).toMatchObject({ w: PHOTO_FRAME.width, h: PHOTO_FRAME.height });
      // Against the source area-averaged to 24 × 32: soft, but the colours and layout hold.
      const small = new Uint8Array(24 * 32 * 3);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 24; x++) for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += PHOTOS[i][((y * 2 + dy) * 48 + x * 2 + dx) * 3 + c];
        small[(y * 24 + x) * 3 + c] = Math.round(sum / 4);
      }
      expect(pixelError(small, d)).toBeLessThan(26);
    }
  });

  test("any size and shape is centre-cropped to 3:4: a wide photo keeps its middle", () => {
    // Left third red, middle green, right third blue, 96 × 32: the 24 × 32 crop is all green.
    const w = 96, h = 32, rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set(x < 32 ? [220, 20, 20] : x < 64 ? [20, 200, 40] : [20, 30, 220], (y * w + x) * 3);
    const d = decodeMicroFrame(encodePhotoFrame(rgb, w, h))!;
    const mid = (12 + 16 * 24) * 4;
    expect(d.rgba[mid + 1]).toBeGreaterThan(150);
    expect(d.rgba[mid]).toBeLessThan(80);
    expect(() => encodePhotoFrame(new Uint8Array(3), 0, 1)).toThrow(RangeError);
    expect(() => encodePhotoFrame(new Uint8Array(5), 2, 1)).toThrow(RangeError);
  });

  test("join: at most five frames, the count (never fewer than the frames) and the cover, within 720 characters", () => {
    const s = joinPhotoStack(frames, { count: 6, cover: 2 });
    expect(s).toBe(`s1.6.2~${frames.slice(0, 5).join("~")}`);
    expect(s.length).toBeLessThanOrEqual(720);
    expect(PHOTO_STACK_RE.test(s)).toBe(true);
    expect(joinPhotoStack(frames.slice(0, 2))).toBe(`s1~${frames[0]}~${frames[1]}`);
    expect(joinPhotoStack(frames.slice(0, 3), { count: 1 })).toBe(`s1.3~${frames.slice(0, 3).join("~")}`);
    expect(joinPhotoStack(frames.slice(0, 2), { cover: 1 })).toBe(`s1.2.1~${frames[0]}~${frames[1]}`);
    expect(joinPhotoStack(frames.slice(0, 2), { count: 2, cover: 5 })).toBe(`s1.2~${frames[0]}~${frames[1]}`);
    expect(joinPhotoStack(["nope", ""])).toBe("");
  });

  test("split (server) and splitStack (card) agree, and refuse anything else", () => {
    const s = joinPhotoStack(frames, { count: 6, cover: 0 });
    expect(splitPhotoStack(s)).toEqual({ count: 6, cover: 0, frames: frames.slice(0, 5) });
    expect(TKP.splitStack(s)).toEqual({ version: 1, count: 6, cover: 0, frames: frames.slice(0, 5) });
    const bare = joinPhotoStack(frames.slice(0, 1));
    expect(splitPhotoStack(bare)).toEqual({ frames: frames.slice(0, 1) });
    expect(TKP.splitStack(bare)).toEqual({ version: 1, count: null, cover: null, frames: frames.slice(0, 1) });
    const video = joinMicroPreview([frames[0].slice(0, 100)]);
    for (const bad of ["", "s1", `s1~${frames.join("~")}`, `s1.~${frames[0]}`, `s1.100~${frames[0]}`, `S1~${frames[0]}`, video, `${bare}\n`, 42, null]) {
      expect(splitPhotoStack(bad)).toBeNull();
      expect(TKP.splitStack(bad)).toBeNull();
    }
    // A video preview isn't a stack, nor the other way round.
    expect(splitMicroPreview(s)).toBeNull();
  });

  test("the card decodes stack frames to the same pixels, at the 8× it draws them", () => {
    for (const f of frames.slice(0, 3)) {
      const a = decodeMicroFrame(f, 8)!, b = TKP.decode(f, 8)!;
      expect([b.w, b.h]).toEqual([192, 256]);
      expect(Buffer.from(b.rgba).equals(Buffer.from(a.rgba))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Version 2 (p2 / s2): wavelet frames with arithmetic coding, what the server makes now
// ---------------------------------------------------------------------------

/** Real Tiny AI Lab frames at the v2 sizes: 45 × 80 video stills (ffmpeg, area-scaled) and a 90 × 160 slide. */
const V2 = ["speedrun", "token", "museum"].map((n) => new Uint8Array(readFileSync(new URL(`v2-${n}.45x80.rgb`, DIR))));
const SLIDE = new Uint8Array(readFileSync(new URL("v2-slide.90x160.rgb", DIR)));

describe("version 2 frames", () => {
  const video = V2.map((rgb) => encodeVideoFrame(rgb, 45, 80));
  const stack = PHOTOS.map((rgb) => encodeStackFrame(rgb, 48, 64));

  test("video frames are 45 × 80 within 360 characters, deterministic, and decode close to the frame", () => {
    for (let i = 0; i < V2.length; i++) {
      expect(video[i].length).toBeLessThanOrEqual(VIDEO_FRAME_CHARS);
      expect(video[i].length).toBeGreaterThan(VIDEO_FRAME_CHARS - 40); // the budget is used, not wasted
      expect(video[i]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeVideoFrame(V2[i], 45, 80)).toBe(video[i]);
      const d = decodeFrame(video[i])!;
      expect([d.w, d.h]).toEqual([45, 80]);
      expect(pixelError(V2[i], d)).toBeLessThan(13); // measured 4.8-10.1 on these frames
      expect(meanColourError(V2[i], d)).toBeLessThan(3);
    }
  });

  test("twice the resolution of version 1 and sharper: less error than a v1 frame of the same video, upscaled", () => {
    for (const rgb of V2) {
      const v2 = pixelError(rgb, decodeFrame(encodeVideoFrame(rgb, 45, 80))!);
      // v1 at its 18 × 32 (area-averaged from the same pixels), compared at 45 × 80 through the card's own upscale.
      const small = new Uint8Array(18 * 32 * 3);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 18; x++) for (let c = 0; c < 3; c++) {
        const sx = Math.floor((x * 45) / 18), sy = Math.floor((y * 80) / 32);
        small[(y * 18 + x) * 3 + c] = rgb[(sy * 45 + sx) * 3 + c];
      }
      const v1 = decodeMicroFrame(encodeMicroFrame(small, 18, 32), 5)!; // 90 × 160
      const at = new Uint8Array(45 * 80 * 3);
      for (let y = 0; y < 80; y++) for (let x = 0; x < 45; x++) for (let c = 0; c < 3; c++) at[(y * 45 + x) * 3 + c] = v1.rgba[((y * 2) * 90 + x * 2) * 4 + c];
      let e1 = 0;
      for (let i = 0; i < at.length; i++) e1 += Math.abs(at[i] - rgb[i]);
      expect(v2).toBeLessThan(e1 / at.length);
    }
  });

  test("a smaller budget costs quality; a tiny one gives no frame rather than a broken one", () => {
    const full = pixelError(V2[0], decodeFrame(video[0])!);
    const small = encodeFrame(V2[0], 45, 80, 120);
    expect(small.length).toBeLessThanOrEqual(120);
    expect(pixelError(V2[0], decodeFrame(small)!)).toBeGreaterThan(full);
    expect(encodeFrame(V2[0], 45, 80, 8)).toBe("");
    expect(() => encodeFrame(new Uint8Array(129 * 2 * 3), 129, 2)).toThrow(RangeError);
    expect(() => encodeFrame(new Uint8Array(3), 1, 1)).toThrow(RangeError);
    expect(() => encodeVideoFrame(new Uint8Array(10), 45, 80)).toThrow(RangeError);
    // A big source is area-averaged into the 80 box first.
    expect(decodeFrame(encodeVideoFrame(SLIDE, 90, 160))).toMatchObject({ w: 45, h: 80 });
  });

  test("stack frames are 48 × 64 (3:4) within 295 characters, or 45 × 80 (9:16) for tall photos", () => {
    for (let i = 0; i < PHOTOS.length; i++) {
      expect(stack[i].length).toBeLessThanOrEqual(STACK_FRAME_CHARS);
      const d = decodeFrame(stack[i])!;
      expect([d.w, d.h]).toEqual([STACK_FRAME.width, STACK_FRAME.height]);
      expect(pixelError(PHOTOS[i], d)).toBeLessThan(16); // measured 4.5-12.7
    }
    const tall = decodeFrame(encodeStackFrame(SLIDE, 90, 160, true))!;
    expect([tall.w, tall.h]).toEqual([STACK_FRAME_TALL.width, STACK_FRAME_TALL.height]);
    expect(decodeFrame(encodeStackFrame(SLIDE, 90, 160))).toMatchObject({ w: 48, h: 64 });
    expect(() => encodeStackFrame(new Uint8Array(5), 2, 1)).toThrow(RangeError);
  });

  test("whole strings stay within the copy budget: a preview ≤ 1,100 characters, a stack ≤ 1,500", () => {
    const p = joinVideoPreview(video, { durationSec: 99_999 });
    expect(p.length).toBeLessThanOrEqual(1_100);
    expect(p).toMatch(PREVIEW2_RE);
    expect(p.startsWith("p2.99999~")).toBe(true);
    const five = [...stack, ...stack].slice(0, 5);
    const s = joinStack(five, { count: 35, cover: 34 });
    expect(s.length).toBeLessThanOrEqual(1_500);
    expect(s).toMatch(STACK2_RE);
    expect(s.startsWith("s2.35.34~")).toBe(true);
    // The worst case: every frame at its full budget, the longest headers.
    expect("p2.99999".length + 3 * (1 + VIDEO_FRAME_CHARS)).toBeLessThanOrEqual(1_100);
    expect("s2.99.98".length + 5 * (1 + STACK_FRAME_CHARS)).toBeLessThanOrEqual(1_500);
    expect(joinVideoPreview(["nope", ""])).toBe("");
    expect(joinStack(frames2(1), { cover: 0 })).toMatch(/^s2\.1\.0~/);
    expect(joinStack(frames2(2), { count: 1 })).toMatch(/^s2\.2~/);
  });
  function frames2(n: number) {
    return stack.slice(0, n);
  }

  test("splits carry the version; old p1/s1 strings still split and decode", () => {
    const p = joinVideoPreview(video, { durationSec: 42 });
    expect(splitMicroPreview(p)).toEqual({ version: 2, durationSec: 42, frames: video });
    expect(TKP.split(p)).toEqual({ version: 2, seconds: 42, frames: video });
    const s = joinStack(stack.slice(0, 3), { count: 6, cover: 2 });
    expect(splitPhotoStack(s)).toEqual({ version: 2, count: 6, cover: 2, frames: stack.slice(0, 3) });
    expect(TKP.splitStack(s)).toEqual({ version: 2, count: 6, cover: 2, frames: stack.slice(0, 3) });
    expect(splitMicroPreview(s)).toBeNull();
    expect(splitPhotoStack(p)).toBeNull();
    const old = joinMicroPreview([encodeMicroFrame(FRAMES[0].rgb, FRAMES[0].w, FRAMES[0].h)]);
    expect(splitMicroPreview(old)!.version).toBeUndefined();
    expect(decodeAnyFrame(splitMicroPreview(old)!.frames[0], 1)).toMatchObject({ w: FRAMES[0].w, h: FRAMES[0].h });
    expect(decodeAnyFrame(video[0], 2)).toMatchObject({ w: 45, h: 80 });
    // A v2 frame read as v1 (or the other way round) is just not a frame.
    expect(decodeMicroFrame(video[0])).toBeNull();
    expect(decodeFrame(splitMicroPreview(old)!.frames[0])).toBeNull();
  });

  test("the card's ES5 decoder gives the same pixels as the server's", () => {
    for (const f of [...video, ...stack, encodeStackFrame(SLIDE, 90, 160, true)]) {
      const a = decodeFrame(f)!, b = TKP.decode2(f)!, c = TKP.frame(f, 2)!;
      expect([b.w, b.h]).toEqual([a.w, a.h]);
      expect(Buffer.from(b.rgba).equals(Buffer.from(a.rgba))).toBe(true);
      expect(Buffer.from(c.rgba).equals(Buffer.from(a.rgba))).toBe(true);
    }
  });

  test("the 12-bit check: a mangled copy decodes to nothing (and never throws), in both decoders", () => {
    let passed = 0, tries = 0;
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const f of [...video, ...stack]) {
      for (let k = 0; k < 40; k++) {
        const at = 6 + ((k * 37) % (f.length - 8));
        const swapped = f.slice(0, at) + (f[at] === "x" ? "y" : "x") + f.slice(at + 1);
        const dropped = f.slice(0, at) + f.slice(at + 1);
        for (const g of [swapped, dropped]) {
          tries++;
          const a = decodeFrame(g), b = TKP.decode2(g);
          expect(a === null).toBe(b === null);
          if (a) passed++;
        }
      }
    }
    expect(passed).toBeLessThanOrEqual(Math.ceil(tries / 200)); // about 1 in 4,096 slips through
    const rnd = lcg(29);
    let junk = 0;
    for (let k = 0; k < 400; k++) {
      const s = Array.from({ length: 6 + Math.floor(rnd() * 400) }, () => A[Math.floor(rnd() * 64)]).join("");
      if (decodeFrame(s) || TKP.decode2(s)) junk++;
    }
    expect(junk).toBeLessThanOrEqual(1);
    for (const bad of [undefined, null, 7, {}, "", "AAAAA", "x".repeat(1001), "has space here", "émoji🎉frame", "_".repeat(400)]) {
      expect(decodeFrame(bad as string)).toBeNull();
      expect(TKP.decode2(bad)).toBeNull();
    }
  });

  test("trailing zero characters are padding: dropped by the encoder, harmless in a copy", () => {
    for (const f of video) expect(f.endsWith("A")).toBe(false);
    const padded = `${video[0]}AA`;
    expect(Buffer.from(decodeFrame(padded)!.rgba).equals(Buffer.from(decodeFrame(video[0])!.rgba))).toBe(true);
    expect(sameFrame(padded, video[0])).toBe(true);
    expect(sameFrame(video[1], video[0])).toBe(false);
  });
});
