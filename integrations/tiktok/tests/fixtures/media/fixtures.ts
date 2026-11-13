/**
 * Generated media fixtures for tests (agent C). Nothing here shells out, so
 * every helper works on ubuntu CI:
 *  - ISO-BMFF box builders for synthetic MP4/MOV files (ftyp, moov, mvhd, trak, tkhd, hdlr, mdat…);
 *  - a minimal PNG encoder;
 *  - `fakeRunner`, a stand-in for `/usr/bin/osascript` (date added), `/usr/bin/defaults`
 *    (screenshot folder) and `/usr/bin/sips -g` that answers like the real tools;
 *  - `put`, which writes a file and sets its mtime.
 *
 * The four `ffmpeg-*.mp4|mov` files next to this one are real ffmpeg 9.0.1 output
 * (testsrc 32×18): see tests/media.test.ts for what ffprobe reported for each.
 * Other suites (tools, verify) may import these helpers.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { RunOptions, RunResult, Runner } from "../../../src/types.ts";

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u8 = (...v: number[]) => Uint8Array.from(v);
export function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}
export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
export function i32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return b;
}
export function u64(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const zeros = (n: number) => new Uint8Array(n);

// ---------------------------------------------------------------------------
// ISO-BMFF boxes
// ---------------------------------------------------------------------------

/** A box with a 32-bit size. */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
}

/** A box with size = 1 and a 64-bit largesize. `declaredSize` overrides the largesize (for sparse/huge boxes). */
export function box64(type: string, payload: Uint8Array = zeros(0), declaredSize?: number): Uint8Array {
  return concat(u32(1), ascii(type), u64(declaredSize ?? 16 + payload.length), payload);
}

/** A box with size = 0: "extends to the end of the file". */
export function boxToEof(type: string, ...payload: Uint8Array[]): Uint8Array {
  return concat(u32(0), ascii(type), concat(...payload));
}

export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payload);
}

export function ftyp(major = "isom", compatible: string[] = ["isom", "iso2", "avc1", "mp41"]): Uint8Array {
  return box("ftyp", ascii(major), u32(0x200), ...compatible.map(ascii));
}

const UNITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
/** The tkhd/mvhd display matrix for a clockwise rotation, as Apple and ffmpeg write it (16.16 a b c d, 2.30 w). */
export function matrix(rotation: 0 | 90 | 180 | 270 = 0): Uint8Array {
  const m =
    rotation === 90
      ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]
      : rotation === 180
        ? [-0x10000, 0, 0, 0, -0x10000, 0, 0, 0, 0x40000000]
        : rotation === 270
          ? [0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000]
          : UNITY;
  return concat(...m.map(i32));
}

/** Movie header. v0: 32-bit times and duration; v1: 64-bit. */
export function mvhd(version: 0 | 1, timescale: number, duration: number | bigint): Uint8Array {
  const times = version === 1 ? concat(u64(0), u64(0), u32(timescale), u64(duration)) : concat(u32(0), u32(0), u32(timescale), u32(Number(duration)));
  return fullBox("mvhd", version, 0, times, u32(0x10000), u16(0x100), zeros(10), matrix(0), zeros(24), u32(3));
}

export interface TkhdOptions {
  version?: 0 | 1;
  width: number;
  height: number;
  rotation?: 0 | 90 | 180 | 270;
  trackId?: number;
}
/** Track header; width/height are written as 16.16 fixed point. */
export function tkhd(o: TkhdOptions): Uint8Array {
  const id = o.trackId ?? 1;
  const head = o.version === 1 ? concat(u64(0), u64(0), u32(id), u32(0), u64(0)) : concat(u32(0), u32(0), u32(id), u32(0), u32(0));
  return fullBox("tkhd", o.version ?? 0, 3, head, zeros(8), u16(0), u16(0), u16(0), u16(0), matrix(o.rotation ?? 0), u32(o.width * 0x10000), u32(o.height * 0x10000));
}

export function hdlr(handler: string, name = "Handler"): Uint8Array {
  return fullBox("hdlr", 0, 0, u32(0), ascii(handler.padEnd(4).slice(0, 4)), zeros(12), ascii(`${name}\0`));
}

export function mdhd(timescale = 1000, duration = 0): Uint8Array {
  return fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
}

/** trak → tkhd + mdia(mdhd, hdlr). */
export function trak(tkhdBox: Uint8Array, handler = "vide"): Uint8Array {
  return box("trak", tkhdBox, box("mdia", mdhd(), hdlr(handler)));
}

export function mehd(version: 0 | 1, fragmentDuration: number): Uint8Array {
  return fullBox("mehd", version, 0, version === 1 ? u64(fragmentDuration) : u32(fragmentDuration));
}

export function moov(...children: Uint8Array[]): Uint8Array {
  return box("moov", ...children);
}

export function mdat(bytes: number): Uint8Array {
  return box("mdat", new Uint8Array(bytes).fill(0x5a));
}

export interface Mp4Options {
  /** Major brand; null writes no ftyp at all (classic QuickTime). Default "isom". */
  brand?: string | null;
  timescale?: number;
  /** Seconds. Default 6. */
  seconds?: number;
  mvhdVersion?: 0 | 1;
  width?: number;
  height?: number;
  rotation?: 0 | 90 | 180 | 270;
  /** Put moov after mdat (the default for many encoders). */
  moovLast?: boolean;
  /** Bytes of fake media data. Default 256. */
  mdatBytes?: number;
  /** Add a 0×0 audio track. Default true. */
  audio?: boolean;
}

