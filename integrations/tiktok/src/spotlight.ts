/**
 * What macOS knows about a file beyond its bytes, for "the one I downloaded from YouTube", "the one I
 * AirDropped" or "the one tagged Red" (find_recent_videos):
 *  - Spotlight attributes from ONE `mdls -plist -` call for many files (where-from URLs, Finder tags and
 *    comment, title, encoding apps, camera make/model, duration, pixel size, creation date, audio channels);
 *  - the quarantine agent from ONE `xattr -p com.apple.quarantine` call ("sharingd" = AirDrop, a browser =
 *    downloaded, "Final Cut Pro" = exported from it).
 * Both are best effort and time-boxed: Spotlight can be off, slow or not indexing a volume, and then the
 * caller works from what the file itself says (src/media.ts). Paths travel as argv, never inside a script.
 * Logs carry counts and exit codes only.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./proc.ts";
import type { Runner } from "./types.ts";

const MDLS = "/usr/bin/mdls";
const XATTR = "/usr/bin/xattr";
const MDLS_TIMEOUT_MS = 4_000;
const XATTR_TIMEOUT_MS = 3_000;
/** Per call. More candidates than this keep their file-only facts. */
export const MAX_SPOTLIGHT_FILES = 200;
const MAX_ARGV_BYTES = 512 * 1024;

export const SPOTLIGHT_ATTRS = [
  "kMDItemWhereFroms",
  "kMDItemUserTags",
  "kMDItemFinderComment",
  "kMDItemTitle",
  "kMDItemEncodingApplications",
  "kMDItemCreator",
  "kMDItemAcquisitionMake",
  "kMDItemAcquisitionModel",
  "kMDItemDurationSeconds",
  "kMDItemPixelWidth",
  "kMDItemPixelHeight",
  "kMDItemContentCreationDate",
  "kMDItemAudioChannelCount",
  "kMDItemCodecs",
] as const;

export interface SpotMeta {
  where_froms?: string[];
  tags?: string[];
  finder_comment?: string;
  title?: string;
  encoding_apps?: string[];
  creator?: string;
  make?: string;
  model?: string;
  duration_sec?: number;
  width?: number;
  height?: number;
  created_ms?: number;
  audio_channels?: number;
  codecs?: string[];
}

export interface FileFacts {
  spot?: SpotMeta;
  /** The quarantine agent: "sharingd", "Safari", "Google Chrome", "Final Cut Pro", "QuickTime Player"… */
  agent?: string;
}

// ---------------------------------------------------------------------------
// A small XML plist reader (mdls -plist output: array, dict, key, string, real, integer, date, true, false)
// ---------------------------------------------------------------------------

type PlistValue = string | number | boolean | Date | PlistValue[] | { [k: string]: PlistValue } | null;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] !== "#") return ENTITY[e.toLowerCase()] ?? "";
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });

