/**
 * Shared types. Every module imports its cross-module shapes from here, so
 * the pieces built in parallel agree on names. Type-only: no runtime code.
 */

/** Time, injectable so tests never wait for real backoff. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects with the signal's reason when aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the kill timer fired. */
  timedOut: boolean;
}

export interface RunOptions {
  /** Kill the child after this long (users' Macs have no `timeout` command). Default 10 000. */
  timeoutMs?: number;
  stdin?: string;
  cwd?: string;
}

/** Runs a child process: `cmd[0]` with `cmd.slice(1)`. Injected so CI (ubuntu) never shells out to sips/osascript/mdls/defaults. */
export type Runner = (cmd: string[], opts?: RunOptions) => Promise<RunResult>;

/** TikTok's Get Post Status values, plus the stages our own ledger tracks before TikTok answers. */
export type PublishStatus = "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED";

export type PrivacyLevel = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

export type WriteTool = "upload_video" | "publish_video" | "upload_photos" | "post_photos";

export type MediaKind = "video" | "photos";
export type WriteMode = "drafts" | "direct";

// ---------------------------------------------------------------------------
// Local media (find_recent_videos / find_recent_images / prepare_photo_post)
// ---------------------------------------------------------------------------

export interface FoundVideo {
  /** Absolute path. Server-side only: never returned to the model or logged. */
  path: string;
  /** Basename, e.g. "final_export.mp4". */
  name: string;
  /** Display folder relative to home, e.g. "Downloads" or "Movies/Exports". */
  folder: string;
  size: number;
  mtimeMs: number;
  /** Arrival time (NSURLAddedToDirectoryDateKey, falling back to birthtime then mtime), epoch ms. */
  addedMs: number;
  /** "video/mp4" | "video/quicktime". */
  mime: string;
  duration_sec?: number;
  width?: number;
  height?: number;
}

export interface FoundImage {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtimeMs: number;
  addedMs: number;
  /** Lower-case extension without the dot: "jpg" | "jpeg" | "png" | "heic" | "heif" | "webp". */
  ext: string;
  width?: number;
  height?: number;
  /** sips `format`, e.g. "jpeg", "png", "heic". */
  format?: string;
  has_alpha?: boolean;
  is_screenshot: boolean;
}

export type CredentialsResult = "none" | "present" | "ai";

/** What `bundle_token` binds: the ordered images and the cover. */
export interface BundleImage {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  width: number;
  height: number;
  format: string;
  has_alpha: boolean;
  credentials: CredentialsResult;
}

// ---------------------------------------------------------------------------
// Server tokens (tokens.ts): what each token resolves to on the server
// ---------------------------------------------------------------------------

export interface FileRef {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtimeMs: number;
  mime: string;
  duration_sec?: number;
  width?: number;
  height?: number;
  /** The micro preview find_recent_videos returned with this token (src/preview.ts): a card's `preview` must equal it. */
  preview?: string;
}

export interface ImageRef {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtimeMs: number;
  ext: string;
  is_screenshot: boolean;
}

export interface BundleRef {
  images: BundleImage[];
  cover_index: number;
  /** The photo stack prepare_photo_post returned with this token (src/preview.ts): a card's `preview` must be it. */
  preview?: string;
  /** The first photos as small 3:4 JPEG data URIs, for the result cards. Never part of a result's data, never logged. */
  thumbs?: string[];
  /** prepare_photo_post's warning line, when it had one: a card's `warning` must be it (and must be there). */
  warning?: string;
}

export interface PostRef {
  connected_account_id: string;
  creator_nickname: string;
  creator_username?: string;
  /** Upper-cased TikTok privacy_level_options, in TikTok's order. */
  privacy_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_duration_sec?: number;
  /** The file_token or bundle_token this creator info was fetched for. */
  media_token: string;
  media_kind: MediaKind;
  /** When creator info was fetched (epoch ms). */
  fetched_at: number;
}

// ---------------------------------------------------------------------------
// Composio / TikTok shapes
// ---------------------------------------------------------------------------

/** Composio's file descriptor for `file_to_upload` (Files API). */
export interface StagedFile {
  name: string;
  mimetype: string;
  s3key: string;
}

export interface CreatorInfo {
  creator_nickname: string;
  creator_username?: string;
  creator_avatar_url?: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec?: number;
}

/** One TikTok Video Object, trimmed to what the cards and the model use. Fields TikTok didn't return stay undefined. */
export interface VideoSummary {
  id: string;
  /** video_description, else title (TikTok returns at most 150 chars). */
  caption: string;
  title?: string;
  video_description?: string;
  /** UTC seconds. */
  create_time?: number;
  duration?: number;
  width?: number;
  height?: number;
  cover_image_url?: string;
  share_url?: string;
  embed_link?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  is_aigc?: boolean;
}

export interface VideoDetails extends VideoSummary {
  hashtags: string[];
  mentions: string[];
  /** True when the returned caption is exactly 150 chars (TikTok's cut). */
  caption_truncated: boolean;
  /** "Nov 1 · 3 days ago". */
  posted_label?: string;
  /** "9:16". */
  aspect?: string;
  /** (likes + comments + shares) / views, only when views ≥ 100. */
  engagement_rate?: number;
}

// ---------------------------------------------------------------------------
// Ledger (ledger.ts): what VoiceOS sent, so "did it go up?" works for private posts and drafts
// ---------------------------------------------------------------------------

export type LedgerStage = "staging" | "uploading" | "processing" | "done" | "failed" | "unknown";

export interface LedgerEntry {
  /** Ours, minted when the background write starts. */
  task_id: string;
  /**
   * Which TikTok connection sent it: the first 16 hex of SHA-256 of the Composio connected account id (never the
   * id itself). Reads show only the current connection's sends, so a newly connected account starts with an
   * empty history. Entries written before 1.2.1 have none and are hidden once a connection is configured.
   */
  account?: string;
  tool: WriteTool;
  stage: LedgerStage;
  publish_id?: string;
  kind: MediaKind;
  mode: WriteMode;
  created_at: string;
  updated_at: string;
  last_status?: PublishStatus;
  fail_reason?: string;
  /** Our error code when stage is failed/unknown. */
  error_code?: string;
  /** Basenames only, never paths; `folder` is the containing folder's own name ("voice clone safety slides"). */
  media: { names: string[]; count: number; folder?: string; cover_index?: number; duration_sec?: number };
  /**
   * The sent video's poster frame (a JPEG data URI) for the completion card and "did it go up?". In memory
   * only, like the rest of the ledger; never logged and never part of a result's data.
   */
  poster?: string;
  /** A photo post's photos (small JPEG data URIs) for its cards, like `poster`. */
  thumbs?: string[];
  /** The sent video's moving loop (src/preview.ts VideoMotion) for its cards, like `poster`. */
  motion?: { src: string; frames?: number; fps?: number };
  details: {
    caption?: string;
    title?: string;
    description?: string;
    privacy_level?: string;
    allow_comment?: boolean;
    allow_duet?: boolean;
    allow_stitch?: boolean;
    auto_add_music?: boolean;
    commercial_disclosure?: boolean;
    brand_organic?: boolean;
    brand_content?: boolean;
    is_aigc?: boolean;
    cover_ms?: number;
    caption_copied?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A glance block carrying a widget, as `_voiceos_glance.blocks` takes it. */
export interface Widget {
  type: "widget";
  html: string;
  height: number;
  label?: string;
}
