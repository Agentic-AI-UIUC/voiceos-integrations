/**
 * Real frames of a local video, for the cards (UI brief, contract 3):
 *  - `poster`: a sharp JPEG data URI (≤ 45 KB) for result cards (find_recent_videos, the completion card,
 *    "did it go up?");
 *  - `micro`: the micro preview (src/microPreview.ts): three tiny frames at ~15 %, ~50 % and ~85 % of the
 *    video, which the confirmation card decodes and crossfades. It travels as the write tools' `preview`
 *    argument, so it has to be small and the same every time for the same file.
 *
 * Frame source: ffmpeg when it's installed (Homebrew paths, then PATH): one fast seek per frame, the poster
 * from the middle frame, micro frames as PPM (rgb24 with a size header) fitted into 80 × 80 (45 × 80 for a
 * 9:16 video, 80 × 45 for 16:9). Without ffmpeg, macOS's `qlmanage -t` thumbnail (one frame) and `sips` for
 * the poster's resize and the micro frame's BMP pixels: a poster and a one-frame micro preview.
 *
 * Best effort and time-boxed (2.5 s by default), cached by path + size + mtime, never throws (returns {}).
 * Temp files live in $TMPDIR/tiktok-preview-* and are removed. Logs carry the source, counts and a
 * duration, never a path or name.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SIPS, SRGB_PROFILE } from "./images.ts";
import { VIDEO_FRAME_BOX, encodeStackFrame, encodeVideoFrame, joinStack, joinVideoPreview } from "./microPreview.ts";
import { log } from "./proc.ts";
import type { Runner } from "./types.ts";

export interface VideoPreview {
  /** data:image/jpeg;base64,…, ≤ 45 KB. */
  poster?: string;
  /** The micro preview string ("p2~…", src/microPreview.ts), ≤ 1,100 chars. */
  micro?: string;
  /** A short moving loop of the video for the result cards (asked for with `motion: true`). */
  motion?: VideoMotion;
}

/**
 * A 2.5 s loop of the video at 8 fps, cropped to the card's 9:16 (16:9 for landscape): an animated WebP when
 * img2webp is installed, else a JPEG filmstrip (`frames` frames side by side) that the card plays with CSS
 * steps(). Either way one data URI, ≤ MAX_MOTION_URI characters.
 */
export interface VideoMotion {
  src: string;
  /** Filmstrips only: how many frames side by side, and their rate. */
  frames?: number;
  fps?: number;
}

export interface PreviewInfo {
  duration_sec?: number;
  width?: number;
  height?: number;
}

export interface PreviewOptions {
  /** Poster width for a 9:16 video (a 16:9 one gets the same pixel count lying down). Default 160; 0 = no poster. */
  posterWidth?: number;
  /** Also make the micro preview. Default true. */
  micro?: boolean;
  signal?: AbortSignal;
  /** Test seam: the ffmpeg binary to use, or null to act as if it isn't installed. Default: found on this Mac. */
  ffmpeg?: string | null;
  /** Where the temp folder goes. Default $TMPDIR. */
  tmpRoot?: string;
  /** Total time for this video. Default 2.5 s. */
  budgetMs?: number;
  /** Also make the moving loop (videoMotion), in parallel, within its own budget (default 5 s); "small" for a gallery cell. */
  motion?: boolean | "small";
  /** Test seam: the img2webp binary, or null to act as if it isn't installed. Default: found on this Mac. */
  img2webp?: string | null;
}

export const PREVIEW_BUDGET_MS = 2_500;
export const DEFAULT_POSTER_WIDTH = 160;
/** Micro frames fit in this square. */
export const MICRO_BOX = VIDEO_FRAME_BOX;
const FRAME_AT = [0.15, 0.5, 0.85] as const;
const MAX_POSTER_URI = 45 * 1024;
const CACHE_MAX = 48;
const CACHE_MS = 30 * 60_000;

const FFMPEG_PATHS = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
let foundFfmpeg: string | null | undefined;

/** ffmpeg on this Mac: Homebrew's paths first (VoiceOS's PATH has neither), then PATH. Looked up once. */
export function findFfmpeg(env: Record<string, string | undefined> = process.env): string | undefined {
  if (foundFfmpeg !== undefined) return foundFfmpeg ?? undefined;
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d.startsWith("/"));
  const hit = [...FFMPEG_PATHS, ...dirs.map((d) => join(d, "ffmpeg"))].find((p) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  });
  foundFfmpeg = hit ?? null;
  return hit;
}

// ---------------------------------------------------------------------------
// Pixel formats
// ---------------------------------------------------------------------------

export interface Pixels {
  w: number;
  h: number;
  /** rgb24, row-major, top row first. */
  rgb: Uint8Array;
}

