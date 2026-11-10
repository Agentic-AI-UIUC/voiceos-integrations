/**
 * Finding the user's videos and photos on this Mac (plan §6.8, §6.9, §8.7;
 * Studio brief "Local files and media"). Integrations get no screen context, so
 * "post my latest export" or "the photos I just AirDropped" is resolved by
 * scanning a fixed allowlist of folders:
 *   videos: ~/Downloads, ~/Desktop, ~/Movies
 *   images: ~/Downloads, ~/Desktop, ~/Pictures and the screenshot folder
 * each at the top level plus one level deep. Hidden files, partial downloads,
 * files still being written (mtime < 5 s), empty files, symlinks and package
 * bundles (Photos/iMovie/Final Cut libraries, apps, …) are skipped.
 *
 * Arrival order is "date added" (NSURLAddedToDirectoryDateKey, one JXA call per
 * search), which survives AirDrop and `touch -t`; it falls back to birthtime,
 * then mtime. Paths stay server-side: results carry `name` and a display
 * `folder` ("Downloads", "Movies/Exports"); logs carry counts only.
 */
import { lstatSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TikTokError } from "./errors.ts";
import { mp4Details, mp4Info, sipsMeta, type VideoDetailsInfo, type VideoInfo } from "./media.ts";
import { log } from "./proc.ts";
import { finderSelection, quicktimeDocuments, type PointedFailure } from "./finderApps.ts";
import { chips, descriptor, evaluate, factsOf, keywordHit, rank as rankVideos, whenLabel, whichQuestion, type Confidence, type Evaluation, type Facts, type Ranking } from "./finderMatch.ts";
import { described, emptyDescribe, parseDescribe, type Describe, type Orientation } from "./finderParse.ts";
import { normName, parseQuery, queryOf, scoreName, type Query } from "./finderText.ts";
import { fileFacts, type FileFacts } from "./spotlight.ts";
import type { Clock, FoundImage, FoundVideo, Runner } from "./types.ts";

// ---------------------------------------------------------------------------
// Names and queries (src/finderText.ts)
// ---------------------------------------------------------------------------

export { editDistance, matchScore, normName } from "./finderText.ts";

// ---------------------------------------------------------------------------
// macOS helpers (through the injected Runner)
// ---------------------------------------------------------------------------

const OSASCRIPT = "/usr/bin/osascript";
const DEFAULTS = "/usr/bin/defaults";
const JXA_TIMEOUT_MS = 8_000;
const MAX_JXA_PATHS = 2_000;
/** macOS ARG_MAX is 1 MB including the environment. */
const MAX_JXA_ARGV_BYTES = 512 * 1024;

/** Paths arrive as argv (never spliced into the script), so quotes, emoji and U+202F need no escaping. Data for osascript; never evaluated here. */
const DATE_ADDED_JXA = `ObjC.import("Foundation");
function run(argv) {
  var out = [];
  for (var i = 0; i < argv.length; i++) {
    var v = null;
    try {
      var ref = Ref(), err = Ref();
      if ($.NSURL.fileURLWithPath(argv[i]).getResourceValueForKeyError(ref, $.NSURLAddedToDirectoryDateKey, err)) {
        var d = ref[0];
        if (d && !(typeof d.isNil === "function" && d.isNil())) {
          var t = Number(d.timeIntervalSince1970);
          if (isFinite(t) && t > 0) v = Math.round(t * 1000);
        }
      }
    } catch (e) { v = null; }
    out.push(v);
  }
  return JSON.stringify(out);
}`;

/**
 * Date added (epoch ms) per path, from ONE `osascript -l JavaScript` call reading
 * NSURLAddedToDirectoryDateKey; works without Spotlight. Absent = unknown (the call
 * failed or timed out after 8 s, the volume doesn't record it, or the path is gone).
 * At most 2,000 paths / 512 KB of argv per call; the rest stay unknown.
 */
export async function dateAdded(paths: string[], runner: Runner): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const list: string[] = [];
  const argv: string[] = [];
  let bytes = 0;
  for (const p of new Set(paths)) {
    const a = resolve(p);
    const n = Buffer.byteLength(a) + 1;
    if (list.length >= MAX_JXA_PATHS || bytes + n > MAX_JXA_ARGV_BYTES) break;
    list.push(p);
    argv.push(a);
    bytes += n;
  }
  if (!list.length) return out;
  let stdout: string;
  try {
    const r = await runner([OSASCRIPT, "-l", "JavaScript", "-e", DATE_ADDED_JXA, ...argv], { timeoutMs: JXA_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) {
      log(`date added unavailable: osascript exit ${r.code}${r.timedOut ? " (timed out)" : ""}`);
      return out;
    }
    stdout = r.stdout;
  } catch (e) {
    log(`date added unavailable: ${(e as Error).name}`);
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== list.length) {
    log("date added unavailable: unexpected osascript output");
    return out;
  }
  parsed.forEach((v, i) => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out.set(list[i], v);
  });
  return out;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The screenshot folder: `defaults read com.apple.screencapture location`. A missing
 * key (exit 1), an empty value, a folder that doesn't exist or a failing runner →
 * <home>/Desktop (where macOS then saves). A literal "~"/"~/…" (as on the verifying
 * Mac: "~/Downloads") is expanded against `home`. Always absolute, no trailing slash.
 */
export async function screenshotFolder(home: string, runner: Runner): Promise<string> {
  const h = resolve(home);
  const desktop = join(h, "Desktop");
  let raw: string;
  try {
    const r = await runner([DEFAULTS, "read", "com.apple.screencapture", "location"], { timeoutMs: 5_000 });
    if (r.code !== 0 || r.timedOut) return desktop;
    raw = r.stdout.replace(/\r?\n$/, "");
  } catch {
    return desktop;
  }
  if (!raw.trim() || /[\r\n]/.test(raw)) return desktop;
  let v = raw;
  if (v.startsWith("file://")) {
    try {
      v = decodeURIComponent(new URL(v).pathname);
    } catch {
      return desktop;
    }
  }
  if (v === "~") v = h;
  else if (v.startsWith("~/")) v = join(h, v.slice(2));
  const abs = isAbsolute(v) ? resolve(v) : resolve(h, v);
  return isDir(abs) ? abs : desktop;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const VIDEO_EXT = new Set(["mp4", "mov"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "heic", "heif", "webp"]);
/** Image types TikTok photo posts can't take (counted into unsupported_count). */
const OTHER_IMAGE_EXT = new Set([
  "gif", "tif", "tiff", "bmp", "avif", "jxl", "jp2", "psd",
  "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw", "x3f", "3fr", "erf", "kdc", "mrw", "raw", "rwl", "iiq",
]);
/** Directories that are macOS packages or app libraries: never descended into. */
const PACKAGE_EXT = new Set([
  "app", "photoslibrary", "photolibrary", "migratedphotolibrary", "aplibrary", "imovielibrary", "theater", "fcpbundle", "fcpcache", "fcpxmld",
  "tvlibrary", "musiclibrary", "dvdmedia", "band", "logicx", "bundle", "framework", "plugin", "kext", "pkg", "mpkg", "rtfd", "pages", "numbers",
  "key", "xcodeproj", "xcworkspace", "xcassets", "playground", "sparsebundle", "lrdata", "lrlibrary", "cocatalog", "screenflow", "screenstudio",
  "download", "photoboothlibrary",
]);
const PACKAGE_NAMES = new Set(["photo booth library"]);
/** A sibling with one of these suffixes means the download isn't finished (Firefox leaves an empty placeholder next to `.part`). */
const PARTIAL_SUFFIXES = [".part", ".crdownload"];
const FRESH_MS = 5_000;
const MAX_SUBDIRS_PER_ROOT = 2_000;
const MAX_ENTRIES_PER_ROOT = 50_000;
/** How many candidates get an exact date added (≈ 0.35 ms each); the rest keep birthtime/mtime. */
const JXA_CANDIDATES = 1_000;
const BATCH_GAP_MS = 120_000;

interface Root {
  path: string;
  label: string;
  /** Subfolder levels to descend: 1 normally, 0 if the folder is home itself. */
  depth: number;
}

interface Candidate {
  path: string;
  name: string;
  folder: string;
  /** Lower-case, no dot. */
  ext: string;
  supported: boolean;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  /** An upper bound on arrival (ctime moves whenever a file is added to a folder). */
  upperMs: number;
  /** iCloud-evicted (no local blocks): don't read it. */
  dataless: boolean;
  addedMs: number;
}

interface Scan {
  files: Candidate[];
  denied: string[];
  searched: string[];
}

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};
const isPackage = (name: string) => PACKAGE_EXT.has(extOf(name)) || PACKAGE_NAMES.has(name.toLowerCase());
const canon = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** "Downloads", "Movies/Exports"; a folder outside home shows its basename. */
function displayFolder(home: string, dir: string): string {
  const rel = relative(home, dir);
  if (rel === "") return "Home";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return basename(dir) || dir;
  return rel.split(sep).join("/");
}

