/**
 * The four writes (plan §6.5, §6.6, §6.11, §6.12, §6.15; Studio brief "Write
 * flow"). Each is a VoiceOS background tool. The handler returns the completion
 * card when the job ends within its soft deadline (45 s). VoiceOS cancels every
 * tool call at 60 s, so a longer job (a big video on a slow uplink) answers
 * "working" instead, carries on detached, and queues a reminder with the
 * completion card when it ends (src/reminders.ts).
 *
 *  1. On arrival, before queueing and before anything leaves the Mac: the relay
 *     (photos), the confirmation receipt (verified and spent), the server
 *     tokens, the direct-post rules, the files on disk and the text limits.
 *     Every refusal says nothing was sent.
 *  2. A ledger entry, then one write at a time per account: the slot is held
 *     until TikTok has answered the init (staging → uploading).
 *  3. At its turn: copy the caption (upload_video, only when the user switched
 *     it on), fresh creator info if the post_token's is over 10 minutes old,
 *     a write-init rate token, then staging (Composio Files API, or
 *     conversion + relay for photos) and exactly one TikTok init. Never retried:
 *     a lost answer is OUTCOME_UNKNOWN.
 *  4. Status polling (5, 10, 20, 40 s, then every 60 s, up to 30 min) to a
 *     terminal status. The relay batch is deleted once TikTok has the photos.
 */
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { bool, int, photoDirectArgs, photoDraftArgs, videoDirectArgs, videoDraftArgs } from "../client.ts";
import { checkText, cleanText, clipText } from "../captions.ts";
import { statusCard, writeOutcomeCopy, writeResultCard, type StatusCardInput, type WriteResultInput } from "../cards.ts";
import { TikTokError, failReasonError, normalizeError, privacyLabel } from "../errors.ts";
import { normName } from "../files.ts";
import { decodeAnyFrame, splitMicroPreview, splitPhotoStack } from "../microPreview.ts";
import { bytes } from "../format.ts";
import type { LedgerPatch, NewLedgerEntry } from "../ledger.ts";
import type { Deps } from "../mcpServer.ts";
import { log } from "../proc.ts";
import { acceptReceipt, receiptCore } from "../receipts.ts";
import { SHOW_POST } from "../reminders.ts";
import { leadWithWords, fail, ok, parseResult, type ToolResult } from "../results.ts";
import { POST_TTL_MS, restat } from "../tokens.ts";
import { focusFromWrite } from "../session.ts";
import type { Handler, ToolExtra } from "../tools.ts";
import type { BundleRef, FileRef, LedgerEntry, MediaKind, PostRef, PublishStatus, Widget, WriteMode, WriteTool } from "../types.ts";
import type { VideoMotion, VideoPreview } from "../preview.ts";
import { READ_BUDGET_MS, compactObject, creatorOf, field, present, progress, signalOf, str } from "./common.ts";

/** TikTok's API maximum for any uploaded video; direct posts also respect the creator's own maximum. */
export const API_MAX_DURATION_SEC = 600;
const MAX_VIDEO_BYTES = 4 * 1024 ** 3;
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime"]);
const PHOTO_INIT_TIMEOUT_MS = 60_000;
/** The completion card's poster frame: one larger tile, so 240 px wide (240 × 427 for 9:16). */
export const RESULT_POSTER_WIDTH = 240;
/** How long a finished write waits for its poster frame before sending the card without it. */
const POSTER_WAIT_MS = 3_000;

/** p's value, or undefined if it hasn't settled within ms (real time: the fake clocks in tests don't move it). */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Staging and init time for a video: 60 s plus 2 s per MB (an uplink down to 0.5 MB/s), at most 15 minutes. */
export const uploadTimeoutMs = (size: number): number => Math.min(15 * 60_000, 60_000 + Math.ceil(Math.max(0, size) / (1024 * 1024)) * 2_000);

/**
 * When a write's tool call answers if its job isn't done yet. VoiceOS 0.1.40 cancels every tool call at 60 s (the
 * MCP SDK's default timeout; no progress token can extend it) and then closes the connection, so the call answers
 * "working" well before that and the job carries on (src/reminders.ts).
 */
export const SOFT_DEADLINE_MS = 45_000;

const KIND: Record<WriteTool, MediaKind> = { upload_video: "video", publish_video: "video", upload_photos: "photos", post_photos: "photos" };
const MODE: Record<WriteTool, WriteMode> = { upload_video: "drafts", publish_video: "direct", upload_photos: "drafts", post_photos: "direct" };

/** Status-check failures that won't clear by waiting: stop watching (the post is with TikTok either way). */
const STOP_POLLING = new Set(["NOT_CONFIGURED", "NOT_CONNECTED", "AUTH_EXPIRED", "AUTH_REVOKED", "SCOPE_MISSING", "INVALID_PARAM"]);

type Args = Record<string, unknown>;
type CreatorFlags = { comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean };

/** A write that passed every on-arrival check. */
export interface Accepted {
  tool: WriteTool;
  kind: MediaKind;
  mode: WriteMode;
  /** The verified arguments as sendable() reads them: no hashtags or mentions, privacy and cover as TikTok's values. */
  args: Args;
  file?: FileRef;
  bundle?: BundleRef;
  post?: PostRef;
  /** Direct posts: the privacy level the user picked (one of the post_token's options). */
  privacy?: string;
  /** Exactly what the receipt signed (CRLF → LF), and what TikTok gets. */
  caption: string;
  title: string;
  description: string;
  accountLabel?: string;
  /** Interactions the user switched on that this account has turned off: sent as off, and said so in the result. */
  forcedOff: string[];
}

const textArg = (v: unknown): string => (v === undefined || v === null ? "" : receiptCore.normCaption(v));
const nothingSent = (e: TikTokError): TikTokError =>
  e.detail.nothing_sent ? e : new TikTokError(e.code, { ...e.detail, nothing_sent: true });

// ---------------------------------------------------------------------------
// The user's words for privacy and the cover frame. The cards read them with TKC.privacyCode and TKC.coverMs
// (confirm-card/card-logic.js) and stage TikTok's values before minting, so a receipt normally signs codes and
// digits already. These are the same rules for a receipt signed over the words; tests/card-commands.test.ts keeps
// both sides in step. (The server can't run card-logic.js: nothing here is compiled from a string.)
// ---------------------------------------------------------------------------

