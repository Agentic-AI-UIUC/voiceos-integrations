/**
 * Local media metadata without an LLM (plan §6.13; verification log §4.3, §4.6).
 *
 * - `mp4Info` / `mp4InfoFromBuffer`: a pure-TS ISO-BMFF (MP4/MOV) reader. It
 *   hops from box header to box header with positioned reads, so a `moov` at
 *   the end of a 4 GB file costs a few dozen reads of ≤ 96 bytes; it never
 *   loads the file, the `mdat` or the sample tables.
 * - `sipsMeta`: pixel size, format and alpha for many images in ONE `sips -g` call.
 * - `contentCredentials`: is a C2PA Manifest Store embedded, and does it say
 *   the image was made with AI?
 *
 * Child processes go through the injected Runner (CI is ubuntu: tests fake it).
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { log } from "./proc.ts";
import type { CredentialsResult, Runner } from "./types.ts";

// ---------------------------------------------------------------------------
// MP4 / MOV
// ---------------------------------------------------------------------------

export interface VideoInfo {
  size: number;
  duration_sec?: number;
  /** ftyp major brand, raw 4 chars ("isom", "qt  "). Absent for classic QuickTime files without ftyp. */
  brand?: string;
  /** Set only when an ftyp box was read; callers fall back to the extension. */
  mime?: "video/mp4" | "video/quicktime";
  /** Display size of the main video track (tkhd, swapped for 90°/270° matrices). */
  width?: number;
  height?: number;
}

/**
 * `mp4Details`: VideoInfo plus what the container says about where the video came from (find_recent_videos
 * matches "the iPhone one", "the CapCut export", "the one with no sound" against these). Location tags are
 * never read.
 */
export interface VideoDetailsInfo extends VideoInfo {
  /** An audio ('soun') track exists. Undefined when no moov was read. */
  has_audio?: boolean;
  /** The main video track's sample entry: "avc1", "hvc1", "hev1", "apcn"… */
  codec?: string;
  /** ©nam / com.apple.quicktime.title / displayname. */
  title?: string;
  /** ©cmt / com.apple.quicktime.comment / description ("Made with Remotion 4.0.540"). */
  comment?: string;
  /** ©too / ©swr / com.apple.quicktime.software ("Lavf63.1.101", "CapCut", "26.5.2"). */
  encoder?: string;
  /** com.apple.quicktime.make / ©mak ("Apple"). */
  make?: string;
  /** com.apple.quicktime.model / ©mod ("iPhone 15 Pro"). */
  model?: string;
  /** com.apple.quicktime.author / ©ART ("ReplayKitRecording" for macOS screen recordings). */
  author?: string;
  /** When it was recorded or rendered (com.apple.quicktime.creationdate, ©day, else mvhd's creation time), epoch ms. */
  created_ms?: number;
}

/** Positioned reads; returns fewer bytes than asked at the end of the data. */
interface Reader {
  readonly size: number;
  read(pos: number, len: number): Uint8Array;
}

interface Box {
  type: string;
  start: number;
  /** First byte after the header (8, or 16 with a 64-bit size). */
  body: number;
  /** Clamped to the parent's end. */
  end: number;
}