const VIDEO_FOLDERS = ["Downloads", "Desktop", "Movies"];
const IMAGE_FOLDERS = ["Downloads", "Desktop", "Pictures", "Screenshots"];

async function resolveRoots(all: string[], home: string, folders: string[] | undefined, runner: Runner): Promise<Root[]> {
  const want = new Set((folders ?? []).map((f) => String(f).trim().toLowerCase()));
  let names = want.size ? all.filter((f) => want.has(f.toLowerCase())) : all;
  if (!names.length) names = all;
  const homeKey = canon(home);
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const name of names) {
    const path = name === "Screenshots" ? await screenshotFolder(home, runner) : join(home, name);
    const key = canon(path);
    if (seen.has(key)) continue; // e.g. the screenshot folder is ~/Downloads or ~/Desktop
    seen.add(key);
    roots.push({ path, label: displayFolder(home, path), depth: key === homeKey ? 0 : 1 });
  }
  return roots;
}

function scan(roots: Root[], supported: Set<string>, other: Set<string>, now: number): Scan {
  const out: Scan = { files: [], denied: [], searched: [] };
  const seen = new Set<string>();
  let skippedDirs = 0;
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root.path, { withFileTypes: true });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EPERM" || code === "EACCES") out.denied.push(root.label);
      else if (code !== "ENOENT" && code !== "ENOTDIR") log(`scan: a folder failed (${code ?? "error"})`);
      continue;
    }
    out.searched.push(root.label);
    const budget = { entries: MAX_ENTRIES_PER_ROOT };
    const subdirs = visit(root.path, root.label, entries, root.depth > 0, budget);
    for (const [dir, label] of subdirs.slice(0, MAX_SUBDIRS_PER_ROOT)) {
      if (budget.entries <= 0) break;
      try {
        visit(dir, label, readdirSync(dir, { withFileTypes: true }), false, budget);
      } catch {
        skippedDirs++; // an unreadable subfolder isn't worth a permission prompt
      }
    }
  }
  if (skippedDirs) log(`scan: ${skippedDirs} unreadable subfolders skipped`);
  return out;

  function visit(dir: string, label: string, entries: Dirent[], descend: boolean, budget: { entries: number }): Array<[string, string]> {
    const names = new Set(entries.map((d) => d.name));
    const subdirs: Array<[string, string]> = [];
    for (const d of entries) {
      if (--budget.entries < 0) break;
      const name = d.name;
      if (name.startsWith(".") || /[\u0000-\u001f\u007f]/.test(name)) continue;
      if (d.isSymbolicLink()) continue; // never follow links out of the allowlisted folders
      let dirLike = d.isDirectory();
      let fileLike = d.isFile();
      if (!dirLike && !fileLike) {
        try {
          const st = lstatSync(join(dir, name));
          dirLike = st.isDirectory();
          fileLike = st.isFile();
        } catch {
          continue;
        }
      }
      if (dirLike) {
        if (descend && !isPackage(name)) subdirs.push([join(dir, name), `${label}/${name}`]);
        continue;
      }
      if (!fileLike) continue;
      const ext = extOf(name);
      const isSupported = supported.has(ext);
      if (!isSupported && !other.has(ext)) continue;
      if (PARTIAL_SUFFIXES.some((s) => names.has(name + s))) continue;
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size <= 0) continue;
      const age = now - st.mtimeMs;
      if (age >= 0 && age < FRESH_MS) continue; // still being written
      const id = `${st.dev}:${st.ino}`;
      if (seen.has(id)) continue; // reached twice (nested screenshot folder) or a hard link
      seen.add(id);
      const birth = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : 0;
      out.files.push({
        path,
        name,
        folder: label,
        ext,
        supported: isSupported,
        size: st.size,
        mtimeMs: st.mtimeMs,
        birthtimeMs: birth,
        upperMs: Math.max(st.ctimeMs || 0, birth, st.mtimeMs),
        dataless: st.blocks === 0 && st.size > 4096,
        addedMs: birth || st.mtimeMs,
      });
    }
    return subdirs;
  }
}

/** Date added for the candidates most likely to be shown (best query score, then newest ctime); everyone else keeps birthtime → mtime. */
async function assignArrival(files: Candidate[], q: Query, runner: Runner): Promise<void> {
  if (!files.length) return;
  const pre = new Map(files.map((f) => [f, scoreName(q, f.name).score]));
  const pick = [...files].sort((a, b) => pre.get(b)! - pre.get(a)! || b.upperMs - a.upperMs).slice(0, JXA_CANDIDATES);
  const added = await dateAdded(
    pick.map((f) => f.path),
    runner,
  );
  for (const f of files) {
    const a = added.get(f.path);
    if (a !== undefined) f.addedMs = a;
  }
}

const byName = (a: Candidate, b: Candidate) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const newestFirst = (a: Candidate, b: Candidate) => b.addedMs - a.addedMs || byName(a, b);

/**
 * Score, filter and sort: matches first by score then arrival; a query that matches nothing → newest overall,
 * query_matched false. `fuzzy`: the best match only matched as a near spelling.
 */
function rank(files: Candidate[], q: Query): { ranked: Candidate[]; matched: boolean; fuzzy: boolean } {
  const scored = files.map((f) => ({ f, ...scoreName(q, f.name) }));
  const matched = !q.meaningful || scored.some((s) => s.hit);
  let pool = scored;
  if (q.required.length) pool = matched ? scored.filter((s) => s.score > 0) : scored.map((s) => ({ ...s, score: 1, fuzzy: false }));
  pool.sort((a, b) => b.score - a.score || newestFirst(a.f, b.f));
  return { ranked: pool.map((s) => s.f), matched, fuzzy: matched && pool.length > 0 && pool[0].fuzzy };
}

