/**
 * Micro previews: a few frames of a video, each packed into at most 100
 * base64url characters, so a picture of the video can travel as a plain tool
 * argument (`preview`) into the confirmation card. The card is a sandboxed
 * widget with no network that only sees its arguments; this is how it shows
 * "a little preview of the video you are about to upload".
 *
 * Format, version 1 (everything below is fixed: the card's decoder and the
 * server's encoder must agree bit for bit):
 *
 *   preview = "p1" [ "." seconds ] 1*3( "~" frame )      e.g. "p1.42~Ab3…~Qx9…~…"
 *
 * `seconds` is the video's whole-second duration (optional, 0–99999), shown
 * on the card's duration pill. Each `frame` is base64url (A–Z a–z 0–9 - _,
 * 6 bits per character, most significant bit first, zero padded) holding:
 *
 *   w-1 (6 bits) · h-1 (6) · q (5) · DC of Y (8), Co (7), Cg (7) · check (6)
 *   then AC coefficients as Exp-Golomb codes (order 0) of zigzag(value)
 *
 * Pixels are YCoCg in sRGB gamma (Y = (r+2g+b)/4, Co = (r-b)/2,
 * Cg = (2g-r-b)/4, all on 0–1). Each channel is a DCT-II of the w×h source
 * (F = mean of f·cos·cos; rebuilt as Σ c(u)c(v)·F·cos·cos with c(0)=1,
 * c(k>0)=2). The coefficients are sent in one fixed scan over all three
 * channels, ordered by spatial frequency (integer key u²h² + v²w², chroma
 * keys ×4 so luma gets twice the resolution of colour), keeping key ≤ w²h².
 * A coefficient's value is round(F / step) with
 * step = base(q)·(1 + 3·sqrt(key / w²h²)) and base(q) = 0.0008·2^(q/4):
 * finer at low frequencies, where errors show as blotches. The stream ends
 * where the bits do: trailing zero bits never complete a code, so every
 * coefficient after the last code is zero. The encoder rounds with a
 * dead zone (small values become 0, which costs 1 bit) and tries all 32
 * values of q, keeping the one whose truncated stream rebuilds the frame
 * best, judged on a lightly blurred comparison so false texture costs more
 * than softness (tuned by eye on Tiny AI Lab frames). `check` is a 6-bit
 * hash of the decoded fields, so a mangled frame decodes to nothing rather
 * than to noise.
 *
 * Frames are tiny on purpose (18×32 for portrait video, 32×18 landscape,
 * at most 40×40): the card upscales them smoothly and crossfades them, so
 * they read as soft, colour-accurate stills of the video.
 *
 * Photo stacks (the photo cards' iMessage-style stack) use the same frames
 * with a bigger budget, at most 140 characters each (encodePhotoFrame: a
 * centre crop to the card's 3:4, 24×32), up to five of them:
 *
 *   stack = "s1" [ "." count [ "." cover ] ] 1*5( "~" frame )   e.g. "s1.6.0~…~…~…~…~…"
 *
 * `count` is how many photos the post has (1–99; there may be more than the
 * frames, which are the first five in carousel order), `cover` the cover's
 * index from 0. A whole stack stays within 720 characters.
 *
 * Version 2 (what the server makes now; version 1 strings still decode):
 *
 *   preview = "p2" [ "." seconds ] 1*3( "~" frame )                 ≤ 1,091 characters
 *   stack   = "s2" [ "." count [ "." cover ] ] 1*5( "~" frame )    ≤ 1,488 characters
 *
 * The same envelope with twice the resolution and much better use of each
 * character: 45×80 video frames (80×45 landscape) within 360 characters, 48×64
 * photo frames within 295, coded with a wavelet and an arithmetic coder (see
 * "Version 2 frames" below for the exact format).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_SIDE = 40;
/** Video previews (v1): at most 100 characters a frame. */
const V1_VIDEO_FRAME_CHARS = 100;
/** Photo stacks: at most 140 characters a frame (and the decoder's hard limit). */
const MAX_FRAME_CHARS = 140;
const HEADER_BITS = 45;
const CHROMA_KEY = 4;
const SLOPE = 3;
const DEAD_ZONE = 0.4;
const ROOT2 = [1, 1.189207115002721, 1.4142135623730951, 1.681792830507429];

/** A whole preview string: version, optional duration, one to three frames. */
export const MICRO_PREVIEW_RE = /^p1(?:\.[0-9]{1,5})?(?:~[A-Za-z0-9_-]{8,100}){1,3}$/;
/** A whole photo stack: version, optional count (and cover index), one to five frames. */
export const PHOTO_STACK_RE = /^s1(?:\.[0-9]{1,2}(?:\.[0-9]{1,2})?)?(?:~[A-Za-z0-9_-]{8,140}){1,5}$/;
/** The photo stack's frame size: the card's 3:4. */
export const PHOTO_FRAME = { width: 24, height: 32 } as const;

function base(q: number): number {
  return 0.0008 * (1 << (q >> 2)) * ROOT2[q & 3];
}

interface Coef {
  ch: number;
  u: number;
  v: number;
  /** The step's frequency weight, 1 + 3·sqrt(key / w²h²). */
  s: number;
}

const scans = new Map<string, Coef[]>();

/** The fixed coefficient order for a w×h frame (integer keys, so every engine sorts it the same way). */
function scanOf(w: number, h: number): Coef[] {
  const id = `${w}x${h}`;
  const hit = scans.get(id);
  if (hit) return hit;
  const max = w * w * h * h;
  const list: Array<Coef & { key: number }> = [];
  for (let ch = 0; ch < 3; ch++) {
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        if (!u && !v) continue;
        const key = (u * u * h * h + v * v * w * w) * (ch ? CHROMA_KEY : 1);
        if (key <= max) list.push({ ch, u, v, key });
      }
    }
  }
  list.sort((a, b) => a.key - b.key || a.ch - b.ch || a.v - b.v || a.u - b.u);
  const scan = list.map(({ ch, u, v, key }) => ({ ch, u, v, s: 1 + SLOPE * Math.sqrt(key / max) }));
  scans.set(id, scan);
  return scan;
}

function cosTable(n: number, size: number, scale: number): Float64Array[] {
  const rows: Float64Array[] = [];
  for (let k = 0; k < n; k++) {
    const row = new Float64Array(size);
    for (let i = 0; i < size; i++) row[i] = Math.cos((Math.PI * k * ((i + 0.5) / scale)) / n);
    rows.push(row);
  }
  return rows;
}

function zigzag(x: number): number {
  return x > 0 ? 2 * x - 1 : -2 * x;
}

function unzigzag(n: number): number {
  return n & 1 ? (n + 1) / 2 : -n / 2;
}

function codeLength(n: number): number {
  let bits = 0;
  for (let m = n + 1; m > 1; m = Math.floor(m / 2)) bits++;
  return 2 * bits + 1;
}

function mix(h: number, x: number): number {
  return ((h ^ x) * 16777619) % 16777216;
}

function checkOf(fields: number[], values: number[]): number {
  let h = 2166136;
  for (const f of fields) h = mix(h, f);
  h = mix(h, values.length);
  for (const v of values) h = mix(h, zigzag(v));
  return (h ^ (h >>> 6) ^ (h >>> 12) ^ (h >>> 18)) & 63;
}

interface Parsed {
  w: number;
  h: number;
  q: number;
  dc: [number, number, number];
  values: number[];
}

/** Rebuild rgba at `scale`× the source size: the same arithmetic, in the same order, as MICRO_PREVIEW_DECODER_JS. */
function rebuild(p: Parsed, scale: number): { w: number; h: number; rgba: Uint8ClampedArray } {
  const W = p.w * scale, H = p.h * scale, n = W * H;
  const chans = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  chans[0].fill(p.dc[0] / 255);
  chans[1].fill(p.dc[1] / 127 - 0.5);
  chans[2].fill(p.dc[2] / 127 - 0.5);
  const cx = cosTable(p.w, W, scale), cy = cosTable(p.h, H, scale);
  const scan = scanOf(p.w, p.h), step = base(p.q);
  for (let i = 0; i < p.values.length; i++) {
    if (!p.values[i]) continue;
    const c = scan[i];
    const val = p.values[i] * step * c.s * (c.u ? 2 : 1) * (c.v ? 2 : 1);
    const out = chans[c.ch], rx = cx[c.u], ry = cy[c.v];
    for (let y = 0; y < H; y++) {
      const fy = ry[y] * val, row = y * W;
      for (let x = 0; x < W; x++) out[row + x] += rx[x] * fy;
    }
  }
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const Y = chans[0][i], co = chans[1][i], cg = chans[2][i], t = Y - cg;
    rgba[i * 4] = Math.round((t + co) * 255);
    rgba[i * 4 + 1] = Math.round((Y + cg) * 255);
    rgba[i * 4 + 2] = Math.round((t - co) * 255);
    rgba[i * 4 + 3] = 255;
  }
  return { w: W, h: H, rgba };
}

/** A 3×3 binomial blur of rgb (edges renormalised): the encoder's error is measured on this. */
function soften(px: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let j = 0; j < 3; j++) {
        let sum = 0, weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
            const k = (2 - Math.abs(dx)) * (2 - Math.abs(dy));
            sum += px[(yy * w + xx) * 3 + j] * k;
            weight += k;
          }
        }
        out[(y * w + x) * 3 + j] = sum / weight;
      }
    }
  }
  return out;
}