/** Parses a plist document's root value; null when it isn't one. Bounded by the input's size. */
export function parsePlist(xml: string): PlistValue {
  const tags = /<(\/?)(array|dict|key|string|real|integer|date|data|true|false)(\s*\/)?>/g;
  let pos = 0;
  const start = xml.indexOf("<plist");
  if (start < 0) return null;
  pos = xml.indexOf(">", start) + 1;
  if (pos <= 0) return null;
  const next = (): { close: boolean; name: string; empty: boolean; end: number; at: number } | null => {
    tags.lastIndex = pos;
    const m = tags.exec(xml);
    if (!m) return null;
    return { close: m[1] === "/", name: m[2], empty: Boolean(m[3]), end: m.index + m[0].length, at: m.index };
  };
  const text = (name: string): string => {
    const close = xml.indexOf(`</${name}>`, pos);
    if (close < 0) throw new Error("unterminated");
    const t = unescapeXml(xml.slice(pos, close));
    pos = close + name.length + 3;
    return t;
  };
  const value = (depth: number): PlistValue | undefined => {
    if (depth > 32) throw new Error("too deep");
    const t = next();
    if (!t || t.close) return undefined;
    pos = t.end;
    switch (t.name) {
      case "true":
        return true;
      case "false":
        return false;
      case "string":
        return t.empty ? "" : text("string");
      case "key":
        return t.empty ? "" : text("key");
      case "real":
      case "integer": {
        const n = Number(text(t.name).trim());
        return Number.isFinite(n) ? n : null;
      }
      case "date": {
        const d = new Date(text("date").trim());
        return Number.isFinite(d.getTime()) ? d : null;
      }
      case "data":
        if (!t.empty) text("data");
        return null;
      case "array": {
        const out: PlistValue[] = [];
        if (t.empty) return out;
        for (;;) {
          const peek = next();
          if (!peek) throw new Error("unterminated array");
          if (peek.close && peek.name === "array") {
            pos = peek.end;
            return out;
          }
          const v = value(depth + 1);
          if (v === undefined) throw new Error("bad array");
          out.push(v);
        }
      }
      case "dict": {
        const out: Record<string, PlistValue> = {};
        if (t.empty) return out;
        for (;;) {
          const peek = next();
          if (!peek) throw new Error("unterminated dict");
          if (peek.close && peek.name === "dict") {
            pos = peek.end;
            return out;
          }
          const k = value(depth + 1);
          if (typeof k !== "string") throw new Error("dict key");
          const v = value(depth + 1);
          if (v === undefined) throw new Error("dict value");
          out[k] = v;
        }
      }
    }
    return undefined;
  };
  try {
    return value(0) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// mdls
// ---------------------------------------------------------------------------

const clip = (s: string, max = 200) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const strOf = (v: PlistValue | undefined): string | undefined => (typeof v === "string" && clip(v) ? clip(v) : undefined);
const numOf = (v: PlistValue | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const listOfStr = (v: PlistValue | undefined): string[] | undefined => {
  const items = (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((x) => strOf(x as PlistValue)).filter((x): x is string => Boolean(x));
  return items.length ? [...new Set(items)].slice(0, 12) : undefined;
};

function toSpotMeta(d: Record<string, PlistValue>): SpotMeta {
  const m: SpotMeta = {};
  const set = <K extends keyof SpotMeta>(k: K, v: SpotMeta[K] | undefined) => {
    if (v !== undefined) m[k] = v;
  };
  set("where_froms", listOfStr(d.kMDItemWhereFroms));
  // Finder tags arrive as "Red\n6" (name, newline, colour index) on some systems: keep the name.
  set("tags", listOfStr(d.kMDItemUserTags)?.map((t) => t.split(/\s*\n|\s{2,}/)[0]).filter(Boolean));
  set("finder_comment", strOf(d.kMDItemFinderComment));
  set("title", strOf(d.kMDItemTitle));
  set("encoding_apps", listOfStr(d.kMDItemEncodingApplications));
  set("creator", strOf(d.kMDItemCreator));
  set("make", strOf(d.kMDItemAcquisitionMake));
  set("model", strOf(d.kMDItemAcquisitionModel));
  set("duration_sec", numOf(d.kMDItemDurationSeconds));
  set("width", numOf(d.kMDItemPixelWidth));
  set("height", numOf(d.kMDItemPixelHeight));
  const created = d.kMDItemContentCreationDate;
  if (created instanceof Date) set("created_ms", created.getTime());
  const ch = d.kMDItemAudioChannelCount;
  if (typeof ch === "number" && Number.isFinite(ch) && ch >= 0) m.audio_channels = ch;
  set("codecs", listOfStr(d.kMDItemCodecs));
  return m;
}

/** The paths that fit in one call (count and argv bytes), absolute, deduplicated. */
function batch(paths: string[]): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const p of new Set(paths)) {
    const a = resolve(p);
    const n = Buffer.byteLength(a) + 1;
    if (out.length >= MAX_SPOTLIGHT_FILES || bytes + n > MAX_ARGV_BYTES) break;
    out.push(a);
    bytes += n;
  }
  return out;
}

async function mdlsOnce(list: string[], runner: Runner): Promise<Record<string, PlistValue>[] | null> {
  const args = [MDLS, "-plist", "-", ...SPOTLIGHT_ATTRS.flatMap((a) => ["-name", a]), ...list];
  let r;
  try {
    r = await runner(args, { timeoutMs: MDLS_TIMEOUT_MS });
  } catch (e) {
    log(`spotlight: mdls failed to start (${(e as Error).name})`);
    return null;
  }
  if (r.timedOut) {
    log(`spotlight: mdls timed out for ${list.length} files`);
    return null;
  }
  const root = r.stdout.includes("<plist") ? parsePlist(r.stdout) : null;
  if (!Array.isArray(root) || root.length !== list.length) {
    if (r.code !== 0) log(`spotlight: mdls exit ${r.code} for ${list.length} files`);
    return null;
  }
  return root.map((d) => (d && typeof d === "object" && !Array.isArray(d) && !(d instanceof Date) ? (d as Record<string, PlistValue>) : {}));
}

/**
 * Spotlight attributes for up to 200 files in ONE `mdls -plist -` call (one array entry per file, in order).
 * mdls prints nothing at all when any file has gone, so that case is retried once with the files still there.
 * Unavailable (no mdls, timed out after 4 s, unexpected output) → an empty map.
 */
export async function spotlightMeta(paths: string[], runner: Runner): Promise<Map<string, SpotMeta>> {
  const out = new Map<string, SpotMeta>();
  let list = batch(paths);
  if (!list.length) return out;
  let rows = await mdlsOnce(list, runner);
  if (!rows) {
    const still = list.filter((p) => existsSync(p));
    if (still.length && still.length < list.length) {
      list = still;
      rows = await mdlsOnce(list, runner);
    }
  }
  if (!rows) return out;
  rows.forEach((d, i) => out.set(list[i], toSpotMeta(d)));
  return out;
}

// ---------------------------------------------------------------------------
// xattr com.apple.quarantine
// ---------------------------------------------------------------------------

/**
 * The quarantine agent per file, from ONE `xattr -p com.apple.quarantine <paths…>` call. Its stdout is
 * "<path>: <flags>;<hex time>;<agent>;<uuid>" for every file that has one (the rest go to stderr, and the exit
 * code is then 1). Lines are matched back to the paths passed, longest first, so a ": " inside a name is fine.
 */
export async function quarantineAgents(paths: string[], runner: Runner): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = batch(paths);
  if (!list.length) return out;
  let stdout = "";
  try {
    const r = await runner([XATTR, "-p", "com.apple.quarantine", ...list], { timeoutMs: XATTR_TIMEOUT_MS });
    if (r.timedOut) {
      log(`quarantine: xattr timed out for ${list.length} files`);
      return out;
    }
    stdout = r.stdout;
  } catch (e) {
    log(`quarantine: xattr failed to start (${(e as Error).name})`);
    return out;
  }
  // One file: xattr prints the bare value, without the "path: " prefix.
  const lines = stdout.split("\n").filter(Boolean);
  if (list.length === 1 && lines.length === 1 && !lines[0].startsWith(`${list[0]}: `)) {
    const agent = agentOf(lines[0]);
    if (agent) out.set(list[0], agent);
    return out;
  }
  const byLength = [...list].sort((a, b) => b.length - a.length);
  for (const line of lines) {
    const p = byLength.find((x) => line.startsWith(`${x}: `));
    if (!p) continue;
    const agent = agentOf(line.slice(p.length + 2));
    if (agent) out.set(p, agent);
  }
  return out;
}

function agentOf(value: string): string | undefined {
  const parts = value.split(";");
  const agent = clip(parts[2] ?? "", 60);
  return agent && /\p{L}/u.test(agent) ? agent : undefined;
}

/** Spotlight attributes and quarantine agents together: both calls run at once. Never throws. */
export async function fileFacts(paths: string[], runner: Runner): Promise<Map<string, FileFacts>> {
  const [spot, agents] = await Promise.all([
    spotlightMeta(paths, runner).catch(() => new Map<string, SpotMeta>()),
    quarantineAgents(paths, runner).catch(() => new Map<string, string>()),
  ]);
  const out = new Map<string, FileFacts>();
  for (const p of new Set(paths)) {
    const a = resolve(p);
    const f: FileFacts = {};
    const s = spot.get(a);
    if (s) f.spot = s;
    const ag = agents.get(a);
    if (ag) f.agent = ag;
    out.set(p, f);
  }
  return out;
}