/** A binary PPM (P6, maxval 255), as ffmpeg's ppm encoder writes it. */
export function parsePpm(b: Uint8Array): Pixels | undefined {
  if (b.length < 11 || b[0] !== 0x50 || b[1] !== 0x36) return undefined;
  const fields: number[] = [];
  let i = 2;
  while (fields.length < 3 && i < b.length) {
    const c = b[i];
    if (c === 0x23) {
      while (i < b.length && b[i] !== 0x0a) i++;
    } else if (c >= 0x30 && c <= 0x39) {
      let n = 0;
      while (i < b.length && b[i] >= 0x30 && b[i] <= 0x39) n = n * 10 + (b[i++] - 0x30);
      fields.push(n);
      continue;
    } else if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) {
      return undefined;
    }
    i++;
  }
  const [w, h, max] = fields;
  if (fields.length !== 3 || max !== 255 || !(w > 0 && h > 0 && w <= 256 && h <= 256)) return undefined;
  const start = i + 1; // one whitespace byte after maxval
  const need = w * h * 3;
  if (b.length < start + need) return undefined;
  return { w, h, rgb: b.slice(start, start + need) };
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

/** One channel through its bit mask, scaled to 0-255. */
function channel(v: number, mask: number): number {
  if (!mask) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const bits = (mask >>> shift).toString(2).length;
  const max = 2 ** bits - 1;
  return Math.round((((v & mask) >>> shift) / max) * 255);
}

/** A 24- or 32-bit BMP (plain or BI_BITFIELDS, bottom-up or top-down), as `sips -s format bmp` writes it. */
export function parseBmp(b: Uint8Array): Pixels | undefined {
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) return undefined;
  const offset = u32(b, 10);
  const w = i32(b, 18);
  const rawH = i32(b, 22);
  const bpp = u16(b, 28);
  const compression = u32(b, 30);
  const h = Math.abs(rawH);
  if (!(w > 0 && h > 0 && w <= 256 && h <= 256) || (bpp !== 24 && bpp !== 32)) return undefined;
  let masks: [number, number, number];
  if (compression === 0) masks = bpp === 32 ? [0xff0000, 0xff00, 0xff] : [0xff0000, 0xff00, 0xff];
  else if (compression === 3 && b.length >= 66) masks = [u32(b, 54), u32(b, 58), u32(b, 62)];
  else return undefined;
  const bytesPer = bpp / 8;
  const stride = Math.floor((bpp * w + 31) / 32) * 4;
  if (b.length < offset + stride * h) return undefined;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = offset + (rawH < 0 ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = row + x * bytesPer;
      const v = bpp === 32 ? u32(b, p) : b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
      const o = (y * w + x) * 3;
      rgb[o] = channel(v, masks[0]);
      rgb[o + 1] = channel(v, masks[1]);
      rgb[o + 2] = channel(v, masks[2]);
    }
  }
  return { w, h, rgb };
}