/** Audience words keyed as privacyCodeOf squashes them (case, spaces, "-" and "_" dropped): TKC's AUDIENCE. */
const AUDIENCE: Readonly<Record<string, string>> = {
  publictoeveryone: "PUBLIC_TO_EVERYONE", everyone: "PUBLIC_TO_EVERYONE", public: "PUBLIC_TO_EVERYONE", anyone: "PUBLIC_TO_EVERYONE",
  followerofcreator: "FOLLOWER_OF_CREATOR", followers: "FOLLOWER_OF_CREATOR",
  mutualfollowfriends: "MUTUAL_FOLLOW_FRIENDS", friends: "MUTUAL_FOLLOW_FRIENDS", mutualfriends: "MUTUAL_FOLLOW_FRIENDS",
  selfonly: "SELF_ONLY", onlyme: "SELF_ONLY", justme: "SELF_ONLY", me: "SELF_ONLY", private: "SELF_ONLY", self: "SELF_ONLY",
};

/** TikTok's privacy code for an audience word ("only me", "Friends"), else the value as TKR.normUpper signs it. */
export function privacyCodeOf(v: unknown): string {
  const key = receiptCore.normText(v).toLowerCase().replace(/[\s_-]+/g, "");
  return Object.prototype.hasOwnProperty.call(AUDIENCE, key) ? AUDIENCE[key] : receiptCore.normUpper(v);
}

const msText = (x: number): string => (Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER ? String(Math.round(x)) : "");
const COVER_UNIT = /\s*(\d+(?:\.\d*)?|\.\d+)\s*(milliseconds?|millis?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])/g;

/**
 * cover_ms as a digit string of milliseconds, or "" when it can't be read (TKC.coverMs): a whole number is
 * milliseconds as before; a decimal point or a unit means seconds or that unit ("2.5", "5s", "5 seconds",
 * "1 min 30 s", "500ms"); a clock is m:ss or h:mm:ss ("0:05", "1:02:03").
 */
export function coverMsOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? msText(v) : msText(v * 1000);
  if (typeof v !== "string") return "";
  const s = v.trim().toLowerCase().replace(/^at\s+/, "");
  if (!s) return "";
  if (/^\d+$/.test(s)) return msText(Number(s)) && s.replace(/^0+(?=\d)/, "");
  const clock = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (clock) {
    const [h, m, sec] = [clock[1] ? Number(clock[1]) : 0, Number(clock[2]), Number(clock[3])];
    return sec >= 60 || (clock[1] && m >= 60) ? "" : msText((h * 3600 + m * 60 + sec) * 1000);
  }
  if (/^(\d+\.\d*|\.\d+)$/.test(s)) return msText(Number(s) * 1000);
  const rest = s.replace(/,|\band\b/g, " ");
  let pos = 0, total = 0, n = 0;
  for (const u of rest.matchAll(COVER_UNIT)) {
    if (u.index !== pos) break;
    const unit = u[2];
    total += Number(u[1]) * (/^(ms|msec|milli)/.test(unit) ? 1 : unit[0] === "m" ? 60_000 : unit[0] === "s" ? 1_000 : 3_600_000);
    pos = u.index + u[0].length;
    n++;
  }
  return n && !/\S/.test(rest.slice(pos)) ? msText(total) : "";
}

/**
 * The arguments a write is checked and sent with, made from the ones the receipt verified. Only signed fields
 * reach TikTok: the card folds hashtags and mentions into the signed caption (photos: description) and stages
 * both as "", so they are dropped here and never sent or appended by the server, whatever they hold; TikTok gets
 * the caption or description exactly as signed. Audience words become TikTok's privacy code and a worded cover
 * time its milliseconds (the card does both before minting; this covers a receipt signed over the words), before
 * the direct-post rules check them. A cover that can't be read stays as it came, for directRules to refuse.
 */