/** Real files have a handful of top-level boxes (fragmented ones a few thousand); this bounds hostile input. */
const MAX_TOP_BOXES = 10_000;
const MAX_CHILD_BOXES = 4_096;
const TOP_TYPE = /^[\x20-\x7e]{4}$/;
const MAX_SANE_SECONDS = 10_000_000;

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const latin1 = (b: Uint8Array, from: number, to: number) => {
  let s = "";
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

function boxAt(r: Reader, pos: number, limit: number): Box | null {
  if (pos + 8 > limit) return null;
  const h = r.read(pos, 16);
  if (h.length < 8) return null;
  const v = dv(h);
  let size = v.getUint32(0);
  let body = pos + 8;
  if (size === 1) {
    if (h.length < 16) return null;
    const big = v.getBigUint64(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    body = pos + 16;
  } else if (size === 0) {
    size = limit - pos; // "extends to the end" (of the file, or of the parent)
  }
  if (size < body - pos) return null;
  return { type: latin1(h, 4, 8), start: pos, body, end: Math.min(pos + size, limit) };
}

function* children(r: Reader, parent: Box): Generator<Box> {
  let pos = parent.body;
  for (let n = 0; n < MAX_CHILD_BOXES; n++) {
    const b = boxAt(r, pos, parent.end);
    if (!b) return;
    yield b;
    if (b.end <= pos) return;
    pos = b.end;
  }
}

interface Track {
  w: number;
  h: number;
  video: boolean;
}

/** The first sample entry's type in mdia/minf/stbl/stsd ("avc1", "hvc1"…), or "". */
function sampleEntry(r: Reader, mdia: Box): string {
  for (const m of children(r, mdia)) {
    if (m.type !== "minf") continue;
    for (const s of children(r, m)) {
      if (s.type !== "stbl") continue;
      for (const d of children(r, s)) {
        if (d.type !== "stsd") continue;
        const b = r.read(d.body, 16);
        const t = b.length >= 16 ? latin1(b, 12, 16) : "";
        return /^[\x20-\x7e]{4}$/.test(t) ? t : "";
      }
    }
  }
  return "";
}

/** Every track's handler ('vide', 'soun', …) and the video codec, for mp4Details. */
function trackKinds(r: Reader, trak: Box): { handler: string; codec: string } {
  for (const c of children(r, trak)) {
    if (c.type !== "mdia") continue;
    let handler = "";
    for (const m of children(r, c)) {
      if (m.type !== "hdlr") continue;
      const b = r.read(m.body, 12);
      if (b.length >= 12) handler = latin1(b, 8, 12);
    }
    return { handler, codec: handler === "vide" ? sampleEntry(r, c) : "" };
  }
  return { handler: "", codec: "" };
}

const MAX_TAG_ITEMS = 96;
const MAX_TAG_BYTES = 320;
/** Seconds between 1904-01-01 (QuickTime's epoch) and 1970-01-01. */
const QT_EPOCH_S = 2_082_844_800;
const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Tag names we keep → our field. Location keys are never read. */
const TAG_FIELD: Record<string, keyof VideoDetailsInfo> = {
  "©nam": "title", "com.apple.quicktime.title": "title", "com.apple.quicktime.displayname": "title",
  "©cmt": "comment", "©des": "comment", "desc": "comment", "com.apple.quicktime.comment": "comment", "com.apple.quicktime.description": "comment",
  "©too": "encoder", "©swr": "encoder", "com.apple.quicktime.software": "encoder",
  "©mak": "make", "com.apple.quicktime.make": "make",
  "©mod": "model", "com.apple.quicktime.model": "model",
  "©ART": "author", "©aut": "author", "com.apple.quicktime.author": "author",
  "©day": "created_ms", "com.apple.quicktime.creationdate": "created_ms",
};

function tagText(b: Uint8Array): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  return utf8.decode(b).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function setTag(out: VideoDetailsInfo, key: string, value: string): void {
  const field = TAG_FIELD[key];
  if (!field || !value) return;
  if (field === "created_ms") {
    // "2026-07-26T17:59:45-0700" (Apple omits the colon in the offset) or "2026".
    const iso = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t > Date.UTC(1990, 0, 1)) out.created_ms ??= t;
    return;
  }
  if (out[field] === undefined) (out as Record<string, unknown>)[field] = value;
}

/** The value of an iTunes-style `data` box inside an ilst item (UTF-8 / UTF-16 text only). */
function dataValue(r: Reader, item: Box): string {
  for (const d of children(r, item)) {
    if (d.type !== "data") continue;
    const b = r.read(d.body, 8 + MAX_TAG_BYTES);
    if (b.length < 8) return "";
    const type = (b[1] << 16) | (b[2] << 8) | b[3];
    const body = b.subarray(8, Math.min(b.length, d.end - d.body));
    if (type === 1 || type === 0) return tagText(body);
    if (type === 2) return new TextDecoder("utf-16be").decode(body).slice(0, 200).trim();
    return "";
  }
  return "";
}

/** A `meta` box: ISO's is a FullBox, QuickTime's isn't; either way hdlr/keys/ilst follow. */
function readMeta(r: Reader, meta: Box, out: VideoDetailsInfo): void {
  const peek = r.read(meta.body, 8);
  const inner = peek.length >= 8 && /^(hdlr|keys|ilst|free)$/.test(latin1(peek, 4, 8)) ? meta : { ...meta, body: meta.body + 4 };
  const keys: string[] = [];
  for (const c of children(r, inner)) {
    if (c.type === "keys") {
      const head = r.read(c.body, 8);
      if (head.length < 8) continue;
      const count = Math.min(MAX_TAG_ITEMS, dv(head).getUint32(4));
      let pos = c.body + 8;
      for (let i = 0; i < count && pos + 8 <= c.end; i++) {
        const h = r.read(pos, 8);
        if (h.length < 8) break;
        const size = dv(h).getUint32(0);
        if (size < 8 || pos + size > c.end) break;
        keys.push(latin1(r.read(pos + 8, Math.min(size - 8, 128)), 0, 128));
        pos += size;
      }
    } else if (c.type === "ilst") {
      let n = 0;
      for (const item of children(r, c)) {
        if (++n > MAX_TAG_ITEMS) break;
        const raw = r.read(item.start + 4, 4);
        const index = raw.length === 4 ? dv(raw).getUint32(0) : 0;
        const key = keys.length && index >= 1 && index <= keys.length ? keys[index - 1] : item.type;
        if (TAG_FIELD[key]) setTag(out, key, dataValue(r, item));
      }
    }
  }
}

/** moov/udta: QuickTime's classic ©xxx atoms ([u16 length][u16 language][text]) and an iTunes-style meta. */
function readUdta(r: Reader, udta: Box, out: VideoDetailsInfo): void {
  let n = 0;
  for (const c of children(r, udta)) {
    if (++n > MAX_TAG_ITEMS) break;
    if (c.type === "meta") {
      readMeta(r, c, out);
      continue;
    }
    if (!TAG_FIELD[c.type]) continue;
    const b = r.read(c.body, 4 + MAX_TAG_BYTES);
    if (b.length >= 8 && latin1(b, 4, 8) === "data") {
      setTag(out, c.type, dataValue(r, c));
    } else if (b.length >= 4) {
      const len = (b[0] << 8) | b[1];
      setTag(out, c.type, tagText(b.subarray(4, 4 + Math.min(len, MAX_TAG_BYTES))));
    }
  }
}

/** mp4Details' extras from a moov: tracks' kinds, the video codec, tags and the creation time. */
function readDetails(r: Reader, moov: Box, out: VideoDetailsInfo): void {
  let audio = false;
  let mvhdMs: number | undefined;
  for (const c of children(r, moov)) {
    if (c.type === "trak") {
      const k = trackKinds(r, c);
      if (k.handler === "soun") audio = true;
      if (k.codec && out.codec === undefined) out.codec = k.codec;
    } else if (c.type === "udta") {
      readUdta(r, c, out);
    } else if (c.type === "meta") {
      readMeta(r, c, out);
    } else if (c.type === "mvhd") {
      const b = r.read(c.body, 12);
      if (b.length < 12) continue;
      const secs = b[0] === 1 ? Number(dv(b).getBigUint64(4)) : dv(b).getUint32(4);
      const ms = (secs - QT_EPOCH_S) * 1000;
      if (secs > QT_EPOCH_S && ms > Date.UTC(1990, 0, 1) && ms < Date.UTC(2100, 0, 1)) mvhdMs = ms;
    }
  }
  out.has_audio = audio;
  if (out.created_ms === undefined && mvhdMs !== undefined) out.created_ms = mvhdMs;
}

function readTrak(r: Reader, trak: Box): Track | null {
  let w = 0;
  let h = 0;
  let swap = false;
  let handler = "";
  for (const c of children(r, trak)) {
    if (c.type === "tkhd") {
      const b = r.read(c.body, 96);
      const base = b[0] === 1 ? 52 : 40; // matrix offset in the payload (v1 has 64-bit times)
      if (b.length < base + 44) continue;
      const v = dv(b);
      const a = v.getInt32(base);
      const bb = v.getInt32(base + 4);
      const cc = v.getInt32(base + 12);
      const d = v.getInt32(base + 16);
      swap = Math.abs(bb) > Math.abs(a) && Math.abs(cc) > Math.abs(d); // 90° / 270°
      w = Math.round(v.getUint32(base + 36) / 65536);
      h = Math.round(v.getUint32(base + 40) / 65536);
    } else if (c.type === "mdia") {
      for (const m of children(r, c)) {
        if (m.type !== "hdlr") continue;
        const b = r.read(m.body, 12);
        if (b.length >= 12) handler = latin1(b, 8, 12);
      }
    }
  }
  if (!(w > 0 && h > 0)) return null;
  return swap ? { w: h, h: w, video: handler === "vide" } : { w, h, video: handler === "vide" };
}

function readMoov(r: Reader, moov: Box, out: VideoInfo): void {
  let timescale = 0;
  let duration = 0;
  let fragmented = 0;
  const tracks: Track[] = [];
  for (const c of children(r, moov)) {
    if (c.type === "mvhd") {
      const b = r.read(c.body, 32);
      const v = dv(b);
      if (b[0] === 1 && b.length >= 32) {
        timescale = v.getUint32(20);
        const d = v.getBigUint64(24);
        duration = d === 0xffffffffffffffffn ? 0 : Number(d);
      } else if (b.length >= 20) {
        timescale = v.getUint32(12);
        const d = v.getUint32(16);
        duration = d === 0xffffffff ? 0 : d;
      }
    } else if (c.type === "trak") {
      const t = readTrak(r, c);
      if (t) tracks.push(t);
    } else if (c.type === "mvex") {
      for (const m of children(r, c)) {
        if (m.type !== "mehd") continue;
        const b = r.read(m.body, 12);
        if (b[0] === 1 && b.length >= 12) fragmented = Number(dv(b).getBigUint64(4));
        else if (b.length >= 8) fragmented = dv(b).getUint32(4);
      }
    }
  }
  const d = duration || fragmented;
  if (timescale > 0 && d > 0) {
    const sec = Math.round((d / timescale) * 1000) / 1000;
    if (Number.isFinite(sec) && sec > 0 && sec < MAX_SANE_SECONDS) out.duration_sec = sec;
  }
  const pool = tracks.some((t) => t.video) ? tracks.filter((t) => t.video) : tracks;
  let best: Track | undefined;
  for (const t of pool) if (!best || t.w * t.h > best.w * best.h) best = t;
  if (best) {
    out.width = best.w;
    out.height = best.h;
  }
}

function parseIsoBmff(r: Reader, details = false): VideoDetailsInfo {
  const out: VideoDetailsInfo = { size: r.size };
  let pos = 0;
  for (let n = 0; n < MAX_TOP_BOXES; n++) {
    const b = boxAt(r, pos, r.size);
    if (!b || !TOP_TYPE.test(b.type)) break; // not (or no longer) ISO-BMFF
    if (b.type === "ftyp" && out.brand === undefined && b.end - b.body >= 4) {
      const brand = latin1(r.read(b.body, 4), 0, 4);
      if (brand.length === 4) {
        out.brand = brand;
        out.mime = brand === "qt  " ? "video/quicktime" : "video/mp4";
      }
    } else if (b.type === "moov") {
      readMoov(r, b, out);
      if (details) {
        try {
          readDetails(r, b, out);
        } catch {
          /* damaged tags: the basics above still stand */
        }
      }
      break;
    }
    if (b.end <= pos) break;
    pos = b.end;
  }
  return out;
}

/** In-memory variant of `mp4Info` (same walk). Never throws: corrupt data → `{ size }` (plus whatever parsed before the damage). */
export function mp4InfoFromBuffer(buf: Uint8Array): VideoInfo {
  const r: Reader = {
    size: buf.length,
    read: (pos, len) => buf.subarray(Math.min(pos, buf.length), Math.min(buf.length, pos + len)),
  };
  try {
    return parseIsoBmff(r);
  } catch {
    return { size: buf.length };
  }
}

/**
 * Duration, brand/MIME and display size of an MP4/MOV file. Seek-based: only
 * box headers and the small mvhd/tkhd/hdlr/mehd boxes are read. Throws only
 * when the file can't be opened (missing, no permission); corrupt content → `{ size }`.
 */
export function mp4Info(path: string): VideoInfo {
  return readFile(path, false);
}

/**
 * mp4Info plus the container's tags, track kinds and creation time (VideoDetailsInfo), for describing a video.
 * Still seek-based and bounded: udta/meta/keys/ilst/stsd headers and ≤ 320-byte tag values. Throws only when
 * the file can't be opened.
 */
export function mp4Details(path: string): VideoDetailsInfo {
  return readFile(path, true);
}

/** In-memory variant of `mp4Details`. Never throws. */
export function mp4DetailsFromBuffer(buf: Uint8Array): VideoDetailsInfo {
  const r: Reader = {
    size: buf.length,
    read: (pos, len) => buf.subarray(Math.min(pos, buf.length), Math.min(buf.length, pos + len)),
  };
  try {
    return parseIsoBmff(r, true);
  } catch {
    return { size: buf.length };
  }
}

function readFile(path: string, details: boolean): VideoDetailsInfo {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const r: Reader = {
      size,
      read(pos, len) {
        const n = Math.max(0, Math.min(len, size - pos));
        const b = new Uint8Array(n);
        let got = 0;
        while (got < n) {
          const k = readSync(fd, b, got, n - got, pos + got);
          if (k <= 0) break;
          got += k;
        }
        return got === n ? b : b.subarray(0, got);
      },
    };
    try {
      return parseIsoBmff(r, details);
    } catch {
      return { size };
    }
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// sips -g (images)
// ---------------------------------------------------------------------------

export interface SipsInfo {
  width: number;
  height: number;
  /** sips `format`: "jpeg", "png", "heic", "heif", "webp", … ("" if sips didn't say). */
  format: string;
  has_alpha: boolean;
}

const SIPS = "/usr/bin/sips";
const SIPS_TIMEOUT_MS = 15_000;

/**
 * Parses `sips -g …` stdout (verified on macOS 27.2, sips-316):
 *   /private/var/…/a b.png        ← the file's RESOLVED path (symlinks followed), column 0
 *     pixelWidth: 3               ← two-space indented `key: value`
 *     pixelHeight: 2
 *     format: png
 *     hasAlpha: yes
 * Unreadable images print `<nil>` dimensions; missing files and folders print no
 * block at all (only "Warning: … not a valid file - skipping" on stderr). Exit code 0 either way.
 */
function parseSipsOutput(stdout: string): Array<{ path: string; props: Record<string, string> }> {
  const blocks: Array<{ path: string; props: Record<string, string> }> = [];
  let cur: { path: string; props: Record<string, string> } | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const kv = /^\s+([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (kv) {
      if (cur) cur.props[kv[1]] = kv[2].trim();
    } else if (/^([A-Za-z]:[\\/]|[\\/])/.test(line)) {
      cur = { path: line, props: {} };
      blocks.push(cur);
    } else {
      cur = undefined; // a warning or anything else: not part of a block
    }
  }
  return blocks;
}

function pathKeys(p: string): string[] {
  const keys = new Set([p, p.normalize("NFC"), p.normalize("NFD")]);
  try {
    const rp = realpathSync(p);
    keys.add(rp).add(rp.normalize("NFC")).add(rp.normalize("NFD"));
  } catch {
    /* missing: sips won't print it either */
  }
  return [...keys];
}

function toSipsInfo(props: Record<string, string>): SipsInfo | null {
  const int = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : 0);
  const width = int(props.pixelWidth);
  const height = int(props.pixelHeight);
  if (!(width > 0 && height > 0)) return null;
  const format = (props.format ?? "").toLowerCase();
  return { width, height, format: format === "<nil>" ? "" : format, has_alpha: /^yes$/i.test(props.hasAlpha ?? "") };
}

/**
 * ONE `sips -g pixelWidth -g pixelHeight -g format -g hasAlpha <paths…>` call.
 * Every input path gets an entry: its metadata, or null when sips couldn't read it
 * (missing file, not an image, sips unavailable or timed out).
 */
export async function sipsMeta(paths: string[], runner: Runner): Promise<Map<string, SipsInfo | null>> {
  const out = new Map<string, SipsInfo | null>();
  const unique = [...new Set(paths)];
  for (const p of unique) out.set(p, null);
  if (!unique.length) return out;
  const abs = unique.map((p) => resolve(p));
  let stdout = "";
  try {
    const r = await runner([SIPS, "-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", "-g", "hasAlpha", ...abs], { timeoutMs: SIPS_TIMEOUT_MS });
    stdout = r.stdout;
    if (r.code !== 0 || r.timedOut) log(`sips -g: exit ${r.code}${r.timedOut ? " (timed out)" : ""} for ${unique.length} images`);
  } catch (e) {
    log(`sips -g failed to start: ${(e as Error).name}`);
    return out;
  }
  // Map blocks back to inputs by path (sips prints the resolved path), then pair leftovers in order when the counts agree.
  const index = new Map<string, number[]>();
  abs.forEach((p, i) => {
    for (const k of pathKeys(p)) {
      const list = index.get(k) ?? [];
      if (!list.includes(i)) list.push(i);
      index.set(k, list);
    }
  });
  const assigned = new Array<boolean>(unique.length).fill(false);
  const leftovers: Record<string, string>[] = [];
  for (const b of parseSipsOutput(stdout)) {
    const hits = index.get(b.path) ?? index.get(b.path.normalize("NFC")) ?? [];
    const i = hits.find((j) => !assigned[j]);
    if (i === undefined) {
      leftovers.push(b.props);
      continue;
    }
    assigned[i] = true;
    out.set(unique[i], toSipsInfo(b.props));
  }
  const open = unique.map((_, i) => i).filter((i) => !assigned[i]);
  if (leftovers.length && leftovers.length === open.length) open.forEach((i, k) => out.set(unique[i], toSipsInfo(leftovers[k])));
  return out;
}

// ---------------------------------------------------------------------------
// Content Credentials (C2PA)
// ---------------------------------------------------------------------------

// The C2PA Manifest Store is a JUMBF superbox whose description box holds this type
// UUID ("c2pa" + ISO suffix), whether it sits in JPEG APP11, PNG caBX, a RIFF/WebP C2PA
// chunk or a BMFF uuid box (C2PA 2.2 §11.1.4.2, appendix A). Remote manifests aren't
// seen, and Brotli-compressed (brob) manifests hide the source type (→ "present").
const C2PA_STORE_UUID = Buffer.from("6332706100110010800000aa00389b71", "hex");
const AI_SOURCES = ["digitalsourcetype/trainedAlgorithmicMedia", "digitalsourcetype/compositeWithTrainedAlgorithmicMedia"].map((s) => Buffer.from(s, "latin1"));
const CHUNK = 8 * 1024 * 1024;
/** ≥ the longest pattern − 1, so nothing straddling two reads is missed. */
const OVERLAP = 64;

/**
 * Verification log §4.6: "none" without the Manifest Store UUID; "ai" when it's
 * present and the bytes also carry an IPTC trained/composite-algorithmic-media
 * source type; else "present". Reads ≤ 8 MB at a time. Rejects if the file can't be read.
 */
export async function contentCredentials(path: string): Promise<CredentialsResult> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(OVERLAP + CHUNK);
    let carry = 0;
    let pos = 0;
    let store = false;
    let ai = false;
    for (;;) {
      const { bytesRead } = await fh.read(buf, carry, CHUNK, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const view = buf.subarray(0, carry + bytesRead);
      if (!store && view.indexOf(C2PA_STORE_UUID) !== -1) store = true;
      if (!ai && AI_SOURCES.some((p) => view.indexOf(p) !== -1)) ai = true;
      if (store && ai) break;
      carry = Math.min(OVERLAP, view.length);
      buf.copy(buf, 0, view.length - carry, view.length);
    }
    return store ? (ai ? "ai" : "present") : "none";
  } finally {
    await fh.close();
  }
}