/** Width and height from a PNG's IHDR. */
function pngSize(b: Uint8Array): { w: number; h: number } | undefined {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return undefined;
  const be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const w = be(16), h = be(20);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

/** Fit w × h inside a box × box square (never larger than the source). */
function fit(w: number, h: number, box: number): { w: number; h: number } {
  const s = Math.min(1, box / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

function posterUri(file: string): string | undefined {
  try {
    const b = new Uint8Array(readFileSync(file));
    if (!isJpeg(b)) return undefined;
    const uri = `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;
    return uri.length <= MAX_POSTER_URI ? uri : undefined;
  } catch {
    return undefined;
  }
}

function microFrame(px: Pixels | undefined): string | undefined {
  if (!px) return undefined;
  try {
    const f = encodeVideoFrame(px.rgb, px.w, px.h);
    return typeof f === "string" && f ? f : undefined;
  } catch {
    return undefined;
  }
}

const readBytes = (file: string): Uint8Array | undefined => {
  try {
    return new Uint8Array(readFileSync(file));
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Frame sources
// ---------------------------------------------------------------------------

interface Plan {
  path: string;
  dir: string;
  duration?: number;
  /** Poster box side (0 = no poster). */
  box: number;
  micro: boolean;
  timeoutMs: number;
}

/** When to grab each frame: ~15 %, ~50 % and ~85 % in, a little before the end; 1 s in when the length is unknown. */
export function frameTimes(duration?: number): number[] {
  if (!(typeof duration === "number" && Number.isFinite(duration) && duration > 0)) return [1];
  const last = Math.max(0, duration - 0.1);
  return FRAME_AT.map((f) => Math.round(Math.min(last, duration * f) * 1000) / 1000);
}

async function viaFfmpeg(bin: string, p: Plan, runner: Runner): Promise<VideoPreview> {
  const times = frameTimes(p.duration);
  const middle = times.length === 3 ? 1 : 0;
  const scaleMicro = `scale=${MICRO_BOX}:${MICRO_BOX}:force_original_aspect_ratio=decrease:flags=area`;
  const scalePoster = `scale=${p.box}:${p.box}:force_original_aspect_ratio=decrease:flags=bicubic`;
  const runs = times.map(async (t, i) => {
    const poster = p.box > 0 && i === middle ? join(p.dir, "poster.jpg") : undefined;
    const micro = p.micro ? join(p.dir, `m${i}.ppm`) : undefined;
    if (!poster && !micro) return { poster: undefined, micro: undefined };
    const cmd = [bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", `file:${p.path}`];
    if (poster) cmd.push("-map", "0:v:0", "-frames:v", "1", "-vf", scalePoster, "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "-y", poster);
    if (micro) cmd.push("-map", "0:v:0", "-frames:v", "1", "-vf", scaleMicro, "-pix_fmt", "rgb24", "-f", "image2", "-c:v", "ppm", "-y", micro);
    await runner(cmd, { timeoutMs: p.timeoutMs });
    // A failed run leaves no file (or a partial one, which the parsers refuse).
    return {
      poster: poster ? posterUri(poster) : undefined,
      micro: micro ? microFrame(parsePpmFile(micro)) : undefined,
    };
  });
  const got = await Promise.all(runs);
  const frames = got.map((g) => g.micro).filter((f): f is string => Boolean(f));
  const poster = got.find((g) => g.poster)?.poster;
  return compact({ poster, micro: frames.length ? joinMicro(frames, p.duration) : undefined });
}

const parsePpmFile = (file: string) => {
  const b = readBytes(file);
  return b ? parsePpm(b) : undefined;
};

/** The frames as one preview string, with the video's whole seconds for the card's duration pill when known. */
function joinMicro(frames: string[], duration?: number): string | undefined {
  try {
    const seconds = typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined;
    const s = joinVideoPreview(frames, seconds !== undefined ? { durationSec: seconds } : {});
    return typeof s === "string" && s ? s : undefined;
  } catch {
    return undefined;
  }
}

async function viaQuickLook(p: Plan, runner: Runner): Promise<VideoPreview> {
  const started = Date.now();
  const size = Math.max(480, p.box);
  await runner(["qlmanage", "-t", "-s", String(size), "-o", p.dir, p.path], { timeoutMs: Math.max(500, p.timeoutMs - 400) });
  let png: string | undefined;
  try {
    png = readdirSync(p.dir).find((f) => f.toLowerCase().endsWith(".png"));
  } catch {
    png = undefined;
  }
  if (!png) return {};
  const src = join(p.dir, png);
  const head = readBytes(src);
  const dims = head ? pngSize(head) : undefined;
  if (!dims) return {};
  const left = () => Math.max(300, p.timeoutMs - (Date.now() - started));
  const jobs: Array<Promise<Partial<VideoPreview>>> = [];
  if (p.box > 0) {
    const out = join(p.dir, "poster.jpg");
    const target = fit(dims.w, dims.h, p.box);
    const resize = target.w < dims.w ? ["--resampleWidth", String(target.w)] : [];
    jobs.push(
      runner(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", ...resize, src, "--out", out], { timeoutMs: left() }).then(() => ({ poster: posterUri(out) })),
    );
  }
  if (p.micro) {
    const out = join(p.dir, "m0.bmp");
    const m = fit(dims.w, dims.h, MICRO_BOX);
    jobs.push(
      runner(["sips", "-s", "format", "bmp", "-z", String(m.h), String(m.w), src, "--out", out], { timeoutMs: left() }).then(() => {
        const b = readBytes(out);
        const frame = microFrame(b ? parseBmp(b) : undefined);
        return { micro: frame ? joinMicro([frame], p.duration) : undefined };
      }),
    );
  }
  const parts = await Promise.all(jobs);
  return compact(Object.assign({}, ...parts) as VideoPreview);
}

function compact(v: VideoPreview): VideoPreview {
  const out: VideoPreview = {};
  if (v.poster) out.poster = v.poster;
  if (v.micro) out.micro = v.micro;
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: VideoPreview }>();
const inflight = new Map<string, Promise<VideoPreview>>();

/** Tests: forget cached previews and the ffmpeg lookup. */
export function clearPreviewCache(): void {
  cache.clear();
  inflight.clear();
  foundFfmpeg = undefined;
  clearMotionCache();
}

/**
 * The poster and micro preview of a local video. Best effort: {} when nothing could be made in time.
 * Cached by path + size + mtime (and the options), so a second look at the same file costs nothing.
 */
export async function videoPreview(path: string, info: PreviewInfo, runner: Runner, opts: PreviewOptions = {}): Promise<VideoPreview> {
  const started = Date.now();
  try {
    if (opts.signal?.aborted) return {};
    const st = statSync(path);
    const posterWidth = Math.max(0, Math.floor(opts.posterWidth ?? DEFAULT_POSTER_WIDTH));
    const micro = opts.micro !== false;
    // The loop runs beside the frames, on its own cache and budget.
    const moving = opts.motion
      ? videoMotion(path, info, runner, { ffmpeg: opts.ffmpeg, img2webp: opts.img2webp, tmpRoot: opts.tmpRoot, signal: opts.signal, small: opts.motion === "small" })
      : Promise.resolve(undefined);
    if (!posterWidth && !micro) {
      const motion = await moving;
      return motion ? { motion } : {};
    }
    const withMotion = async (v: VideoPreview): Promise<VideoPreview> => {
      const motion = await moving;
      return motion ? { ...v, motion } : { ...v };
    };
    const key = `${path}|${st.size}|${st.mtimeMs}|${posterWidth}|${micro ? 1 : 0}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at <= CACHE_MS) return withMotion(hit.value);
    const pending = inflight.get(key);
    if (pending) return withMotion(await pending);
    const budget = Math.max(300, opts.budgetMs ?? PREVIEW_BUDGET_MS);
    const work = make(path, info, runner, { posterWidth, micro, budget, ffmpeg: opts.ffmpeg, tmpRoot: opts.tmpRoot ?? tmpdir() });
    inflight.set(key, work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<VideoPreview>((resolve) => (timer = setTimeout(() => resolve({}), budget + 250)));
    const value = await Promise.race([work, late]).finally(() => clearTimeout(timer));
    work
      .then((v) => {
        if (v.poster || v.micro) {
          cache.set(key, { at: Date.now(), value: v });
          while (cache.size > CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
      })
      .catch(() => {})
      .finally(() => inflight.delete(key));
    return withMotion(value);
  } catch {
    log(`preview error ${Date.now() - started}ms`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// The moving loop (result cards)
// ---------------------------------------------------------------------------

export const MOTION_BUDGET_MS = 5_000;
/** One loop as data-URI characters (~90 KB of WebP or JPEG), so a card with a loop and a few posters stays under VoiceOS's cap. */
export const MAX_MOTION_URI = 125_000;
/** A gallery cell's loop (the find card with several videos plays each one). */
export const MAX_SMALL_MOTION_URI = 40_000;
const MOTION_SECONDS = 2.5;
const MOTION_FPS = 8;
const IMG2WEBP_PATHS = ["/opt/homebrew/bin/img2webp", "/usr/local/bin/img2webp"];
let foundImg2webp: string | null | undefined;

/** img2webp (Homebrew's webp tools) on this Mac, looked up once. */
export function findImg2webp(env: Record<string, string | undefined> = process.env): string | undefined {
  if (foundImg2webp !== undefined) return foundImg2webp ?? undefined;
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d.startsWith("/"));
  const hit = [...IMG2WEBP_PATHS, ...dirs.map((d) => join(d, "img2webp"))].find((p) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  });
  foundImg2webp = hit ?? null;
  return hit;
}

const motionCache = new Map<string, { at: number; value: VideoMotion }>();
const motionInflight = new Map<string, Promise<VideoMotion | undefined>>();

/** Tests: forget cached loops and the img2webp lookup. */
export function clearMotionCache(): void {
  motionCache.clear();
  motionInflight.clear();
  foundImg2webp = undefined;
}

/** Where the loop starts and how long it runs: a fifth of the way in (past the intro), 2.5 s or the whole of a shorter video. */
export function motionWindow(duration?: number): { start: number; seconds: number; frames: number } {
  const d = typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : undefined;
  const seconds = d === undefined ? MOTION_SECONDS : Math.max(0.5, Math.min(MOTION_SECONDS, d - 0.05));
  const start = d === undefined ? 0 : Math.max(0, Math.min(d * 0.2, d - seconds - 0.05));
  return { start: Math.round(start * 1000) / 1000, seconds: Math.round(seconds * 1000) / 1000, frames: Math.max(2, Math.min(20, Math.round(seconds * MOTION_FPS))) };
}

const fileUri = (file: string, mime: string, max = MAX_MOTION_URI): string | undefined => {
  const b = readBytes(file);
  if (!b || b.length < 12) return undefined;
  const uri = `data:${mime};base64,${Buffer.from(b).toString("base64")}`;
  return uri.length <= max ? uri : undefined;
};
const isWebp = (b: Uint8Array) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

/**
 * The video's moving loop. Best effort and time-boxed (5 s), cached by path + size + mtime (a second card for
 * the same file costs nothing), never throws: undefined when there's no ffmpeg or nothing came out in time.
 */
export async function videoMotion(
  path: string,
  info: PreviewInfo,
  runner: Runner,
  opts: { ffmpeg?: string | null; img2webp?: string | null; tmpRoot?: string; budgetMs?: number; signal?: AbortSignal; small?: boolean } = {},
): Promise<VideoMotion | undefined> {
  const started = Date.now();
  try {
    if (opts.signal?.aborted) return undefined;
    const st = statSync(path);
    const small = opts.small === true;
    const key = `${path}|${st.size}|${st.mtimeMs}|${small ? "s" : "l"}`;
    const hit = motionCache.get(key);
    if (hit && Date.now() - hit.at <= CACHE_MS) return { ...hit.value };
    const pending = motionInflight.get(key);
    if (pending) {
      const v = await pending;
      return v ? { ...v } : undefined;
    }
    const budget = Math.max(500, opts.budgetMs ?? MOTION_BUDGET_MS);
    const bin = opts.ffmpeg === undefined ? findFfmpeg() : opts.ffmpeg ?? undefined;
    if (!bin) return undefined;
    const webp = opts.img2webp === undefined ? findImg2webp() : opts.img2webp ?? undefined;
    // A gallery cell's loop is WebP only: a filmstrip needs a box of its own exact shape.
    if (small && !webp) return undefined;
    const work = makeMotion(path, info, runner, { bin, webp, budget, small, tmpRoot: opts.tmpRoot ?? tmpdir() });
    motionInflight.set(key, work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), budget + 250)));
    const value = await Promise.race([work, late]).finally(() => clearTimeout(timer));
    work
      .then((v) => {
        if (!v) return;
        motionCache.set(key, { at: Date.now(), value: v });
        while (motionCache.size > 16) {
          const oldest = motionCache.keys().next().value;
          if (oldest === undefined) break;
          motionCache.delete(oldest);
        }
      })
      .catch(() => {})
      .finally(() => motionInflight.delete(key));
    return value ? { ...value } : undefined;
  } catch {
    log(`motion error ${Date.now() - started}ms`);
    return undefined;
  }
}

async function makeMotion(
  path: string,
  info: PreviewInfo,
  runner: Runner,
  o: { bin: string; webp?: string; budget: number; small?: boolean; tmpRoot: string },
): Promise<VideoMotion | undefined> {
  const started = Date.now();
  const left = () => Math.max(300, o.budget - (Date.now() - started));
  let dir: string | undefined;
  let out: VideoMotion | undefined;
  let how = "none";
  try {
    dir = mkdtempSync(join(o.tmpRoot, "tiktok-preview-"));
    const wide = typeof info.width === "number" && typeof info.height === "number" && info.width > info.height * 1.08;
    const win = motionWindow(info.duration_sec);
    const head = [o.bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(win.start), "-t", String(win.seconds), "-i", `file:${path}`, "-an", "-map", "0:v:0"];
    const crop = (w: number, h: number) => `fps=${MOTION_FPS},scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`;
    if (o.webp) {
      // 180 × 320 frames (320 × 180 lying down) into one lossy, looping WebP; a busy clip gets a second, coarser pass.
      // A gallery cell gets 108 × 192 at a lower quality (~12-20K), so six of them fit one card.
      const [w, h] = o.small ? (wide ? [192, 108] : [108, 192]) : wide ? [320, 180] : [180, 320];
      await runner([...head, "-vf", crop(w, h), "-frames:v", String(win.frames), "-f", "image2", "-c:v", "ppm", join(dir, "f%02d.ppm")], { timeoutMs: left() });
      const frames = readdirSync(dir).filter((f) => /^f\d+\.ppm$/.test(f)).sort().map((f) => join(dir as string, f));
      if (frames.length >= 2) {
        for (const q of o.small ? [30, 12] : [42, 24]) {
          const file = join(dir, `m${q}.webp`);
          await runner([o.webp, "-loop", "0", "-lossy", "-q", String(q), "-m", "4", "-d", String(Math.round(1000 / MOTION_FPS)), ...frames, "-o", file], { timeoutMs: left() });
          const b = readBytes(file);
          const uri = b && isWebp(b) ? fileUri(file, "image/webp", o.small ? MAX_SMALL_MOTION_URI : MAX_MOTION_URI) : undefined;
          if (uri) {
            out = { src: uri };
            how = `webp q${q}`;
            break;
          }
        }
      }
    }
    if (!out && !o.small) {
      // A filmstrip: the frames side by side in one JPEG (144 × 256 each), played by the card with CSS steps().
      const [w, h] = wide ? [256, 144] : [144, 256];
      for (const q of [12, 20]) {
        const file = join(dir, `s${q}.jpg`);
        await runner([...head, "-vf", `${crop(w, h)},tile=${win.frames}x1`, "-frames:v", "1", "-q:v", String(q), "-f", "image2", "-c:v", "mjpeg", "-y", file], { timeoutMs: left() });
        const b = readBytes(file);
        const uri = b && isJpeg(b) ? fileUri(file, "image/jpeg") : undefined;
        if (uri) {
          out = { src: uri, frames: win.frames, fps: MOTION_FPS };
          how = `strip q${q}`;
          break;
        }
      }
    }
  } catch {
    out = undefined;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* swept later with the other tiktok-* temp folders */
      }
    }
    log(`motion ${how} chars=${out ? out.src.length : 0} ${Date.now() - started}ms`);
  }
  return out;
}

async function make(
  path: string,
  info: PreviewInfo,
  runner: Runner,
  o: { posterWidth: number; micro: boolean; budget: number; ffmpeg?: string | null; tmpRoot: string },
): Promise<VideoPreview> {
  const started = Date.now();
  let dir: string | undefined;
  let source = "none";
  let result: VideoPreview = {};
  try {
    dir = mkdtempSync(join(o.tmpRoot, "tiktok-preview-"));
    const plan: Plan = {
      path,
      dir,
      duration: info.duration_sec,
      // A 9:16 poster posterWidth wide fits a square this big; a 16:9 one gets the same size lying down.
      box: o.posterWidth > 0 ? Math.round((o.posterWidth * 16) / 9) : 0,
      micro: o.micro,
      timeoutMs: o.budget,
    };
    const bin = o.ffmpeg === undefined ? findFfmpeg() : o.ffmpeg ?? undefined;
    if (bin) {
      source = "ffmpeg";
      result = await viaFfmpeg(bin, plan, runner);
    }
    if (!result.poster && !result.micro) {
      source = bin ? "ffmpeg+qlmanage" : "qlmanage";
      result = await viaQuickLook(plan, runner);
    }
  } catch {
    result = {};
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* swept later with the other tiktok-* temp folders */
      }
    }
  }
  const frames = result.micro ? result.micro.split("~").length - 1 : 0;
  log(`preview ${source} poster=${result.poster ? 1 : 0} frames=${frames} ${Date.now() - started}ms`);
  return result;
}