class Bits {
  private out = "";
  private acc = 0;
  private n = 0;
  length = 0;
  put(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | (Math.floor(value / 2 ** i) & 1);
      this.length++;
      if (++this.n === 6) {
        this.out += ALPHABET[this.acc];
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  code(n: number): void {
    const m = n + 1;
    let bits = 0;
    for (let t = m; t > 1; t = Math.floor(t / 2)) bits++;
    this.put(0, bits);
    this.put(m, bits + 1);
  }
  text(): string {
    return this.n ? this.out + ALPHABET[this.acc << (6 - this.n)] : this.out;
  }
}

/**
 * Encode one frame. `rgb` is rgb24, row-major, width×height×3 bytes (18×32
 * for portrait video, 32×18 landscape; each side 1–40). Returns base64url of
 * at most `maxChars` characters (default 100, the video budget; at most
 * 140, the photo budget). Deterministic: the same pixels always give the
 * same string.
 */
export function encodeMicroFrame(rgb: Uint8Array, width: number, height: number, maxChars = V1_VIDEO_FRAME_CHARS): string {
  const w = Math.floor(width), h = Math.floor(height);
  if (!(w >= 1 && w <= MAX_SIDE && h >= 1 && h <= MAX_SIDE)) throw new RangeError("A micro frame is 1-40 pixels on each side.");
  if (!rgb || rgb.length !== w * h * 3) throw new RangeError("A micro frame needs width*height*3 bytes of rgb24.");
  const budget = Math.max(8, Math.min(MAX_FRAME_CHARS, Math.floor(maxChars))) * 6;
  const n = w * h;
  const src = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255;
    src[0][i] = (r + 2 * g + b) / 4;
    src[1][i] = (r - b) / 2;
    src[2][i] = (2 * g - r - b) / 4;
  }
  const mean = src.map((c) => c.reduce((a, b) => a + b, 0) / n);
  const dc: [number, number, number] = [
    Math.max(0, Math.min(255, Math.round(mean[0] * 255))),
    Math.max(0, Math.min(127, Math.round((mean[1] + 0.5) * 127))),
    Math.max(0, Math.min(127, Math.round((mean[2] + 0.5) * 127))),
  ];
  const scan = scanOf(w, h);
  const cx = cosTable(w, w, 1), cy = cosTable(h, h, 1);
  const F = scan.map((c) => {
    let s = 0;
    const ch = src[c.ch], rx = cx[c.u], ry = cy[c.v];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s += ch[y * w + x] * rx[x] * ry[y];
    return s / n;
  });

  const target = soften(Float64Array.from(rgb), w, h);
  let best: { err: number; q: number; values: number[] } | undefined;
  for (let q = 0; q < 32; q++) {
    const step = base(q), values: number[] = [];
    let bits = HEADER_BITS, kept = 0;
    for (let i = 0; i < scan.length; i++) {
      const x = F[i] / (step * scan[i].s);
      const value = Math.sign(x) * Math.floor(Math.abs(x) + 0.5 - DEAD_ZONE) || 0;
      const len = codeLength(zigzag(value));
      if (bits + len > budget) break;
      bits += len;
      values.push(value);
      if (value) kept = values.length;
    }
    values.length = kept;
    const { rgba } = rebuild({ w, h, q, dc, values }, 1);
    const got = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) got[i * 3 + j] = rgba[i * 4 + j];
    const soft = soften(got, w, h);
    let err = 0;
    for (let i = 0; i < n * 3; i++) err += Math.abs(soft[i] - target[i]);
    if (!best || err < best.err) best = { err, q, values };
  }
  const { q, values } = best as { q: number; values: number[] };
  const out = new Bits();
  out.put(w - 1, 6);
  out.put(h - 1, 6);
  out.put(q, 5);
  out.put(dc[0], 8);
  out.put(dc[1], 7);
  out.put(dc[2], 7);
  out.put(checkOf([w - 1, h - 1, q, dc[0], dc[1], dc[2]], values), 6);
  for (const v of values) out.code(zigzag(v));
  return out.text();
}

/**
 * One photo for a stack: `rgb` is rgb24 of any size up to 1024×1024 (a small
 * render of the photo, e.g. from `sips`). It is centre-cropped to 3:4 (the
 * stack's cards are 3:4, drawn to cover), area-averaged down to 24×32 and
 * encoded with the photo budget (≤ 140 characters). Throws RangeError for a
 * bad size.
 */
export function encodePhotoFrame(rgb: Uint8Array, width: number, height: number): string {
  const w = Math.floor(width), h = Math.floor(height);
  if (!(w >= 1 && w <= 1024 && h >= 1 && h <= 1024)) throw new RangeError("A photo frame source is 1-1024 pixels on each side.");
  if (!rgb || rgb.length !== w * h * 3) throw new RangeError("A photo frame needs width*height*3 bytes of rgb24.");
  const { width: W, height: H } = PHOTO_FRAME;
  // The largest centred 3:4 window.
  const cw = Math.min(w, (h * W) / H), ch = Math.min(h, (w * H) / W);
  const x0 = (w - cw) / 2, y0 = (h - ch) / 2;
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const ya = y0 + (y * ch) / H, yb = y0 + ((y + 1) * ch) / H;
    for (let x = 0; x < W; x++) {
      const xa = x0 + (x * cw) / W, xb = x0 + ((x + 1) * cw) / W;
      const sum = [0, 0, 0];
      let area = 0;
      // Area average over the source pixels the target pixel covers (partial pixels weighted).
      for (let sy = Math.floor(ya); sy < Math.min(h, Math.ceil(yb)); sy++) {
        const fy = Math.min(yb, sy + 1) - Math.max(ya, sy);
        if (fy <= 0) continue;
        for (let sx = Math.floor(xa); sx < Math.min(w, Math.ceil(xb)); sx++) {
          const fx = Math.min(xb, sx + 1) - Math.max(xa, sx);
          if (fx <= 0) continue;
          const k = fx * fy, i = (sy * w + sx) * 3;
          sum[0] += rgb[i] * k;
          sum[1] += rgb[i + 1] * k;
          sum[2] += rgb[i + 2] * k;
          area += k;
        }
      }
      for (let j = 0; j < 3; j++) out[(y * W + x) * 3 + j] = Math.round(sum[j] / (area || 1));
    }
  }
  return encodeMicroFrame(out, W, H, MAX_FRAME_CHARS);
}

function parseFrame(frame: string): Parsed | null {
  if (typeof frame !== "string" || frame.length < 8 || frame.length > MAX_FRAME_CHARS || !/^[A-Za-z0-9_-]+$/.test(frame)) return null;
  const total = frame.length * 6;
  let pos = 0;
  const bit = () => {
    const c = ALPHABET.indexOf(frame[Math.floor(pos / 6)]);
    const b = (c >> (5 - (pos % 6))) & 1;
    pos++;
    return b;
  };
  const read = (bits: number) => {
    let v = 0;
    for (let i = 0; i < bits; i++) v = v * 2 + bit();
    return v;
  };
  const w = read(6) + 1, h = read(6) + 1, q = read(5);
  const dc: [number, number, number] = [read(8), read(7), read(7)];
  const check = read(6);
  if (w > MAX_SIDE || h > MAX_SIDE) return null;
  const scan = scanOf(w, h), values: number[] = [];
  while (pos < total && values.length < scan.length) {
    let zeros = 0;
    while (pos < total && bit() === 0) zeros++;
    // Out of bits before the code's 1 (the zero padding) or before its suffix: the stream is over.
    if (total - pos < zeros) break;
    const m = 2 ** zeros + read(zeros);
    values.push(unzigzag(m - 1));
  }
  while (values.length && !values[values.length - 1]) values.pop();
  if (checkOf([w - 1, h - 1, q, dc[0], dc[1], dc[2]], values) !== check) return null;
  return { w, h, q, dc, values };
}

/**
 * Decode one frame to rgba at `scale`× its stored size (1-8; the DCT basis is
 * continuous, so a larger scale is a smooth, band-limited upscale). Null for
 * anything that isn't a valid frame. The card runs MICRO_PREVIEW_DECODER_JS,
 * which gives the same bytes.
 */
export function decodeMicroFrame(frame: string, scale = 1): { w: number; h: number; rgba: Uint8ClampedArray } | null {
  const p = parseFrame(frame);
  if (!p) return null;
  const s = Math.max(1, Math.min(8, Math.floor(scale) || 1));
  return rebuild(p, s);
}

/** Up to three frames (and optionally the duration in seconds) as one preview string, or "" when nothing is valid. */
export function joinMicroPreview(frames: string[], meta: { durationSec?: number } = {}): string {
  const ok = (frames ?? []).filter((f) => typeof f === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(f)).slice(0, 3);
  if (!ok.length) return "";
  const d = meta.durationSec;
  const seconds = typeof d === "number" && Number.isFinite(d) && d >= 0 ? `.${Math.min(99_999, Math.round(d))}` : "";
  return `p1${seconds}~${ok.join("~")}`;
}

/**
 * Up to five photo frames (the first five in carousel order) as one stack
 * string, with the post's photo count and the cover's index (from 0), or ""
 * when no frame is valid. The cover is kept only with a count.
 */
