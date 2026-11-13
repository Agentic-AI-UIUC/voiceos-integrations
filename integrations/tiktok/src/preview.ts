/**
 * Real frames of a local video, for the cards (UI brief, contract 3):
 *  - `poster`: a sharp JPEG data URI (≤ 58,000 characters) for result cards (find_recent_videos, the completion
 *    card, "did it go up?"), twice the CSS size of the tile it lands in (the notch is a 2× display);
 *  - `micro`: the micro preview (src/microPreview.ts): three tiny frames at ~15 %, ~50 % and ~85 % of the
 *    video, which the confirmation card decodes and crossfades. It travels as the write tools' `preview`
 *    argument, so it has to be small and the same every time for the same file;
 *  - `motion`: the video playing, a seamless 3 s loop (videoMotion).
 *
 * Frame source: ffmpeg when it's installed (Homebrew paths, then PATH; ffmpeg.exe on PATH or from winget, Scoop
 * or Chocolatey on Windows): one fast seek per frame, the poster from the middle frame, micro frames as PPM
 * (rgb24 with a size header) fitted into 80 × 80 (45 × 80 for a 9:16 video, 80 × 45 for 16:9). Without ffmpeg,
 * macOS's `qlmanage -t` thumbnail (one frame) and `sips` for the poster's resize and the micro frame's BMP
 * pixels: a poster and a one-frame micro preview (on Windows without ffmpeg: nothing, quietly).
 *
 * Best effort and time-boxed (2.5 s by default), cached by path + size + mtime, never throws (returns {}).
 * Temp files live in $TMPDIR/tiktok-preview-* and are removed. Logs carry the source, counts and a
 * duration, never a path or name.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { LOOP_TILES, MAX_MOTION_CHARS, galleryCell } from "./cards.ts";
import { SIPS, SRGB_PROFILE } from "./images.ts";
import { VIDEO_FRAME_BOX, encodeStackFrame, encodeVideoFrame, joinStack, joinVideoPreview } from "./microPreview.ts";
import { log } from "./proc.ts";
import type { Runner } from "./types.ts";

export interface VideoPreview {
  /** data:image/jpeg;base64,…, ≤ MAX_POSTER_URI characters. */
  poster?: string;
  /** The micro preview string ("p2~…", src/microPreview.ts), ≤ 1,100 chars. */
  micro?: string;
  /** A short moving loop of the video for the result cards (asked for with `motion: true`). */
  motion?: VideoMotion;
}

/**
 * The video playing, cropped to the card's 9:16 (16:9 for landscape) at twice the CSS size of the tile it plays in:
 * an animated AVIF (3 s at 24 fps, its end cross-faded into its start so the restart doesn't jump) when ffmpeg has
 * the SVT-AV1 encoder; else an animated WebP (1.5 s at 12 fps) when img2webp is installed; else a JPEG filmstrip
 * (`frames` frames side by side, 8 fps) that the card plays with CSS steps(). One data URI, ≤ MAX_MOTION_URI
 * characters (a gallery cell's: its share of the card).
 */
export interface VideoMotion {
  src: string;
  /** Filmstrips only: how many frames side by side, and their rate. */
  frames?: number;
  fps?: number;
  /** Filmstrips only: the smeared border on each side of each frame, as a fraction of the frame's width (src/cards.ts). */
  edge?: number;
}

export interface PreviewInfo {
  duration_sec?: number;
  width?: number;
  height?: number;
}