// ---------------------------------------------------------------------------
// Photos: the carousel's stack (prepare_photo_post) and small thumbnails (find_recent_images)
// ---------------------------------------------------------------------------

export interface PhotoPreview {
  /** The photo stack string ("s2.6.0~…", src/microPreview.ts, ≤ 1,500 chars): the first ≤ 5 photos, for the confirmation card. */
  stack?: string;
  /** The same photos as 3:4 JPEG data URIs (centre-cropped, oriented, sRGB), in order, for the result cards. */
  thumbs?: string[];
}

export interface PhotoPreviewOptions {
  /** The post's photo count and cover index, written into the stack's header. */
  count?: number;
  cover?: number;
  /** Make the stack frames. Default true. */
  frames?: boolean;
  /** Thumbnail width in px (3:4, so 150 → 150 × 200); 0 = no thumbnails. Default 150. */
  thumbWidth?: number;
  /** How many photos, from the first (default 5; at most 35). The stack's frames take at most 5 of them. */
  max?: number;
  /** All thumbnails together, in data-URI characters: over it, they're encoded again at a lower quality. */
  thumbBudget?: number;
  /** Tall photos (slides, phone screenshots): 9:16 thumbnails instead of 3:4, so nothing is cropped away. */
  tall?: boolean;
  signal?: AbortSignal;
  tmpRoot?: string;
  /** Total time for the batch. Default 4 s. */
  budgetMs?: number;
}