export function joinPhotoStack(frames: string[], meta: { count?: number; cover?: number } = {}): string {
  const ok = (frames ?? []).filter((f) => typeof f === "string" && /^[A-Za-z0-9_-]{8,140}$/.test(f)).slice(0, 5);
  if (!ok.length) return "";
  const whole = (n: unknown, min: number) => (typeof n === "number" && Number.isFinite(n) && n >= min ? Math.min(99, Math.floor(n)) : undefined);
  let count = whole(meta.count, 1);
  const cover = whole(meta.cover, 0);
  if (count === undefined && cover !== undefined) count = ok.length;
  if (count !== undefined && count < ok.length) count = ok.length;
  const head = count === undefined ? "s1" : cover === undefined || cover >= count ? `s1.${count}` : `s1.${count}.${cover}`;
  return `${head}~${ok.join("~")}`;
}

/** The parts of a photo stack string (s1 or s2: `version` is 2 for s2), or null when it doesn't match PHOTO_STACK_RE / STACK2_RE. */
export function splitPhotoStack(stack: unknown): { version?: 2; count?: number; cover?: number; frames: string[] } | null {
  if (typeof stack !== "string") return null;
  const v2 = STACK2_RE.test(stack);
  if (!v2 && !PHOTO_STACK_RE.test(stack)) return null;
  const [head, ...frames] = stack.split("~");
  const [, count, cover] = head.split(".");
  return {
    ...(v2 ? { version: 2 as const } : {}),
    ...(count !== undefined ? { count: Number(count) } : {}),
    ...(cover !== undefined ? { cover: Number(cover) } : {}),
    frames,
  };
}

/** The parts of a preview string (p1 or p2: `version` is 2 for p2), or null when it doesn't match MICRO_PREVIEW_RE / PREVIEW2_RE. */
export function splitMicroPreview(preview: unknown): { version?: 2; durationSec?: number; frames: string[] } | null {
  if (typeof preview !== "string") return null;
  const v2 = PREVIEW2_RE.test(preview);
  if (!v2 && !MICRO_PREVIEW_RE.test(preview)) return null;
  const [head, ...frames] = preview.split("~");
  const dot = head.indexOf(".");
  return { ...(v2 ? { version: 2 as const } : {}), ...(dot < 0 ? {} : { durationSec: Number(head.slice(dot + 1)) }), frames };
}

// ---------------------------------------------------------------------------
// Version 2 frames (p2 / s2): a wavelet image codec with arithmetic coding
// ---------------------------------------------------------------------------
//
//   frame = header(33 bits) · arithmetic-coded body, as base64url with trailing "A"s (zero bits) dropped
//   header = w-1 (7 bits) · h-1 (7) · q (7) · check (12)
//
// Pixels are YCoCg as in version 1, luma less a half (so mid grey is 0). Luma is coded at w×h, the two chroma
// planes at half size (ceil(w/2)×ceil(h/2), 2×2 means), so luma gets the bits. Each plane goes through a CDF 9/7
// lifting wavelet (symmetric edges, normalised so a uniform step is near MSE-optimal; up to 4 levels for luma, 3
// for chroma, fewer for tiny planes) and a dead-zone quantiser: value = sign·floor(|c| / (step·weight) + 0.25),
// rebuilt at sign·(|value| + 0.2)·step·weight, step = 0.004·2^(q/16). The weights make the finest details
// coarser (×1.6 at the finest level, ×1.25, ×1.05, then 1; diagonal bands ×1.15): softness reads better than
// texture noise once the card upscales the frame ~3×. The encoder picks the smallest step whose frame fits its
// character budget.
//
// The body codes, per plane (Y, Co, Cg): the coarsest band (LL) in raster order as residuals from a median
// predictor (zero flag, bypass sign, Exp-Golomb with context-coded prefix, order 4 for luma, 2 for chroma, +3 for
// the first value), then every detail band, coarsest level first (HL, LH, HH), raster order: a significance flag
// (context: plane class, level, the left/up/up-left/up-right neighbours, and the parent coefficient one level
// coarser), a bypass sign, then |v| > 1 and |v| > 2 flags and Exp-Golomb order 0 of the rest. Contexts are 12-bit
// probabilities (start 1/2, adapt by 1/16). The coder is a 30-bit binary arithmetic coder (integer arithmetic in
// doubles, exact in every engine); the decoder reads zero bits past the end, which is why trailing "A"s can go.
//
// `check` is a 12-bit hash of w, h, q and every coefficient: a frame mangled in copying decodes to nothing (1 in
// 4,096 slips through) rather than to noise. Frames are independent, so a broken one costs only itself.

const V2_MAX_SIDE = 128;
const V2_LEVELS_Y = 4;
const V2_LEVELS_C = 3;
const V2_FINE = [1.6, 1.25, 1.05, 1, 1, 1];
const V2_HH = 1.15;
const V2_DEAD = 0.25;
const V2_REC = 0.2;
const V2_SHIFT = 4;
const V2_HEADER_BITS = 33;
/** Video frames (p2): at most 360 characters each, so three and the header stay within 1,100. */
export const VIDEO_FRAME_CHARS = 360;
/** Photo stack frames (s2): at most 295 characters each, so five and the header stay within 1,500. */
export const STACK_FRAME_CHARS = 295;
/** The largest v2 frame the decoders take. */
export const MAX_FRAME2_CHARS = 1_000;
/** Video frames fit in this box (45×80 for 9:16, 80×45 for 16:9). */
export const VIDEO_FRAME_BOX = 80;
/** The stack's frame size: the card's 3:4. */
export const STACK_FRAME = { width: 48, height: 64 } as const;
/** A tall carousel's frame size (slides, phone screenshots): 9:16, like a video's. */
export const STACK_FRAME_TALL = { width: 45, height: 80 } as const;

/** A whole v2 preview: version, optional duration, one to three frames. */
export const PREVIEW2_RE = /^p2(?:\.[0-9]{1,5})?(?:~[A-Za-z0-9_-]{6,1000}){1,3}$/;
/** A whole v2 photo stack: version, optional count (and cover index), one to five frames. */
export const STACK2_RE = /^s2(?:\.[0-9]{1,2}(?:\.[0-9]{1,2})?)?(?:~[A-Za-z0-9_-]{6,1000}){1,5}$/;

const LIFT = [-1.586134342059924, -0.052980118572961, 0.882911075530934, 0.443506852043971];
/** Band gains: the low band of a constant and the high band of an alternating signal come out at √2. */
const LIFT_LOW = 1.1496043988602447, LIFT_HIGH = 0.8698644516247788;

const TOP = 1073741824, HALF = 536870912, QUARTER = 268435456;

class ArithEncoder {
  private low = 0;
  private high = TOP - 1;
  private pending = 0;
  readonly bits: number[] = [];
  private emit(b: number): void {
    this.bits.push(b);
    for (; this.pending > 0; this.pending--) this.bits.push(1 - b);
  }
  private code(b: number, p0: number): void {
    const mid = this.low + Math.floor(((this.high - this.low + 1) * p0) / 4096) - 1;
    if (b) this.low = mid + 1;
    else this.high = mid;
    for (;;) {
      if (this.high < HALF) this.emit(0);
      else if (this.low >= HALF) {
        this.emit(1);
        this.low -= HALF;
        this.high -= HALF;
      } else if (this.low >= QUARTER && this.high < HALF + QUARTER) {
        this.pending++;
        this.low -= QUARTER;
        this.high -= QUARTER;
      } else break;
      this.low *= 2;
      this.high = this.high * 2 + 1;
    }
  }
  bit(b: number, ctx: Int32Array, i: number): void {
    const p = ctx[i];
    this.code(b, p);
    ctx[i] = b ? p - (p >> V2_SHIFT) : p + ((4096 - p) >> V2_SHIFT);
  }
  bypass(b: number): void {
    this.code(b, 2048);
  }
  finish(): number[] {
    this.pending++;
    this.emit(this.low < QUARTER ? 0 : 1);
    return this.bits;
  }
}

class ArithDecoder {
  private low = 0;
  private high = TOP - 1;
  private value = 0;
  constructor(private readonly next: () => number) {
    for (let i = 0; i < 30; i++) this.value = this.value * 2 + next();
  }
  private code(p0: number): number {
    const mid = this.low + Math.floor(((this.high - this.low + 1) * p0) / 4096) - 1;
    let b = 0;
    if (this.value <= mid) this.high = mid;
    else {
      b = 1;
      this.low = mid + 1;
    }
    for (;;) {
      if (this.high < HALF) {
        /* both halves agree on a 0 */
      } else if (this.low >= HALF) {
        this.low -= HALF;
        this.high -= HALF;
        this.value -= HALF;
      } else if (this.low >= QUARTER && this.high < HALF + QUARTER) {
        this.low -= QUARTER;
        this.high -= QUARTER;
        this.value -= QUARTER;
      } else break;
      this.low *= 2;
      this.high = this.high * 2 + 1;
      this.value = this.value * 2 + this.next();
    }
    return b;
  }
  bit(ctx: Int32Array, i: number): number {
    const p = ctx[i];
    const b = this.code(p);
    ctx[i] = b ? p - (p >> V2_SHIFT) : p + ((4096 - p) >> V2_SHIFT);
    return b;
  }
  bypass(): number {
    return this.code(2048);
  }
}