export function sendable(tool: WriteTool, args: Args): Args {
  const { hashtags: _hashtags, mentions: _mentions, ...out } = args;
  if (MODE[tool] === "direct" && present(out.privacy_level)) out.privacy_level = privacyCodeOf(out.privacy_level);
  if (tool === "publish_video" && present(out.cover_ms)) {
    const ms = coverMsOf(out.cover_ms);
    if (ms && !(typeof out.cover_ms === "number" && Number.isInteger(out.cover_ms))) out.cover_ms = ms;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. On arrival
// ---------------------------------------------------------------------------

/** Every check that can refuse a write before anything leaves the Mac. Throws a TikTokError; the receipt is spent by then. */
export function accept(tool: WriteTool, args: Args, deps: Deps): Accepted {
  const kind = KIND[tool];
  const mode = MODE[tool];
  if (kind === "photos" && !deps.relay.configured) throw new TikTokError("RELAY_NOT_CONFIGURED", { nothing_sent: true });
  // First, before any token check or network call: verify the card's receipt and spend it (persisted).
  acceptReceipt(tool, args, deps.spent as never, deps.clock.now());
  // Then everything reads the signed fields alone, with the user's words for privacy and the cover read as codes.
  args = sendable(tool, args);
  const a: Accepted = {
    tool, kind, mode, args,
    caption: textArg(args.caption), title: textArg(args.title), description: textArg(args.description),
    forcedOff: [],
  };
  if (kind === "video") a.file = deps.tokens.file(args.file_token);
  else a.bundle = deps.tokens.bundle(args.bundle_token);
  cardShowsTheMedia(a);
  if (mode === "direct") {
    a.post = deps.tokens.post(args.post_token);
    a.privacy = directRules(a, deps);
    a.accountLabel = a.post.creator_nickname;
  } else {
    a.accountLabel = clipText(cleanText(args.account_label), 40) || undefined;
  }
  if (a.file) videoChecks(a);
  if (a.file) restat(a.file);
  for (const image of a.bundle?.images ?? []) restat(image, "image");
  if (kind === "video") checkText("caption", a.caption);
  else {
    checkText("title", a.title);
    checkText("description", a.description);
  }
  return a;
}

/**
 * The card's file name and photo count come from the agent; what's sent comes from the token. A token passed
 * with another candidate's name would show the user one video and send another, so they have to agree. Names
 * are compared as a model may retype them: any case, plain spaces for macOS's narrow ones, extension optional.
 */
/**
 * Could the card have shown something this file didn't mint? Every frame carries a checksum, and the card draws
 * only frames that decode, so a garbled copy just hides frames (or falls back to the plain tile): that's no reason
 * to refuse the write. A frame that decodes but isn't one of this file's frames, or a different duration, is.
 */
export function previewMisleads(shown: string, minted: string | undefined): boolean {
  if (shown === minted) return false;
  const got = splitMicroPreview(shown);
  if (!got) return false;
  const own = minted ? splitMicroPreview(minted) : null;
  if (got.durationSec !== undefined && got.durationSec !== own?.durationSec) return true;
  const mine = framesOf(own, got.version ?? 1);
  return got.frames.some((f) => {
    const seen = decodeAnyFrame(f, got.version ?? 1);
    return seen !== null && !mine.some((m) => m.text === f || sameDrawing(m.image(), seen));
  });
}

type Drawing = { w: number; h: number; rgba: Uint8ClampedArray };

/** A minted preview's frames for comparison, decoded on demand; none when it is another version (it can't match). */
function framesOf(own: { version?: 2; frames: string[] } | null, version: 1 | 2): Array<{ text: string; image: () => Drawing | null }> {
  if (!own || (own.version ?? 1) !== version) return [];
  return own.frames.map((text) => {
    let done = false, cached: Drawing | null = null;
    return { text, image: () => (done ? cached : ((done = true), (cached = decodeAnyFrame(text, version)))) };
  });
}

/** The card would draw both the same (a copy can differ in bits that decode to nothing, like trailing padding). */
function sameDrawing(a: Drawing | null, b: Drawing): boolean {
  if (!a || a.w !== b.w || a.h !== b.h || a.rgba.length !== b.rgba.length) return false;
  for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) return false;
  return true;
}

/**
 * The same rule for a photo stack (prepare_photo_post's `preview`): the photos it would draw, in their order,
 * have to be this bundle's own, and so do the count and cover it states. Frames that don't decode are dropped
 * by the card, so a garbled stack is no reason to refuse; a frame from another bundle, a reorder, or another
 * count or cover is.
 */
export function stackMisleads(shown: string, minted: string | undefined): boolean {
  if (shown === minted) return false;
  const got = splitPhotoStack(shown);
  if (!got) return false;
  const own = minted ? splitPhotoStack(minted) : null;
  if (got.count !== undefined && got.count !== own?.count) return true;
  if (got.cover !== undefined && got.cover !== own?.cover) return true;
  const version = got.version ?? 1, mine = framesOf(own, version);
  let at = 0;
  for (const f of got.frames) {
    const seen = decodeAnyFrame(f, version);
    if (seen === null) continue;
    let i = at;
    while (i < mine.length && !(mine[i].text === f || sameDrawing(mine[i].image(), seen))) i++;
    if (i >= mine.length) return true;
    at = i + 1;
  }
  return false;
}

function cardShowsTheMedia(a: Accepted): void {
  const plain = (s: string) => normName(s).trim().toLowerCase();
  if (a.file && present(a.args.file_name)) {
    const shown = plain(String(a.args.file_name));
    const name = plain(a.file.name);
    if (shown !== name && shown !== name.replace(/\.[^.]+$/, "")) throw new TikTokError("CONFIRMATION_REQUIRED", { reason: "card_mismatch", kind: "video" });
  }
  // The card's moving preview, likewise: it has to be the one minted with this file_token (find_recent_videos),
  // or the user could have been shown one video's frames while another is sent. Leaving it out is fine (the card
  // then shows its plain tile).
  if (a.file && present(a.args.preview) && previewMisleads(String(a.args.preview).trim(), a.file.preview)) {
    throw new TikTokError("CONFIRMATION_REQUIRED", { reason: "card_mismatch", kind: "video" });
  }
  // The photo stack, likewise: only the photos prepare_photo_post minted with this bundle_token.
  if (a.bundle && present(a.args.preview) && stackMisleads(String(a.args.preview).trim(), a.bundle.preview)) {
    throw new TikTokError("CONFIRMATION_REQUIRED", { reason: "card_mismatch", kind: "photos" });
  }
  const count = a.bundle && present(a.args.count_label) ? /\d+/.exec(String(a.args.count_label)) : null;
  if (a.bundle && count && Number(count[0]) !== a.bundle.images.length) {
    throw new TikTokError("CONFIRMATION_REQUIRED", { reason: "card_mismatch", kind: "photos" });
  }
  cardLabelsAreTrue(a);
}

const mismatch = (kind: MediaKind, field: string) => new TikTokError("CONFIRMATION_REQUIRED", { reason: "card_mismatch", kind, field });
/** The words of a line as a model may retype them: any case, spacing and quote style, × as x, no closing period. */
const plainLine = (v: unknown) =>
  cleanText(v)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00d7/g, "x")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