export const PHOTO_PREVIEW_BUDGET_MS = 4_000;
/** Stack photos (the format's limit) and thumbnails (a candidates card shows six rows). */
export const PHOTO_STACK_MAX = 5;
const PHOTO_THUMBS_MAX = 35;
/** 150 × 200: a result card's stack card is ~92 × 123 CSS px. */
export const PHOTO_THUMB_WIDTH = 150;
/** One thumbnail as data-URI characters; a 150 × 200 JPEG at quality 60 is ~12-17K, 240 × 320 ~25-40K. */
const MAX_THUMB_URI = 48_000;
/** All of a stack's thumbnails together (the result card's own cap is 300,000 characters, markup included). */
export const PHOTO_THUMBS_BUDGET = 210_000;

/**
 * Thumbnail width for a carousel of n photos (3:4): 240 px for a few, smaller as the count grows, so every photo
 * fits the card's budget (~210K characters): 6 → 240, 11 → 178, 20 → 131, 35 → 99.
 */
export function stackThumbWidth(n: number): number {
  const k = Math.max(1, Math.floor(n || 1));
  return Math.max(96, Math.min(240, Math.round(240 * Math.sqrt(Math.min(1, 6 / k)))));
}
/** The frames' source: 96 × 128 (the stack's 48 × 64, area-averaged from twice the size); 90 × 160 for tall photos (45 × 80). */
const FRAME_SOURCE = { w: 96, h: 128 } as const;
const FRAME_SOURCE_TALL = { w: 90, h: 160 } as const;

