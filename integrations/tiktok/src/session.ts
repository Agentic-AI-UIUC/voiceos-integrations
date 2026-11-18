/**
 * Focus memory: the video the user is working on right now, so "it", "that video", "the same one" or
 * "actually make it a post" need no re-asking across notch turns (VoiceOS shows the model only the last few
 * turns as text, never earlier tool results).
 *
 * Set when find_recent_videos returns one clear match, when query_creator_info gets a file_token (a post is
 * being prepared), and when a video write arrives (sent, or refused before anything left the Mac). Also kept:
 * the last card's numbered videos ("the second one") and the ranking behind it ("the other one").
 *
 * In memory only, for 2 hours after the last touch; a restart forgets it. Paths and captions never leave the
 * process: snapshots carry a spoken title, a folder name and plain facts, and nothing here logs.
 */
import { basename } from "node:path";
import type { Clock, FileRef, WriteTool } from "./types.ts";

export const FOCUS_TTL_MS = 2 * 60 * 60_000;
/** The numbered videos on the last card, for "the second one". */
export const LIST_TTL_MS = 30 * 60_000;

/** How the video became the focus. */
export type FocusHow = "picked" | "post_prepared" | "sent_draft" | "sent_post" | "draft_not_sent" | "post_not_sent";

export interface FocusIntent {
  /** What the user last asked for with this video. */
  mode?: "draft" | "post";
  caption?: string;
  privacy_level?: string;
  is_aigc?: boolean;
  tool?: WriteTool;
  /** sent: the write was accepted; refused: nothing was sent (e.g. approved by voice, not on the card). */
  outcome?: "sent" | "refused" | "prepared";
  at: number;
}

/** What the transcript hook and the model may see: no path, no token. */
export interface FocusSnapshot {
  /** Plain spoken title, no extension ("ep01 strawberry tokens"). */
  title: string;
  /** "Downloads" | "Desktop" | "Movies" | the subfolder's name. Never a path. */
  folder?: string;
  duration_sec?: number;
  orientation?: "vertical" | "horizontal" | "square";
  /** Short natural description ("vertical · 0:37 · added yesterday 9:14 PM"). */
  descriptor?: string;
  how?: FocusHow;
  /** When it became (or last stayed) the focus, epoch ms. */
  at: number;
  mode?: "draft" | "post";
  caption?: string;
  privacy_level?: string;
  is_aigc?: boolean;
}

/** What the user asked for in the search behind the last card ("the other one" ranks alternatives by it). */
export interface LastSearch {
  describe?: string;
  query?: string;
}

export interface FocusEntry {
  ref: FileRef;
  how: FocusHow;
  at: number;
  descriptor?: string;
  intent?: FocusIntent;
}

/** The structural contract Deps uses (tests may pass a fake). */
export interface SessionLike {
  current(now: number): FocusSnapshot | undefined;
  focus(now: number): FocusEntry | undefined;
  setFocus(ref: FileRef, how: FocusHow, now: number, o?: { descriptor?: string; intent?: Omit<FocusIntent, "at"> }): void;
  rememberList(shown: FileRef[], ranked: FileRef[], now: number, search?: LastSearch): void;
  list(now: number): { shown: FileRef[]; ranked: FileRef[]; at: number; search?: LastSearch } | undefined;
  clear(): void;
}

const sameFile = (a: FileRef, b: FileRef) => a.path === b.path && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;

/** "ep01-strawberry_tokens.mp4" → "ep01 strawberry tokens". */
export function spokenTitle(name: string): string {
  const stem = basename(String(name ?? "")).replace(/\.[^.]{1,5}$/, "");
  // Underscores and word-joining hyphens read as spaces; a date's hyphens ("2026-10-21") stay.
  return stem.replace(/_+/g, " ").replace(/(?<!\d)-|-(?!\d)/g, " ").replace(/[\s   ]+/g, " ").trim() || stem;
}

const orientationOf = (w?: number, h?: number): FocusSnapshot["orientation"] => {
  if (!(typeof w === "number" && typeof h === "number" && w > 0 && h > 0)) return undefined;
  if (h > w * 1.05) return "vertical";
  if (w > h * 1.05) return "horizontal";
  return "square";
};

