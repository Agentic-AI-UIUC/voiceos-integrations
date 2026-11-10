/**
 * What VoiceOS sent to TikTok, and the rule that only one write runs at a time
 * per account (plan §6.15).
 *
 * Only Me posts and drafts never appear in list_videos or query_videos, so
 * "did it go up?", "what did I post today?" and "what caption did I use?" are
 * answered from here. An entry is created when a write is accepted (before
 * TikTok answers), so a question asked mid-upload finds it, and its stage moves
 * staging → uploading → processing → done | failed | unknown. Refused attempts
 * (nothing sent: no card approval, a stale token) are recorded too, with no
 * media, so the agent can say what happened to them.
 *
 * The ledger persists in the integration's state folder (ledger.json, next to
 * spent-receipts.json), so it survives the restart every VoiceOS Reload does:
 * the last LEDGER_SIZE entries for 30 days. Each entry carries a hash of the
 * connection that sent it (accountTag), and reads see only the current
 * connection's entries, so a newly connected account starts with an empty
 * history. On disk an entry holds only that tag, the
 * tool, kind, mode, stage, TikTok's publish_id and status, our error code,
 * times, privacy and AI label, file and folder names (basenames, never paths)
 * and the caption, title or description the user approved, clipped to 150
 * characters. Pictures (poster, loop, photo thumbnails) stay in memory, for the
 * newest entries only. A missing or corrupt file starts an empty ledger, logged
 * by file name and count only; a failed save is logged and never fails a write.
 *
 * matchAbout() finds the send the user means from their own words ("the voice
 * clone carousel", "the enigma one", "my last photo post", "today's posts").
 */
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import { log } from "./proc.ts";
import { ensureDir, errCode, fileVersion, readJson, writeJsonAtomic } from "./state.ts";
import type { Clock, LedgerEntry, LedgerStage, MediaKind, PublishStatus, WriteMode, WriteTool } from "./types.ts";

/** Entries kept, in memory and on disk. */
export const LEDGER_SIZE = 100;
/** Entries older than this are dropped. */
export const LEDGER_MAX_AGE_MS = 30 * 86_400_000;
/** Captions, titles and descriptions are clipped to this on disk (TikTok's own read-back cut). */
export const LEDGER_TEXT_MAX = 150;
export const LEDGER_FILE = "ledger.json";
/** The newest entries keep their pictures in memory; older ones drop them (a loop can be ~100 KB). */
const PICTURES_KEPT = 20;
const NAMES_MAX = 35;
const NAME_MAX = 120;

/** What the caller supplies when a write is accepted; the ledger adds the id, stage and timestamps. */
export type NewLedgerEntry = Omit<LedgerEntry, "task_id" | "stage" | "created_at" | "updated_at">;

export type LedgerPatch = Partial<{
  stage: LedgerStage;
  publish_id: string;
  last_status: PublishStatus;
  fail_reason: string;
  error_code: string;
  caption_copied: boolean;
  /** A data URI: kept for the cards, never logged, never saved. */
  poster: string;
  /** The video's moving loop, likewise. */
  motion: { src: string; frames?: number; fps?: number };
}>;

/** Patch keys that change what's on disk (the pictures don't). */
const SAVED_KEYS: ReadonlySet<string> = new Set(["stage", "publish_id", "last_status", "fail_reason", "error_code", "caption_copied"]);

/** Our code for a write cut off by a server restart before TikTok had it (set when the ledger loads). */
export const INTERRUPTED = "INTERRUPTED";

export interface LedgerOptions {
  /** Where to persist (the state folder's ledger.json). Without one the ledger lives in memory only. */
  file?: string;
  max?: number;
  /**
   * The Composio connected account id in use. New entries are tagged with its hash (accountTag) and reads only
   * see entries with the same tag, so switching TikTok accounts never shows another account's sends. Without
   * one, nothing is tagged or filtered.
   */
  account?: string;
}