/** From the newest arrival, every file that arrived ≤ 120 s after the previous one (an AirDrop batch). */
function newestCluster(files: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const f of [...files].sort(newestFirst)) {
    if (out.length && out[out.length - 1].addedMs - f.addedMs > BATCH_GAP_MS) break;
    out.push(f);
  }
  return out;
}

function clockLabel(t: number, now: number): string {
  const d = new Date(t);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(t) === day(now)) return `at ${time}`;
  if (day(t) === day(now - 86_400_000)) return `yesterday at ${time}`;
  return `on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}

function batchHint(cluster: Candidate[], now: number): string {
  const when = clockLabel(Math.max(...cluster.map((c) => c.addedMs)), now);
  return cluster.length === 1 ? `1 image arrived ${when}` : `${cluster.length} images arrived together ${when}`;
}

const SCREENSHOT_PREFIXES = [
  "screenshot", "screen shot", "cleanshot", "capture d'écran", "bildschirmfoto", "スクリーンショット", "captura de pantalla", "captura de tela",
  "captura de ecrã", "schermata", "skärmavbild", "schermafbeelding", "zrzut ekranu", "снимок экрана", "знімок екрана", "截屏", "截圖", "螢幕截圖",
  "螢幕快照", "스크린샷", "ekran resmi", "näyttökuva", "skjermbilde", "skærmbillede", "snímek obrazovky", "képernyőfotó", "στιγμιότυπο οθόνης",
];
/** macOS screenshot names (English and common localizations). iPhone screenshots arrive as IMG_… and can't be told apart by name. */
function isScreenshotName(name: string): boolean {
  const n = normName(name).toLowerCase().replace(/[‘’ʼ]/g, "'");
  return SCREENSHOT_PREFIXES.some((p) => n.startsWith(p));
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function assertSomeFolderReadable(s: Scan): void {
  if (s.denied.length && !s.searched.length) throw new TikTokError("FOLDER_PERMISSION_DENIED", { folders: s.denied });
}

// ---------------------------------------------------------------------------
// find_recent_videos
// ---------------------------------------------------------------------------

/** A video the server already knows (the focus, a card's numbered videos): matched to the disk by path, size and mtime. */
export interface KnownVideo {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtimeMs: number;
}

/** What the conversation already holds (src/session.ts), so "it", "the second one" and "the other one" resolve. */
export interface FindContext {
  focus?: KnownVideo;
  /** The numbered videos on the last card, in card order. */
  shown?: KnownVideo[];
  /** The ranking behind that card (alternatives the card didn't show). */
  ranked?: KnownVideo[];
  /** The search behind that card, so "the other one" ranks the alternatives by it. */
  previous?: { describe?: string; query?: string };
}

/** `web_download`: downloaded from a website or browser (not "in the Downloads folder"; that's `folders`). "downloaded" is the old name. */
export type VideoSource = "any" | "finder_selection" | "quicktime" | "screen_recording" | "phone" | "web_download" | "downloaded";

export interface FindVideosOptions {
  home: string;
  /** Words from the file name (the original field; parsed like `describe`). */
  query?: string;
  folders?: string[];
  limit: number;
  runner: Runner;
  clock: Clock;
  /** The user's own words, ≤ 160 chars ("the vertical one from yesterday"). */
  describe?: string;
  /** Epoch ms. */
  added_after?: number;
  added_before?: number;
  min_duration_sec?: number;
  max_duration_sec?: number;
  orientation?: Orientation;
  source?: VideoSource;
  /** 1-based position on the last card, or "current" (the video in progress). */
  pick?: number | "current";
  context?: FindContext;
}

/** A found video with the words that describe it. Every extra field is optional, so test fakes may leave them out. */
export interface FoundVideoX extends FoundVideo {
  /** 1-based, as numbered on the card. */
  rank?: number;
  /** "vertical · 0:37 · added yesterday 9:14 PM · Movies › Tiny AI Lab · downloaded from youtube.com". */
  descriptor?: string;
  /** Short reasons it matched ("added yesterday 9:14 PM", "vertical", "name is spelled a little differently"). */
  why?: string[];
  /** Card chips: ["vertical", "yesterday 9:14 PM", "screen recording"]. */
  chips?: string[];
  orientation?: Orientation;
  quality?: string;
  has_audio?: boolean;
  source_label?: string;
  /** The video in progress (src/session.ts). */
  in_progress?: boolean;
  /** The clear match (confidence exact or likely). */
  best?: boolean;
}

export interface FoundVideos {
  videos: FoundVideoX[];
  query_matched: boolean;
  denied_folders: string[];
  searched_folders: string[];
  /** The best match only matched the query as a near spelling ("strawbery" → "strawberry"). */
  query_fuzzy?: boolean;
  /** Nothing in the folders asked for matched the query; these matches are from the other video folders. */
  found_elsewhere?: boolean;
  /** With found_elsewhere: the folders that were asked for (and had no match). */
  requested_folders?: string[];
  /** How sure the first video is the one meant (see src/finderMatch.ts). Absent from test fakes. */
  confidence?: Confidence;
  /** With ambiguous: one short question naming the difference. */
  question?: string;
  /** What was understood from the description, in plain words. */
  understood?: string[];
  /** With none: what the closest video doesn't fit. */
  unmet?: string[];
  /** Typos fixed in the description: [said, read as]. */
  corrections?: Array<[string, string]>;
  /** How the answer was found. */
  mode?: "search" | "current" | "list" | "relative" | "finder_selection" | "quicktime";
  /** "show it in Finder" was asked. */
  reveal?: boolean;
  /** "it"/"that video" was asked but nothing is in progress. */
  no_focus?: boolean;
  /** Finder selection / QuickTime: what went wrong, and how many pointed-at items weren't videos. */
  pointed?: { app: "Finder" | "QuickTime"; failure?: PointedFailure; skipped: number; count: number };
  /** How many videos fit everything said. */
  fits?: number;
  /** Found by its name (or title, tag, comment) although something else said doesn't fit; `unmet` says what. */
  by_name?: boolean;
  /** Server side only (paths): the next best after `videos`, for "the other one" later. */
  alternates?: KnownVideo[];
}

/** Facts are read for at most this many candidates per search (newest and best-named first). */
const FACTS_POOL = 150;

const mimeOf = (c: Candidate, info?: VideoInfo) => info?.mime ?? (c.ext === "mov" ? "video/quicktime" : "video/mp4");

/** A candidate for a path the server was pointed at or already knew. Null when it isn't a usable file any more. */
function candidateAt(path: string, home: string): Candidate | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size <= 0) return null;
  const name = basename(path);
  const birth = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : 0;
  return {
    path,
    name,
    folder: displayFolder(home, dirname(path)),
    ext: extOf(name),
    supported: true,
    size: st.size,
    mtimeMs: st.mtimeMs,
    birthtimeMs: birth,
    upperMs: Math.max(st.ctimeMs || 0, birth, st.mtimeMs),
    dataless: st.blocks === 0 && st.size > 4096,
    addedMs: birth || st.mtimeMs,
  };
}

interface Described {
  c: Candidate;
  info?: VideoDetailsInfo;
  facts: Facts;
}

/**
 * Date added (one JXA call), Spotlight + quarantine (one mdls and one xattr call) and the container's own
 * facts for up to FACTS_POOL candidates, all at once. Everyone else is described from the scan alone.
 */
async function describeAll(files: Candidate[], q: Query, runner: Runner, wantFacts: boolean): Promise<Described[]> {
  if (!files.length) return [];
  const pre = new Map(files.map((f) => [f, scoreName(q, f.name).score]));
  const pool = wantFacts ? [...files].sort((a, b) => pre.get(b)! - pre.get(a)! || b.upperMs - a.upperMs).slice(0, FACTS_POOL) : [];
  const [, facts] = await Promise.all([
    assignArrival(files, q, runner),
    pool.length ? fileFacts(pool.map((p) => p.path), runner) : Promise.resolve(new Map<string, FileFacts>()),
  ]);
  const metaOk = [...facts.values()].some((f) => f.spot || f.agent);
  const inPool = new Set(pool);
  return files.map((c) => {
    let info: VideoDetailsInfo | undefined;
    if ((inPool.has(c) || !wantFacts) && !c.dataless) {
      try {
        info = wantFacts ? mp4Details(c.path) : mp4Info(c.path);
      } catch {
        info = undefined; // vanished or unreadable since the scan: described without it
      }
    }
    const ff = facts.get(c.path);
    return { c, info, facts: factsOf({ name: c.name, folder: c.folder, size: c.size, addedMs: c.addedMs }, info, ff, metaOk && inPool.has(c)) };
  });
}

/** The output shape of a described candidate. */
function toVideoX(x: Described, now: number, ev?: Evaluation): FoundVideoX {
  const { c, info, facts: f } = x;
  const v: FoundVideoX = { path: c.path, name: c.name, folder: c.folder, size: c.size, mtimeMs: c.mtimeMs, addedMs: c.addedMs, mime: mimeOf(c, info) };
  if (f.duration_sec !== undefined) v.duration_sec = f.duration_sec;
  if (f.width && f.height) {
    v.width = f.width;
    v.height = f.height;
  }
  v.descriptor = descriptor(f, now);
  v.chips = chips(f, now);
  if (f.orientation) v.orientation = f.orientation;
  if (f.quality) v.quality = f.quality;
  if (f.has_audio !== undefined) v.has_audio = f.has_audio;
  if (f.sourceLabel) v.source_label = f.sourceLabel;
  if (ev) {
    const why = ev.checks.filter((k) => k.verdict === "yes").map((k) => k.why ?? k.label);
    if (ev.near?.length) why.push(...ev.near.map(([said, name]) => `"${said}" read as "${name}"`));
    if (why.length) v.why = [...new Set(why)].slice(0, 5);
  }
  return v;
}

const sameKnown = (a: { path: string; size: number; mtimeMs: number }, b: { path: string; size: number; mtimeMs: number }) =>
  a.path === b.path && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;

/** Merge the parsed query into the description, then the structured fields (they win). */
function describeFrom(o: FindVideosOptions, now: number): Describe {
  const d = parseDescribe(o.describe, now);
  if (o.query) {
    // `query` keeps its original meaning: words from the file name (export/final/render boost). A reference
    // ("the other one", "not that one", "the same one", "the second one") passed as query counts as said.
    const ref = parseDescribe(o.query.slice(0, 80), now);
    if (ref.relative || ref.listRef || ref.current === "strong") {
      d.relative ??= ref.relative;
      d.listRef ??= ref.listRef;
      if (ref.current === "strong" && !d.relative) d.current ??= "strong";
      for (const u of ref.understood) if (!d.understood.includes(u)) d.understood.push(u);
    }
    const q = ref.relative || ref.listRef || ref.current === "strong" ? { required: ref.keywords, boost: ref.boost, meaningful: ref.keywords.length > 0 } : parseQuery(o.query.slice(0, 80));
    for (const k of q.required) if (!d.keywords.includes(k)) d.keywords.push(k);
    d.boost ||= q.boost;
    const label = q.required.length ? `named like "${d.keywords.join(" ")}"` : q.boost ? "an export" : "";
    d.understood = d.understood.filter((u) => !u.startsWith("named like"));
    if (label && !d.understood.includes(label)) d.understood.push(label);
  }
  const after = Number(o.added_after);
  const before = Number(o.added_before);
  if (Number.isFinite(after) || Number.isFinite(before)) {
    const from = Number.isFinite(after) ? after : 0;
    const to = Number.isFinite(before) ? before : now + 60_000;
    const label = Number.isFinite(after) && Number.isFinite(before) ? `added between ${whenLabel(from, now)} and ${whenLabel(to, now)}` : Number.isFinite(after) ? `added after ${whenLabel(from, now)}` : `added before ${whenLabel(to, now)}`;
    d.time = d.time ? { ...d.time, from: Math.max(d.time.from, from), to: Math.min(d.time.to, to) } : { from, to, label, basis: "added" };
    if (!d.understood.includes(label) && d.time.label === label) d.understood.push(label);
  }
  const min = Number(o.min_duration_sec);
  const max = Number(o.max_duration_sec);
  if ((Number.isFinite(min) && min > 0) || (Number.isFinite(max) && max > 0)) {
    const w = {
      ...(Number.isFinite(min) && min > 0 ? { min } : {}),
      ...(Number.isFinite(max) && max > 0 ? { max } : {}),
      label: Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0 ? `${Math.round(min)}–${Math.round(max)} s long` : Number.isFinite(min) && min > 0 ? `over ${Math.round(min)} s` : `under ${Math.round(max)} s`,
    };
    d.duration = w;
    if (!d.understood.includes(w.label)) d.understood.push(w.label);
  }
  if (o.orientation === "vertical" || o.orientation === "landscape" || o.orientation === "square") {
    d.orientation = o.orientation;
    if (!d.understood.includes(o.orientation)) d.understood.push(o.orientation);
  }
  if (o.source === "finder_selection") d.finder = true;
  else if (o.source === "quicktime") d.quicktime = true;
  else if (o.source === "screen_recording" || o.source === "phone") {
    if (!d.sources.includes(o.source)) d.sources.push(o.source);
  } else if (o.source === "web_download" || o.source === "downloaded") {
    // The old value "downloaded" next to the Downloads folder ("the video from downloads") meant the folder.
    const meantFolder = o.source === "downloaded" && (d.folders.includes("Downloads") || (o.folders ?? []).includes("Downloads") || /\bdownloads\b/i.test(o.describe ?? ""));
    if (!meantFolder && !d.sources.includes("downloaded")) d.sources.push("downloaded");
    if (meantFolder && !d.folders.includes("Downloads") && !(o.folders ?? []).includes("Downloads")) d.folders.push("Downloads");
  }
  if (o.pick === "current") {
    d.current = "strong";
    d.relative = undefined;
    d.listRef = undefined;
  } else if (typeof o.pick === "number" && Number.isInteger(o.pick) && o.pick >= 1 && o.pick <= 20 && !d.listRef && !d.order) {
    d.listRef = o.pick;
  }
  return d;
}

/**
 * A ranking of name matches that don't fit everything else said: the best is offered as likely (one match, or one
 * that fits more of the rest, or a clearly better name), else it's a toss-up between the equally good ones.
 * `unmet` is what the best one doesn't fit.
 */
function nameRanking(r: Ranking<Described>): Ranking<Described> {
  if (r.fits > 0) return { ...r, confidence: r.confidence === "exact" ? "likely" : r.confidence, unmet: [] };
  const [top, second] = r.ranked;
  const unmet = top ? top.ev.checks.filter((c) => c.verdict === "no").map((c) => c.label) : [];
  if (!top) return { ...r, confidence: "none", unmet };
  const clear = !second || top.ev.no < second.ev.no || top.ev.kw >= second.ev.kw + 0.3;
  const tied = clear ? 1 : r.ranked.filter((x) => x.ev.no === top.ev.no && x.ev.kw === top.ev.kw).length;
  return { ...r, confidence: clear ? "likely" : "ambiguous", unmet, tied, fuzzy: top.ev.kwFuzzy };
}

/** The same description without the parts already used up (selection, position, "it"…), for ranking what's left. */
const rest = (d: Describe): Describe => ({ ...d, listRef: undefined, relative: undefined, current: undefined, finder: undefined, quicktime: undefined, reveal: undefined });

/**
 * Finds the video the user means. With nothing described: the newest .mp4/.mov files in Downloads, Desktop
 * and Movies (or `folders`), by date added, as before. With a description (`describe`, `query`, or the
 * structured fields): every candidate's metadata is checked against it and the answer comes with a
 * confidence, a descriptor per video and, when it's a toss-up, the one question to ask. "it" / pick
 * "current" resolves to context.focus, "the second one" to context.shown, "the other one" / "the one before
 * that" relative to them, and source finder_selection / quicktime to what the user is pointing at.
 * EPERM/EACCES on a folder → partial results + denied_folders; every folder denied → FOLDER_PERMISSION_DENIED.
 */
export async function findRecentVideos(o: FindVideosOptions): Promise<FoundVideos> {
  const t0 = performance.now();
  const home = resolve(o.home);
  const limit = clampInt(o.limit, 1, 6, 5);
  const now = o.clock.now();
  const d = describeFrom(o, now);
  const q = queryOf(d.keywords, d.boost);
  const ctx = o.context ?? {};
  const extras = {
    understood: d.understood,
    ...(d.corrections.length ? { corrections: d.corrections } : {}),
    ...(d.reveal ? { reveal: true } : {}),
  };
  const done = (r: FoundVideos, what: string): FoundVideos => {
    log(`find_recent_videos(${r.mode ?? "search"}): ${what}, ${r.videos.length} returned, ${r.confidence ?? "-"}, ${Math.round(performance.now() - t0)} ms`);
    return r;
  };
  const known = async (list: KnownVideo[]): Promise<Described[]> => {
    const cands = list.map((k) => {
      const c = candidateAt(k.path, home);
      return c ? { ...c, folder: k.folder || c.folder } : null;
    }).filter((c): c is Candidate => Boolean(c));
    return describeAll(cands, q, o.runner, true);
  };
  const one = (x: Described, mode: FoundVideos["mode"], confidence: Confidence, extra: Partial<FoundVideos> = {}): FoundVideos => {
    const v = toVideoX(x, now, evaluate(rest(d), x.facts, now));
    v.rank = 1;
    v.best = confidence === "exact" || confidence === "likely";
    if (ctx.focus && sameKnown(ctx.focus, x.c)) v.in_progress = true;
    return { videos: [v], query_matched: true, denied_folders: [], searched_folders: [], confidence, mode, fits: 1, ...extras, ...extra };
  };

  // 1. "it" / "that video" / pick "current": the video in progress.
  if (d.current === "strong" && !d.relative) {
    if (ctx.focus) {
      const [x] = await known([ctx.focus]);
      if (x) return done(one(x, "current", "exact"), "the video in progress");
    }
    d.current = undefined;
  }
  const noFocus = !d.relative && (o.pick === "current" || (d.current === undefined && /\b(it|that|this|same)\b/i.test(o.describe ?? "") && !described(rest(d)) && !ctx.focus));

  // 2. What the user points at: Finder's selection, QuickTime's front document.
  if (d.finder || d.quicktime) {
    const app = d.finder ? "Finder" : "QuickTime";
    const p = d.finder ? await finderSelection(o.runner) : await quicktimeDocuments(o.runner);
    const pointed = { app, ...(p.failure ? { failure: p.failure } : {}), skipped: p.skipped, count: p.paths.length } as FoundVideos["pointed"];
    const mode = d.finder ? "finder_selection" : "quicktime";
    if (!p.paths.length) {
      return done({ videos: [], query_matched: true, denied_folders: [], searched_folders: [], confidence: "none", mode, pointed, fits: 0, ...extras }, `nothing usable ${p.failure ?? ""}`.trim());
    }
    const xs = await known(p.paths.map((path) => ({ path, name: basename(path), folder: "", size: 0, mtimeMs: 0 })));
    const r = rankVideos(xs.map((x) => ({ item: x, facts: x.facts })), rest(d), now);
    const shown = r.ranked.slice(0, r.confidence === "none" ? Math.min(3, limit) : limit);
    // Several selected and nothing else said: the user means one of them, so ask (front-most first).
    const confidence: Confidence = xs.length === 1 ? (r.confidence === "none" ? "none" : "exact") : r.confidence === "likely" && !described(rest(d)) ? "ambiguous" : r.confidence;
    const videos = shown.map((s, i) => ({ ...toVideoX(s.item, now, s.ev), rank: i + 1, ...(i === 0 && (confidence === "exact" || confidence === "likely") ? { best: true } : {}) }));
    const question = confidence === "ambiguous" ? whichQuestion(shown.map((s) => s.facts), now) : undefined;
    return done(
      { videos, query_matched: true, denied_folders: [], searched_folders: [], confidence, mode, pointed, fits: r.fits, ...(question ? { question } : {}), ...(r.unmet.length ? { unmet: r.unmet } : {}), ...extras },
      `${xs.length} pointed at`,
    );
  }

  // 3. "the second one": a position on the card the user just saw.
  if (d.listRef && ctx.shown?.length && !d.relative) {
    const k = ctx.shown[d.listRef - 1];
    if (!k) {
      return done(
        { videos: [], query_matched: true, denied_folders: [], searched_folders: [], confidence: "none", mode: "list", fits: 0, unmet: [`number ${d.listRef} (the card showed ${ctx.shown.length})`], ...extras },
        "position past the card",
      );
    }
    const [x] = await known([k]);
    if (x) return done(one(x, "list", "exact"), `number ${d.listRef} on the card`);
  }

  // 4. "the other one": the card's other video(s), or the next best of the last ranking.
  // (A card of one, or none: the search below, without the video in focus, ranked by the earlier search.)
  if (d.relative === "other" && ctx.shown && ctx.shown.length > 1) {
    const notFocus = (k: KnownVideo) => !(ctx.focus ? sameKnown(ctx.focus, k) : false);
    const pool = ctx.shown.filter(notFocus);
    const xs = await known(pool);
    if (xs.length === 1) return done(one(xs[0], "relative", "exact"), "the other one");
    if (xs.length > 1) {
      const r = rankVideos(xs.map((x) => ({ item: x, facts: x.facts })), rest(d), now);
      const conf: Confidence = described(rest(d)) ? r.confidence : "ambiguous";
      const shown = r.ranked.slice(0, limit);
      const question = conf === "ambiguous" ? whichQuestion(shown.map((s) => s.facts), now, { names: true }) : undefined;
      return done(
        {
          videos: shown.map((s, i) => ({ ...toVideoX(s.item, now, s.ev), rank: i + 1, ...(i === 0 && (conf === "exact" || conf === "likely") ? { best: true } : {}) })),
          query_matched: true, denied_folders: [], searched_folders: [], confidence: conf, mode: "relative", fits: r.fits, ...(question ? { question } : {}), ...extras,
        },
        "the other ones",
      );
    }
  }

  // 5. The search itself.
  const folders = [...new Set([...(o.folders ?? []), ...d.folders])];
  const roots = await resolveRoots(VIDEO_FOLDERS, home, folders.length ? folders : undefined, o.runner);
  const s = scan(roots, VIDEO_EXT, new Set(), now);
  // "the other one" / "not that one" with no card of several: everything but the video in focus and the last
  // card's first, ranked by the earlier search when nothing new was said, else by recency.
  const otherMode = d.relative === "other";
  const excluded = otherMode ? [ctx.focus, ctx.shown?.[0]].filter((k): k is KnownVideo => Boolean(k)) : [];
  const earlier =
    otherMode && !described(rest(d)) && (ctx.previous?.describe || ctx.previous?.query)
      ? describeFrom({ home: o.home, limit, runner: o.runner, clock: o.clock, describe: ctx.previous.describe, query: ctx.previous.query }, now)
      : undefined;
  const look = earlier ? rest(earlier) : rest(d);
  const isExcluded = (x: Described) => excluded.some((k) => sameKnown(k, x.c));
  let xs = s.searched.length ? (await describeAll(s.files, queryOf(look.keywords, look.boost), o.runner, true)).filter((x) => !isExcluded(x)) : [];
  const focusOf = (x: Described) => Boolean(ctx.focus && sameKnown(ctx.focus, x.c));
  const rankOf = (list: Described[], want: Describe) => rankVideos(list.map((x) => ({ item: x, facts: x.facts, focus: focusOf(x) })), want, now);
  // A word no video's name or details has ("acctualli", a slip of the tongue) is set aside when other things
  // were said; a description of only unknown words still comes back as "nothing matched".
  const unmatchedIn = (list: Described[]) => look.keywords.filter((k) => !list.some((x) => keywordHit(k, x.facts)));
  const others = VIDEO_FOLDERS.filter((f) => !roots.some((root) => root.label === f));
  const canLookElsewhere = others.length > 0 && folders.length > 0;
  let unmatched = unmatchedIn(xs);
  let kwMatched = !look.keywords.length || unmatched.length < look.keywords.length;
  const relaxable = (u: string[], hit: boolean) => u.length > 0 && (hit || described({ ...look, keywords: [] }) || Boolean(d.current === "soft" && ctx.focus));
  // The name comes first: a video whose name (or title, tag, comment) has the user's words is offered even when
  // other things said don't fit it (wrong folder, not a web download, another day). Those re-rank it and are
  // reported; they never hide it. Order: everything fits here → the name fits here → everything fits in the
  // other folders → the name fits there → (only then) words that match nothing are set aside.
  const strict = { ...look };
  const byNameIn = (list: Described[]): Ranking<Described> | undefined => {
    if (!look.keywords.length) return undefined;
    const missing = unmatchedIn(list);
    const words = look.keywords.filter((k) => !missing.includes(k));
    if (!words.length || words.length * 2 < look.keywords.length) return undefined;
    const hits = list.filter((x) => words.every((w) => keywordHit(w, x.facts)));
    return hits.length ? rankOf(hits, { ...look, keywords: words }) : undefined;
  };
  let r = rankOf(xs, strict);
  let byName = false;
  let elsewhere = false;
  let s2: Scan | undefined;
  if (r.fits === 0) {
    const here = byNameIn(xs);
    if (here) {
      r = here;
      byName = true;
    } else if (described(look) && canLookElsewhere) {
      const more = await resolveRoots(VIDEO_FOLDERS, home, others, o.runner);
      s2 = scan(more, VIDEO_EXT, new Set(), now);
      const xs2 = (await describeAll(s2.files, q, o.runner, true)).filter((x) => !isExcluded(x));
      const r2 = rankOf(xs2, strict);
      const there = r2.fits > 0 ? undefined : byNameIn(xs2);
      if (r2.fits > 0 || there) {
        xs = xs2;
        r = there ?? r2;
        byName = Boolean(there);
        elsewhere = true;
        kwMatched = true;
        unmatched = [];
      }
    }
  }
  if (byName) kwMatched = true;
  if (!elsewhere && !byName && r.fits === 0 && relaxable(unmatched, kwMatched)) {
    look.keywords = look.keywords.filter((k) => !unmatched.includes(k));
    r = rankOf(xs, look);
  }
  if (byName) r = nameRanking(r);
  let otherNames = false;
  if (otherMode) {
    if (r.fits === 0 || (!earlier && !described(rest(d)))) {
      // Nothing else fits the earlier search: the alternatives by recency, one question naming them.
      r = rankOf(xs, emptyDescribe());
      r = { ...r, confidence: xs.length === 1 ? "likely" : xs.length ? "ambiguous" : "none", tied: Math.min(3, xs.length), unmet: [] };
      otherNames = true;
    } else {
      r = { ...r, confidence: r.fits === 1 ? "likely" : r.confidence === "exact" ? "likely" : r.confidence };
    }
  }
  // "it" plus words that match nothing: the video in progress after all (if it's in the folder named, when one was).
  const focusInFolders = Boolean(ctx.focus && (!folders.length || folders.some((f) => ctx.focus!.folder === f || ctx.focus!.folder.startsWith(`${f}/`))));
  if (d.current === "soft" && ctx.focus && focusInFolders && !described(look) && !d.relative) {
    const [x] = await known([ctx.focus]);
    if (x) return done(one(x, "current", "exact"), "the video in progress (other words matched nothing)");
  }
  if (!elsewhere) assertSomeFolderReadable(s);
  const denied = [...s.denied, ...(s2?.denied ?? [])];
  const searched = [...s.searched, ...(elsewhere && s2 ? s2.searched : [])];

  let ranked = r.ranked;
  let confidence: Confidence = r.confidence;
  let mode: FoundVideos["mode"] = "search";
  // "the one before/after that": the neighbour of the video in progress (or of the card's first) by arrival.
  if (otherMode) mode = "relative";
  else if (d.relative === "before" || d.relative === "after") {
    const anchor = ctx.focus ?? ctx.shown?.[0];
    {
      const byArrival = ranked.slice(0, r.fits).sort((a, b) => b.facts.addedMs - a.facts.addedMs);
      const at = anchor ? byArrival.findIndex((x) => sameKnown(anchor, x.item.c)) : -1;
      const pick = at >= 0 ? byArrival[d.relative === "before" ? at + 1 : at - 1] : d.relative === "before" ? byArrival[1] : undefined;
      if (pick) {
        ranked = [pick, ...ranked.filter((x) => x !== pick)];
        confidence = at >= 0 ? "exact" : "likely";
      } else {
        confidence = "none";
        r = { ...r, unmet: [d.relative === "before" ? "an older video" : "a newer video"] };
      }
    }
    mode = "relative";
  } else if (d.listRef) {
    // "the second one" with no card to point at: the second of this ranking.
    const pick = ranked.slice(0, r.fits)[d.listRef - 1];
    if (pick) {
      ranked = [pick, ...ranked.filter((x) => x !== pick)];
      confidence = "exact";
    }
  }
  if (noFocus) confidence = "none";

  const count = confidence === "exact" ? 1 : confidence === "ambiguous" ? Math.min(limit, Math.max(2, r.tied)) : confidence === "none" ? Math.min(limit, 3) : limit;
  // Only videos that fit are offered, unless none does (then the closest, said as such).
  const shown = (confidence === "none" || byName ? ranked : ranked.slice(0, Math.max(1, r.fits))).slice(0, count);
  const videos = shown.map((x, i) => {
    const v = toVideoX(x.item, now, x.ev);
    v.rank = i + 1;
    if (i === 0 && (confidence === "exact" || confidence === "likely")) v.best = true;
    if (focusOf(x.item)) v.in_progress = true;
    return v;
  });
  const question = confidence === "ambiguous" && videos.length >= 2 ? whichQuestion(shown.map((x) => x.facts), now, { names: otherNames }) : undefined;
  const alternates = (confidence === "none" || byName ? ranked : ranked.slice(0, Math.max(1, r.fits)))
    .filter((x) => !shown.includes(x))
    .slice(0, 5)
    .map((x): KnownVideo => ({ path: x.item.c.path, name: x.item.c.name, folder: x.item.c.folder, size: x.item.c.size, mtimeMs: x.item.c.mtimeMs }));
  const matched = kwMatched;
  const result: FoundVideos = {
    videos,
    query_matched: matched,
    denied_folders: denied,
    searched_folders: searched,
    confidence,
    mode,
    fits: r.fits,
    ...(r.fuzzy && confidence !== "none" ? { query_fuzzy: true } : {}),
    ...(elsewhere ? { found_elsewhere: true, requested_folders: roots.map((root) => root.label) } : {}),
    ...(question ? { question } : {}),
    ...((confidence === "none" || byName) && r.unmet.length ? { unmet: r.unmet } : {}),
    ...(byName ? { by_name: true } : {}),
    ...(noFocus ? { no_focus: true } : {}),
    ...(alternates.length ? { alternates } : {}),
    ...extras,
  };
  return done(result, `${searched.length}/${roots.length} folders, ${s.files.length + (s2?.files.length ?? 0)} candidates, ${r.fits} fit`);
}

// ---------------------------------------------------------------------------
// find_recent_images
// ---------------------------------------------------------------------------

export interface FindImagesOptions {
  home: string;
  query?: string;
  source: "any" | "screenshots" | "recent_batch";
  folders?: string[];
  since_hours?: number;
  limit: number;
  runner: Runner;
  clock: Clock;
}

/** A one-level subfolder of images: "voice clone safety slides" (11 images), the unit a carousel usually is. */
export interface ImageGroup {
  /** The folder's own name. */
  name: string;
  /** Display folder: "Downloads/voice clone safety slides". */
  folder: string;
  /** Supported images in it. */
  count: number;
  /** When its newest image arrived, epoch ms. */
  newest: number;
}

export interface FoundImages {
  images: FoundImage[];
  query_matched: boolean;
  denied_folders: string[];
  batch_hint?: string;
  unsupported_count: number;
  searched_folders: string[];
  /** The images are this folder, whole, in name order (01, 02 … 10, 11). */
  group?: ImageGroup;
  /** exact/likely: go ahead with `images`; ambiguous: ask `question`. Absent when no folder was involved. */
  confidence?: "exact" | "likely" | "ambiguous";
  question?: string;
  /** Other folders that matched too, or arrived around the same time. */
  other_groups?: ImageGroup[];
}

/** Words about the kind of set, not its name: they make a folder wanted but aren't required in names. */
const IMAGE_GROUP_WORDS = /^(?:slides?|decks?|carousels?|pics?|pictures?|imgs?|images?|photos?|sets?|folders?|batch|album|albums|zip)$/;
const IMAGE_FILLER = /^(?:i|i've|ive|just|downloaded|download|downloads|got|saved|airdropped|post|posting|upload|uploading|make|made|out|it|only|me|from|into|a|an|the|my|of|in|on|and|to|for|with|those|these|that|this|new|latest|recent|newest|all|some|please|tiktok)$/;
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const naturalByName = (a: Candidate, b: Candidate) => natural.compare(a.name, b.name);
const IMAGE_GROUP_MAX = 35;

/** The query's name words, and whether it asked for a set ("slides", "carousel", "pics"…). */
function imageQuery(raw: string | undefined): { q: Query; wantsGroup: boolean } {
  const words = normName(raw ?? "").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const wantsGroup = words.some((w) => IMAGE_GROUP_WORDS.test(w));
  return { q: parseQuery(words.filter((w) => !IMAGE_GROUP_WORDS.test(w) && !IMAGE_FILLER.test(w)).join(" ")), wantsGroup };
}

/** Supported images by one-level subfolder (top-level files aren't a group). */
function imageGroups(files: Candidate[]): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>();
  for (const f of files) {
    if (!f.folder.includes("/")) continue;
    const list = out.get(f.folder) ?? [];
    list.push(f);
    out.set(f.folder, list);
  }
  return out;
}
const groupOf = (folder: string, files: Candidate[]): ImageGroup => ({
  name: folder.split("/").pop() ?? folder,
  folder,
  count: files.length,
  newest: Math.max(...files.map((f) => f.addedMs)),
});
const quoteGroup = (g: ImageGroup, now: number) => `“${g.name}” (${g.count} image${g.count === 1 ? "" : "s"}, ${whenLabel(g.newest, now)})`;

/**
 * The newest .jpg/.jpeg/.png/.heic/.heif/.webp files in Downloads, Desktop, Pictures and
 * the screenshot folder (or `folders`), by date added; `limit` 1–35.
 *  - source "screenshots": macOS screenshot names; "recent_batch": the newest cluster of
 *    arrivals ≤ 120 s apart (Mac screenshots left out unless every image is one), with a
 *    batch_hint; "any": newest overall (batch_hint when the newest 2+ arrived together).
 *  - since_hours filters by arrival. The query ranks within the source's set.
 *  - unsupported_count: .gif/.tiff/RAW… files that passed the same filters and are at least as
 *    new as the oldest returned image (inside the batch window for recent_batch; every one
 *    the query named when it has words).
 * Dimensions, format and alpha come from ONE sips call for the returned images.
 */
export async function findRecentImages(o: FindImagesOptions): Promise<FoundImages> {
  const t0 = performance.now();
  const home = resolve(o.home);
  const now = o.clock.now();
  const limit = clampInt(o.limit, 1, 35, 10);
  const source = o.source === "screenshots" || o.source === "recent_batch" ? o.source : "any";
  const { q, wantsGroup } = imageQuery(o.query?.slice(0, 80));
  const roots = await resolveRoots(IMAGE_FOLDERS, home, o.folders, o.runner);
  const s = scan(roots, IMAGE_EXT, OTHER_IMAGE_EXT, now);
  assertSomeFolderReadable(s);

  let files = source === "screenshots" ? s.files.filter((f) => isScreenshotName(f.name)) : s.files;
  await assignArrival(files, q, o.runner);
  const since = Number(o.since_hours);
  if (Number.isFinite(since) && since > 0) files = files.filter((f) => f.addedMs >= now - since * 3_600_000);

  let supported = files.filter((f) => f.supported);
  let unsupported = files.filter((f) => !f.supported);

  // A folder is the set: one whose name has the query's words ("voice clone safety slides"), or, for "the pics
  // I just downloaded", the folder the newest arrival is in. It comes back whole, in name order.
  const groups = source === "screenshots" ? new Map<string, Candidate[]>() : imageGroups(supported);
  let chosen: { folder: string; files: Candidate[] } | undefined;
  let confidence: FoundImages["confidence"];
  let question: string | undefined;
  let others: ImageGroup[] = [];
  if (q.required.length && groups.size) {
    const hits = [...groups]
      .map(([folder, list]) => ({ folder, list, s: scoreName(q, folder.split("/").pop() ?? folder), g: groupOf(folder, list) }))
      .filter((x) => x.s.hit)
      .sort((a, b) => b.s.score - a.s.score || b.g.newest - a.g.newest);
    // A file named like the words, outside those folders, at least as well: the files win ("dinner" for dinner.jpeg).
    const bestFile = Math.max(0, ...supported.filter((f) => !hits.some((h) => h.folder === f.folder)).map((f) => scoreName(q, f.name).score));
    if (hits.length && hits[0].s.score >= bestFile) {
      const tied = hits.filter((h) => h.s.score > hits[0].s.score - 0.25);
      chosen = { folder: hits[0].folder, files: hits[0].list };
      others = hits.slice(1, 4).map((h) => h.g);
      confidence = tied.length > 1 ? "ambiguous" : hits[0].s.fuzzy ? "likely" : "exact";
      if (tied.length > 1) question = `Which set: ${tied.slice(0, 3).map((h) => quoteGroup(h.g, now)).join(tied.length === 2 ? " or " : ", ")}?`;
    }
  } else if (!q.required.length && (source === "recent_batch" || wantsGroup) && groups.size) {
    const arrivals = supported.filter((f) => !isScreenshotName(f.name));
    const newest = [...(arrivals.length ? arrivals : supported)].sort(newestFirst)[0];
    const list = newest ? groups.get(newest.folder) : undefined;
    if (newest && list) {
      const g = groupOf(newest.folder, list);
      chosen = { folder: newest.folder, files: list };
      // Other folders that arrived in the two hours before it; one within 5 minutes makes it a toss-up.
      others = [...groups]
        .filter(([folder]) => folder !== newest.folder)
        .map(([folder, l]) => groupOf(folder, l))
        .filter((x) => g.newest - x.newest <= 2 * 3_600_000)
        .sort((a, b) => b.newest - a.newest)
        .slice(0, 3);
      const close = others.filter((x) => g.newest - x.newest <= 5 * 60_000);
      confidence = close.length ? "ambiguous" : "likely";
      if (close.length) question = `Which set: ${[g, ...close].slice(0, 3).map((x) => quoteGroup(x, now)).join(close.length === 1 ? " or " : ", ")}${close.length > 2 ? ", or another one" : ""}?`;
    }
  }
  if (chosen) {
    const all = [...chosen.files].sort(naturalByName);
    const picked = all.slice(0, IMAGE_GROUP_MAX);
    const group = groupOf(chosen.folder, chosen.files);
    const unsupportedHere = unsupported.filter((f) => f.folder === chosen!.folder).length;
    const meta = await sipsMeta(picked.filter((p) => !p.dataless).map((p) => p.path), o.runner);
    const images = picked.map((c): FoundImage => {
      const img: FoundImage = { path: c.path, name: c.name, folder: c.folder, size: c.size, mtimeMs: c.mtimeMs, addedMs: c.addedMs, ext: c.ext, is_screenshot: isScreenshotName(c.name) };
      const m = meta.get(c.path);
      if (m) {
        img.width = m.width;
        img.height = m.height;
        if (m.format) img.format = m.format;
        img.has_alpha = m.has_alpha;
      }
      return img;
    });
    log(`find_recent_images(${source}): a folder of ${all.length}, ${others.length} other folders, ${confidence}, ${Math.round(performance.now() - t0)} ms`);
    return {
      images,
      query_matched: true,
      denied_folders: s.denied,
      unsupported_count: unsupportedHere,
      searched_folders: s.searched,
      batch_hint: `${all.length} image${all.length === 1 ? "" : "s"} in the folder “${group.name}”${all.length > IMAGE_GROUP_MAX ? ` (TikTok takes ${IMAGE_GROUP_MAX})` : ""}`,
      group,
      ...(confidence ? { confidence } : {}),
      ...(question ? { question } : {}),
      ...(others.length ? { other_groups: others } : {}),
    };
  }

  let batch: Candidate[] | undefined;
  if (source === "recent_batch") {
    const arrivals = supported.filter((f) => !isScreenshotName(f.name));
    const pool = arrivals.length ? arrivals : supported;
    // One place at a time: the newest arrival's folder, never a mix of folders.
    const where = [...pool].sort(newestFirst)[0]?.folder;
    batch = newestCluster(pool.filter((f) => f.folder === where));
    supported = batch;
    if (batch.length) {
      const lo = Math.min(...batch.map((b) => b.addedMs)) - BATCH_GAP_MS;
      const hi = Math.max(...batch.map((b) => b.addedMs)) + BATCH_GAP_MS;
      unsupported = unsupported.filter((f) => f.addedMs >= lo && f.addedMs <= hi);
    }
  }
  const { ranked, matched } = rank(supported, q);
  const picked = ranked.slice(0, limit);

  if (q.required.length) unsupported = unsupported.filter((f) => scoreName(q, f.name).score > 0);
  else if (picked.length) {
    const oldest = Math.min(...picked.map((p) => p.addedMs));
    unsupported = unsupported.filter((f) => f.addedMs >= oldest);
  }

  const cluster = batch ?? newestCluster(ranked);
  const batch_hint = cluster.length >= 2 || (batch && cluster.length === 1) ? batchHint(cluster, now) : undefined;

  // iCloud-evicted files would be downloaded by sips (and could blow its timeout): they stay without dimensions.
  const meta = await sipsMeta(
    picked.filter((p) => !p.dataless).map((p) => p.path),
    o.runner,
  );
  const images = picked.map((c): FoundImage => {
    const img: FoundImage = { path: c.path, name: c.name, folder: c.folder, size: c.size, mtimeMs: c.mtimeMs, addedMs: c.addedMs, ext: c.ext, is_screenshot: isScreenshotName(c.name) };
    const m = meta.get(c.path);
    if (m) {
      img.width = m.width;
      img.height = m.height;
      if (m.format) img.format = m.format;
      img.has_alpha = m.has_alpha;
    }
    return img;
  });
  log(`find_recent_images(${source}): ${s.searched.length}/${roots.length} folders, ${files.length} candidates, ${images.length} returned, ${Math.round(performance.now() - t0)} ms`);
  const result: FoundImages = {
    images,
    query_matched: matched,
    denied_folders: s.denied,
    unsupported_count: unsupported.length,
    searched_folders: s.searched,
  };
  if (batch_hint) result.batch_hint = batch_hint;
  return result;
}