/**
 * The `sips -j` canvas script for thumbnails (data: written to the temp folder and run by sips, never
 * evaluated here). Per input, in argument order: honour the EXIF orientation (as SIPS_ORIENT_JS does), cover
 * a w × h canvas (centre crop), flatten onto white, and write `<index>.jpg`. An undecodable input (0 × 0)
 * gets no output, so its index is missing and the caller gives up on the batch.
 */
export function photoThumbScript(w: number, h: number): string {
  const W = Math.max(8, Math.min(600, Math.round(w))), H = Math.max(8, Math.min(800, Math.round(h)));
  return String.raw`// tiktok thumbs: orient, centre-crop to ${W}x${H}, flatten onto white.
let index = 0;
for (const img of sips.images) {
  const k = index++;
  if (!img.size || !(img.size.width > 0 && img.size.height > 0)) continue;
  const o = Number((img.properties || {}).Orientation || 1);
  const w = img.size.width, h = img.size.height;
  const swap = o >= 5 && o <= 8;
  const ow = swap ? h : w, oh = swap ? w : h;
  const scale = Math.max(${W} / ow, ${H} / oh);
  const c = new Canvas(${W}, ${H});
  c.fillStyle = "white"; c.fillRect(0, 0, ${W}, ${H});
  c.save();
  c.translate((${W} - ow * scale) / 2, (${H} - oh * scale) / 2);
  c.scale(scale, scale);
  switch (o) {
    case 2: c.translate(ow, 0); c.scale(-1, 1); break;
    case 3: c.translate(ow, oh); c.rotate(Math.PI); break;
    case 4: c.translate(0, oh); c.scale(1, -1); break;
    case 5: c.rotate(Math.PI / 2); c.scale(1, -1); break;
    case 6: c.translate(ow, 0); c.rotate(Math.PI / 2); break;
    case 7: c.translate(ow, oh); c.rotate(-Math.PI / 2); c.scale(1, -1); break;
    case 8: c.translate(0, oh); c.rotate(-Math.PI / 2); break;
  }
  c.drawImage(img, 0, 0, w, h);
  c.restore();
  new Output(c, k + ".jpg").addToQueue();
}
`;
}

