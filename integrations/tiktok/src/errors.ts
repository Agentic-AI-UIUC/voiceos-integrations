/**
 * Every failure the integration can report, with the words the user sees.
 *
 * One error type (TikTokError) carries our code plus a detail object. Its
 * `message` is the one-sentence spoken line; `card` is the longer card text
 * and `title` the card headline (plan §5.5, Studio brief "Error codes and
 * copy"). TikTok's own `error.code` strings and `fail_reason` values map onto
 * our codes here and nowhere else.
 */

export type TikTokErrorCode =
  | "NOT_CONFIGURED" | "NOT_CONNECTED" | "AUTH_EXPIRED" | "AUTH_REVOKED" | "SCOPE_MISSING"
  | "CREATOR_CANNOT_POST" | "DRAFTS_CAP" | "POSTING_CAP" | "PRIVATE_ACCOUNT_REQUIRED"
  | "PRIVACY_MISMATCH" | "BRANDED_PRIVATE_BLOCKED" | "DISCLOSURE_INCOMPLETE" | "URL_OWNERSHIP_UNVERIFIED"
  | "FILE_NOT_FOUND" | "FOLDER_PERMISSION_DENIED" | "AUTOMATION_DENIED" | "FILE_TOO_LONG" | "FILE_TOO_LARGE" | "UNSUPPORTED_FORMAT"
  | "TOO_MANY_PHOTOS" | "NO_PHOTOS" | "IMAGE_TOO_LARGE" | "IMAGE_UNREADABLE" | "INVALID_PARAM"
  | "CAPTION_TOO_LONG" | "TITLE_TOO_LONG" | "DESCRIPTION_TOO_LONG"
  | "RELAY_NOT_CONFIGURED" | "RELAY_UNAVAILABLE" | "RELAY_EXPIRED"
  | "RATE_LIMITED" | "PROCESSING_FAILED" | "UPLOAD_FAILED" | "TOKEN_STALE" | "APP_VERSION_TOO_OLD"
  | "MIXED_MEDIA_NOT_SUPPORTED"
  | "CONFIRMATION_REQUIRED" | "OUTCOME_UNKNOWN" | "CAPTION_FLAGGED" | "POST_BLOCKED" | "CANCELLED"
  | "TIMEOUT" | "TIKTOK_SERVER" | "UNKNOWN";

export type Detail = Record<string, unknown>;

/** Plain-word privacy labels, shared by cards, copy and the confirmation widgets. */
export const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};
export const privacyLabel = (v: unknown) => PRIVACY_LABELS[String(v ?? "").trim().toUpperCase()] ?? String(v ?? "");