/** One lifting pass over n samples of x (offset, stride), in place: forward leaves [low…, high…]. */
function lift(x: Float64Array, off: number, stride: number, n: number, s: Float64Array, d: Float64Array, inverse: boolean): void {
  if (n < 2) return;
  const ns = (n + 1) >> 1, nd = n >> 1;
  let i: number;
  const S = (k: number) => s[k < ns ? k : ns - 1];
  const D = (k: number) => d[k < 0 ? 0 : k < nd ? k : nd - 1];
  if (!inverse) {
    for (i = 0; i < ns; i++) s[i] = x[off + 2 * i * stride];
    for (i = 0; i < nd; i++) d[i] = x[off + (2 * i + 1) * stride];
    for (i = 0; i < nd; i++) d[i] += LIFT[0] * (s[i] + S(i + 1));
    for (i = 0; i < ns; i++) s[i] += LIFT[1] * (D(i - 1) + D(i));
    for (i = 0; i < nd; i++) d[i] += LIFT[2] * (s[i] + S(i + 1));
    for (i = 0; i < ns; i++) s[i] += LIFT[3] * (D(i - 1) + D(i));
    for (i = 0; i < ns; i++) x[off + i * stride] = s[i] * LIFT_LOW;
    for (i = 0; i < nd; i++) x[off + (ns + i) * stride] = d[i] * LIFT_HIGH;
  } else {
    for (i = 0; i < ns; i++) s[i] = x[off + i * stride] / LIFT_LOW;
    for (i = 0; i < nd; i++) d[i] = x[off + (ns + i) * stride] / LIFT_HIGH;
    for (i = 0; i < ns; i++) s[i] -= LIFT[3] * (D(i - 1) + D(i));
    for (i = 0; i < nd; i++) d[i] -= LIFT[2] * (s[i] + S(i + 1));
    for (i = 0; i < ns; i++) s[i] -= LIFT[1] * (D(i - 1) + D(i));
    for (i = 0; i < nd; i++) d[i] -= LIFT[0] * (s[i] + S(i + 1));
    for (i = 0; i < ns; i++) x[off + 2 * i * stride] = s[i];
    for (i = 0; i < nd; i++) x[off + (2 * i + 1) * stride] = d[i];
  }
}

function wavelet(x: Float64Array, w: number, h: number, levels: number, inverse: boolean): void {
  const s = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const sizes: Array<[number, number]> = [];
  let cw = w, ch = h;
  for (let l = 0; l < levels; l++) {
    sizes.push([cw, ch]);
    cw = (cw + 1) >> 1;
    ch = (ch + 1) >> 1;
  }
  if (!inverse) {
    for (const [a, b] of sizes) {
      for (let y = 0; y < b; y++) lift(x, y * w, 1, a, s, d, false);
      for (let c = 0; c < a; c++) lift(x, c, w, b, s, d, false);
    }
  } else {
    for (let l = levels - 1; l >= 0; l--) {
      const [a, b] = sizes[l];
      for (let c = 0; c < a; c++) lift(x, c, w, b, s, d, true);
      for (let y = 0; y < b; y++) lift(x, y * w, 1, a, s, d, true);
    }
  }
}

/** How many levels a w×h plane gets: up to `max`, keeping the coarsest band at least 2 on its short side. */
function levelsFor(w: number, h: number, max: number): number {
  let l = 0;
  while (l < max && Math.min(w, h) >> (l + 1) >= 2) l++;
  return l;
}

interface Band {
  x0: number;
  y0: number;
  bw: number;
  bh: number;
  /** 0 = the finest level. */
  level: number;
  /** 0 HL (right), 1 LH (below), 2 HH (diagonal). */
  o: number;
  /** The same orientation one level coarser (its parent), or px0 = -1 for the coarsest level. */
  px0: number;
  py0: number;
  pbw: number;
  pbh: number;
}

interface Layout {
  llw: number;
  llh: number;
  bands: Band[];
}

const layouts = new Map<string, Layout>();

/** The Mallat layout of a w×h plane after `levels` passes: the LL corner and the detail bands, coarsest first. */
function layoutOf(w: number, h: number, levels: number): Layout {
  const id = `${w}x${h}x${levels}`;
  const hit = layouts.get(id);
  if (hit) return hit;
  const sz: Array<[number, number]> = [[w, h]];
  for (let l = 0; l < levels; l++) sz.push([(sz[l][0] + 1) >> 1, (sz[l][1] + 1) >> 1]);
  const rects = (l: number): number[][] => {
    const [a, b] = sz[l], [la, lb] = sz[l + 1];
    return [
      [la, 0, a - la, lb],
      [0, lb, la, b - lb],
      [la, lb, a - la, b - lb],
    ];
  };
  const bands: Band[] = [];
  for (let l = levels - 1; l >= 0; l--) {
    const mine = rects(l), parent = l + 1 < levels ? rects(l + 1) : null;
    for (let o = 0; o < 3; o++) {
      const [x0, y0, bw, bh] = mine[o];
      const [px0, py0, pbw, pbh] = parent ? parent[o] : [-1, -1, 0, 0];
      bands.push({ x0, y0, bw, bh, level: l, o, px0, py0, pbw, pbh });
    }
  }
  const layout = { llw: sz[levels][0], llh: sz[levels][1], bands };
  layouts.set(id, layout);
  return layout;
}

/** Each coefficient's step weight (chroma's level 0 sits one level coarser than luma's). */
function weightsOf(w: number, h: number, levels: number, chroma: boolean): Float64Array {
  const out = new Float64Array(w * h).fill(1);
  for (const b of layoutOf(w, h, levels).bands) {
    const f = (V2_FINE[b.level + (chroma ? 1 : 0)] ?? 1) * (b.o === 2 ? V2_HH : 1);
    for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) out[(b.y0 + y) * w + b.x0 + x] = f;
  }
  return out;
}

const CTX_SIG = 0, CTX_GT1 = 96, CTX_GT2 = 132, CTX_EG = 144, CTX_LLZ = 176, CTX_LLP = 182, CTX_COUNT = 214;

function egPut(e: ArithEncoder, ctx: Int32Array, base: number, n: number, k: number): void {
  const m = Math.floor(n / 2 ** k) + 1;
  let bits = 0;
  for (let t = m; t > 1; t = Math.floor(t / 2)) bits++;
  for (let i = 0; i < bits; i++) e.bit(1, ctx, base + Math.min(i, 15));
  e.bit(0, ctx, base + Math.min(bits, 15));
  for (let i = bits - 1; i >= 0; i--) e.bypass(Math.floor(m / 2 ** i) & 1);
  for (let i = k - 1; i >= 0; i--) e.bypass(Math.floor(n / 2 ** i) & 1);
}

/** -1 when the prefix runs past 20 (only a broken frame does that). */
function egGet(d: ArithDecoder, ctx: Int32Array, base: number, k: number): number {
  let bits = 0;
  while (d.bit(ctx, base + Math.min(bits, 15))) if (++bits > 20) return -1;
  let m = 1;
  for (let i = 0; i < bits; i++) m = m * 2 + d.bypass();
  let n = m - 1;
  for (let i = 0; i < k; i++) n = n * 2 + d.bypass();
  return n;
}

function median(a: number, b: number, c: number): number {
  return c >= Math.max(a, b) ? Math.min(a, b) : c <= Math.min(a, b) ? Math.max(a, b) : a + b - c;
}

/** Code (e) or decode (d) one plane of quantised coefficients q. False when the data is broken. */
function planeCode(e: ArithEncoder | null, d: ArithDecoder | null, ctx: Int32Array, q: Int32Array, w: number, h: number, levels: number, cls: number): boolean {
  const { llw, llh, bands } = layoutOf(w, h, levels);
  const k = cls ? 2 : 4;
  for (let y = 0; y < llh; y++) {
    for (let x = 0; x < llw; x++) {
      const at = y * w + x;
      const a = x ? q[at - 1] : 0, b = y ? q[at - w] : 0;
      const pred = x && y ? median(a, b, q[at - w - 1]) : x ? a : y ? b : 0;
      const zc = CTX_LLZ + cls * 3 + (x || y ? 1 : 0), kk = x || y ? k : k + 3;
      if (e) {
        const r = q[at] - pred;
        e.bit(r ? 1 : 0, ctx, zc);
        if (r) {
          e.bypass(r < 0 ? 1 : 0);
          egPut(e, ctx, CTX_LLP + cls * 16, Math.abs(r) - 1, kk);
        }
      } else if (d) {
        let r = 0;
        if (d.bit(ctx, zc)) {
          const neg = d.bypass();
          const m = egGet(d, ctx, CTX_LLP + cls * 16, kk);
          if (m < 0) return false;
          r = neg ? -(m + 1) : m + 1;
        }
        q[at] = pred + r;
      }
    }
  }
  for (const B of bands) {
    const lv = Math.min(5, B.level), row = cls * 6 + lv;
    for (let y = 0; y < B.bh; y++) {
      for (let x = 0; x < B.bw; x++) {
        const at = (B.y0 + y) * w + B.x0 + x;
        const n = (x && q[at - 1] ? 2 : 0) + (y && q[at - w] ? 2 : 0) + (x && y && q[at - w - 1] ? 1 : 0) + (y && x + 1 < B.bw && q[at - w + 1] ? 1 : 0);
        const nb = n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : 3;
        const parent = B.px0 < 0 ? 1 : q[(B.py0 + Math.min(B.pbh - 1, y >> 1)) * w + B.px0 + Math.min(B.pbw - 1, x >> 1)] ? 1 : 0;
        const sc = CTX_SIG + row * 8 + nb * 2 + parent, mc = CTX_GT1 + row * 3 + Math.min(2, nb);
        if (e) {
          const v = q[at];
          e.bit(v ? 1 : 0, ctx, sc);
          if (!v) continue;
          e.bypass(v < 0 ? 1 : 0);
          const m = Math.abs(v);
          e.bit(m > 1 ? 1 : 0, ctx, mc);
          if (m < 2) continue;
          e.bit(m > 2 ? 1 : 0, ctx, CTX_GT2 + row);
          if (m > 2) egPut(e, ctx, CTX_EG + cls * 16, m - 3, 0);
        } else if (d) {
          let v = 0;
          if (d.bit(ctx, sc)) {
            const neg = d.bypass();
            let m = 1;
            if (d.bit(ctx, mc)) {
              m = 2;
              if (d.bit(ctx, CTX_GT2 + row)) {
                const r = egGet(d, ctx, CTX_EG + cls * 16, 0);
                if (r < 0) return false;
                m = 3 + r;
              }
            }
            v = neg ? -m : m;
          }
          q[at] = v;
        }
      }
    }
  }
  return true;
}