const photoCache = new Map<string, { at: number; value: PhotoPreview }>();
const photoInflight = new Map<string, Promise<PhotoPreview>>();

/** Tests: forget cached photo previews. */
export function clearPhotoPreviewCache(): void {
  photoCache.clear();
  photoInflight.clear();
}

const thumbUri = (file: string): string | undefined => {
  const b = readBytes(file);
  if (!b || !isJpeg(b)) return undefined;
  const uri = `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;
  return uri.length <= MAX_THUMB_URI ? uri : undefined;
};

/**
 * The carousel's stack and thumbnails, from the photos themselves (paths in carousel order). Three `sips`
 * passes over at most five photos: the canvas script (orient + 3:4 crop), sRGB at JPEG quality 60, and 96 × 128
 * BMPs for the frames. All or nothing per part: a stack or thumbnail set with a photo missing would show the
 * wrong order. Best effort and time-boxed (4 s), cached by path + size + mtime, never throws (returns {}).
 */
export async function photoPreview(paths: string[], runner: Runner, opts: PhotoPreviewOptions = {}): Promise<PhotoPreview> {
  const started = Date.now();
  try {
    if (opts.signal?.aborted) return {};
    const max = Math.max(1, Math.min(PHOTO_THUMBS_MAX, Math.floor(opts.max ?? PHOTO_STACK_MAX)));
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p).slice(0, max);
    if (!list.length) return {};
    const thumbWidth = Math.max(0, Math.min(600, Math.floor(opts.thumbWidth ?? PHOTO_THUMB_WIDTH)));
    const frames = opts.frames !== false;
    if (!thumbWidth && !frames) return {};
    const stamp = list.map((p) => {
      const st = statSync(p);
      return `${p}|${st.size}|${st.mtimeMs}`;
    });
    const key = `${stamp.join("\n")}|${thumbWidth}|${frames ? 1 : 0}|${opts.count ?? ""}|${opts.cover ?? ""}|${opts.thumbBudget ?? ""}|${opts.tall ? 1 : 0}`;
    const hit = photoCache.get(key);
    if (hit && Date.now() - hit.at <= CACHE_MS) return copyPhotos(hit.value);
    const pending = photoInflight.get(key);
    if (pending) return copyPhotos(await pending);
    const budget = Math.max(500, opts.budgetMs ?? PHOTO_PREVIEW_BUDGET_MS);
    const work = makePhotos(list, runner, { thumbWidth, frames, budget, count: opts.count, cover: opts.cover, thumbBudget: opts.thumbBudget, tall: opts.tall === true, tmpRoot: opts.tmpRoot ?? tmpdir() });
    photoInflight.set(key, work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<PhotoPreview>((resolve) => (timer = setTimeout(() => resolve({}), budget + 250)));
    const value = await Promise.race([work, late]).finally(() => clearTimeout(timer));
    work
      .then((v) => {
        if (v.stack || v.thumbs) {
          photoCache.set(key, { at: Date.now(), value: v });
          while (photoCache.size > CACHE_MAX) {
            const oldest = photoCache.keys().next().value;
            if (oldest === undefined) break;
            photoCache.delete(oldest);
          }
        }
      })
      .catch(() => {})
      .finally(() => photoInflight.delete(key));
    return copyPhotos(value);
  } catch {
    log(`photo preview error ${Date.now() - started}ms`);
    return {};
  }
}

const copyPhotos = (v: PhotoPreview): PhotoPreview => ({ ...(v.stack ? { stack: v.stack } : {}), ...(v.thumbs ? { thumbs: [...v.thumbs] } : {}) });

async function makePhotos(
  paths: string[],
  runner: Runner,
  o: { thumbWidth: number; frames: boolean; budget: number; count?: number; cover?: number; thumbBudget?: number; tall?: boolean; tmpRoot: string },
): Promise<PhotoPreview> {
  const started = Date.now();
  const left = () => Math.max(300, o.budget - (Date.now() - started));
  let dir: string | undefined;
  const out: PhotoPreview = {};
  try {
    dir = mkdtempSync(join(o.tmpRoot, "tiktok-preview-"));
    const [canvasDir, srgbDir, bmpDir] = ["c", "s", "b"].map((d) => join(dir as string, d));
    for (const d of [canvasDir, srgbDir, bmpDir]) mkdirSync(d, { mode: 0o700 });
    // The canvas is the thumbnail when there is one, else just big enough for the frames.
    const w = o.thumbWidth || FRAME_SOURCE.w;
    const script = join(dir, "thumbs.js");
    writeFileSync(script, photoThumbScript(w, Math.round((w * (o.tall ? 16 : 4)) / (o.tall ? 9 : 3))), { mode: 0o600 });
    await runner([SIPS, "-j", script, ...paths, "-o", canvasDir], { timeoutMs: left() });
    let jpgs = paths.map((_, i) => join(canvasDir, `${i}.jpg`));
    if (!jpgs.every((f) => isJpegFile(f))) return {};
    // The canvas writes the photos' own space (often Display P3): convert to sRGB, which is what the frames assume.
    await runner([SIPS, "--matchTo", SRGB_PROFILE, "-s", "formatOptions", "60", ...jpgs, "--out", srgbDir], { timeoutMs: left() });
    const srgb = paths.map((_, i) => join(srgbDir, `${i}.jpg`));
    if (srgb.every((f) => isJpegFile(f))) jpgs = srgb;
    if (o.thumbWidth) {
      let uris = jpgs.map(thumbUri);
      const total = () => uris.reduce((sum, u) => sum + (u?.length ?? 0), 0);
      // A long carousel over its budget: the same pixels once more at quality 40 (fast: they're small by now).
      if (o.thumbBudget && (total() > o.thumbBudget || !uris.every(Boolean))) {
        const lowDir = join(dir, "q");
        mkdirSync(lowDir, { mode: 0o700 });
        const canvas = paths.map((_, i) => join(canvasDir, `${i}.jpg`));
        await runner([SIPS, "--matchTo", SRGB_PROFILE, "-s", "formatOptions", "40", ...canvas, "--out", lowDir], { timeoutMs: left() });
        const low = paths.map((_, i) => thumbUri(join(lowDir, `${i}.jpg`)));
        if (low.every(Boolean)) uris = low;
      }
      if (uris.every((u): u is string => Boolean(u))) out.thumbs = uris;
    }
    if (o.frames) {
      const take = jpgs.slice(0, PHOTO_STACK_MAX);
      // Tall photos keep their 9:16 in the stack too (45 × 80 frames), so a slide's title isn't cropped away.
      const src = o.tall ? FRAME_SOURCE_TALL : FRAME_SOURCE;
      await runner([SIPS, "-s", "format", "bmp", "-z", String(src.h), String(src.w), ...take, "--out", bmpDir], { timeoutMs: left() });
      const frames = take.map((_, i) => {
        const b = readBytes(join(bmpDir, `${i}.bmp`));
        const px = b ? parseBmp(b) : undefined;
        if (!px) return undefined;
        try {
          return encodeStackFrame(px.rgb, px.w, px.h, o.tall === true) || undefined;
        } catch {
          return undefined;
        }
      });
      if (frames.every((f): f is string => Boolean(f))) {
        const stack = joinStack(frames, { count: o.count ?? paths.length, ...(o.cover !== undefined ? { cover: o.cover } : {}) });
        if (stack) out.stack = stack;
      }
    }
  } catch {
    return {};
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* swept later with the other tiktok-* temp folders */
      }
    }
    log(`photo preview photos=${paths.length} stack=${out.stack ? 1 : 0} thumbs=${out.thumbs?.length ?? 0} ${Date.now() - started}ms`);
  }
  return out;
}

function isJpegFile(file: string): boolean {
  const b = readBytes(file);
  return Boolean(b && isJpeg(b));
}