/** A connection's tag on disk: the first 16 hex of SHA-256 of its id (the id itself is never stored). */
export function accountTag(connectedAccountId: string): string {
  return createHash("sha256").update(connectedAccountId.trim()).digest("hex").slice(0, 16);
}

const copy = <T>(v: T): T => structuredClone(v);

export class Ledger {
  private entries: LedgerEntry[] = [];
  private readonly file?: string;
  private readonly max: number;
  private loaded = false;
  /** Version of the file last read or written (state.ts fileVersion). */
  private seen = "";
  private readonly warned = new Set<string>();
  /** How many times each entry changed: a merge keeps the copy that changed more (times can tie to the ms). */
  private readonly revs = new Map<string, number>();
  /** accountTag of the connection in use; undefined = no filtering. */
  private readonly account?: string;

  constructor(
    private readonly clock: Clock,
    opts: LedgerOptions | number = {},
  ) {
    const o = typeof opts === "number" ? { max: opts } : opts;
    this.file = o.file;
    this.max = o.max ?? LEDGER_SIZE;
    this.account = o.account?.trim() ? accountTag(o.account) : undefined;
  }

  /** The entries this connection may see: its own sends only, once a connection is configured. */
  private visible(): LedgerEntry[] {
    return this.account ? this.entries.filter((e) => e.account === this.account) : this.entries;
  }

  /** Record a write that was just accepted. Returns a copy of the new entry. */
  start(entry: NewLedgerEntry): LedgerEntry {
    this.load();
    const at = new Date(this.clock.now()).toISOString();
    const full: LedgerEntry = {
      ...copy(entry),
      ...(this.account ? { account: this.account } : {}),
      task_id: `t_${randomBytes(6).toString("hex")}`,
      stage: "staging",
      created_at: at,
      updated_at: at,
    };
    this.entries.push(full);
    this.prune();
    this.save();
    return copy(full);
  }