function check12(w: number, h: number, q: number, planes: Int32Array[]): number {
  let hsh = 2166136;
  const mix = (x: number) => {
    hsh = ((hsh ^ (x % 16777216)) * 16777619) % 16777216;
  };
  mix(w);
  mix(h);
  mix(q);
  for (const p of planes) {
    mix(p.length);
    for (let i = 0; i < p.length; i++) {
      if (!p[i]) continue;
      mix(i);
      mix(zigzag(p[i]));
    }
  }
  return (hsh ^ Math.floor(hsh / 4096)) % 4096;
}

const stepOf2 = (q: number) => 0.004 * Math.pow(2, q / 16);

interface Planes2 {
  w: number;
  h: number;
  cw: number;
  ch: number;
  ly: number;
  lc: number;
}

function planesOf(w: number, h: number): Planes2 {
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  return { w, h, cw, ch, ly: levelsFor(w, h, V2_LEVELS_Y), lc: levelsFor(cw, ch, V2_LEVELS_C) };
}

function quantise(c: Float64Array, wt: Float64Array, step: number): Int32Array {
  const out = new Int32Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const v = c[i] / (step * wt[i]);
    out[i] = (v < 0 ? -1 : 1) * Math.floor(Math.abs(v) + V2_DEAD);
  }
  return out;
}

function pack2(p: Planes2, q: number, planes: Int32Array[]): string {
  const e = new ArithEncoder(), ctx = new Int32Array(CTX_COUNT).fill(2048);
  planeCode(e, null, ctx, planes[0], p.w, p.h, p.ly, 0);
  planeCode(e, null, ctx, planes[1], p.cw, p.ch, p.lc, 1);
  planeCode(e, null, ctx, planes[2], p.cw, p.ch, p.lc, 1);
  const out = new Bits();
  out.put(p.w - 1, 7);
  out.put(p.h - 1, 7);
  out.put(q, 7);
  out.put(check12(p.w, p.h, q, planes), 12);
  const body = e.finish();
  for (const b of body) out.put(b, 1);
  return out.text().replace(/A+$/, "");
}

/**
 * Encode one version-2 frame (p2 / s2). `rgb` is rgb24, row-major, width×height×3 bytes, each side 2-128.
 * Returns base64url of at most `maxChars` characters (default VIDEO_FRAME_CHARS; 8-1,000): the finest quantiser
 * step that fits, or "" when even the coarsest doesn't. Deterministic: the same pixels and budget always give the same string.
 */
export function encodeFrame(rgb: Uint8Array, width: number, height: number, maxChars = VIDEO_FRAME_CHARS): string {
  const w = Math.floor(width), h = Math.floor(height);
  if (!(w >= 2 && w <= V2_MAX_SIDE && h >= 2 && h <= V2_MAX_SIDE)) throw new RangeError("A frame is 2-128 pixels on each side.");
  if (!rgb || rgb.length !== w * h * 3) throw new RangeError("A frame needs width*height*3 bytes of rgb24.");
  const budget = Math.max(8, Math.min(MAX_FRAME2_CHARS, Math.floor(maxChars)));
  const p = planesOf(w, h);
  const Y = new Float64Array(w * h), Co = new Float64Array(p.cw * p.ch), Cg = new Float64Array(p.cw * p.ch), n = new Float64Array(p.cw * p.ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
      const j = (y >> 1) * p.cw + (x >> 1);
      Y[y * w + x] = (r + 2 * g + b) / 4 - 0.5;
      Co[j] += (r - b) / 2;
      Cg[j] += (2 * g - r - b) / 4;
      n[j]++;
    }
  }
  for (let j = 0; j < n.length; j++) {
    Co[j] /= n[j];
    Cg[j] /= n[j];
  }
  wavelet(Y, w, h, p.ly, false);
  wavelet(Co, p.cw, p.ch, p.lc, false);
  wavelet(Cg, p.cw, p.ch, p.lc, false);
  const wy = weightsOf(w, h, p.ly, false), wc = weightsOf(p.cw, p.ch, p.lc, true);
  const tryQ = (q: number) => {
    const s = stepOf2(q);
    return pack2(p, q, [quantise(Y, wy, s), quantise(Co, wc, s), quantise(Cg, wc, s)]);
  };
  // Length falls as the step grows (not strictly): bisect for the finest fitting q, then look a little finer.
  let lo = 0, hi = 127, best = tryQ(127);
  if (best.length > budget) return "";
  while (lo < hi) {
    const mid = (lo + hi) >> 1, s = tryQ(mid);
    if (s.length <= budget) {
      hi = mid;
      best = s;
    } else lo = mid + 1;
  }
  for (let q = lo - 1; q >= Math.max(0, lo - 3); q--) {
    const s = tryQ(q);
    if (s.length <= budget) best = s;
  }
  return best;
}

/** A parsed v2 frame's planes, or null for anything that isn't one. */
function parseFrame2(frame: string): { p: Planes2; q: number; planes: Int32Array[] } | null {
  if (typeof frame !== "string" || frame.length < 6 || frame.length > MAX_FRAME2_CHARS || !/^[A-Za-z0-9_-]+$/.test(frame)) return null;
  const total = frame.length * 6;
  let pos = 0;
  const next = () => {
    if (pos >= total) {
      pos++;
      return 0;
    }
    const b = (ALPHABET.indexOf(frame[Math.floor(pos / 6)]) >> (5 - (pos % 6))) & 1;
    pos++;
    return b;
  };
  const read = (bits: number) => {
    let v = 0;
    for (let i = 0; i < bits; i++) v = v * 2 + next();
    return v;
  };
  const w = read(7) + 1, h = read(7) + 1, q = read(7), check = read(12);
  if (w < 2 || h < 2) return null;
  const p = planesOf(w, h);
  const d = new ArithDecoder(next), ctx = new Int32Array(CTX_COUNT).fill(2048);
  const planes = [new Int32Array(w * h), new Int32Array(p.cw * p.ch), new Int32Array(p.cw * p.ch)];
  if (!planeCode(null, d, ctx, planes[0], w, h, p.ly, 0)) return null;
  if (!planeCode(null, d, ctx, planes[1], p.cw, p.ch, p.lc, 1)) return null;
  if (!planeCode(null, d, ctx, planes[2], p.cw, p.ch, p.lc, 1)) return null;
  if (check12(w, h, q, planes) !== check) return null;
  return { p, q, planes };
}

/**
 * Decode one version-2 frame to rgba at its stored size (the card's canvas upscales it, smoothly). Null for
 * anything that isn't a valid frame. The card runs MICRO_PREVIEW_DECODER_JS (TKP.decode2), which gives the same
 * bytes.
 */