/** A small, structurally valid MP4/MOV: ftyp, moov(mvhd, video trak, audio trak), mdat. */
export function mp4(o: Mp4Options = {}): Uint8Array {
  const ts = o.timescale ?? 600;
  const seconds = o.seconds ?? 6;
  const tracks = [trak(tkhd({ width: o.width ?? 1080, height: o.height ?? 1920, rotation: o.rotation }), "vide")];
  if (o.audio !== false) tracks.push(trak(tkhd({ width: 0, height: 0, trackId: 2 }), "soun"));
  const m = moov(mvhd(o.mvhdVersion ?? 0, ts, Math.round(seconds * ts)), ...tracks);
  const data = mdat(o.mdatBytes ?? 256);
  const head = o.brand === null ? box("wide") : ftyp(o.brand ?? "isom");
  return o.moovLast ? concat(head, data, m) : concat(head, m, data);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const td = concat(ascii(type), data);
  return concat(u32(data.length), td, u32(crc32(td)));
}

/** A solid-colour PNG (RGB, or RGBA at 50% alpha). */
export function pngBytes(width: number, height: number, alpha = false, rgb: [number, number, number] = [254, 44, 85]): Uint8Array {
  const bpp = alpha ? 4 : 3;
  const raw = new Uint8Array((width * bpp + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * bpp + 1);
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * bpp;
      raw.set(rgb, o);
      if (alpha) raw[o + 3] = 128;
    }
  }
  const ihdr = concat(u32(width), u32(height), u8(8, alpha ? 6 : 2, 0, 0, 0));
  return concat(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", zeros(0)));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Write `bytes` at root/rel (creating folders) and set its mtime (default: an hour before `Date.now()`). Returns the path. */
export function put(root: string, rel: string, bytes: Uint8Array | string = "x", mtimeMs = Date.now() - 3_600_000): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

// ---------------------------------------------------------------------------
// Fake Runner
// ---------------------------------------------------------------------------

export interface SipsFake {
  width: number;
  height: number;
  format: string;
  has_alpha: boolean;
}

export interface FakeRunnerOptions {
  /** Date added (epoch ms) per absolute path, as osascript's JXA would report it. Missing/null → unknown. */
  added?: Record<string, number | null> | Map<string, number | null> | ((path: string) => number | null | undefined);
  /** Force this result for every osascript call (e.g. { code: 1 } or { timedOut: true }). */
  osascript?: Partial<RunResult>;
  /** `defaults read com.apple.screencapture location`: the stored string, or null/undefined for "key missing" (exit 1). */
  screenshotLocation?: string | null;
  /** Per-path `sips -g` answer: metadata, null for "not an image" (<nil> dims), undefined for "not a valid file" (no block). */
  sips?: (path: string) => SipsFake | null | undefined;
  /** What sips prints as each block's first line. Real sips prints the resolved path (symlinks followed). */
  sipsPrintPath?: (path: string) => string;
  /** Force this result for every sips call. */
  sipsResult?: Partial<RunResult>;
}

export interface FakeRunner extends Runner {
  calls: Array<{ cmd: string[]; opts?: RunOptions }>;
  /** Calls whose program basename is `tool` ("osascript", "sips", "defaults"). */
  count(tool: string): number;
}

const ok = (stdout: string, stderr = ""): RunResult => ({ code: 0, stdout, stderr, timedOut: false });
const done = (r: Partial<RunResult>): RunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...r });

export function fakeRunner(o: FakeRunnerOptions = {}): FakeRunner {
  const calls: FakeRunner["calls"] = [];
  const addedOf = (p: string): number | null => {
    const a = o.added;
    if (!a) return null;
    const v = typeof a === "function" ? a(p) : a instanceof Map ? a.get(p) : a[p];
    return typeof v === "number" ? v : null;
  };
  const fn = (async (cmd: string[], opts?: RunOptions): Promise<RunResult> => {
    calls.push({ cmd: [...cmd], opts });
    const tool = basename(cmd[0] ?? "");
    if (tool === "osascript") {
      if (o.osascript) return done(o.osascript);
      const i = cmd.indexOf("-e");
      const paths = i >= 0 ? cmd.slice(i + 2) : [];
      return ok(`${JSON.stringify(paths.map(addedOf))}\n`);
    }
    if (tool === "defaults") {
      if (o.screenshotLocation === undefined || o.screenshotLocation === null) {
        return { code: 1, stdout: "", stderr: "\nThe domain/default pair of (com.apple.screencapture, location) does not exist\n", timedOut: false };
      }
      return ok(`${o.screenshotLocation}\n`);
    }
    if (tool === "sips") {
      if (o.sipsResult) return done(o.sipsResult);
      const paths: string[] = [];
      for (let i = 1; i < cmd.length; i++) {
        if (cmd[i] === "-g") i++;
        else paths.push(cmd[i]);
      }
      let stdout = "";
      let stderr = "";
      for (const p of paths) {
        const meta = o.sips ? o.sips(p) : undefined;
        if (meta === undefined) {
          stderr += `Warning: ${p} not a valid file - skipping\n`;
          continue;
        }
        stdout += `${o.sipsPrintPath ? o.sipsPrintPath(p) : p}\n`;
        stdout +=
          meta === null
            ? "  pixelWidth: <nil>\n  pixelHeight: <nil>\n  format: png\n  hasAlpha: no\n"
            : `  pixelWidth: ${meta.width}\n  pixelHeight: ${meta.height}\n  format: ${meta.format}\n  hasAlpha: ${meta.has_alpha ? "yes" : "no"}\n`;
      }
      return { code: 0, stdout, stderr, timedOut: false };
    }
    return { code: 127, stdout: "", stderr: `fakeRunner: ${tool} not faked`, timedOut: false };
  }) as FakeRunner;
  fn.calls = calls;
  fn.count = (tool: string) => calls.filter((c) => basename(c.cmd[0] ?? "") === tool).length;
  return fn;
}