  /** Move an entry along. Unknown ids (evicted, or never recorded) are ignored. Returns the updated copy. */
  update(taskId: string, patch: LedgerPatch): LedgerEntry | undefined {
    this.load();
    const e = this.entries.find((x) => x.task_id === taskId);
    if (!e) return undefined;
    const { caption_copied, ...rest } = patch;
    let changed = false;
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      const slot = e as unknown as Record<string, unknown>;
      if (SAVED_KEYS.has(key) && slot[key] !== value) changed = true;
      slot[key] = value;
    }
    if (caption_copied !== undefined) {
      if (e.details.caption_copied !== caption_copied) changed = true;
      e.details.caption_copied = caption_copied;
    }
    e.updated_at = new Date(this.clock.now()).toISOString();
    if (changed) {
      this.revs.set(e.task_id, (this.revs.get(e.task_id) ?? 0) + 1);
      this.save();
    }
    return copy(e);
  }

  get(taskId: string): LedgerEntry | undefined {
    this.load();
    const e = this.visible().find((x) => x.task_id === taskId);
    return e ? copy(e) : undefined;
  }

  /** The newest entry TikTok gave this publish_id. */
  byPublishId(publishId: string): LedgerEntry | undefined {
    this.load();
    const id = publishId.trim();
    const mine = this.visible();
    for (let i = mine.length - 1; i >= 0; i--) {
      if (mine[i].publish_id === id) return copy(mine[i]);
    }
    return undefined;
  }

  /** The most recent write, whatever its stage (refusals included). */
  latest(): LedgerEntry | undefined {
    this.load();
    const mine = this.visible();
    const e = mine[mine.length - 1];
    return e ? copy(e) : undefined;
  }

  /** Newest first. */
  list(): LedgerEntry[] {
    this.load();
    return this.visible().map(copy).reverse();
  }

  /** Entries this connection sees. */
  get size(): number {
    this.load();
    return this.visible().length;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** The first use reads the file. Anything left mid-write by an earlier server can't still be running. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    const before = new Set(this.entries.map((e) => e.task_id));
    const n = this.merge();
    for (const e of this.entries) {
      if (before.has(e.task_id) || e.publish_id) continue;
      // staging: the file was still going to Composio's storage, so TikTok never saw it. uploading: the init may
      // have reached TikTok. The time stays as it was, so a newer record of the same write still wins a merge.
      if (e.stage === "staging") Object.assign(e, { stage: "failed", error_code: INTERRUPTED });
      else if (e.stage === "uploading") Object.assign(e, { stage: "unknown", error_code: "OUTCOME_UNKNOWN" });
    }
    if (n) log(`ledger: loaded ${n} entr${n === 1 ? "y" : "ies"}`);
  }

  /** Merge the file into memory if it changed since we last saw it. Returns how many entries it held. */
  private merge(): number {
    const file = this.file!;
    const version = fileVersion(file);
    if (!version || version === this.seen) return 0;
    this.seen = version;
    const raw = readJson<unknown>(file, undefined);
    if (raw === undefined) return 0;
    const { entries, bad } = parseLedger(raw);
    if (bad) log(`ledger: ignored ${bad} unreadable entr${bad === 1 ? "y" : "ies"} in ${basename(file)}`);
    for (const { entry: theirs, rev } of entries) {
      const i = this.entries.findIndex((e) => e.task_id === theirs.task_id);
      const mine = this.revs.get(theirs.task_id) ?? 0;
      if (i < 0) {
        this.entries.push(theirs);
        this.revs.set(theirs.task_id, rev);
      } else if (rev > mine || (rev === mine && theirs.updated_at > this.entries[i].updated_at)) {
        this.entries[i] = keepMemory(this.entries[i], theirs);
        this.revs.set(theirs.task_id, rev);
      }
    }
    this.entries.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    this.prune();
    return entries.length;
  }

  private prune(): void {
    const oldest = new Date(this.clock.now() - LEDGER_MAX_AGE_MS).toISOString();
    this.entries = this.entries.filter((e) => e.created_at >= oldest);
    while (this.entries.length > this.max) this.entries.shift();
    if (this.revs.size > this.entries.length) {
      const kept = new Set(this.entries.map((e) => e.task_id));
      for (const id of this.revs.keys()) if (!kept.has(id)) this.revs.delete(id);
    }
    for (let i = 0; i < this.entries.length - PICTURES_KEPT; i++) {
      const e = this.entries[i];
      delete e.poster;
      delete e.motion;
      delete e.thumbs;
    }
  }

  /** Written whole (temp file + rename), after merging what another server wrote meanwhile. Never throws. */
  private save(): void {
    if (!this.file) return;
    try {
      this.merge();
      ensureDir(dirname(this.file));
      writeJsonAtomic(this.file, { version: 1, entries: this.entries.map((e) => toDisk(e, this.revs.get(e.task_id) ?? 0)) } satisfies LedgerFile);
      this.seen = fileVersion(this.file);
    } catch (error) {
      const code = errCode(error);
      if (!this.warned.has(code)) log(`ledger: couldn't save ${basename(this.file)} (${code}); kept in memory`);
      this.warned.add(code);
    }
  }
}