const folderName = (folder: string): string | undefined => {
  const parts = String(folder ?? "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : undefined;
};

export class Session implements SessionLike {
  private entry: FocusEntry | undefined;
  private last: { shown: FileRef[]; ranked: FileRef[]; at: number; search?: LastSearch } | undefined;

  constructor(private readonly ttlMs = FOCUS_TTL_MS) {}

  /** The focus, or undefined once 2 hours have passed since it was last set. */
  focus(now: number): FocusEntry | undefined {
    if (this.entry && now - this.entry.at > this.ttlMs) this.entry = undefined;
    return this.entry;
  }

  /**
   * Makes `ref` the video in progress. The same file keeps its intent unless a new one is given (a find for
   * "it" after a draft still knows the draft's caption); a different file starts fresh.
   */
  setFocus(ref: FileRef, how: FocusHow, now: number, o: { descriptor?: string; intent?: Omit<FocusIntent, "at"> } = {}): void {
    const prev = this.focus(now);
    const same = prev && sameFile(prev.ref, ref);
    // A plain re-find of the video already being sent or prepared doesn't demote what happened to it.
    const keepHow = same && how === "picked" && prev.how !== "picked";
    const intent = o.intent ? { ...(same ? prev.intent : undefined), ...stripUndefined(o.intent), at: now } : same ? prev.intent : undefined;
    this.entry = {
      ref: { ...ref },
      how: keepHow ? prev.how : how,
      at: now,
      ...(o.descriptor ?? (same ? prev.descriptor : undefined) ? { descriptor: o.descriptor ?? prev!.descriptor } : {}),
      ...(intent ? { intent } : {}),
    };
  }

  current(now: number): FocusSnapshot | undefined {
    const e = this.focus(now);
    if (!e) return undefined;
    const snap: FocusSnapshot = { title: spokenTitle(e.ref.name), at: e.at, how: e.how };
    const folder = folderName(e.ref.folder);
    if (folder) snap.folder = folder;
    if (typeof e.ref.duration_sec === "number") snap.duration_sec = e.ref.duration_sec;
    const o = orientationOf(e.ref.width, e.ref.height);
    if (o) snap.orientation = o;
    if (e.descriptor) snap.descriptor = e.descriptor;
    const i = e.intent;
    if (i?.mode) snap.mode = i.mode;
    if (i?.caption) snap.caption = i.caption;
    if (i?.privacy_level) snap.privacy_level = i.privacy_level;
    if (typeof i?.is_aigc === "boolean") snap.is_aigc = i.is_aigc;
    return snap;
  }

  /** The numbered videos on the card just shown, and the ranking they came from (both ≤ 6). */
  rememberList(shown: FileRef[], ranked: FileRef[], now: number, search?: LastSearch): void {
    this.last = {
      shown: shown.slice(0, 6).map((r) => ({ ...r })),
      ranked: ranked.slice(0, 6).map((r) => ({ ...r })),
      at: now,
      ...(search && (search.describe || search.query) ? { search: { ...search } } : {}),
    };
  }

  list(now: number): { shown: FileRef[]; ranked: FileRef[]; at: number; search?: LastSearch } | undefined {
    if (this.last && now - this.last.at > LIST_TTL_MS) this.last = undefined;
    return this.last;
  }

  clear(): void {
    this.entry = undefined;
    this.last = undefined;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") (out as Record<string, unknown>)[k] = v;
  return out;
}

/**
 * A video write arrived (upload_video / publish_video): its video becomes the focus, with what the user asked
 * for (draft or post, caption, privacy, AI label), whether it went out ("sent") or was refused before anything
 * left the Mac. A token that doesn't resolve leaves the focus as it was. Never throws.
 */
export function focusFromWrite(
  deps: { session?: Partial<SessionLike>; tokens: { file(token: unknown): FileRef }; clock: { now(): number } },
  tool: WriteTool,
  args: Record<string, unknown>,
  outcome: "sent" | "refused",
  file?: FileRef,
): void {
  if (tool !== "upload_video" && tool !== "publish_video") return;
  try {
    const ref = file ?? deps.tokens.file(args.file_token);
    const mode = tool === "publish_video" ? "post" : "draft";
    const how: FocusHow = outcome === "sent" ? (mode === "post" ? "sent_post" : "sent_draft") : mode === "post" ? "post_not_sent" : "draft_not_sent";
    const caption = typeof args.caption === "string" && args.caption.trim() ? args.caption.trim().slice(0, 2200) : undefined;
    const privacy = typeof args.privacy_level === "string" && args.privacy_level.trim() ? args.privacy_level.trim().toUpperCase() : undefined;
    const aigc = args.is_aigc === true || args.is_aigc === "true" ? true : args.is_aigc === false || args.is_aigc === "false" ? false : undefined;
    deps.session?.setFocus?.(ref, how, deps.clock.now(), {
      intent: { mode, outcome, tool, caption, privacy_level: privacy, ...(mode === "post" && aigc !== undefined ? { is_aigc: aigc } : {}) },
    });
  } catch {
    /* a stale or foreign token: nothing to remember */
  }
}