export interface PreviewOptions {
  /** Poster width for a 9:16 video (a 16:9 one gets the same pixel count lying down). Default 160; 0 = no poster. */
  posterWidth?: number;
  /** Poster width for a landscape video that plays bigger than a portrait one would (the posting-as card's across tile). */
  posterWide?: number;
  /** A "small" loop's gallery: how many cells it has (2-6), so the loop is twice the cell's size and its share of the card. Default 2. */
  cells?: number;
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
/**
 * One poster as data-URI characters (~43 KB of JPEG): under a card's per-image cap (64,000) and the posting-as
 * card's picture budget (60,000), so even the 716 × 402 across-the-card poster fits. A 216 × 384 one is ~20-30K.
 */
export const MAX_POSTER_URI = 58_000;
/**
 * The poster at ffmpeg's -q:v 3 (lower is better), and two copies of the same frame made beside it (one decode, tiny
 * encodes) in case a busy frame is over the cap: coarser, then also smaller (a 716-wide 10-bit phone frame can be
 * 140K characters at -q:v 3 and 83K at 8). The first one under the cap wins.
 */
const POSTER_RUNGS = [
  { name: "poster.jpg", q: 3, scale: 1 },
  { name: "poster-safe.jpg", q: 8, scale: 1 },
  { name: "poster-small.jpg", q: 6, scale: 0.6 },
] as const;
const CACHE_MAX = 48;
const CACHE_MS = 30 * 60_000;

type Env = Record<string, string | undefined>;
const FFMPEG_PATHS = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
let foundFfmpeg: string | null | undefined;

/** PATH's absolute directories (Windows spells it Path; quotes around an entry are allowed). */
function pathDirs(env: Env): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const raw = env.PATH ?? (key ? env[key] : undefined) ?? "";
  return raw.split(delimiter).map((d) => d.trim().replace(/^"|"$/g, "")).filter((d) => d && isAbsolute(d));
}