export function decodeFrame(frame: string): { w: number; h: number; rgba: Uint8ClampedArray } | null {
  const f = parseFrame2(frame);
  if (!f) return null;
  const { p, q } = f, step = stepOf2(q);
  const deq = (v: Int32Array, wt: Float64Array) => {
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) if (v[i]) out[i] = (v[i] + (v[i] > 0 ? V2_REC : -V2_REC)) * step * wt[i];
    return out;
  };
  const Y = deq(f.planes[0], weightsOf(p.w, p.h, p.ly, false));
  const wc = weightsOf(p.cw, p.ch, p.lc, true);
  const Co = deq(f.planes[1], wc), Cg = deq(f.planes[2], wc);
  wavelet(Y, p.w, p.h, p.ly, true);
  wavelet(Co, p.cw, p.ch, p.lc, true);
  wavelet(Cg, p.cw, p.ch, p.lc, true);
  const { w, h, cw, ch } = p, rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    // Chroma back to full size, bilinear between the 2×2 block centres.
    const fy = Math.min(ch - 1, Math.max(0, (y - 0.5) / 2)), y0 = Math.floor(fy), y1 = Math.min(ch - 1, y0 + 1), ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cw - 1, Math.max(0, (x - 0.5) / 2)), x0 = Math.floor(fx), x1 = Math.min(cw - 1, x0 + 1), ax = fx - x0;
      const a = y0 * cw + x0, b = y0 * cw + x1, c = y1 * cw + x0, dd = y1 * cw + x1;
      const co = (Co[a] * (1 - ax) + Co[b] * ax) * (1 - ay) + (Co[c] * (1 - ax) + Co[dd] * ax) * ay;
      const cg = (Cg[a] * (1 - ax) + Cg[b] * ax) * (1 - ay) + (Cg[c] * (1 - ax) + Cg[dd] * ax) * ay;
      const Yv = Y[y * w + x] + 0.5, t = Yv - cg, i = (y * w + x) * 4;
      rgba[i] = Math.round((t + co) * 255);
      rgba[i + 1] = Math.round((Yv + cg) * 255);
      rgba[i + 2] = Math.round((t - co) * 255);
      rgba[i + 3] = 255;
    }
  }
  return { w, h, rgba };
}

/** The same frame as the minted one, as the decoder sees it (trailing "A"s are zero bits either way). */
export function sameFrame(a: string, b: string): boolean {
  return typeof a === "string" && typeof b === "string" && a.replace(/A+$/, "") === b.replace(/A+$/, "");
}

/** Area-average rgb24 w×h into the largest centred window of the target's aspect, at W×H. */
function coverResample(rgb: Uint8Array, w: number, h: number, W: number, H: number): Uint8Array {
  const cw = Math.min(w, (h * W) / H), ch = Math.min(h, (w * H) / W);
  const x0 = (w - cw) / 2, y0 = (h - ch) / 2;
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const ya = y0 + (y * ch) / H, yb = y0 + ((y + 1) * ch) / H;
    for (let x = 0; x < W; x++) {
      const xa = x0 + (x * cw) / W, xb = x0 + ((x + 1) * cw) / W;
      let r = 0, g = 0, b = 0, area = 0;
      for (let sy = Math.floor(ya); sy < Math.min(h, Math.ceil(yb)); sy++) {
        const fy = Math.min(yb, sy + 1) - Math.max(ya, sy);
        if (fy <= 0) continue;
        for (let sx = Math.floor(xa); sx < Math.min(w, Math.ceil(xb)); sx++) {
          const fx = Math.min(xb, sx + 1) - Math.max(xa, sx);
          if (fx <= 0) continue;
          const k = fx * fy, i = (sy * w + sx) * 3;
          r += rgb[i] * k;
          g += rgb[i + 1] * k;
          b += rgb[i + 2] * k;
          area += k;
        }
      }
      const o = (y * W + x) * 3, a = area || 1;
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
    }
  }
  return out;
}

/**
 * One video frame for a p2 preview: `rgb` is rgb24 of any size up to 1024×1024 (ffmpeg's 45×80 for 9:16).
 * Larger than VIDEO_FRAME_BOX on its long side, it is area-averaged down to fit; then encoded within
 * VIDEO_FRAME_CHARS. Throws RangeError for a bad size.
 */
export function encodeVideoFrame(rgb: Uint8Array, width: number, height: number): string {
  const w = Math.floor(width), h = Math.floor(height);
  if (!(w >= 2 && w <= 1024 && h >= 2 && h <= 1024)) throw new RangeError("A video frame source is 2-1024 pixels on each side.");
  if (!rgb || rgb.length !== w * h * 3) throw new RangeError("A video frame needs width*height*3 bytes of rgb24.");
  const s = Math.min(1, VIDEO_FRAME_BOX / Math.max(w, h));
  if (s >= 1) return encodeFrame(rgb, w, h, VIDEO_FRAME_CHARS);
  const W = Math.max(2, Math.round(w * s)), H = Math.max(2, Math.round(h * s));
  return encodeFrame(coverResample(rgb, w, h, W, H), W, H, VIDEO_FRAME_CHARS);
}

/**
 * One photo for an s2 stack: `rgb` is rgb24 of any size up to 1024×1024 (a small render of the photo, e.g.
 * from `sips`). Centre-cropped to the stack's card shape and area-averaged to it: 48×64 (3:4), or 45×80 (9:16)
 * with `tall` (a carousel of slides or phone screenshots, shown whole), then encoded within STACK_FRAME_CHARS.
 * Throws RangeError for a bad size.
 */
export function encodeStackFrame(rgb: Uint8Array, width: number, height: number, tall = false): string {
  const w = Math.floor(width), h = Math.floor(height);
  if (!(w >= 1 && w <= 1024 && h >= 1 && h <= 1024)) throw new RangeError("A photo frame source is 1-1024 pixels on each side.");
  if (!rgb || rgb.length !== w * h * 3) throw new RangeError("A photo frame needs width*height*3 bytes of rgb24.");
  const { width: W, height: H } = tall ? STACK_FRAME_TALL : STACK_FRAME;
  return encodeFrame(coverResample(rgb, w, h, W, H), W, H, STACK_FRAME_CHARS);
}

const FRAME2 = /^[A-Za-z0-9_-]{6,1000}$/;

/** Up to three v2 frames (and optionally the duration in seconds) as one "p2" preview, or "" when none is valid. */
export function joinVideoPreview(frames: string[], meta: { durationSec?: number } = {}): string {
  const ok = (frames ?? []).filter((f) => typeof f === "string" && FRAME2.test(f)).slice(0, 3);
  if (!ok.length) return "";
  const d = meta.durationSec;
  const seconds = typeof d === "number" && Number.isFinite(d) && d >= 0 ? `.${Math.min(99_999, Math.round(d))}` : "";
  return `p2${seconds}~${ok.join("~")}`;
}

/** Up to five v2 photo frames as one "s2" stack, with the post's count and cover index (from 0); "" when none is valid. */
export function joinStack(frames: string[], meta: { count?: number; cover?: number } = {}): string {
  const ok = (frames ?? []).filter((f) => typeof f === "string" && FRAME2.test(f)).slice(0, 5);
  if (!ok.length) return "";
  const whole = (n: unknown, min: number) => (typeof n === "number" && Number.isFinite(n) && n >= min ? Math.min(99, Math.floor(n)) : undefined);
  let count = whole(meta.count, 1);
  const cover = whole(meta.cover, 0);
  if (count === undefined && cover !== undefined) count = ok.length;
  if (count !== undefined && count < ok.length) count = ok.length;
  const head = count === undefined ? "s2" : cover === undefined || cover >= count ? `s2.${count}` : `s2.${count}.${cover}`;
  return `${head}~${ok.join("~")}`;
}

/** Decode a frame of either version (`version` from the preview's prefix): v1 at `scale`×, v2 at its own size. */
export function decodeAnyFrame(frame: string, version: 1 | 2): { w: number; h: number; rgba: Uint8ClampedArray } | null {
  return version === 2 ? decodeFrame(frame) : decodeMicroFrame(frame);
}

/**
 * The card's decoder, plain ES5 (no arrows, let/const, classes, template
 * strings or regex backslashes), inlined into the confirmation widgets'
 * <script> by confirm-card/build.ts. Nothing here is compiled from a string:
 * it is ordinary script text in the page.
 *
 *   TKP.split(preview)        -> { seconds: number|null, frames: [string] } | null
 *   TKP.splitStack(stack)     -> { count: number|null, cover: number|null, frames: [string] } | null
 *   TKP.decode(frame, scale?) -> { w, h, rgba: Uint8ClampedArray } | null
 */