/** A newer copy from disk, keeping what only memory has (pictures; the full text the disk copy clipped). */
function keepMemory(mine: LedgerEntry, theirs: LedgerEntry): LedgerEntry {
  const out = { ...theirs, details: { ...theirs.details }, media: { ...theirs.media } };
  if (mine.poster) out.poster = mine.poster;
  if (mine.motion) out.motion = mine.motion;
  if (mine.thumbs) out.thumbs = mine.thumbs;
  for (const k of ["caption", "title", "description"] as const) {
    const full = mine.details[k];
    const cut = out.details[k];
    if (full && cut && cut.endsWith("…") && full.startsWith(cut.slice(0, -1).trimEnd())) out.details[k] = full;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

interface LedgerFile {
  version: 1;
  entries: unknown[];
}

const TOOLS: ReadonlySet<string> = new Set<WriteTool>(["upload_video", "publish_video", "upload_photos", "post_photos"]);
const KINDS: ReadonlySet<string> = new Set<MediaKind>(["video", "photos"]);
const MODES: ReadonlySet<string> = new Set<WriteMode>(["drafts", "direct"]);
const STAGES: ReadonlySet<string> = new Set<LedgerStage>(["staging", "uploading", "processing", "done", "failed", "unknown"]);
const STATUSES: ReadonlySet<string> = new Set<PublishStatus>(["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"]);
const TASK_ID = /^t_[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const PUBLISH_ID = /^[\x21-\x7e]{1,64}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ACCOUNT = /^[0-9a-f]{16}$/;

/** One line of text, at most `max` characters (an ellipsis marks a cut). */
function clip(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  let out = "";
  for (const ch of t) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** A file or folder name: the last path component only, whatever it was given. */
const nameOf = (v: unknown): string | undefined => clip(typeof v === "string" ? v.split("/").filter(Boolean).pop() : undefined, NAME_MAX);

const intOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const numOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const boolOf = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strOf = (v: unknown, re: RegExp): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);

function defined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** What goes to disk: no pictures, names only, text clipped. */
function toDisk(e: LedgerEntry, rev: number): Record<string, unknown> {
  return defined({
    task_id: e.task_id,
    rev,
    account: strOf(e.account, ACCOUNT),
    tool: e.tool,
    kind: e.kind,
    mode: e.mode,
    stage: e.stage,
    publish_id: e.publish_id,
    last_status: e.last_status,
    error_code: e.error_code,
    fail_reason: clip(e.fail_reason, 64),
    created_at: e.created_at,
    updated_at: e.updated_at,
    media: defined({
      names: e.media.names.slice(0, NAMES_MAX).map(nameOf).filter((n): n is string => Boolean(n)),
      count: e.media.count,
      folder: nameOf(e.media.folder),
      cover_index: e.media.cover_index,
      duration_sec: e.media.duration_sec,
    }),
    details: defined({
      caption: clip(e.details.caption, LEDGER_TEXT_MAX),
      title: clip(e.details.title, LEDGER_TEXT_MAX),
      description: clip(e.details.description, LEDGER_TEXT_MAX),
      privacy_level: strOf(e.details.privacy_level, CODE),
      is_aigc: e.details.is_aigc,
      caption_copied: e.details.caption_copied,
    }),
  });
}

/** The file's entries that are whole and well-formed; the rest are counted, never echoed. */
function parseLedger(raw: unknown): { entries: Array<{ entry: LedgerEntry; rev: number }>; bad: number } {
  const list = raw !== null && typeof raw === "object" ? (raw as Partial<LedgerFile>).entries : undefined;
  if (!Array.isArray(list)) return { entries: [], bad: 1 };
  const entries: Array<{ entry: LedgerEntry; rev: number }> = [];
  const ids = new Set<string>();
  let bad = 0;
  for (const item of list) {
    const e = fromDisk(item);
    if (e && !ids.has(e.task_id)) {
      ids.add(e.task_id);
      entries.push({ entry: e, rev: intOf((item as Record<string, unknown>).rev) ?? 0 });
    } else bad++;
  }
  return { entries, bad };
}

function fromDisk(item: unknown): LedgerEntry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const r = item as Record<string, unknown>;
  const m = (r.media && typeof r.media === "object" ? r.media : {}) as Record<string, unknown>;
  const d = (r.details && typeof r.details === "object" ? r.details : {}) as Record<string, unknown>;
  const task_id = strOf(r.task_id, TASK_ID);
  const created_at = strOf(r.created_at, ISO);
  const updated_at = strOf(r.updated_at, ISO) ?? created_at;
  const count = intOf(m.count);
  if (
    !task_id || !created_at || !updated_at || count === undefined || !Array.isArray(m.names) ||
    typeof r.tool !== "string" || !TOOLS.has(r.tool) || typeof r.kind !== "string" || !KINDS.has(r.kind) ||
    typeof r.mode !== "string" || !MODES.has(r.mode) || typeof r.stage !== "string" || !STAGES.has(r.stage)
  ) {
    return undefined;
  }
  return {
    task_id,
    tool: r.tool as WriteTool,
    kind: r.kind as MediaKind,
    mode: r.mode as WriteMode,
    stage: r.stage as LedgerStage,
    created_at,
    updated_at,
    ...defined({
      account: strOf(r.account, ACCOUNT),
      publish_id: strOf(r.publish_id, PUBLISH_ID),
      last_status: typeof r.last_status === "string" && STATUSES.has(r.last_status) ? (r.last_status as PublishStatus) : undefined,
      error_code: strOf(r.error_code, CODE),
      fail_reason: clip(r.fail_reason, 64),
    }),
    media: defined({
      names: m.names.slice(0, NAMES_MAX).map(nameOf).filter((n): n is string => Boolean(n)),
      count,
      folder: nameOf(m.folder),
      cover_index: intOf(m.cover_index),
      duration_sec: numOf(m.duration_sec),
    }),
    details: defined({
      caption: clip(d.caption, LEDGER_TEXT_MAX),
      title: clip(d.title, LEDGER_TEXT_MAX),
      description: clip(d.description, LEDGER_TEXT_MAX),
      privacy_level: strOf(d.privacy_level, CODE),
      is_aigc: boolOf(d.is_aigc),
      caption_copied: boolOf(d.caption_copied),
    }),
  };
}

// ---------------------------------------------------------------------------
// What an entry means
// ---------------------------------------------------------------------------

/** Refused before anything was sent (no approval on the card, a stale token…): nothing from the card was kept. */
export const isRefused = (e: LedgerEntry): boolean => e.stage === "failed" && !e.publish_id && e.media.count === 0;

/** Nothing of it is on TikTok: refused, interrupted, or failed before TikTok gave it a publish_id. */
export const notSent = (e: LedgerEntry): boolean => e.stage === "failed" && !e.publish_id;

/** TikTok may still change its status: processing, or not confirmed, with a publish_id to ask about. */
export const isOpen = (e: LedgerEntry): boolean => Boolean(e.publish_id) && (e.stage === "processing" || e.stage === "unknown" || e.stage === "uploading");

/** How the user names it: the video's file name without its extension, or the photos' folder. */
export function sendTitle(e: LedgerEntry | undefined): string {
  if (!e) return "";
  if (e.kind === "video") return (e.media.names[0] ?? "").replace(/\.(mp4|mov|m4v|webm)$/i, "").trim();
  return e.media.folder?.trim() || e.details.title?.trim() || "";
}

/** "video draft", "video post", "photo draft", "carousel post". */
export function sendWhat(e: Pick<LedgerEntry, "kind" | "mode" | "media">): string {
  const thing = e.kind === "video" ? "video" : e.media.count === 1 ? "photo" : "carousel";
  return `${thing} ${e.mode === "drafts" ? "draft" : "post"}`;
}

/** A short mark for a send: "Only me", "Everyone", "In drafts", "Uploading", "Processing", "Failed", "Not sent", "Not confirmed". */
export function sendMark(e: LedgerEntry): string {
  if (e.stage === "failed") return notSent(e) ? "Not sent" : "Failed";
  if (e.stage === "unknown") return "Not confirmed";
  if (e.stage === "staging" || e.stage === "uploading") return "Uploading";
  if (e.stage === "processing") return "Processing";
  // done
  if (e.mode === "drafts" && e.last_status !== "PUBLISH_COMPLETE") return "In drafts";
  return privacyWord(e.details.privacy_level) || "Posted";
}

const PRIVACY_WORDS: Record<string, string> = {
  SELF_ONLY: "Only me",
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
};
const privacyWord = (v: unknown): string => PRIVACY_WORDS[String(v ?? "").toUpperCase()] ?? "";

// ---------------------------------------------------------------------------
// Finding the send the user means
// ---------------------------------------------------------------------------

export interface AboutWords {
  /** The words that name it ("voice", "clone"), lower-cased. */
  words: string[];
  kind?: MediaKind;
  drafts?: boolean;
  day?: "today" | "yesterday" | "week";
  order?: "latest" | "previous" | "first";
  privacy?: "private" | "public";
  /** A number next to a photo word ("the 11-photo one"). */
  count?: number;
  /** The words ask for more than one ("today's posts", "all my carousels", "both"). */
  plural: boolean;
}

const PHOTO_WORDS = new Set(["carousel", "carousels", "photo", "photos", "pic", "pics", "picture", "pictures", "image", "images", "slide", "slides", "slideshow", "slideshows", "deck", "gallery", "album", "carrousel", "carosel", "carousal"]);
const VIDEO_WORDS = new Set(["video", "videos", "vid", "vids", "clip", "clips", "reel", "reels", "short", "shorts", "movie", "film", "recording", "episode", "ep"]);
const PLURAL_KIND = new Set(["carousels", "slideshows", "videos", "vids", "clips", "reels", "shorts"]);
const DRAFT_WORDS = new Set(["draft", "drafts", "inbox"]);
const PLURAL_WORDS = new Set(["all", "every", "everything", "both", "posts", "uploads", "sends", "ones", "things", "stuff", "drafts"]);
const LATEST_WORDS = new Set(["last", "latest", "newest", "recent", "recently", "just", "new"]);
const PREVIOUS_WORDS = new Set(["previous", "prior", "before"]);
const FIRST_WORDS = new Set(["first", "oldest", "earliest"]);
// One string split on spaces: the build's import check would read a quoted word right after the word from as an import.
const STOP = new Set(
  [
    "a an the my me i im ive we our you your it its that this these those there one did does do done go goes went",
    "gone going get got thru through yet up out over already still finally now is was were are be been being has",
    "have had of on to from for about with in at and or so as by any some what whats which who how where when why",
    "status check tell show see find look please can could would tiktok tik tok voiceos mac computer laptop post",
    "posted posting publish published send sent sending upload uploaded uploading put made make making shared share",
    "live happen happened work worked ok okay yeah hey um uh like thing called named titled today todays tonight",
    "yesterday yesterdays morning afternoon evening night week earlier later ago minute minutes hour hours only",
    "private public set everyone visible",
  ]
    .join(" ")
    .split(" "),
);

/** Plain lower-case words: accents folded, apostrophes dropped, anything else a separator. */
function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    // "05" and "5" are the same episode.
    .map((w) => (/^\d+$/.test(w) ? String(Number(w)) : w));
}

/** The user's words for a send, sorted into what names it and what narrows it. */
export function parseAbout(about: string): AboutWords {
  const t = tokens(String(about ?? "").slice(0, 200));
  const out: AboutWords = { words: [], plural: false };
  const phrase = ` ${t.join(" ")} `;
  if (/ (today|todays|tonight|this (morning|afternoon|evening)) /.test(phrase)) out.day = "today";
  else if (/ (yesterday|yesterdays|last night) /.test(phrase)) out.day = "yesterday";
  else if (/ (this|last|past) week /.test(phrase)) out.day = "week";
  if (/ only me | private /.test(phrase)) out.privacy = "private";
  else if (/ public | everyone /.test(phrase)) out.privacy = "public";
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    const next = t[i + 1];
    if (/^\d+$/.test(w) && next && PHOTO_WORDS.has(next)) out.count = Number(w);
    if (PHOTO_WORDS.has(w)) {
      out.kind ??= "photos";
      if (PLURAL_KIND.has(w)) out.plural = true;
      continue;
    }
    if (VIDEO_WORDS.has(w)) {
      out.kind ??= "video";
      if (PLURAL_KIND.has(w)) out.plural = true;
      continue;
    }
    if (DRAFT_WORDS.has(w)) out.drafts = true;
    if (PLURAL_WORDS.has(w)) out.plural = true;
    if (w === "last" && (next === "night" || next === "week")) continue;
    if (LATEST_WORDS.has(w)) out.order ??= "latest";
    else if (PREVIOUS_WORDS.has(w)) out.order = "previous";
    else if (FIRST_WORDS.has(w)) out.order ??= "first";
    if (LATEST_WORDS.has(w) || PREVIOUS_WORDS.has(w) || FIRST_WORDS.has(w) || DRAFT_WORDS.has(w) || PLURAL_WORDS.has(w) || STOP.has(w)) continue;
    if (w.length < 2 && !/^\d$/.test(w)) continue;
    if (/^\d+$/.test(w) && next && PHOTO_WORDS.has(next)) continue;
    if (!out.words.includes(w)) out.words.push(w);
  }
  // "the second last", "the one before that": a previous send, not the plural.
  if (out.order === "previous") out.plural = false;
  return out;
}