/** The first of these that is a file. */
function firstFile(paths: string[]): string | undefined {
  return paths.find((p) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Where Windows package managers put a tool when VoiceOS's PATH predates the install: winget's links, Scoop's shims, Chocolatey's bin. */
function windowsToolPaths(exe: string, env: Env): string[] {
  const at = (base: string | undefined, ...parts: string[]) => (base ? [join(base, ...parts, exe)] : []);
  return [
    ...at(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
    ...at(env.USERPROFILE, "scoop", "shims"),
    ...at(env.ProgramData ?? env.PROGRAMDATA, "chocolatey", "bin"),
  ];
}

/**
 * ffmpeg on this computer, looked up once. On a Mac: Homebrew's paths first (VoiceOS's PATH has neither), then PATH.
 * On Windows: ffmpeg.exe on PATH, then where winget, Scoop and Chocolatey put it. None is fine: posters only, no loop.
 */
export function findFfmpeg(env: Env = process.env, platform: string = process.platform): string | undefined {
  if (foundFfmpeg !== undefined) return foundFfmpeg ?? undefined;
  const win = platform === "win32";
  const exe = win ? "ffmpeg.exe" : "ffmpeg";
  const hit = firstFile([...(win ? [] : FFMPEG_PATHS), ...pathDirs(env).map((d) => join(d, exe)), ...(win ? windowsToolPaths(exe, env) : [])]);
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
  const scalePoster = (box: number) => `scale=${box}:${box}:force_original_aspect_ratio=decrease:flags=lanczos`;
  const runs = times.map(async (t, i) => {
    const posters = p.box > 0 && i === middle ? POSTER_RUNGS.map((r) => ({ ...r, file: join(p.dir, r.name) })) : [];
    const micro = p.micro ? join(p.dir, `m${i}.ppm`) : undefined;
    if (!posters.length && !micro) return { poster: undefined, micro: undefined };
    const cmd = [bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", `file:${p.path}`];
    for (const r of posters) {
      cmd.push("-map", "0:v:0", "-frames:v", "1", "-vf", scalePoster(Math.max(16, Math.round(p.box * r.scale))), "-q:v", String(r.q), "-f", "image2", "-c:v", "mjpeg", "-y", r.file);
    }
    if (micro) cmd.push("-map", "0:v:0", "-frames:v", "1", "-vf", scaleMicro, "-pix_fmt", "rgb24", "-f", "image2", "-c:v", "ppm", "-y", micro);
    await runner(cmd, { timeoutMs: p.timeoutMs });
    // A failed run leaves no file (or a partial one, which the parsers refuse).
    return {
      poster: posters.reduce<string | undefined>((got, r) => got ?? posterUri(r.file), undefined),
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
    const target = fit(dims.w, dims.h, p.box);
    const resize = target.w < dims.w ? ["--resampleWidth", String(target.w)] : [];
    // Quality 82, or 62 for a busy frame over the cap.
    const encode = async (q: number) => {
      const out = join(p.dir, `poster-${q}.jpg`);
      await runner(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(q), ...resize, src, "--out", out], { timeoutMs: left() });
      return posterUri(out);
    };
    jobs.push(encode(82).then(async (poster) => ({ poster: poster ?? (await encode(62)) })));
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
    // A landscape video's own poster width, when asked for (else its long side is the 9:16 poster's height).
    const posterWide = posterWidth > 0 && isWideInfo(info) && opts.posterWide ? Math.max(0, Math.min(1_280, Math.floor(opts.posterWide))) : 0;
    const micro = opts.micro !== false;
    // The loop runs beside the frames, on its own cache and budget.
    const moving = opts.motion
      ? videoMotion(path, info, runner, {
          ffmpeg: opts.ffmpeg, img2webp: opts.img2webp, tmpRoot: opts.tmpRoot, signal: opts.signal, small: opts.motion === "small", ...(opts.cells !== undefined ? { cells: opts.cells } : {}),
        })
      : Promise.resolve(undefined);
    if (!posterWidth && !micro) {
      const motion = await moving;
      return motion ? { motion } : {};
    }
    const withMotion = async (v: VideoPreview): Promise<VideoPreview> => {
      const motion = await moving;
      return motion ? { ...v, motion } : { ...v };
    };
    const key = `${path}|${st.size}|${st.mtimeMs}|${posterWidth}|${posterWide}|${micro ? 1 : 0}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at <= CACHE_MS) return withMotion(hit.value);
    const pending = inflight.get(key);
    if (pending) return withMotion(await pending);
    const budget = Math.max(300, opts.budgetMs ?? PREVIEW_BUDGET_MS);
    const work = make(path, info, runner, { posterWidth, posterWide, micro, budget, ffmpeg: opts.ffmpeg, tmpRoot: opts.tmpRoot ?? tmpdir() });
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
/** One loop as data-URI characters (src/cards.ts MAX_MOTION_CHARS): ~94 KB, so a card with a loop and its posters stays under VoiceOS's cap. */
export const MAX_MOTION_URI = MAX_MOTION_CHARS;

/** How a loop runs: `seconds` long at `fps`, its last `fade` seconds cross-faded into its first (so the restart doesn't jump). */
export interface LoopShape {
  seconds: number;
  fade: number;
  fps: number;
}
/** AVIF: 3 s at 24 fps (72 frames). */
export const AVIF_LOOP: LoopShape = { seconds: 3, fade: 0.4, fps: 24 };
/** WebP, without an AV1 encoder: 1.5 s at 12 fps. Lossy WebP needs about three times AVIF's bytes for the same frames. */
export const WEBP_LOOP: LoopShape = { seconds: 1.5, fade: 0.25, fps: 12 };
/** The filmstrip, with neither: 2 s at 8 fps of 144 × 256 frames (a JPEG strip can't afford twice the tile). */
export const STRIP_LOOP: LoopShape = { seconds: 2, fade: 0.3, fps: 8 };
/** AV1 quality (SVT-AV1's CRF): start here, and rather than go past MAX_CRF, make the frames smaller. */
const START_CRF = 36;
/** At these sizes a higher CRF looks better than fewer pixels scaled up (checked side by side on a real clip), so the ceiling is high. */
const MAX_CRF = 54;
/** A loop's size halves about every this many CRF steps (10-18 measured on real clips: the low side, so a guess rarely overshoots). */
const CRF_HALVING = 12;
const WEBP_QUALITY = [45, 28, 14, 6];
const STRIP_QUALITY = [9, 13, 18];
/** Each filmstrip frame's smeared border, px per side (src/cards.ts shows only what's inside it). */
const STRIP_BLEED = 2;
const IMG2WEBP_PATHS = ["/opt/homebrew/bin/img2webp", "/usr/local/bin/img2webp"];
let foundImg2webp: string | null | undefined;

/** img2webp (Homebrew's webp tools) on this computer, looked up once. */
export function findImg2webp(env: Env = process.env, platform: string = process.platform): string | undefined {
  if (foundImg2webp !== undefined) return foundImg2webp ?? undefined;
  const win = platform === "win32";
  const exe = win ? "img2webp.exe" : "img2webp";
  const hit = firstFile([...(win ? [] : IMG2WEBP_PATHS), ...pathDirs(env).map((d) => join(d, exe)), ...(win ? windowsToolPaths(exe, env) : [])]);
  foundImg2webp = hit ?? null;
  return hit;
}

const motionCache = new Map<string, { at: number; value: VideoMotion }>();
const motionInflight = new Map<string, Promise<VideoMotion | undefined>>();
const avifProbe = new Map<string, Promise<boolean>>();

/** Tests: forget cached loops, the img2webp lookup and what each ffmpeg can encode. */
export function clearMotionCache(): void {
  motionCache.clear();
  motionInflight.clear();
  avifProbe.clear();
  foundImg2webp = undefined;
}

/**
 * Whether this ffmpeg writes animated AVIF: the SVT-AV1 encoder and the avif muxer (ffmpeg 6+). Asked once per
 * binary; an answer that didn't come (a timeout, a crash) is asked again next time. Never throws.
 */
export function ffmpegAvif(bin: string, runner: Runner): Promise<boolean> {
  const known = avifProbe.get(bin);
  if (known) return known;
  const forget = () => {
    avifProbe.delete(bin);
    return false;
  };
  const asked = Promise.all([runner([bin, "-hide_banner", "-encoders"], { timeoutMs: 3_000 }), runner([bin, "-hide_banner", "-muxers"], { timeoutMs: 3_000 })]).then(
    ([enc, mux]) => {
      if (enc.code !== 0 || mux.code !== 0 || !enc.stdout || !mux.stdout) return forget();
      return /^\s*V\S*\s+libsvtav1\b/m.test(enc.stdout) && /^\s*D?E\S*\s+avif\b/m.test(mux.stdout);
    },
    forget,
  );
  avifProbe.set(bin, asked);
  return asked;
}

const sec = (x: number) => Math.round(x * 1000) / 1000;
const isWideInfo = (info: PreviewInfo) => typeof info.width === "number" && typeof info.height === "number" && info.width > info.height * 1.08;

/**
 * Where the loop starts and how it runs: a fifth of the way in (past the intro), `seconds` plus the cross-fade of
 * the video. A shorter video gives what it has (a 0.25 s fade, none under a second); an unknown length, no fade.
 */
export function motionWindow(duration?: number, shape: LoopShape = AVIF_LOOP): { start: number; seconds: number; fade: number } {
  const d = typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : undefined;
  if (d === undefined) return { start: 0, seconds: shape.seconds, fade: 0 };
  const span = Math.min(shape.seconds + shape.fade, Math.max(0.1, d - 0.1));
  const fade = span >= shape.seconds + shape.fade ? shape.fade : span >= 1 ? Math.min(shape.fade, 0.25) : 0;
  const start = Math.max(0, Math.min(d * 0.2, d - span - 0.1));
  return { start: sec(start), seconds: sec(span - fade), fade: sec(fade) };
}

/**
 * The loop's filtergraph: the window at `fps`, scaled to cover w × h and centre-cropped, then (with a fade) its
 * last `fade` seconds cross-faded into its first, so the last frame leads straight back into the first. `then`
 * runs on the result (the filmstrip's tiling). Output label [v].
 */
export function loopGraph(w: number, h: number, fps: number, win: { seconds: number; fade: number }, o: { format?: string; then?: string } = {}): string {
  const base = `[0:v:0]fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}${o.format ? `,format=${o.format}` : ""}`;
  const then = o.then ? `,${o.then}` : "";
  if (!(win.fade > 0)) return `${base},trim=duration=${win.seconds}${then}[v]`;
  return (
    `${base},split[a][b];[a]trim=${win.fade}:${sec(win.seconds + win.fade)},setpts=PTS-STARTPTS[x];[b]trim=0:${win.fade},setpts=PTS-STARTPTS[y];` +
    `[x][y]xfade=transition=fade:duration=${win.fade}:offset=${sec(win.seconds - win.fade)}${then}[v]`
  );
}

type Size = [number, number];

/**
 * The loop's sizes in device px, twice the CSS size of the biggest tile it plays in (the notch is a 2× display;
 * src/cards.ts LOOP_TILES and galleryCell): AVIF's ladder (biggest first), WebP's, the filmstrip's, and its cap.
 *  - portrait: the hero tile, 216 × 384, then 162 × 288;
 *  - landscape: the posting-as card's across tile, 716 × 402, then 538 × 302, then the hero lying down, 384 × 216;
 *  - a gallery cell (`cells` given): twice the cell (224 × 398 for two cells, 138 × 246 for six), then 1.5 times;
 *    its cap is its share of the card's pictures, and no filmstrip (it needs a box of its own exact shape).
 */
export function loopPlan(wide: boolean, cells?: number): { avif: Size[]; webp: Size; strip?: Size; cap: number } {
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  const shape = (w: number): Size => (wide ? [even(w), even((w * 9) / 16)] : [even(w), even((w * 16) / 9)]);
  if (cells !== undefined) {
    const cell = galleryCell(cells, !wide);
    return { avif: [shape(2 * cell.w), shape(1.5 * cell.w)], webp: shape(2 * cell.w), cap: Math.min(MAX_MOTION_URI, cell.chars) };
  }
  const { hero, across } = LOOP_TILES;
  return wide
    ? { avif: [shape(2 * across.w), shape(1.5 * across.w), shape(2 * hero.h)], webp: shape(2 * hero.h), strip: [256, 144], cap: MAX_MOTION_URI }
    : { avif: [shape(2 * hero.w), shape(1.5 * hero.w)], webp: shape(2 * hero.w), strip: [144, 256], cap: MAX_MOTION_URI };
}

/**
 * After an AVIF of `sizes[i]` at `crf` came out `chars` long (over `cap`): the next try. The biggest size predicted
 * to fit by MAX_CRF, at its predicted CRF (a loop's size halves every ~CRF_HALVING steps and grows with pixels^0.9);
 * failing that, the smallest at MAX_CRF once. Undefined when that was already tried.
 */
export function nextRung(sizes: Size[], i: number, crf: number, chars: number, cap: number): { i: number; crf: number } | undefined {
  const px = (s: Size) => s[0] * s[1];
  for (let j = i; j < sizes.length; j++) {
    const scaled = chars * (px(sizes[j]) / px(sizes[i])) ** 0.9;
    const need = crf + Math.ceil(CRF_HALVING * Math.log2(scaled / cap)) + 1;
    const next = j === i ? Math.max(need, crf + 3) : Math.max(START_CRF, need);
    if (next <= MAX_CRF) return { i: j, crf: next };
  }
  const last = sizes.length - 1;
  return i < last || crf < MAX_CRF ? { i: last, crf: MAX_CRF } : undefined;
}

/** An ISO-BMFF file whose major brand is AVIF's (avis: an image sequence; avif: a still). */
export const isAvif = (b: Uint8Array) =>
  b.length > 16 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && (b[11] === 0x73 || b[11] === 0x66);
const isWebp = (b: Uint8Array) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
const dataUri = (b: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(b).toString("base64")}`;
/** A data URI's length for b bytes of mime, without building it. */
const uriLength = (bytes: number, mime: string) => `data:${mime};base64,`.length + Math.ceil(bytes / 3) * 4;

/**
 * The video's moving loop. Best effort and time-boxed (5 s), cached by path + size + mtime (a second card for the
 * same file costs nothing; calls in flight share the work), never throws: undefined when there's no ffmpeg or
 * nothing came out in time. `small` makes a gallery cell's loop (for a gallery of `cells`, default 2).
 */
export async function videoMotion(
  path: string,
  info: PreviewInfo,
  runner: Runner,
  opts: { ffmpeg?: string | null; img2webp?: string | null; tmpRoot?: string; budgetMs?: number; signal?: AbortSignal; small?: boolean; cells?: number } = {},
): Promise<VideoMotion | undefined> {
  const started = Date.now();
  try {
    if (opts.signal?.aborted) return undefined;
    const st = statSync(path);
    const cells = opts.small === true ? Math.max(2, Math.min(6, Math.floor(opts.cells ?? 2) || 2)) : undefined;
    const key = `${path}|${st.size}|${st.mtimeMs}|${cells ? `s${cells}` : "l"}`;
    const hit = motionCache.get(key);
    if (hit && Date.now() - hit.at <= CACHE_MS) return { ...hit.value };
    const budget = Math.max(500, opts.budgetMs ?? MOTION_BUDGET_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = () => new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), budget + 250)));
    // A second card for the same video while the first is still making it: the same work, within this call's budget.
    const pending = motionInflight.get(key);
    if (pending) {
      const v = await Promise.race([pending, late()]).finally(() => clearTimeout(timer));
      return v ? { ...v } : undefined;
    }
    const bin = opts.ffmpeg === undefined ? findFfmpeg() : opts.ffmpeg ?? undefined;
    if (!bin) return undefined;
    const webp = opts.img2webp === undefined ? findImg2webp() : opts.img2webp ?? undefined;
    const work = makeMotion(path, info, runner, { bin, webp, budget, cells, tmpRoot: opts.tmpRoot ?? tmpdir() });
    motionInflight.set(key, work);
    const value = await Promise.race([work, late()]).finally(() => clearTimeout(timer));
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
  o: { bin: string; webp?: string; budget: number; cells?: number; tmpRoot: string },
): Promise<VideoMotion | undefined> {
  const started = Date.now();
  const remaining = () => o.budget - (Date.now() - started);
  const left = () => Math.max(300, remaining());
  let dir: string | undefined;
  let out: VideoMotion | undefined;
  let how = "none";
  let tries = 0;
  try {
    dir = mkdtempSync(join(o.tmpRoot, "tiktok-preview-"));
    const plan = loopPlan(isWideInfo(info), o.cells);
    // -t takes a little more than the window, so the trims never come up a frame short.
    const head = (win: { start: number; seconds: number; fade: number }) => [
      o.bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(win.start), "-t", String(sec(win.seconds + win.fade + 0.15)), "-i", `file:${path}`, "-an",
    ];
    // 1. Animated AVIF (SVT-AV1): twice the tile at 24 fps, quality stepped down (then size) until it fits the cap.
    let avifRan = false;
    if (await ffmpegAvif(o.bin, runner)) {
      const win = motionWindow(info.duration_sec, AVIF_LOOP);
      let rung: { i: number; crf: number } | undefined = { i: 0, crf: START_CRF };
      let lastMs = 0;
      let lastPx = 0;
      while (rung && tries < 6) {
        const [w, h] = plan.avif[rung.i];
        // Time for one more? (The last try's time, scaled by pixels; the first one always goes.)
        if (lastMs && remaining() < (lastMs * (w * h)) / lastPx + 200) break;
        const file = join(dir, `l${tries}.avif`);
        const t0 = Date.now();
        tries++;
        const r = await runner(
          [...head(win), "-filter_complex", loopGraph(w, h, AVIF_LOOP.fps, win, { format: "yuv420p" }), "-map", "[v]",
            "-c:v", "libsvtav1", "-preset", w * h <= 100_000 ? "6" : "8", "-crf", String(rung.crf), "-g", "999", "-f", "avif", "-loop", "0", "-y", file],
          { timeoutMs: left() },
        );
        [lastMs, lastPx] = [Math.max(1, Date.now() - t0), w * h];
        // Nothing usable (no AV1 after all, this video won't decode, or out of time: a killed run's file is partial). WebP next.
        const b = r.code === 0 && !r.timedOut ? readBytes(file) : undefined;
        if (!b || !isAvif(b)) break;
        avifRan = true;
        const chars = uriLength(b.length, "image/avif");
        if (chars <= plan.cap) {
          out = { src: dataUri(b, "image/avif") };
          how = `avif ${w}x${h} crf${rung.crf}`;
          break;
        }
        rung = nextRung(plan.avif, rung.i, rung.crf, chars, plan.cap);
      }
    }
    // 2. Animated WebP (img2webp), only when AV1 couldn't run: a clip AVIF can't fit won't fit as WebP either.
    if (!out && !avifRan && o.webp && remaining() > 600) {
      const win = motionWindow(info.duration_sec, WEBP_LOOP);
      const [w, h] = plan.webp;
      tries++;
      const r = await runner([...head(win), "-filter_complex", loopGraph(w, h, WEBP_LOOP.fps, win), "-map", "[v]", "-f", "image2", "-c:v", "ppm", join(dir, "f%03d.ppm")], { timeoutMs: left() });
      const frames = readdirSync(dir).filter((f) => /^f\d+\.ppm$/.test(f)).sort().map((f) => join(dir as string, f));
      if (r.code === 0 && !r.timedOut && frames.length >= 2) {
        for (const q of WEBP_QUALITY) {
          if (remaining() < 250) break;
          const file = join(dir, `m${q}.webp`);
          tries++;
          const done = await runner([o.webp, "-loop", "0", "-lossy", "-q", String(q), "-m", "4", "-d", String(Math.round(1000 / WEBP_LOOP.fps)), ...frames, "-o", file], { timeoutMs: left() });
          const b = done.code === 0 && !done.timedOut ? readBytes(file) : undefined;
          if (b && isWebp(b) && uriLength(b.length, "image/webp") <= plan.cap) {
            out = { src: dataUri(b, "image/webp") };
            how = `webp ${w}x${h} q${q}`;
            break;
          }
        }
      }
    }
    // 3. A JPEG filmstrip (hero tiles only), played by the card with CSS steps(). Each frame gets a smeared border, so
    // a step that lands between device pixels shows more of the same frame, never a sliver of the next.
    if (!out && plan.strip && remaining() > 400) {
      const win = motionWindow(info.duration_sec, STRIP_LOOP);
      const [w, h] = plan.strip;
      const n = Math.max(2, Math.min(30, Math.floor(win.seconds * STRIP_LOOP.fps + 1e-6)));
      const tail = `pad=${w + 2 * STRIP_BLEED}:${h}:${STRIP_BLEED}:0,fillborders=left=${STRIP_BLEED}:right=${STRIP_BLEED}:mode=smear,tile=${n}x1`;
      for (const q of STRIP_QUALITY) {
        if (remaining() < 250) break;
        const file = join(dir, `s${q}.jpg`);
        tries++;
        const r = await runner(
          [...head(win), "-filter_complex", loopGraph(w, h, STRIP_LOOP.fps, win, { then: tail }), "-map", "[v]", "-frames:v", "1", "-q:v", String(q), "-f", "image2", "-c:v", "mjpeg", "-y", file],
          { timeoutMs: left() },
        );
        const b = r.code === 0 && !r.timedOut ? readBytes(file) : undefined;
        if (!b || !isJpeg(b)) break;
        if (uriLength(b.length, "image/jpeg") <= plan.cap) {
          out = { src: dataUri(b, "image/jpeg"), frames: n, fps: STRIP_LOOP.fps, edge: Math.round((STRIP_BLEED / w) * 1e6) / 1e6 };
          how = `strip ${w}x${h} q${q}`;
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
    log(`motion ${how} chars=${out ? out.src.length : 0} tries=${tries} ${Date.now() - started}ms`);
  }
  return out;
}

async function make(
  path: string,
  info: PreviewInfo,
  runner: Runner,
  o: { posterWidth: number; posterWide: number; micro: boolean; budget: number; ffmpeg?: string | null; tmpRoot: string },
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
      // A 9:16 poster posterWidth wide fits a square this big; a 16:9 one gets the same size lying down, or its own width.
      box: o.posterWidth > 0 ? o.posterWide || Math.round((o.posterWidth * 16) / 9) : 0,
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
/**
 * The default thumbnail width (150 × 200). The tools pass their own, twice the CSS width of the card that shows it:
 * stackThumbWidth for a carousel's stack (its biggest card, the posting-as card's, is 108 × 144), and 96 for the
 * photo candidates' 36 × 48 tiles.
 */
export const PHOTO_THUMB_WIDTH = 150;
/** One thumbnail as data-URI characters; a 150 × 200 JPEG at quality 72 is ~15-20K, 240 × 320 ~30-45K. */
const MAX_THUMB_URI = 48_000;
/** Thumbnails' JPEG quality (sips' formatOptions), then the steps down for a carousel over its budget. */
const PHOTO_QUALITY = [72, 56, 40] as const;
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
 * passes over at most five photos: the canvas script (orient + 3:4 crop), sRGB at JPEG quality 72 (56, then 40, for a carousel over its budget), and 96 × 128
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
    await runner([SIPS, "--matchTo", SRGB_PROFILE, "-s", "formatOptions", String(PHOTO_QUALITY[0]), ...jpgs, "--out", srgbDir], { timeoutMs: left() });
    const srgb = paths.map((_, i) => join(srgbDir, `${i}.jpg`));
    if (srgb.every((f) => isJpegFile(f))) jpgs = srgb;
    if (o.thumbWidth) {
      let uris = jpgs.map(thumbUri);
      const total = () => uris.reduce((sum, u) => sum + (u?.length ?? 0), 0);
      // A long carousel over its budget: the same pixels again at the next quality down (fast: they're small by now).
      for (const q of PHOTO_QUALITY.slice(1)) {
        if (!(o.thumbBudget && (total() > o.thumbBudget || !uris.every(Boolean)))) break;
        const lowDir = join(dir, `q${q}`);
        mkdirSync(lowDir, { mode: 0o700 });
        const canvas = paths.map((_, i) => join(canvasDir, `${i}.jpg`));
        await runner([SIPS, "--matchTo", SRGB_PROFILE, "-s", "formatOptions", String(q), ...canvas, "--out", lowDir], { timeoutMs: left() });
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