export const MICRO_PREVIEW_DECODER_JS = `var TKP = (function () {
  "use strict";
  var ALPHABET = "${ALPHABET}";
  var ROOT2 = [1, 1.189207115002721, 1.4142135623730951, 1.681792830507429];
  var PREVIEW = /^p1(?:[.][0-9]{1,5})?(?:~[A-Za-z0-9_-]{8,100}){1,3}$/;
  var STACK = /^s1(?:[.][0-9]{1,2}(?:[.][0-9]{1,2})?)?(?:~[A-Za-z0-9_-]{8,140}){1,5}$/;
  var FRAME = /^[A-Za-z0-9_-]{8,140}$/;
  var scans = {};

  function base(q) { return 0.0008 * (1 << (q >> 2)) * ROOT2[q & 3]; }

  function scanOf(w, h) {
    var id = w + "x" + h, max = w * w * h * h, list = [], ch, u, v, key;
    if (scans[id]) return scans[id];
    for (ch = 0; ch < 3; ch++) {
      for (v = 0; v < h; v++) {
        for (u = 0; u < w; u++) {
          if (!u && !v) continue;
          key = (u * u * h * h + v * v * w * w) * (ch ? 4 : 1);
          if (key <= max) list.push({ ch: ch, u: u, v: v, key: key, s: 1 + 3 * Math.sqrt(key / max) });
        }
      }
    }
    list.sort(function (a, b) { return a.key - b.key || a.ch - b.ch || a.v - b.v || a.u - b.u; });
    scans[id] = list;
    return list;
  }

  function cosTable(n, size, scale) {
    var rows = [], k, i, row;
    for (k = 0; k < n; k++) {
      row = new Float64Array(size);
      for (i = 0; i < size; i++) row[i] = Math.cos((Math.PI * k * ((i + 0.5) / scale)) / n);
      rows.push(row);
    }
    return rows;
  }

  function zigzag(x) { return x > 0 ? 2 * x - 1 : -2 * x; }
  function unzigzag(n) { return n & 1 ? (n + 1) / 2 : -n / 2; }
  function mix(h, x) { return ((h ^ x) * 16777619) % 16777216; }

  function parse(frame) {
    if (typeof frame !== "string" || !FRAME.test(frame)) return null;
    var total = frame.length * 6, pos = 0;
    function bit() {
      var c = ALPHABET.indexOf(frame.charAt(Math.floor(pos / 6)));
      var b = (c >> (5 - (pos % 6))) & 1;
      pos++;
      return b;
    }
    function read(bits) {
      var v = 0;
      for (var i = 0; i < bits; i++) v = v * 2 + bit();
      return v;
    }
    var w = read(6) + 1, h = read(6) + 1, q = read(5);
    var dc = [read(8), read(7), read(7)], check = read(6);
    if (w > 40 || h > 40) return null;
    var scan = scanOf(w, h), values = [], zeros, m, i, hsh;
    while (pos < total && values.length < scan.length) {
      zeros = 0;
      while (pos < total && bit() === 0) zeros++;
      if (total - pos < zeros) break;
      m = Math.pow(2, zeros) + read(zeros);
      values.push(unzigzag(m - 1));
    }
    while (values.length && !values[values.length - 1]) values.pop();
    hsh = 2166136;
    var fields = [w - 1, h - 1, q, dc[0], dc[1], dc[2]];
    for (i = 0; i < fields.length; i++) hsh = mix(hsh, fields[i]);
    hsh = mix(hsh, values.length);
    for (i = 0; i < values.length; i++) hsh = mix(hsh, zigzag(values[i]));
    if (((hsh ^ (hsh >>> 6) ^ (hsh >>> 12) ^ (hsh >>> 18)) & 63) !== check) return null;
    return { w: w, h: h, q: q, dc: dc, values: values };
  }

  function rebuild(p, scale) {
    var W = p.w * scale, H = p.h * scale, n = W * H, i, x, y;
    var chans = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    var d0 = p.dc[0] / 255, d1 = p.dc[1] / 127 - 0.5, d2 = p.dc[2] / 127 - 0.5;
    for (i = 0; i < n; i++) { chans[0][i] = d0; chans[1][i] = d1; chans[2][i] = d2; }
    var cx = cosTable(p.w, W, scale), cy = cosTable(p.h, H, scale);
    var scan = scanOf(p.w, p.h), step = base(p.q);
    for (i = 0; i < p.values.length; i++) {
      if (!p.values[i]) continue;
      var c = scan[i];
      var val = p.values[i] * step * c.s * (c.u ? 2 : 1) * (c.v ? 2 : 1);
      var out = chans[c.ch], rx = cx[c.u], ry = cy[c.v];
      for (y = 0; y < H; y++) {
        var fy = ry[y] * val, row = y * W;
        for (x = 0; x < W; x++) out[row + x] += rx[x] * fy;
      }
    }
    var rgba = new Uint8ClampedArray(n * 4);
    for (i = 0; i < n; i++) {
      var Y = chans[0][i], co = chans[1][i], cg = chans[2][i], t = Y - cg;
      rgba[i * 4] = Math.round((t + co) * 255);
      rgba[i * 4 + 1] = Math.round((Y + cg) * 255);
      rgba[i * 4 + 2] = Math.round((t - co) * 255);
      rgba[i * 4 + 3] = 255;
    }
    return { w: W, h: H, rgba: rgba };
  }

  function decode(frame, scale) {
    var p;
    try { p = parse(frame); } catch (e) { return null; }
    if (!p) return null;
    var s = Math.max(1, Math.min(8, Math.floor(scale) || 1));
    return rebuild(p, s);
  }

  // ---- Version 2 frames (p2 / s2): the same arithmetic as decodeFrame in src/microPreview.ts.
  var PREVIEW2 = /^p2(?:[.][0-9]{1,5})?(?:~[A-Za-z0-9_-]{6,1000}){1,3}$/;
  var STACK2 = /^s2(?:[.][0-9]{1,2}(?:[.][0-9]{1,2})?)?(?:~[A-Za-z0-9_-]{6,1000}){1,5}$/;
  var FRAME2 = /^[A-Za-z0-9_-]{6,1000}$/;
  var LIFT = [-1.586134342059924, -0.052980118572961, 0.882911075530934, 0.443506852043971];
  var LIFT_LOW = 1.1496043988602447, LIFT_HIGH = 0.8698644516247788;
  var FINE = [1.6, 1.25, 1.05, 1, 1, 1], HH = 1.15, REC = 0.2, SHIFT = 4;
  var TOP = 1073741824, HALF = 536870912, QUARTER = 268435456;
  var CTX_SIG = 0, CTX_GT1 = 96, CTX_GT2 = 132, CTX_EG = 144, CTX_LLZ = 176, CTX_LLP = 182, CTX_COUNT = 214;
  var layouts = {};

  function Arith(next) {
    this.low = 0;
    this.high = TOP - 1;
    this.value = 0;
    this.next = next;
    for (var i = 0; i < 30; i++) this.value = this.value * 2 + next();
  }
  Arith.prototype.code = function (p0) {
    var mid = this.low + Math.floor(((this.high - this.low + 1) * p0) / 4096) - 1, b = 0;
    if (this.value <= mid) this.high = mid;
    else { b = 1; this.low = mid + 1; }
    for (;;) {
      if (this.high < HALF) {
        // both halves agree on a 0
      } else if (this.low >= HALF) {
        this.low -= HALF; this.high -= HALF; this.value -= HALF;
      } else if (this.low >= QUARTER && this.high < HALF + QUARTER) {
        this.low -= QUARTER; this.high -= QUARTER; this.value -= QUARTER;
      } else break;
      this.low *= 2;
      this.high = this.high * 2 + 1;
      this.value = this.value * 2 + this.next();
    }
    return b;
  };
  Arith.prototype.bit = function (ctx, i) {
    var p = ctx[i], b = this.code(p);
    ctx[i] = b ? p - (p >> SHIFT) : p + ((4096 - p) >> SHIFT);
    return b;
  };
  Arith.prototype.bypass = function () { return this.code(2048); };

  function unlift(x, off, stride, n, s, d) {
    if (n < 2) return;
    var ns = (n + 1) >> 1, nd = n >> 1, i;
    function S(k) { return s[k < ns ? k : ns - 1]; }
    function D(k) { return d[k < 0 ? 0 : k < nd ? k : nd - 1]; }
    for (i = 0; i < ns; i++) s[i] = x[off + i * stride] / LIFT_LOW;
    for (i = 0; i < nd; i++) d[i] = x[off + (ns + i) * stride] / LIFT_HIGH;
    for (i = 0; i < ns; i++) s[i] -= LIFT[3] * (D(i - 1) + D(i));
    for (i = 0; i < nd; i++) d[i] -= LIFT[2] * (s[i] + S(i + 1));
    for (i = 0; i < ns; i++) s[i] -= LIFT[1] * (D(i - 1) + D(i));
    for (i = 0; i < nd; i++) d[i] -= LIFT[0] * (s[i] + S(i + 1));
    for (i = 0; i < ns; i++) x[off + 2 * i * stride] = s[i];
    for (i = 0; i < nd; i++) x[off + (2 * i + 1) * stride] = d[i];
  }

  function unwavelet(x, w, h, levels) {
    var s = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h)), sizes = [], cw = w, ch = h, l, c, y;
    for (l = 0; l < levels; l++) { sizes.push([cw, ch]); cw = (cw + 1) >> 1; ch = (ch + 1) >> 1; }
    for (l = levels - 1; l >= 0; l--) {
      for (c = 0; c < sizes[l][0]; c++) unlift(x, c, w, sizes[l][1], s, d);
      for (y = 0; y < sizes[l][1]; y++) unlift(x, y * w, 1, sizes[l][0], s, d);
    }
  }

  function levelsFor(w, h, max) {
    var l = 0;
    while (l < max && Math.min(w, h) >> (l + 1) >= 2) l++;
    return l;
  }

  function layoutOf(w, h, levels) {
    var id = w + "x" + h + "x" + levels, sz = [[w, h]], l, o, bands = [];
    if (layouts[id]) return layouts[id];
    for (l = 0; l < levels; l++) sz.push([(sz[l][0] + 1) >> 1, (sz[l][1] + 1) >> 1]);
    function rects(k) {
      var a = sz[k][0], b = sz[k][1], la = sz[k + 1][0], lb = sz[k + 1][1];
      return [[la, 0, a - la, lb], [0, lb, la, b - lb], [la, lb, a - la, b - lb]];
    }
    for (l = levels - 1; l >= 0; l--) {
      var mine = rects(l), parent = l + 1 < levels ? rects(l + 1) : null;
      for (o = 0; o < 3; o++) {
        var pr = parent ? parent[o] : [-1, -1, 0, 0];
        bands.push({ x0: mine[o][0], y0: mine[o][1], bw: mine[o][2], bh: mine[o][3], level: l, o: o, px0: pr[0], py0: pr[1], pbw: pr[2], pbh: pr[3] });
      }
    }
    layouts[id] = { llw: sz[levels][0], llh: sz[levels][1], bands: bands };
    return layouts[id];
  }

  function weightsOf(w, h, levels, chroma) {
    var out = new Float64Array(w * h), bands = layoutOf(w, h, levels).bands, i, b, f, x, y;
    for (i = 0; i < out.length; i++) out[i] = 1;
    for (i = 0; i < bands.length; i++) {
      b = bands[i];
      f = FINE[b.level + (chroma ? 1 : 0)];
      if (f === undefined) f = 1;
      f *= b.o === 2 ? HH : 1;
      for (y = 0; y < b.bh; y++) for (x = 0; x < b.bw; x++) out[(b.y0 + y) * w + b.x0 + x] = f;
    }
    return out;
  }

  function egGet(dec, ctx, base, k) {
    var bits = 0, m = 1, n, i;
    while (dec.bit(ctx, base + Math.min(bits, 15))) if (++bits > 20) return -1;
    for (i = 0; i < bits; i++) m = m * 2 + dec.bypass();
    n = m - 1;
    for (i = 0; i < k; i++) n = n * 2 + dec.bypass();
    return n;
  }

  function median(a, b, c) {
    return c >= Math.max(a, b) ? Math.min(a, b) : c <= Math.min(a, b) ? Math.max(a, b) : a + b - c;
  }

  function plane(dec, ctx, q, w, h, levels, cls) {
    var lay = layoutOf(w, h, levels), k = cls ? 2 : 4, x, y, at, a, b, pred, zc, kk, r, neg, m, bi, B, lv, row, n, nb, par, sc, mc, v;
    for (y = 0; y < lay.llh; y++) {
      for (x = 0; x < lay.llw; x++) {
        at = y * w + x;
        a = x ? q[at - 1] : 0;
        b = y ? q[at - w] : 0;
        pred = x && y ? median(a, b, q[at - w - 1]) : x ? a : y ? b : 0;
        zc = CTX_LLZ + cls * 3 + (x || y ? 1 : 0);
        kk = x || y ? k : k + 3;
        r = 0;
        if (dec.bit(ctx, zc)) {
          neg = dec.bypass();
          m = egGet(dec, ctx, CTX_LLP + cls * 16, kk);
          if (m < 0) return false;
          r = neg ? -(m + 1) : m + 1;
        }
        q[at] = pred + r;
      }
    }
    for (bi = 0; bi < lay.bands.length; bi++) {
      B = lay.bands[bi];
      lv = Math.min(5, B.level);
      row = cls * 6 + lv;
      for (y = 0; y < B.bh; y++) {
        for (x = 0; x < B.bw; x++) {
          at = (B.y0 + y) * w + B.x0 + x;
          n = (x && q[at - 1] ? 2 : 0) + (y && q[at - w] ? 2 : 0) + (x && y && q[at - w - 1] ? 1 : 0) + (y && x + 1 < B.bw && q[at - w + 1] ? 1 : 0);
          nb = n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : 3;
          par = B.px0 < 0 ? 1 : q[(B.py0 + Math.min(B.pbh - 1, y >> 1)) * w + B.px0 + Math.min(B.pbw - 1, x >> 1)] ? 1 : 0;
          sc = CTX_SIG + row * 8 + nb * 2 + par;
          mc = CTX_GT1 + row * 3 + Math.min(2, nb);
          v = 0;
          if (dec.bit(ctx, sc)) {
            neg = dec.bypass();
            m = 1;
            if (dec.bit(ctx, mc)) {
              m = 2;
              if (dec.bit(ctx, CTX_GT2 + row)) {
                r = egGet(dec, ctx, CTX_EG + cls * 16, 0);
                if (r < 0) return false;
                m = 3 + r;
              }
            }
            v = neg ? -m : m;
          }
          q[at] = v;
        }
      }
    }
    return true;
  }

  function check12(w, h, q, planes) {
    var hsh = 2166136, i, j, p;
    function mixIn(x) { hsh = ((hsh ^ (x % 16777216)) * 16777619) % 16777216; }
    mixIn(w);
    mixIn(h);
    mixIn(q);
    for (j = 0; j < planes.length; j++) {
      p = planes[j];
      mixIn(p.length);
      for (i = 0; i < p.length; i++) {
        if (!p[i]) continue;
        mixIn(i);
        mixIn(zigzag(p[i]));
      }
    }
    return (hsh ^ Math.floor(hsh / 4096)) % 4096;
  }

  function decode2(frame) {
    if (typeof frame !== "string" || !FRAME2.test(frame)) return null;
    var total = frame.length * 6, pos = 0;
    function next() {
      if (pos >= total) { pos++; return 0; }
      var b = (ALPHABET.indexOf(frame.charAt(Math.floor(pos / 6))) >> (5 - (pos % 6))) & 1;
      pos++;
      return b;
    }
    function read(bits) {
      var v = 0;
      for (var i = 0; i < bits; i++) v = v * 2 + next();
      return v;
    }
    var w = read(7) + 1, h = read(7) + 1, q = read(7), check = read(12);
    if (w < 2 || h < 2) return null;
    var cw = (w + 1) >> 1, ch = (h + 1) >> 1, ly = levelsFor(w, h, 4), lc = levelsFor(cw, ch, 3);
    var dec = new Arith(next), ctx = new Int32Array(CTX_COUNT), i, x, y;
    for (i = 0; i < CTX_COUNT; i++) ctx[i] = 2048;
    var planes = [new Int32Array(w * h), new Int32Array(cw * ch), new Int32Array(cw * ch)];
    if (!plane(dec, ctx, planes[0], w, h, ly, 0)) return null;
    if (!plane(dec, ctx, planes[1], cw, ch, lc, 1)) return null;
    if (!plane(dec, ctx, planes[2], cw, ch, lc, 1)) return null;
    if (check12(w, h, q, planes) !== check) return null;
    var step = 0.004 * Math.pow(2, q / 16);
    function deq(v, wt) {
      var out = new Float64Array(v.length);
      for (var k = 0; k < v.length; k++) if (v[k]) out[k] = (v[k] + (v[k] > 0 ? REC : -REC)) * step * wt[k];
      return out;
    }
    var Y = deq(planes[0], weightsOf(w, h, ly, false)), wc = weightsOf(cw, ch, lc, true);
    var Co = deq(planes[1], wc), Cg = deq(planes[2], wc);
    unwavelet(Y, w, h, ly);
    unwavelet(Co, cw, ch, lc);
    unwavelet(Cg, cw, ch, lc);
    var rgba = new Uint8ClampedArray(w * h * 4);
    for (y = 0; y < h; y++) {
      var fy = Math.min(ch - 1, Math.max(0, (y - 0.5) / 2)), y0 = Math.floor(fy), y1 = Math.min(ch - 1, y0 + 1), ay = fy - y0;
      for (x = 0; x < w; x++) {
        var fx = Math.min(cw - 1, Math.max(0, (x - 0.5) / 2)), x0 = Math.floor(fx), x1 = Math.min(cw - 1, x0 + 1), ax = fx - x0;
        var a = y0 * cw + x0, b = y0 * cw + x1, c = y1 * cw + x0, dd = y1 * cw + x1;
        var co = (Co[a] * (1 - ax) + Co[b] * ax) * (1 - ay) + (Co[c] * (1 - ax) + Co[dd] * ax) * ay;
        var cg = (Cg[a] * (1 - ax) + Cg[b] * ax) * (1 - ay) + (Cg[c] * (1 - ax) + Cg[dd] * ax) * ay;
        var Yv = Y[y * w + x] + 0.5, t = Yv - cg, o = (y * w + x) * 4;
        rgba[o] = Math.round((t + co) * 255);
        rgba[o + 1] = Math.round((Yv + cg) * 255);
        rgba[o + 2] = Math.round((t - co) * 255);
        rgba[o + 3] = 255;
      }
    }
    return { w: w, h: h, rgba: rgba };
  }

  function safe2(frame) {
    try { return decode2(frame); } catch (e) { return null; }
  }

  function split(preview) {
    if (typeof preview !== "string") return null;
    var v = PREVIEW2.test(preview) ? 2 : PREVIEW.test(preview) ? 1 : 0;
    if (!v) return null;
    var parts = preview.split("~"), head = parts.shift(), dot = head.indexOf(".");
    return { version: v, seconds: dot < 0 ? null : Number(head.slice(dot + 1)), frames: parts };
  }

  function splitStack(stack) {
    if (typeof stack !== "string") return null;
    var v = STACK2.test(stack) ? 2 : STACK.test(stack) ? 1 : 0;
    if (!v) return null;
    var parts = stack.split("~"), head = parts.shift().split(".");
    return { version: v, count: head.length > 1 ? Number(head[1]) : null, cover: head.length > 2 ? Number(head[2]) : null, frames: parts };
  }

  // A frame of either version at about display size: v1 rebuilt at scale (its DCT is a smooth upscale), v2 at its own size.
  function frame(f, version, scale) {
    return version === 2 ? safe2(f) : decode(f, scale);
  }

  return { decode: decode, decode2: safe2, frame: frame, split: split, splitStack: splitStack };
})();`;