/** "Frame at 0:03", "Cover: 0:03" → "0:03", as the card shows a cover_label beside its own "Cover". */
const coverWords = (v: unknown) => cleanText(v).trim().replace(/^(?:cover|frame)(?:\s+frame)?(?:\s+at)?\s*:?\s*/i, "");
const SIZE_LABEL = /^(\d+(?:\.\d+)?)\s*(bytes?|b|kb|mb|gb|tb)$/;
const SIZE_UNIT: Record<string, number> = { b: 1, byte: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
/** A size label ("12.3 MB", as format.ts bytes() writes it, any case or spacing) in bytes; undefined when unreadable. */
function sizeOfLabel(v: unknown): number | undefined {
  const m = SIZE_LABEL.exec(cleanText(v).trim().toLowerCase());
  return m ? Number(m[1]) * SIZE_UNIT[m[2]] : undefined;
}

/**
 * The card's other labels come from the agent too (QA, PR 47): a length, a size or a cover time the file doesn't
 * have, or a photo warning left out, would have the user approve something other than what's sent. Each shown label
 * has to agree with the token or the signed cover time; a label left out is fine, except a warning about AI or
 * content credentials (it bears on TikTok's AI label): when the photos carry credentials, the card has to show it.
 * A format note (resize, HEIC, transparency) may be left out: it doesn't change what the user approves, and nearly
 * every phone carousel has one, so requiring the agent to copy it would refuse good cards. Compared as a model may
 * retype them: lengths to the second, sizes within 5 %, words in any case, spacing and quote style.
 */
function cardLabelsAreTrue(a: Accepted): void {
  if (a.file) {
    const dur = a.file.duration_sec;
    if (present(a.args.duration_label)) {
      const shown = coverMsOf(cleanText(a.args.duration_label));
      if (dur === undefined || !shown || !(Math.abs(Number(shown) / 1000 - dur) < 1)) throw mismatch("video", "duration_label");
    }
    if (present(a.args.size_label)) {
      const shown = sizeOfLabel(a.args.size_label);
      if (shown === undefined || !(Math.abs(shown - a.file.size) <= a.file.size * 0.05)) throw mismatch("video", "size_label");
    }
    if (present(a.args.cover_label)) {
      // The card fills cover_label in from cover_ms (TKC.settle). A label naming another time, or one with no cover set,
      // is refused; a cover time that can't be read is directRules' to refuse, in its own words.
      const shown = coverMsOf(coverWords(a.args.cover_label));
      const cover = present(a.args.cover_ms) ? coverMsOf(a.args.cover_ms) : "";
      const unreadableCover = present(a.args.cover_ms) && !cover;
      if (!unreadableCover && (!shown || !cover || !(Math.abs(Number(shown) - Number(cover)) < 1000))) throw mismatch("video", "cover_label");
    }
  }
  if (a.bundle) {
    const shown = plainLine(a.args.warning), own = plainLine(a.bundle.warning);
    const credentials = a.bundle.images.some((i) => i.credentials === "ai" || i.credentials === "present");
    if (shown ? shown !== own : credentials && own !== "") throw mismatch("photos", "warning");
  }
}

/**
 * Direct-post rules the card can't enforce (plan §6.6, §7.1). The post_token
 * must belong to this file or bundle and this account, and the card must have
 * shown the token's nickname and options; then TikTok's own rules, worded as
 * TikTok words them. Returns the chosen privacy level.
 */
export function directRules(a: Accepted, deps: Deps): string {
  const post = a.post!;
  const mediaToken = str(a.kind === "video" ? a.args.file_token : a.args.bundle_token);
  if (post.media_kind !== a.kind || str(post.media_token) !== mediaToken) {
    throw new TikTokError("TOKEN_STALE", { kind: "post", reason: "other_media" });
  }
  if (deps.cfg.connectedAccountId && post.connected_account_id !== deps.cfg.connectedAccountId) {
    throw new TikTokError("TOKEN_STALE", { kind: "post", reason: "other_account" });
  }
  if (
    receiptCore.normText(a.args.creator_nickname) !== receiptCore.normText(post.creator_nickname) ||
    receiptCore.normOptions(a.args.privacy_options) !== receiptCore.normOptions(post.privacy_options)
  ) {
    throw new TikTokError("TOKEN_STALE", { kind: "post", reason: "card_out_of_date" });
  }
  const level = receiptCore.normUpper(a.args.privacy_level);
  if (!level || !post.privacy_options.includes(level)) {
    throw new TikTokError("PRIVACY_MISMATCH", { chosen: level, options: [...post.privacy_options] });
  }
  const disclosure = bool(a.args.commercial_disclosure);
  if (disclosure && !bool(a.args.brand_organic) && !bool(a.args.brand_content)) throw new TikTokError("DISCLOSURE_INCOMPLETE");
  if (disclosure && bool(a.args.brand_content) && level === "SELF_ONLY") throw new TikTokError("BRANDED_PRIVATE_BLOCKED");
  if (a.kind === "video") {
    const dur = a.file!.duration_sec;
    const max = post.max_duration_sec;
    if (dur !== undefined && max !== undefined && dur > max) throw new TikTokError("FILE_TOO_LONG", { max, dur: Math.ceil(dur) });
    if (present(a.args.cover_ms)) {
      const cover = int(a.args.cover_ms);
      if (cover === undefined || !Number.isInteger(cover) || cover < 0) {
        throw new TikTokError("INVALID_PARAM", { message: "The cover frame must be a time in the video, such as 0:05, 5s or 3000 (milliseconds)." });
      }
      if (dur !== undefined && cover > dur * 1000) throw new TikTokError("INVALID_PARAM", { message: "The cover frame is past the end of the video." });
    }
  }
  if (bool(a.args.allow_comment) && post.comment_disabled) a.forcedOff.push("comments");
  if (a.kind === "video" && bool(a.args.allow_duet) && post.duet_disabled) a.forcedOff.push("Duet");
  if (a.kind === "video" && bool(a.args.allow_stitch) && post.stitch_disabled) a.forcedOff.push("Stitch");
  return level;
}

function videoChecks(a: Accepted): void {
  const f = a.file!;
  if (!VIDEO_MIMES.has(f.mime)) throw new TikTokError("UNSUPPORTED_FORMAT", { name: f.name });
  if (f.size > MAX_VIDEO_BYTES) throw new TikTokError("FILE_TOO_LARGE", { size: bytes(f.size) });
  // Drafts aren't held to the creator's own maximum (the user can trim them in TikTok), only to the API's.
  if (a.mode === "drafts" && f.duration_sec !== undefined && f.duration_sec > API_MAX_DURATION_SEC) {
    throw new TikTokError("FILE_TOO_LONG", { max: API_MAX_DURATION_SEC, dur: Math.ceil(f.duration_sec), mode: "drafts" });
  }
}

/** Basenames, the approved text and the settings sent: never paths or tokens. */
function ledgerEntryFor(a: Accepted): NewLedgerEntry {
  const on = (key: string) => bool(a.args[key]);
  const disclosure = on("commercial_disclosure");
  // status: the folder's own name (never its path), so "the voice clone carousel" finds this send later (ledger.ts).
  // A video's folder is already a label ("Movies/Exports"); photos carry real paths (C:\… on Windows).
  const dirs = a.kind === "video" ? [a.file!.folder ?? ""] : [...new Set(a.bundle!.images.map((i) => dirname(i.path)))];
  const folder = dirs.length !== 1 ? undefined : a.kind === "video" ? dirs[0]!.split("/").filter(Boolean).pop() : basename(dirs[0]!);
  const media =
    a.kind === "video"
      ? { names: [a.file!.name], count: 1, ...(folder ? { folder } : {}), ...(a.file!.duration_sec !== undefined ? { duration_sec: a.file!.duration_sec } : {}) }
      : { names: a.bundle!.images.map((i) => i.name), count: a.bundle!.images.length, ...(folder ? { folder } : {}), cover_index: a.bundle!.cover_index };
  let details: LedgerEntry["details"];
  switch (a.tool) {
    case "upload_video":
      details = compactObject({ caption: a.caption || undefined });
      break;
    case "publish_video": {
      const cover = int(a.args.cover_ms);
      details = compactObject({
        caption: a.caption || undefined,
        privacy_level: a.privacy,
        allow_comment: on("allow_comment") && !a.post!.comment_disabled,
        allow_duet: on("allow_duet") && !a.post!.duet_disabled,
        allow_stitch: on("allow_stitch") && !a.post!.stitch_disabled,
        commercial_disclosure: disclosure,
        brand_organic: disclosure && on("brand_organic"),
        brand_content: disclosure && on("brand_content"),
        is_aigc: on("is_aigc"),
        cover_ms: cover,
      });
      break;
    }
    case "upload_photos":
      details = compactObject({ title: a.title || undefined, description: a.description || undefined });
      break;
    default:
      details = compactObject({
        title: a.title || undefined,
        description: a.description || undefined,
        privacy_level: a.privacy,
        allow_comment: on("allow_comment") && !a.post!.comment_disabled,
        auto_add_music: on("auto_add_music"),
        commercial_disclosure: disclosure,
        brand_organic: disclosure && on("brand_organic"),
        brand_content: disclosure && on("brand_content"),
      });
  }
  // A photo post's thumbnails ride along for its cards ("did it go up?"), like a video's poster.
  return { tool: a.tool, kind: a.kind, mode: a.mode, media, details, ...(a.bundle?.thumbs?.length ? { thumbs: a.bundle.thumbs } : {}) };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function writeHandler(tool: WriteTool): Handler {
  return async (args: Args, deps: Deps, extra: ToolExtra): Promise<ToolResult> => leadWithWords(await runWrite(tool, args, deps, extra));
}

async function runWrite(tool: WriteTool, args: Args, deps: Deps, extra: ToolExtra): Promise<ToolResult> {
  const started = deps.clock.now();
  let a: Accepted;
  try {
    a = accept(tool, args, deps);
  } catch (e) {
    const err = nothingSent(normalizeError(e, { slug: tool }));
    focusFromWrite(deps, tool, args, "refused"); // finder: the video stays in focus ("actually make it a post")
    log(`${tool} refused ${err.code} ${Math.max(0, deps.clock.now() - started)}ms`);
    // Recorded so "did it go up?" answers about this attempt (not an older one). Nothing from the card is kept:
    // its labels are the agent's, and nothing was sent.
    const refused = deps.ledger.start({ tool, kind: KIND[tool], mode: MODE[tool], media: { names: [], count: 0 }, details: {} });
    deps.ledger.update(refused.task_id, { stage: "failed", error_code: err.code });
    const card: WriteResultInput = { outcome: "refused", kind: KIND[tool], mode: MODE[tool], error: err };
    return fail(err, writeResultCard(card), { outcome: "refused", nothing_sent: true, kind: KIND[tool], mode: MODE[tool], ...copyOf(card) });
  }
  const entry = deps.ledger.start(ledgerEntryFor(a));
  focusFromWrite(deps, tool, a.args, "sent", a.file); // finder: focus memory (src/session.ts), with privacy as sent
  const id = entry.task_id;
  // The job runs on its own signal, not the call's: answering early, or VoiceOS cancelling the call, mustn't stop
  // an upload in flight (it can't be resumed, and a lost init answer is never retried). Progress goes to the call
  // only while it's open.
  const job = new AbortController();
  let answered = false;
  let running = false;
  const jobExtra: ToolExtra = {
    signal: job.signal,
    ...(extra._meta ? { _meta: extra._meta } : {}),
    sendNotification: (n) => (answered || !extra.sendNotification ? Promise.resolve() : extra.sendNotification(n)),
  };
  const work = (async () => {
    const release = await deps.queue.acquire(deps.cfg.connectedAccountId ?? "");
    running = true;
    try {
      return await execute(a, entry, release, deps, jobExtra, started);
    } finally {
      release();
    }
  })();
  // VoiceOS cancelling the call (its 60 s limit, or the user) detaches the job the same way: it still ends, and
  // still says how it ended.
  const first = await settledWithin(work, deps.softDeadlineMs, extra.signal);
  if (first.done) return first.value;
  // Still running: answer honestly now, and tell VoiceOS how it ended later.
  answered = true;
  log(`${a.tool} working ${Math.max(0, deps.clock.now() - started)}ms`);
  deps.jobs.track(id, work.then((result) => endedLater(a, id, result, deps), (e) => endedLater(a, id, undefined, deps, e)));
  return workingResult(a, id, running ? undefined : "queued", deps);
}

/** p's outcome if it settles within ms (real time) and before `cancel` aborts, else { done: false }. */
async function settledWithin<T>(p: Promise<T>, ms: number, cancel?: AbortSignal): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    onAbort = () => resolve({ done: false });
    if (cancel?.aborted) onAbort();
    else cancel?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([p.then((value) => ({ done: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
    if (onAbort) cancel?.removeEventListener("abort", onAbort);
  }
}

/** The card input for an accepted write, from what the ledger knows now (captions copied, the poster). */
function inputFor(a: Accepted, e: LedgerEntry | undefined, outcome: WriteResultInput["outcome"], error?: TikTokError): WriteResultInput {
  return {
    outcome,
    kind: a.kind,
    mode: a.mode,
    ...(a.file ? { name: a.file.name } : {}),
    ...(a.bundle ? { count: a.bundle.images.length } : {}),
    ...(a.privacy ? { privacy_label: privacyLabel(a.privacy) } : {}),
    ...(a.kind === "video" ? (a.caption ? { caption: a.caption } : {}) : a.title || a.description ? { caption: a.title || a.description } : {}),
    ...(e?.details.caption_copied !== undefined ? { caption_copied: e.details.caption_copied } : {}),
    ...(a.accountLabel ? { account_label: a.accountLabel } : {}),
    ...(e?.poster ? { poster: e.poster } : {}),
    ...(e?.motion ? { motion: e.motion } : {}),
    ...(a.bundle?.thumbs?.length ? { thumbs: a.bundle.thumbs, cover_index: a.bundle.cover_index } : {}),
    ...(error ? { error } : {}),
  };
}

export type Working = "queued" | "uploading" | "processing";

/** The words for a write that's still running after its call answered: never a success, and how the user hears the end. */
export function workingCopy(mode: WriteMode, working: Working): { title: string; body: string; spoken: string } {
  const later = `I'll let you know when ${mode === "drafts" ? "it's in your inbox" : "it's posted"}, or ask 'did it go up?'`;
  if (working === "processing") return { title: "TikTok is processing it", body: `TikTok has it. ${later}`, spoken: `TikTok has it and is processing it. ${later}` };
  if (working === "queued") {
    return { title: "Waiting for your other upload", body: `It starts when the one before it is done. ${later}`, spoken: `It's next, after your other TikTok upload. ${later}` };
  }
  const where = mode === "drafts" ? "Uploading to your TikTok drafts" : "Uploading to TikTok";
  return { title: where, body: `This can take a few minutes on a slow connection. ${later}`, spoken: `${where}. ${later}` };
}

/**
 * The call's answer while the job carries on: what it's doing now, never a success. The card is the processing
 * look of the completion card once TikTok has the post, and the status card's "Uploading" look before that.
 */
function workingResult(a: Accepted, id: string, queued: "queued" | undefined, deps: Deps): ToolResult {
  const e = deps.ledger.get(id);
  const working: Working = queued ?? (e?.publish_id ? "processing" : "uploading");
  const c = workingCopy(a.mode, working);
  const card =
    working === "processing"
      ? writeResultCard(inputFor(a, e, "processing"))
      : statusCard(
          compactObject({
            state: "uploading" as const,
            now: deps.clock.now(),
            kind: a.kind,
            mode: a.mode,
            count: a.bundle?.images.length,
            name: a.file?.name,
            started_at: e?.created_at,
            privacy_label: a.privacy ? privacyLabel(a.privacy) : undefined,
            poster: e?.poster,
            motion: e?.motion,
            thumbs: a.bundle?.thumbs,
            cover_index: a.bundle?.cover_index,
          }) as StatusCardInput,
        );
  return ok(
    compactObject({
      outcome: "working",
      running: true,
      working,
      stage: e?.stage,
      task_id: id,
      publish_id: e?.publish_id,
      kind: a.kind,
      mode: a.mode,
      file_name: a.file?.name,
      count: a.bundle?.images.length,
      privacy_level: a.privacy,
      privacy_label: a.privacy ? privacyLabel(a.privacy) : undefined,
      title: c.title,
      message: c.body,
      summary: c.spoken,
    }),
    card,
  );
}

/** What the reminder says: the outcome in a line, with the file (or photo count) it's about. */
export function endedMessage(json: Record<string, any>, a: Pick<Accepted, "kind" | "mode" | "file" | "bundle" | "privacy">): string {
  const n = a.bundle?.images.length ?? 0;
  const what = a.file ? a.file.name : n ? `${n} photo${n === 1 ? "" : "s"}` : "";
  const privacy = a.privacy ? privacyLabel(a.privacy) : "";
  const words = [String(json.summary ?? ""), String(json.message ?? "")].map((t) => t.trim()).filter(Boolean);
  switch (json.outcome) {
    case "posted":
      return a.mode === "drafts" ? `Your TikTok post is up${what ? `: ${what}` : ""}.` : `Your TikTok post is up${privacy ? ` (${privacy})` : ""}${what ? `: ${what}` : ""}.`;
    case "inbox":
      return `In your TikTok inbox${what ? `: ${what}` : ""}. Open TikTok and tap the notification to finish.`;
    case "processing":
      return `TikTok is still processing your post${what ? ` (${what})` : ""}. Ask 'did it go up?' any time.`;
    default:
      return `${a.mode === "drafts" ? "Your TikTok upload" : "Your TikTok post"}${what ? ` (${what})` : ""} didn't go through. ${words.join(" ")}`.trim();
  }
}

/** A detached job ended: keep its card for the reminder's Show button, then queue the reminder (best effort). */
async function endedLater(a: Accepted, id: string, result: ToolResult | undefined, deps: Deps, error?: unknown): Promise<void> {
  let json: Record<string, any>;
  if (result) {
    json = parseResult(result);
  } else {
    // execute() answers every failure itself; this is only a guard. TikTok may have it, so it's unknown, not failed.
    const err = new TikTokError("OUTCOME_UNKNOWN", { reason: "job_error" });
    log(`${a.tool} job error ${(error as Error)?.name ?? "error"}`);
    deps.ledger.update(id, { stage: "unknown", error_code: err.code });
    const input = inputFor(a, deps.ledger.get(id), "unknown", err);
    json = { outcome: "unknown", ...copyOf(input), _voiceos_glance: { blocks: [writeResultCard(input)] } };
  }
  const message = endedMessage(json, a);
  const card = json._voiceos_glance?.blocks?.[0] as Widget | undefined;
  if (card) deps.jobs.finished(id, card, message);
  await deps.reminders.trigger({ message, speak: false, actions: [{ ...SHOW_POST }], data: { entry: id } });
}

interface Polled {
  outcome: "inbox" | "posted" | "failed" | "processing";
  status?: PublishStatus;
  error?: TikTokError;
  failReason?: string;
  /** Why watching stopped early, when it did. */
  statusError?: TikTokError;
}

async function execute(a: Accepted, entry: LedgerEntry, release: () => void, deps: Deps, extra: ToolExtra, started: number): Promise<ToolResult> {
  const signal = signalOf(extra);
  const id = entry.task_id;
  let phase: "before" | "init" | "after" = "before";
  // The video's poster frame for the completion card (and for "did it go up?" through the ledger), made alongside
  // the upload. Best effort; a data URI, so it's never logged.
  let poster: string | undefined;
  let motion: VideoMotion | undefined;
  // The poster and the moving loop (cached from find_recent_videos or query_creator_info, so usually instant).
  const posterReady: Promise<string | undefined> = a.file
    ? deps
        .preview(a.file.path, { duration_sec: a.file.duration_sec, width: a.file.width, height: a.file.height }, { posterWidth: RESULT_POSTER_WIDTH, micro: false, motion: true })
        .then((p) => p, (): VideoPreview => ({}))
        .then((p) => {
          poster = p.poster;
          motion = p.motion;
          if (p.poster || p.motion) deps.ledger.update(id, { ...(p.poster ? { poster: p.poster } : {}), ...(p.motion ? { motion: p.motion } : {}) });
          return p.poster;
        })
    : Promise.resolve(undefined);
  /** Wait (briefly) for the poster before a card is built. */
  const withPoster = async () => void (await within(posterReady, POSTER_WAIT_MS));
  let captionCopied: boolean | undefined;
  let publishId: string | undefined;
  let batchId: string | undefined;
  let batchDeleted = false;
  const dropBatch = async () => {
    if (!batchId || batchDeleted) return;
    batchDeleted = true;
    await deps.relay.deleteBatch(batchId).catch(() => {});
  };
  // The text that was sent or handed off (a photo draft's card says "already filled in" only when there was some),
  // the clipboard outcome and the poster: inputFor() reads them, the last two as they stand now.
  const cardInput = (outcome: WriteResultInput["outcome"], error?: TikTokError): WriteResultInput => {
    const input = inputFor(a, undefined, outcome, error);
    if (captionCopied !== undefined) input.caption_copied = captionCopied;
    if (poster) input.poster = poster;
    if (motion) input.motion = motion;
    return input;
  };
  const facts = () =>
    compactObject({
      task_id: id,
      publish_id: publishId,
      kind: a.kind,
      mode: a.mode,
      file_name: a.file?.name,
      count: a.bundle?.images.length,
      privacy_level: a.privacy,
      privacy_label: a.privacy ? privacyLabel(a.privacy) : undefined,
      caption_copied: captionCopied,
      forced_off: a.forcedOff.length ? a.forcedOff : undefined,
    });
  const done = (outcome: string, err?: TikTokError) =>
    log(`${a.tool} ${outcome}${err ? ` ${err.code}` : ""} ${Math.max(0, deps.clock.now() - started)}ms${
      typeof err?.detail.log_id === "string" ? ` log_id=${err.detail.log_id}` : ""
    }${batchId ? ` batch=${batchId.slice(0, 6)}` : ""}`);

  try {
    progress(extra, 0, 4, "Getting ready");
    // The clipboard first, right after approval: a copy made minutes later could overwrite what the user copied since.
    // Only with something to copy: an empty caption must not clear what the user has on the clipboard.
    if (a.tool === "upload_video" && bool(a.args.copy_caption) && a.caption.trim()) {
      try {
        await deps.copyToClipboard(a.caption);
        captionCopied = true;
      } catch {
        captionCopied = false;
        log("upload_video: couldn't copy the caption to the clipboard");
      }
      deps.ledger.update(id, { caption_copied: captionCopied });
    }
    const creator = a.post ? await currentCreator(a, deps, signal) : undefined;
    // TikTok allows 6 inits a minute per user: take one before uploading anything.
    if (!deps.limits.writeInit.tryTake()) throw new TikTokError("RATE_LIMITED", { nothing_sent: true });
    await deps.client.assertAccount(signal);
    let data: unknown;
    if (a.kind === "video") {
      const file = a.file!;
      const timeoutMs = uploadTimeoutMs(file.size);
      progress(extra, 1, 4, "Uploading the video");
      // Checked again now, not only at approval: the write may have waited its turn, and a re-export saved over the
      // same path since then is another video (QA, PR 47). Again once staged, in case it changed while being read.
      restat(file);
      const staged = await deps.client.stageFile(file.path, file.mime, "TIKTOK_UPLOAD_VIDEO", deps.clock.now() + timeoutMs, signal);
      restat(file);
      deps.ledger.update(id, { stage: "uploading" });
      progress(extra, 2, 4, "Sending to TikTok");
      phase = "init";
      data = await deps.client.exec(
        "TIKTOK_UPLOAD_VIDEO",
        a.mode === "drafts" ? videoDraftArgs(staged) : videoDirectArgs(staged, a.args, creator!),
        { deadline: deps.clock.now() + timeoutMs + 1_000, write: true, timeoutMs, signal },
      );
    } else {
      const bundle = a.bundle!;
      progress(extra, 1, 4, "Preparing the photos");
      // The photos too: checked again at the write's turn, and once read, so only the approved ones go out.
      for (const image of bundle.images) restat(image, "image");
      const converted = await deps.convert(bundle.images, deps.runner);
      let urls: string[];
      try {
        for (const image of bundle.images) restat(image, "image");
        const batch = await deps.relay.createBatch(converted.files.length, signal);
        batchId = batch.batch_id;
        const files = converted.files.map((f) => ({ bytes: new Uint8Array(readFileSync(f.path)), mime: "image/jpeg" as const }));
        urls = await deps.relay.putImages(batch, files, signal);
      } finally {
        await converted.cleanup().catch(() => {});
      }
      deps.ledger.update(id, { stage: "uploading" });
      progress(extra, 2, 4, "Sending to TikTok");
      phase = "init";
      data = await deps.client.exec(
        "TIKTOK_POST_PHOTO",
        a.mode === "drafts"
          ? photoDraftArgs(urls, bundle.cover_index, a.args)
          : photoDirectArgs(urls, bundle.cover_index, a.args, { comment_disabled: creator!.comment_disabled }),
        { deadline: deps.clock.now() + PHOTO_INIT_TIMEOUT_MS + 1_000, write: true, timeoutMs: PHOTO_INIT_TIMEOUT_MS, signal },
      );
    }
    publishId = str(field(data, "publish_id")) || undefined;
    // TikTok said yes without an id: it may have taken it, so this is unknown, not a failure.
    if (!publishId) throw new TikTokError("OUTCOME_UNKNOWN", { reason: "no_publish_id" });
    phase = "after";
    deps.ledger.update(id, { stage: "processing", publish_id: publishId });
    // TikTok has answered the init: the next write for this account may start.
    release();
    progress(extra, 3, 4, "TikTok is processing it");
    const polled = await poll(publishId, deps, signal, async (status) => {
      deps.ledger.update(id, { last_status: status });
      // The relay copy goes once TikTok reports a final status (in the inbox, posted or failed): by then it has the
      // photos or won't fetch them. No earlier status proves the pull is over: PROCESSING_UPLOAD can come before it
      // (QA, PR 47), and deleting too soon fails the carousel. A batch left when watching ends expires on the relay.
      if (a.kind === "photos" && TERMINAL[status] !== undefined) await dropBatch();
    });
    await withPoster();
    return finish(a, id, polled, deps, cardInput, facts, done);
  } catch (e) {
    const err = normalizeError(e, { slug: a.tool });
    await withPoster();
    if (phase === "before") {
      // Nothing reached TikTok. Any relay batch goes now.
      await dropBatch();
      const refusal = nothingSent(err);
      deps.ledger.update(id, { stage: "failed", error_code: refusal.code });
      done("not_sent", refusal);
      return fail(refusal, writeResultCard(cardInput("failed", refusal)), { outcome: "failed", nothing_sent: true, ...facts(), ...copyOf(cardInput("failed", refusal)) });
    }
    if (phase === "init") {
      if (err.code === "OUTCOME_UNKNOWN") {
        // TikTok may have it (and may still pull the photos): no retry, and the batch stays until it expires.
        deps.ledger.update(id, { stage: "unknown", error_code: err.code });
        done("unknown", err);
        return fail(err, writeResultCard(cardInput("unknown", err)), { outcome: "unknown", ...facts(), ...copyOf(cardInput("unknown", err)) });
      }
      await dropBatch();
      deps.ledger.update(id, { stage: "failed", error_code: err.code });
      done("failed", err);
      return fail(err, writeResultCard(cardInput("failed", err)), { outcome: "failed", ...facts(), ...copyOf(cardInput("failed", err)) });
    }
    // After TikTok accepted it: the post is with TikTok whatever went wrong here.
    done("processing", err);
    return ok({ outcome: "processing", ...facts(), ...copyOf(cardInput("processing")) }, writeResultCard(cardInput("processing")));
  }
}

/** The card's words in the result too (nothing only on the card): its title, body, and the one spoken line as the summary. */
function copyOf(input: WriteResultInput, extra = ""): { title: string; message: string; summary: string } {
  const c = writeOutcomeCopy(input);
  return { title: c.title, message: `${c.body}${extra}`, summary: c.spoken };
}

function finish(
  a: Accepted,
  id: string,
  polled: Polled,
  deps: Deps,
  cardInput: (outcome: WriteResultInput["outcome"], error?: TikTokError) => WriteResultInput,
  facts: () => Record<string, unknown>,
  done: (outcome: string, err?: TikTokError) => void,
): ToolResult {
  const status = polled.status ? { status: polled.status } : {};
  if (polled.outcome === "failed") {
    const err = polled.error!;
    deps.ledger.update(id, { stage: "failed", error_code: err.code, ...(polled.failReason ? { fail_reason: polled.failReason } : {}) });
    done("failed", err);
    const input = cardInput("failed", err);
    return fail(err, writeResultCard(input), { outcome: "failed", ...status, ...facts(), ...copyOf(input) });
  }
  if (polled.outcome === "inbox" || polled.outcome === "posted") deps.ledger.update(id, { stage: "done" });
  done(polled.outcome, polled.statusError);
  const input = cardInput(polled.outcome);
  const forced = a.forcedOff.length ? ` ${a.forcedOff.join(", ")} stayed off: this account has them turned off.` : "";
  const watch = polled.statusError ? { status_check: { code: polled.statusError.code, message: polled.statusError.spoken } } : {};
  return ok({ outcome: polled.outcome, ...status, ...facts(), ...watch, ...copyOf(input, forced) }, writeResultCard(input));
}

// ---------------------------------------------------------------------------
// Creator info at the write's turn
// ---------------------------------------------------------------------------

/**
 * The creator flags to send. When the post_token's creator info is over 10
 * minutes old by the time this write's turn comes, ask TikTok again; if the
 * chosen privacy is no longer allowed, refuse with nothing sent.
 */
async function currentCreator(a: Accepted, deps: Deps, signal: AbortSignal): Promise<CreatorFlags> {
  const post = a.post!;
  const flags: CreatorFlags = { comment_disabled: post.comment_disabled, duet_disabled: post.duet_disabled, stitch_disabled: post.stitch_disabled };
  if (deps.clock.now() - post.fetched_at <= POST_TTL_MS) return flags;
  if (!deps.limits.creatorInfo.tryTake()) throw new TikTokError("RATE_LIMITED", { nothing_sent: true });
  await deps.client.assertAccount(signal);
  const fresh = creatorOf(await deps.client.exec("TIKTOK_QUERY_CREATOR_INFO", {}, { deadline: deps.clock.now() + READ_BUDGET_MS, signal }));
  if (!fresh.privacy_options.includes(a.privacy!)) {
    throw new TikTokError("PRIVACY_MISMATCH", { chosen: a.privacy, options: fresh.privacy_options, nothing_sent: true });
  }
  const dur = a.file?.duration_sec;
  if (dur !== undefined && fresh.max_duration_sec !== undefined && dur > fresh.max_duration_sec) {
    throw new TikTokError("FILE_TOO_LONG", { max: fresh.max_duration_sec, dur: Math.ceil(dur), nothing_sent: true });
  }
  return { comment_disabled: fresh.comment_disabled, duet_disabled: fresh.duet_disabled, stitch_disabled: fresh.stitch_disabled };
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

const TERMINAL: Record<string, Polled["outcome"]> = { SEND_TO_USER_INBOX: "inbox", PUBLISH_COMPLETE: "posted", FAILED: "failed" };
const KNOWN_STATUS = new Set(["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"]);

/**
 * Watch a publish_id until TikTok reports a terminal status, or until
 * pollMaxMs has passed ("still processing"). A failed status check is retried
 * at the next tick unless it can't clear by waiting; it never makes the
 * outcome "failed". The init is never repeated.
 */
export async function poll(
  publishId: string,
  deps: Deps,
  signal: AbortSignal,
  onStatus: (status: PublishStatus) => Promise<void>,
): Promise<Polled> {
  const start = deps.clock.now();
  const schedule = deps.pollScheduleMs;
  let last: PublishStatus | undefined;
  for (let i = 0; ; i++) {
    const wait = Math.max(schedule[Math.min(i, schedule.length - 1)], deps.limits.status.msUntilNext());
    if (deps.clock.now() + wait - start > deps.pollMaxMs) return { outcome: "processing", status: last };
    try {
      await deps.clock.sleep(wait, signal);
    } catch {
      // VoiceOS stopped waiting: TikTok still has the post.
      return { outcome: "processing", status: last };
    }
    if (!deps.limits.status.tryTake()) continue;
    let data: unknown;
    try {
      data = await deps.client.exec("TIKTOK_FETCH_PUBLISH_STATUS", { publish_id: publishId }, { deadline: deps.clock.now() + READ_BUDGET_MS, signal });
    } catch (e) {
      const err = normalizeError(e, { slug: "TIKTOK_FETCH_PUBLISH_STATUS" });
      if (STOP_POLLING.has(err.code)) return { outcome: "processing", status: last, statusError: err };
      log(`status check ${err.code}; trying again`);
      continue;
    }
    const status = str(field(data, "status")).toUpperCase();
    if (!KNOWN_STATUS.has(status)) continue;
    last = status as PublishStatus;
    await onStatus(last);
    const outcome = TERMINAL[status];
    if (!outcome) continue;
    if (outcome === "failed") {
      const reason = str(field(data, "fail_reason"));
      return { outcome, status: last, error: failReasonError(reason), ...(reason ? { failReason: reason } : {}) };
    }
    return { outcome, status: last };
  }
}

export type { LedgerPatch };