const s = (v: unknown, fallback = "") => (v === undefined || v === null || v === "" ? fallback : String(v));
const trim = (v: unknown, max = 200) => {
  const t = s(v).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

interface Copy {
  /** Card headline, ≤ 60 chars. */
  title: string;
  /** One sentence the agent can say. */
  spoken: string;
  /** The card's body text. */
  card: (d: Detail) => string;
}

/** What a card that didn't match its token showed wrong, by label (src/tools/writes.ts cardLabelsAreTrue). */
const MISMATCH_LINE: Record<string, string> = {
  duration_label: "The card showed another length for this video. Ask again and check the card.",
  size_label: "The card showed another size for this video. Ask again and check the card.",
  cover_label: "The card showed another cover time. Ask again and check the card.",
  warning: "The card didn't show the right note about these photos. Ask again and check the card.",
};

const COPY: Record<TikTokErrorCode, Copy> = {
  NOT_CONFIGURED: {
    title: "Set up TikTok",
    spoken: "TikTok isn't set up yet.",
    card: (d) =>
      d.reason === "key_rejected"
        ? "Composio didn't accept the API key. Paste a project API key (not ck_ or uak_) in the integration's settings."
        : "Add your Composio API key and connected account id in the integration's settings.",
  },
  NOT_CONNECTED: {
    title: "Connect TikTok",
    spoken: "Your TikTok isn't connected.",
    card: (d) =>
      d.reason === "other_user"
        ? "That connection belongs to a different Composio user ID. Set the matching user ID in settings."
        : d.reason === "connecting"
          ? "TikTok hasn't finished connecting. Finish signing in through Composio, then try again."
          : "Connect TikTok in Composio → Connected accounts, then paste the active connection id in settings.",
  },
  AUTH_EXPIRED: {
    title: "Reconnect TikTok",
    spoken: "Your TikTok connection expired.",
    card: () => "Reconnect TikTok in Composio, then try again. Nothing was posted.",
  },
  AUTH_REVOKED: {
    title: "TikTok access removed",
    spoken: "TikTok access was removed.",
    card: () => "It was turned off in TikTok or Composio. Reconnect to use it again.",
  },
  SCOPE_MISSING: {
    title: "Permission missing",
    spoken: "TikTok didn't grant that permission.",
    card: (d) => `Reconnect and allow ${s(d.scope, "the missing permission")}.`,
  },
  CREATOR_CANNOT_POST: {
    title: "Can't post right now",
    spoken: "TikTok says you can't post right now.",
    card: () => "Try again later.",
  },
  DRAFTS_CAP: {
    title: "Drafts limit reached",
    spoken: "You've hit TikTok's drafts limit.",
    card: () => "TikTok allows 5 pending drafts per 24 hours. Finish or delete some in the TikTok app first.",
  },
  POSTING_CAP: {
    title: "Daily posting limit reached",
    spoken: "You've hit today's TikTok posting limit.",
    card: () => "Try again tomorrow, or post from the TikTok app.",
  },
  PRIVATE_ACCOUNT_REQUIRED: {
    title: "Private account needed",
    spoken: "Your account needs to be private for now.",
    card: () => "Until TikTok approves this app, posts need a private account and stay Only me. Switch to private, then try again.",
  },
  PRIVACY_MISMATCH: {
    title: "Pick who can see it",
    spoken: "That privacy option isn't available.",
    card: (d) => {
      const opts = Array.isArray(d.options) ? (d.options as unknown[]).map(privacyLabel).filter(Boolean) : [];
      const list = opts.length ? opts.join(", ") : "Only me";
      return s(d.chosen) === ""
        ? `Pick who can see it on the card. Options: ${list}.`
        : `Pick one of: ${list}.`;
    },
  },
  BRANDED_PRIVATE_BLOCKED: {
    title: "Branded content can't be private",
    spoken: "Branded content can't be private.",
    card: () => "Posts from this app are Only me for now. Send it to drafts and post from TikTok, or turn off Branded content.",
  },
  DISCLOSURE_INCOMPLETE: {
    title: "Say what you're promoting",
    spoken: "Tell me what you're promoting.",
    card: () => "You need to indicate if your content promotes yourself, a third party, or both.",
  },
  URL_OWNERSHIP_UNVERIFIED: {
    title: "Photo host not verified",
    spoken: "TikTok wouldn't accept where the photos are hosted.",
    card: () => "The photo host isn't verified for this app yet. Videos still work.",
  },
  FILE_NOT_FOUND: {
    title: "File not found",
    spoken: "I couldn't find that file.",
    card: () => "It may have moved. Say its name, or ask for your recent videos or photos.",
  },
  FOLDER_PERMISSION_DENIED: {
    title: "Folder access needed",
    spoken: "I can't see that folder.",
    card: (d) =>
      `Allow VoiceOS in System Settings → Privacy & Security → Files and Folders${
        Array.isArray(d.folders) && d.folders.length ? ` (${(d.folders as unknown[]).map(String).join(", ")})` : ""
      }.`,
  },
  AUTOMATION_DENIED: {
    title: "Automation access needed",
    spoken: "macOS isn't letting VoiceOS see which video you mean.",
    card: (d) =>
      `Turn on ${s(d.app, "Finder")} for VoiceOS in System Settings → Privacy & Security → Automation, or describe the video.`,
  },
  FILE_TOO_LONG: {
    title: "Video too long",
    spoken: "That video is too long for your account.",
    card: (d) =>
      d.mode === "drafts"
        ? `Max ${s(d.max, "600")}s from apps; this one is ${s(d.dur, "?")}s. Trim it, then send it again.`
        : `Max ${s(d.max, "?")}s; this one is ${s(d.dur, "?")}s. Send it to drafts instead and trim it in TikTok.`,
  },
  FILE_TOO_LARGE: {
    title: "File too big",
    spoken: "That file is too big.",
    card: (d) => `${s(d.size, "This file")}. TikTok accepts videos up to 4 GB.`,
  },
  UNSUPPORTED_FORMAT: {
    title: "File type not supported",
    spoken: "TikTok can't take that file type.",
    card: () => "Use an .mp4 or .mov video, or a .jpg/.png/.heic/.webp photo.",
  },
  TOO_MANY_PHOTOS: {
    title: "Too many photos",
    spoken: "TikTok allows 35 photos per post.",
    card: (d) => `You picked ${s(d.n, "more than 35")}. Want the first 35, or split them into two posts?`,
  },
  NO_PHOTOS: {
    title: "No photos found",
    spoken: "I didn't find any photos.",
    card: () => "Say the file names, or put the photos in Downloads, Desktop or Pictures.",
  },
  IMAGE_TOO_LARGE: {
    title: "Photo too big",
    spoken: "One photo is still too big after resizing.",
    card: (d) => `${s(d.name, "A photo")} is over 20 MB. Try exporting it smaller.`,
  },
  IMAGE_UNREADABLE: {
    title: "Photo can't be read",
    spoken: "I couldn't read one of the photos.",
    card: (d) => `${s(d.name, "One photo")} may be damaged or unsupported. Remove it and try again.`,
  },
  INVALID_PARAM: {
    title: "TikTok rejected the details",
    spoken: "TikTok rejected the post details.",
    card: (d) => trim(d.message) || "TikTok didn't accept one of the post's settings.",
  },
  CAPTION_TOO_LONG: {
    title: "Caption too long",
    spoken: "That text is too long.",
    card: () => "Captions take up to 2,200 characters (emoji count as 2).",
  },
  TITLE_TOO_LONG: {
    title: "Title too long",
    spoken: "That text is too long.",
    card: () => "Photo titles take up to 90 characters (emoji count as 2).",
  },
  DESCRIPTION_TOO_LONG: {
    title: "Description too long",
    spoken: "That text is too long.",
    card: () => "Descriptions take up to 4,000 characters (emoji count as 2).",
  },
  RELAY_NOT_CONFIGURED: {
    title: "Photo posting isn't set up",
    spoken: "Photo posting isn't set up yet.",
    card: () => "Videos work; photo carousels need the media relay.",
  },
  RELAY_UNAVAILABLE: {
    title: "Couldn't stage the photos",
    spoken: "I couldn't stage the photos.",
    card: () => "Try again in a minute. Nothing was sent to TikTok.",
  },
  RELAY_EXPIRED: {
    title: "Upload took too long",
    spoken: "That upload took too long.",
    card: () => "TikTok couldn't fetch the photos in time. Try again.",
  },
  RATE_LIMITED: {
    title: "Slow down",
    spoken: "TikTok asked me to slow down.",
    card: () => "Try again in a minute.",
  },
  PROCESSING_FAILED: {
    title: "TikTok couldn't process it",
    spoken: "TikTok couldn't process the post.",
    card: (d) => `Reason: ${s(d.fail_reason, "not given")}.`,
  },
  UPLOAD_FAILED: {
    title: "Upload didn't go through",
    spoken: "The video didn't upload.",
    card: () => "Nothing was posted. Try again in a minute, or export the video again if it keeps failing.",
  },
  TOKEN_STALE: {
    title: "Confirmation expired",
    spoken: "That confirmation expired.",
    // A file, photo or bundle token goes stale when VoiceOS restarts the server or the file changes: the agent finds
    // the same media again (find_recent_videos returns the video in progress) and keeps the caption and settings.
    card: (d) =>
      d.kind === "image" || d.kind === "bundle"
        ? "The photos changed, or VoiceOS restarted. Ask again to keep the same order."
        : d.kind === "file" || d.reason === "file_changed"
          ? "The video changed, or VoiceOS restarted. Say 'the same video' to keep the caption and settings."
          : "Ask again and I'll refresh your options.",
  },
  APP_VERSION_TOO_OLD: {
    title: "Update TikTok",
    spoken: "Your TikTok app is too old for photo drafts.",
    card: () => "Update TikTok to 31.8 or later, or say 'post them' to post directly.",
  },
  MIXED_MEDIA_NOT_SUPPORTED: {
    title: "Photos and video can't mix",
    spoken: "One TikTok post can't mix photos and video.",
    card: () => "Post them separately, or send the video on its own.",
  },
  CONFIRMATION_REQUIRED: {
    title: "Not sent",
    spoken: "Not sent. Nothing reached TikTok.",
    card: (d) =>
      d.reason === "card_mismatch"
        ? (Object.prototype.hasOwnProperty.call(MISMATCH_LINE, String(d.field)) ? MISMATCH_LINE[String(d.field)] : undefined) ??
          (d.kind === "photos"
            ? "The card showed a different number of photos. Ask again and check the card."
            : "The card named a different video. Ask again and check the file name.")
        : "Ask again and click the card's button; saying yes sends nothing. No card? Turn on Ask before every action.",
  },
  OUTCOME_UNKNOWN: {
    title: "Not sure it went through",
    spoken: "I'm not sure that went through.",
    card: () => "TikTok may have it. Check your drafts or profile before trying again.",
  },
  CAPTION_FLAGGED: {
    title: "Caption flagged",
    spoken: "TikTok flagged the caption.",
    card: () => "TikTok's spam check flagged the text. Edit the caption and try again.",
  },
  POST_BLOCKED: {
    title: "Post blocked",
    spoken: "TikTok blocked this post.",
    card: () => "TikTok's safety check stopped it. If that's a mistake, post from the TikTok app.",
  },
  CANCELLED: {
    title: "Cancelled",
    spoken: "Cancelled.",
    card: () => "TikTok didn't get the photos.",
  },
  TIMEOUT: {
    title: "TikTok is taking a while",
    spoken: "TikTok is taking a while.",
    card: () => "It may still go through. Ask 'did it go up?' in a few minutes.",
  },
  TIKTOK_SERVER: {
    title: "TikTok is having trouble",
    spoken: "TikTok is having trouble right now.",
    card: () => "Try again in a few minutes.",
  },
  UNKNOWN: {
    title: "Something went wrong",
    spoken: "Something went wrong with TikTok.",
    card: (d) => `${trim(d.message) || "TikTok or Composio returned an error."} Nothing was retried.`,
  },
};

export class TikTokError extends Error {
  readonly code: TikTokErrorCode;
  readonly detail: Detail;
  constructor(code: TikTokErrorCode, detail: Detail = {}) {
    super(COPY[code].spoken);
    this.name = "TikTokError";
    this.code = code;
    this.detail = detail;
  }
  /** Card headline. */
  get title(): string {
    return COPY[this.code].title;
  }
  /** One sentence for the agent to say. */
  get spoken(): string {
    return COPY[this.code].spoken;
  }
  /** Card body text. */
  get card(): string {
    return COPY[this.code].card(this.detail);
  }
  /** What the model reads in a failed result. No paths, keys or tokens ever go in `detail`. */
  toJSON() {
    return { code: this.code, message: this.spoken, detail: this.card };
  }
}

export const isTikTokError = (e: unknown): e is TikTokError => e instanceof TikTokError;

// ---------------------------------------------------------------------------
// TikTok's error.code strings → our code (plan §5.5; Studio brief)
// ---------------------------------------------------------------------------

export const TIKTOK_CODE_MAP: Record<string, TikTokErrorCode> = {
  access_token_invalid: "AUTH_EXPIRED",
  scope_not_authorized: "SCOPE_MISSING",
  rate_limit_exceeded: "RATE_LIMITED",
  spam_risk_too_many_posts: "POSTING_CAP",
  spam_risk_too_many_pending_share: "DRAFTS_CAP",
  spam_risk_user_banned_from_posting: "CREATOR_CANNOT_POST",
  reached_active_user_cap: "CREATOR_CANNOT_POST",
  unaudited_client_can_only_post_to_private_accounts: "PRIVATE_ACCOUNT_REQUIRED",
  privacy_level_option_mismatch: "PRIVACY_MISMATCH",
  url_ownership_unverified: "URL_OWNERSHIP_UNVERIFIED",
  invalid_file_upload: "UPLOAD_FAILED",
  invalid_param: "INVALID_PARAM",
  invalid_params: "INVALID_PARAM",
  invalid_publish_id: "INVALID_PARAM",
  token_not_authorized_for_specified_publish_id: "INVALID_PARAM",
  publish_not_cancellable: "INVALID_PARAM",
  app_version_check_failed: "APP_VERSION_TOO_OLD",
  internal_error: "TIKTOK_SERVER",
};

/** TikTok's 13 fail_reason values (status FAILED) → our code + TikTok's retry guidance. */
export const FAIL_REASON_MAP: Record<string, { code: TikTokErrorCode; retry: "no" | "yes" | "fix-first" }> = {
  file_format_check_failed: { code: "UNSUPPORTED_FORMAT", retry: "fix-first" },
  duration_check_failed: { code: "FILE_TOO_LONG", retry: "fix-first" },
  frame_rate_check_failed: { code: "UNSUPPORTED_FORMAT", retry: "fix-first" },
  picture_size_check_failed: { code: "UNSUPPORTED_FORMAT", retry: "fix-first" },
  internal: { code: "TIKTOK_SERVER", retry: "yes" },
  video_pull_failed: { code: "PROCESSING_FAILED", retry: "yes" },
  photo_pull_failed: { code: "RELAY_EXPIRED", retry: "yes" },
  publish_cancelled: { code: "CANCELLED", retry: "no" },
  auth_removed: { code: "AUTH_REVOKED", retry: "no" },
  spam_risk_too_many_posts: { code: "POSTING_CAP", retry: "no" },
  spam_risk_user_banned_from_posting: { code: "CREATOR_CANNOT_POST", retry: "no" },
  spam_risk_text: { code: "CAPTION_FLAGGED", retry: "fix-first" },
  spam_risk: { code: "POST_BLOCKED", retry: "no" },
};

/** A TikTok `error` object ({ code, message, log_id }) → our error. */
export function tiktokErrorFrom(err: { code?: unknown; message?: unknown; log_id?: unknown }): TikTokError {
  const raw = s(err?.code).trim();
  const code = TIKTOK_CODE_MAP[raw] ?? "UNKNOWN";
  const detail: Detail = { tiktok_code: raw || undefined, message: trim(err?.message) || raw || undefined };
  if (typeof err?.log_id === "string" && err.log_id) detail.log_id = err.log_id;
  if (code === "SCOPE_MISSING") detail.scope = scopeFromMessage(s(err?.message));
  return new TikTokError(code, detail);
}

/** A FAILED status's fail_reason → our error. Unknown reasons become PROCESSING_FAILED with the reason shown. */
export function failReasonError(reason: unknown): TikTokError {
  const r = s(reason).trim();
  const mapped = FAIL_REASON_MAP[r];
  return new TikTokError(mapped?.code ?? "PROCESSING_FAILED", { fail_reason: r || undefined, retry: mapped?.retry });
}

function scopeFromMessage(message: string): string | undefined {
  const m = message.match(/\b(user\.info\.(?:basic|profile|stats)|video\.(?:list|upload|publish))\b/);
  return m?.[1];
}

/**
 * TikTok's error codes are snake_case words ("spam_risk_too_many_posts"); Composio's are numbers or PascalCase slugs.
 * An object with such a code and TikTok's message or log_id is TikTok's own error, listed in TIKTOK_CODE_MAP or not.
 */
const TIKTOK_CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const isTikTokErrorObject = (o: Record<string, unknown>) =>
  typeof o.code === "string" && (Boolean(TIKTOK_CODE_MAP[o.code]) || (TIKTOK_CODE_SHAPE.test(o.code) && ("log_id" in o || "message" in o)));

/** Codes found inside free text, longest first so `spam_risk_too_many_posts` wins over shorter keys. */
const SCANNABLE = Object.keys(TIKTOK_CODE_MAP).sort((a, b) => b.length - a.length);

function scanText(text: string): TikTokError | undefined {
  for (const key of SCANNABLE) {
    if (new RegExp(`(^|[^a-z_])${key}([^a-z_]|$)`).test(text)) {
      return tiktokErrorFrom({ code: key, message: text });
    }
  }
  return undefined;
}

/** Composio's own refusals (connection, key, rate limit), by its slug. `source: "composio"`: Composio answered them itself. */
function fromComposioSlug(slug: string, message: string): TikTokError | undefined {
  const source = "composio";
  if (/ConnectedAccountNotFound|NoConnectedAccount|ConnectedAccount_NotFound/i.test(slug)) return new TikTokError("NOT_CONNECTED", { message, source });
  if (/Expired/i.test(slug)) return new TikTokError("AUTH_EXPIRED", { message, source });
  if (/Inactive|Disabled|Revoked/i.test(slug)) return new TikTokError("AUTH_REVOKED", { message, source });
  if (/Unauthori[sz]ed|InvalidApiKey|ApiKey|Forbidden/i.test(slug)) return new TikTokError("NOT_CONFIGURED", { reason: "key_rejected", source });
  if (/RateLimit|TooManyRequests/i.test(slug)) return new TikTokError("RATE_LIMITED", { message, source });
  return undefined;
}

export interface NormalizeContext {
  /** The Composio tool slug or endpoint, for logs. */
  slug?: string;
  /** HTTP status of the Composio response, if any. */
  status?: number;
  /** True for Composio's own endpoints (connected accounts, files): a 401 there means the API key was rejected. */
  composioOwn?: boolean;
}

/**
 * Anything thrown or returned as a failure → our error. Handles TikTok error
 * objects, Composio's `{ error: { message, slug, status } }`, JSON strings,
 * free text that names a TikTok code, HTTP statuses and timeouts.
 */
export function normalizeError(raw: unknown, ctx: NormalizeContext = {}, depth = 0): TikTokError {
  if (raw instanceof TikTokError) return raw;
  if (depth > 4) return new TikTokError("UNKNOWN", { slug: ctx.slug });
  if (raw instanceof Error) {
    if (raw.name === "TimeoutError" || raw.name === "AbortError") return new TikTokError("TIMEOUT", { slug: ctx.slug });
    return scanText(raw.message) ?? fromStatus(ctx) ?? new TikTokError("UNKNOWN", { message: trim(raw.message), slug: ctx.slug });
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return normalizeError(JSON.parse(t), ctx, depth + 1);
      } catch {
        /* not JSON: fall through to text */
      }
    }
    return scanText(t) ?? fromStatus(ctx) ?? new TikTokError("UNKNOWN", { message: trim(t), slug: ctx.slug });
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const status = typeof o.composioStatus === "number" ? o.composioStatus : typeof o.status === "number" ? o.status : ctx.status;
    const next = { ...ctx, status };
    if (isTikTokErrorObject(o)) return tiktokErrorFrom(o as never);
    if (o.error && typeof o.error === "object") {
      const inner = normalizeError(o.error, next, depth + 1);
      if (inner.code !== "UNKNOWN" || inner.detail.tiktok_code !== undefined) return inner;
    }
    const message = s(o.message ?? (typeof o.error === "string" ? o.error : ""));
    if (typeof o.slug === "string") {
      const bySlug = fromComposioSlug(o.slug, message);
      if (bySlug) return bySlug;
    }
    if (typeof o.error === "string") {
      const fromText = normalizeError(o.error, next, depth + 1);
      if (fromText.code !== "UNKNOWN") return fromText;
    }
    if (message) {
      const fromText = scanText(message);
      if (fromText) return fromText;
    }
    return fromStatus(next) ?? new TikTokError("UNKNOWN", { message: trim(message) || undefined, slug: ctx.slug });
  }
  return fromStatus(ctx) ?? new TikTokError("UNKNOWN", { slug: ctx.slug });
}

function fromStatus(ctx: NormalizeContext): TikTokError | undefined {
  const st = ctx.status;
  if (typeof st !== "number") return undefined;
  if (st === 401 || st === 403) return ctx.composioOwn ? new TikTokError("NOT_CONFIGURED", { reason: "key_rejected", status: st }) : new TikTokError("AUTH_EXPIRED", { status: st });
  if (st === 429) return new TikTokError("RATE_LIMITED", { status: st });
  if (st >= 500) return new TikTokError("TIKTOK_SERVER", { status: st });
  return undefined;
}

/** Errors that mean "check the connection again before believing anything" (plan §5.6 expiry detection). */
export function isAuthShaped(e: TikTokError): boolean {
  return e.code === "AUTH_EXPIRED" || e.code === "AUTH_REVOKED" || e.code === "NOT_CONNECTED" || e.detail.status === 401;
}