/** "cloning" ≈ "clone", "slides" ≈ "slide", "recipies" ≈ "recipe". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Edit distance, stopping once it passes `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** 2 for the same word, 1 for a close one (a plural, a typo, a prefix of 4+ letters), 0 otherwise. */
function likeness(said: string, have: string): number {
  if (said === have) return 2;
  const a = stem(said), b = stem(have);
  if (a === b) return 2;
  const short = Math.min(a.length, b.length);
  if (short >= 4 && (a.startsWith(b) || b.startsWith(a))) return 1;
  if (short >= 4 && within(said, have, Math.max(said.length, have.length) >= 8 ? 2 : 1)) return 1;
  return 0;
}

/** A name's words: "ep05-enigma_recipe FINAL.mp4" → ep05, ep, 05, enigma, recipe, final. */
function nameWords(name: string): string[] {
  const bare = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  const out: string[] = [];
  for (const w of tokens(bare)) {
    out.push(w);
    for (const part of w.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)) if (part !== w) out.push(/^\d+$/.test(part) ? String(Number(part)) : part);
  }
  return out;
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Created on the day (or in the week) named, in the Mac's time zone; any time without one. */
export function inPeriod(e: LedgerEntry, day: AboutWords["day"], now: number): boolean {
  const t = Date.parse(e.created_at);
  if (!day || !Number.isFinite(t)) return true;
  if (day === "week") return now - t <= 7 * 86_400_000;
  if (day === "today") return localDay(t) === localDay(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  return localDay(t) === localDay(y.getTime());
}

/** How well the words name it: how many of them it has, and how strongly (name 3, folder 2, caption 1 per word). */
function scoreWords(e: LedgerEntry, words: string[]): { hits: number; score: number } {
  const fields: Array<[string[], number]> = [
    [e.media.names.slice(0, 3).flatMap(nameWords), 3],
    [e.media.folder ? nameWords(e.media.folder) : [], 2],
    [tokens([e.details.caption, e.details.title, e.details.description].filter(Boolean).join(" ")), 1],
  ];
  let hits = 0;
  let score = 0;
  for (const w of words) {
    let best = 0;
    for (const [have, weight] of fields) {
      for (const h of have) {
        const l = likeness(w, h);
        if (l) best = Math.max(best, weight * (l === 2 ? 1 : 0.75));
      }
    }
    if (best) {
      hits++;
      score += best;
    }
  }
  return { hits, score };
}

export interface AboutMatch {
  /** The sends the words point at, newest first: one for a clear answer, several for a list or a toss-up. */
  entries: LedgerEntry[];
  /** The words asked for a list ("today's posts"), not one send. */
  plural: boolean;
  /** Nothing in the period they named ("today"), as opposed to nothing matching. */
  empty_period: boolean;
  words: AboutWords;
}

/**
 * The sends `about` (the user's own words) points at, from `entries` (newest first). Names (file, then folder,
 * then the approved text) are matched loosely: plurals, typos ("recipie") and word forms ("cloning") count.
 * Kind words (carousel, slides, video), "drafts", privacy, "today"/"yesterday" and "last"/"previous"/"first"
 * narrow it. Several equally good matches all come back, for the caller to list.
 */
export function matchAbout(about: string, entries: LedgerEntry[], now: number): AboutMatch {
  const words = parseAbout(about);
  const result = (list: LedgerEntry[], plural = words.plural, empty_period = false): AboutMatch => ({ entries: list, plural, empty_period, words });
  const period = entries.filter((e) => inPeriod(e, words.day, now));
  if (!period.length) return result([], words.plural, true);
  // Kind, drafts, privacy and a photo count narrow the field when something fits them; with names to go on,
  // a misremembered kind ("the voice clone video" that was a carousel) still finds it.
  let pool = period;
  const narrow = (keep: (e: LedgerEntry) => boolean) => {
    const narrowed = pool.filter(keep);
    if (narrowed.length || !words.words.length) pool = narrowed;
  };
  if (words.kind) narrow((e) => e.kind === words.kind);
  if (words.drafts) narrow((e) => e.mode === "drafts");
  if (words.privacy) narrow((e) => (words.privacy === "private" ? e.details.privacy_level === "SELF_ONLY" : Boolean(e.details.privacy_level && e.details.privacy_level !== "SELF_ONLY")));
  if (words.count !== undefined) narrow((e) => e.media.count === words.count);
  if (!pool.length) return result([]);

  let group = pool;
  if (words.words.length) {
    // The narrowed field first; the whole period when it names the send with more of the words.
    let named = byName(pool, words.words);
    if (pool !== period) {
      const wide = byName(period, words.words);
      if (wide && (!named || wide.hits > named.hits)) named = wide;
    }
    if (!named) return result([]);
    group = named.entries;
  }
  if (words.order === "latest") return result(preferSent(group).slice(0, 1), false);
  if (words.order === "previous") return result(group.filter((e) => !isRefused(e)).slice(1, 2), false);
  if (words.order === "first") return result(group.filter((e) => !isRefused(e)).slice(-1), false);
  if (words.plural || (words.day && !words.words.length && !words.kind)) return result(group.filter((e) => !isRefused(e)), true);
  if (!words.words.length) return result(preferSent(group).slice(0, 1), false);
  // A name with several sends: the ones that reached TikTok, unless none did.
  const sent = group.filter((e) => !notSent(e));
  return result(sent.length ? sent : group.slice(0, 1), false);
}

/** The entries that have the most of the words, and within half a point of the best score (a toss-up keeps both). */
function byName(pool: LedgerEntry[], words: string[]): { entries: LedgerEntry[]; hits: number } | undefined {
  const scored = pool.map((e) => ({ e, ...scoreWords(e, words) })).filter((s) => s.hits > 0);
  if (!scored.length) return undefined;
  const most = Math.max(...scored.map((s) => s.hits));
  const top = scored.filter((s) => s.hits === most);
  const best = Math.max(...top.map((s) => s.score));
  return { entries: top.filter((s) => s.score >= best - 0.5).map((s) => s.e), hits: most };
}

/** Newest first, with anything that reached TikTok ahead of what didn't (a refusal, an interrupted upload). */
export function preferSent(list: LedgerEntry[]): LedgerEntry[] {
  return [...list.filter((e) => !notSent(e)), ...list.filter(notSent)];
}

// ---------------------------------------------------------------------------
// One write at a time
// ---------------------------------------------------------------------------

/**
 * One write at a time per TikTok account (GitHub #16 runs one mutation at a
 * time per account). A write holds its account's slot until TikTok has
 * answered its init, i.e. until it leaves staging/uploading; status polling
 * runs outside the slot, so a second write doesn't wait out the first one's
 * processing. Concurrent inits would race TikTok's 5-pending-drafts cap and its
 * 6-inits-a-minute limit. Slots are granted in arrival order.
 */
export class WriteQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly counts = new Map<string, number>();

  /** Resolves when it's this caller's turn, with a release function (idempotent). */
  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((resolve) => (open = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left > 0) this.counts.set(key, left);
      else this.counts.delete(key);
      if (this.tails.get(key) === tail) this.tails.delete(key);
      open();
    };
  }

  /** Writes holding or waiting for this account's slot. */
  depth(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
