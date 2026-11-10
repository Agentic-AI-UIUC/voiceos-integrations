/**
 * The four reads (plan §6.1–6.4): profile stats, recent public posts, post
 * details and post status. Each returns trimmed JSON, a plain-fact summary and
 * one card. Captions are TikTok users' writing: results carry them as data
 * with UNTRUSTED_NOTE, and summaries never quote them.
 */
import { UNTRUSTED_NOTE, cleanText, clipText, hashtags, mentions } from "../captions.ts";
import { postDetailsCard, postsDetailsCard, sendsCard, statsCard, statusCard, videoListCard, type SendRow, type StatusCardInput } from "../cards.ts";
import { TikTokError, failReasonError, normalizeError, privacyLabel, type TikTokErrorCode } from "../errors.ts";
import { ago, aspect, duration, plural, postedLabel } from "../format.ts";
import { INTERRUPTED, inPeriod, isOpen, isRefused, matchAbout, notSent, sendMark, sendTitle, sendWhat, type AboutMatch, type AboutWords } from "../ledger.ts";
import { log } from "../proc.ts";
import type { Deps } from "../mcpServer.ts";
import { errorJson, ok, type ToolResult } from "../results.ts";
import type { ToolExtra } from "../tools.ts";
import type { LedgerEntry, PublishStatus, VideoDetails, VideoSummary, Widget } from "../types.ts";
import { compactObject, field, guarded, httpsUrl, isDefined, listOf, num, readExec, signalOf, str, truthy } from "./common.ts";

/** Covers fetched for a list: the rows a card shows (5 today; one spare). */
export const CARD_COVERS = 6;
/** A whole read's pictures arrive within this, or the card goes without them (they stay cached for next time). */
export const COVERS_BUDGET_MS = 2_000;
/** The one cover on a single post's card is shown larger than a list row's. */
export const DETAIL_COVER_WIDTH = 200;

type Args = Record<string, unknown>;

// ---------------------------------------------------------------------------
// get_user_stats
// ---------------------------------------------------------------------------

// avatar_url_100 is a user.info.basic field (like display_name), so asking for it on every call needs no extra
// scope: the card always shows the profile picture.
const BASE_FIELDS = ["follower_count", "following_count", "likes_count", "video_count", "display_name", "username", "avatar_url_100"];
const PROFILE_FIELDS = ["bio_description", "is_verified", "profile_deep_link"];

export function getUserStats(args: Args, deps: Deps, extra: ToolExtra): Promise<ToolResult> {
  return guarded("get_user_stats", deps, async () => {
    const signal = signalOf(extra);
    const wantProfile = truthy(args.include_profile);
    await deps.client.assertAccount(signal);
    let profileUnavailable = false;
    let data: unknown;
    try {
      data = await readExec(deps, "TIKTOK_GET_USER_STATS", { fields: wantProfile ? [...BASE_FIELDS, ...PROFILE_FIELDS] : BASE_FIELDS }, signal);
    } catch (e) {
      // A field without its scope fails the whole call (TikTok's scope notice): retry once with the stats alone.
      const err = normalizeError(e, { slug: "TIKTOK_GET_USER_STATS" });
      if (!wantProfile || err.code !== "SCOPE_MISSING") throw err;
      profileUnavailable = true;
      data = await readExec(deps, "TIKTOK_GET_USER_STATS", { fields: BASE_FIELDS }, signal);
    }
    const nested = field(data, "user");
    const u = nested && typeof nested === "object" ? nested : data;
    const withProfile = wantProfile && !profileUnavailable;
    const user = compactObject({
      display_name: clipText(cleanText(field(u, "display_name")), 80),
      username: cleanText(field(u, "username")).replace(/^@+/, ""),
      follower_count: num(field(u, "follower_count")),
      following_count: num(field(u, "following_count")),
      likes_count: num(field(u, "likes_count")),
      video_count: num(field(u, "video_count")),
      ...(withProfile
        ? {
            bio_description: clipText(cleanText(field(u, "bio_description")), 300),
            is_verified: typeof field(u, "is_verified") === "boolean" || field(u, "is_verified") === "true" ? truthy(field(u, "is_verified")) : undefined,
            avatar_url_100: httpsUrl(field(u, "avatar_url_100")),
            profile_deep_link: httpsUrl(field(u, "profile_deep_link")),
          }
        : {}),
    });
    // The picture for the card (best effort: the monogram stays when it can't be had in time).
    const avatarUrl = httpsUrl(field(u, "avatar_url_100")) ?? httpsUrl(field(u, "avatar_url"));
    const avatar = avatarUrl ? await deps.images.dataUri(avatarUrl, { signal }) : undefined;
    const f = user.follower_count, l = user.likes_count, v = user.video_count;
    const facts = [
      f !== undefined ? plural(f, "follower") : "",
      l !== undefined ? plural(l, "like") : "",
      v !== undefined ? plural(v, "public video") : "",
    ].filter(Boolean);
    let summary =
      f !== undefined && l !== undefined && v !== undefined
        ? `You have ${plural(f, "follower")} and ${plural(l, "like")} across ${plural(v, "public video")}.`
        : facts.length
          ? `${facts.join(", ")}.`
          : "TikTok returned the profile without stats.";
    if (profileUnavailable) summary += " Bio, verified badge and profile link need the user.info.profile permission, which this connection lacks.";
    return ok(
      {
        ...user,
        ...(profileUnavailable ? { profile_unavailable: true } : {}),
        note: UNTRUSTED_NOTE,
        summary,
      },
      statsCard({ ...user, include_profile: withProfile, ...(avatar ? { avatar_data: avatar } : {}) }),
    );
  });
}

// ---------------------------------------------------------------------------
// list_videos / query_videos
// ---------------------------------------------------------------------------

/** One TikTok Video Object → our summary. Text stays as TikTok sent it (≤ 150 chars), so caption_truncated can see TikTok's cut. */
export function videoOf(raw: unknown): VideoSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = str(r.id ?? r.video_id);
  if (!id) return undefined;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const title = text(r.title);
  const description = text(r.video_description);
  return compactObject({
    id,
    caption: description ?? title ?? "",
    title,
    video_description: description,
    create_time: num(r.create_time),
    duration: num(r.duration),
    width: num(r.width),
    height: num(r.height),
    cover_image_url: httpsUrl(r.cover_image_url),
    share_url: httpsUrl(r.share_url),
    embed_link: httpsUrl(r.embed_link),
    view_count: num(r.view_count),
    like_count: num(r.like_count),
    comment_count: num(r.comment_count),
    share_count: num(r.share_count),
    is_aigc: typeof r.is_aigc === "boolean" ? r.is_aigc : undefined,
  }) as VideoSummary;
}

/** The model's view of a post: one caption field, plus labels it can say. */
function videoJson(v: VideoSummary, now: number): Record<string, unknown> {
  return compactObject({
    id: v.id,
    caption: v.caption.trim(),
    title: v.title && v.title.trim() !== v.caption.trim() ? v.title.trim() : undefined,
    create_time: v.create_time,
    posted_label: v.create_time !== undefined ? postedLabel(v.create_time, now) : undefined,
    duration: v.duration,
    duration_label: v.duration ? duration(v.duration) : undefined,
    width: v.width,
    height: v.height,
    view_count: v.view_count,
    like_count: v.like_count,
    comment_count: v.comment_count,
    share_count: v.share_count,
    is_aigc: v.is_aigc,
    share_url: v.share_url,
    embed_link: v.embed_link,
    cover_image_url: v.cover_image_url,
  });
}

/** Post id → cover data URI for the posts a card shows; whatever doesn't arrive in time is left out. */
async function coversFor(videos: VideoSummary[], deps: Deps, signal: AbortSignal): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  for (const v of videos) if (v.cover_image_url) urls[v.id] = v.cover_image_url;
  return Object.keys(urls).length ? deps.images.many(urls, { budgetMs: COVERS_BUDGET_MS, signal }) : {};
}

/**
 * The average views of the account's latest public posts, remembered from the last first-page list_videos
 * (30 minutes), so a single post's card can say how it compares without another TikTok call.
 */
export class ChannelMemo {
  private seen?: { at: number; views: number; posts: number };
  static readonly TTL_MS = 30 * 60_000;
  /** Needs at least this many posts with a view count to call it an average. */
  static readonly MIN_POSTS = 3;

  note(videos: VideoSummary[], now: number): void {
    const views = videos.map((v) => v.view_count).filter((n): n is number => typeof n === "number" && n >= 0);
    this.seen = views.length >= ChannelMemo.MIN_POSTS ? { at: now, views: Math.round(views.reduce((a, b) => a + b, 0) / views.length), posts: views.length } : undefined;
  }

  average(now: number): { views: number; posts: number } | undefined {
    const s = this.seen;
    return s && now - s.at <= ChannelMemo.TTL_MS ? { views: s.views, posts: s.posts } : undefined;
  }
}

const EMPTY_LIST = "No public posts yet. Private (Only me) posts and drafts don't show up here.";

/** How far back list_videos' via_voiceos section looks, and how many sends it carries. */
export const VIA_DAYS = 7;
export const VIA_MAX = 10;

/** What went through VoiceOS lately (refused attempts left out: nothing of them was sent), newest first. */
function viaVoiceos(all: LedgerEntry[], now: number): LedgerEntry[] {
  return all.filter((e) => !isRefused(e) && inPeriod(e, "week", now)).slice(0, VIA_MAX);
}

/** "Through VoiceOS today: 9 videos and 1 carousel posted as Only me (…). Earlier this week: …" */
function viaWords(sends: LedgerEntry[], now: number): string {
  const today = sends.filter((e) => inPeriod(e, "today", now));
  const earlier = sends.filter((e) => !inPeriod(e, "today", now));
  const parts = [
    today.length ? `Through VoiceOS today: ${sendsInWords(today, now)}.` : "",
    earlier.length ? `${today.length ? "Earlier this week" : "Through VoiceOS in the last 7 days"}: ${sendsInWords(earlier, now)}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export function listVideos(args: Args, deps: Deps, extra: ToolExtra): Promise<ToolResult> {
  return guarded("list_videos", deps, async () => {
    const signal = signalOf(extra);
    const max = Math.min(20, Math.max(1, Math.floor(num(args.max_count) ?? 5)));
    const cursor = num(args.cursor);
    await deps.client.assertAccount(signal);
    const now = deps.clock.now();
    // The first page also says what went through VoiceOS lately: TikTok lists public posts only, so Only me posts
    // and drafts would be missing when the user asks what they posted today. Sends still processing are checked meanwhile.
    const recent = cursor === undefined ? viaVoiceos(deps.ledger.list(), now) : [];
    const [data, sends] = await Promise.all([
      // Always pass max_count: Composio's default is 10.
      readExec(deps, "TIKTOK_LIST_VIDEOS", { max_count: max, ...(cursor !== undefined ? { cursor } : {}) }, signal),
      recent.length ? refreshOpen(recent, deps, signal).catch(() => recent) : Promise.resolve(recent),
    ]);
    const videos = listOf(field(data, "videos")).map(videoOf).filter(isDefined).slice(0, max);
    const hasMore = truthy(field(data, "has_more"));
    const next = num(field(data, "cursor"));
    if (cursor === undefined) deps.channel.note(videos, now);
    const covers = await coversFor(videos.slice(0, CARD_COVERS), deps, signal);
    let summary = sends.length ? "No public posts on TikTok (its list shows public posts only)." : EMPTY_LIST;
    if (videos.length) {
      const views = videos[0].view_count;
      summary =
        videos.length === 1
          ? views !== undefined
            ? `Your latest public post has ${plural(views, "view")}.`
            : "Your latest public post."
          : `Your last ${videos.length} public posts, newest first${views !== undefined ? `: the newest has ${plural(views, "view")}` : ""}.`;
      if (hasMore) summary += " More are available: pass cursor to get the next page.";
    }
    if (sends.length) summary += ` ${viaWords(sends, now)}`;
    return ok(
      {
        count: videos.length,
        videos: videos.map((v) => videoJson(v, now)),
        has_more: hasMore,
        ...(next !== undefined ? { cursor: next } : {}),
        // Only me posts and drafts included: VoiceOS's own record of what it sent (src/ledger.ts).
        ...(sends.length ? { via_voiceos: sends.map((e) => sendJson(e, now)) } : {}),
        note: UNTRUSTED_NOTE,
        summary,
      },
      videoListCard({ videos, has_more: hasMore }, now, { covers, ...(sends.length ? { sends: sends.map((e) => sendRow(e, now)) } : {}) }),
    );
  });
}

export function detailsOf(v: VideoSummary, now: number): VideoDetails {
  const views = v.view_count, likes = v.like_count, comments = v.comment_count, shares = v.share_count;
  const rate =
    views !== undefined && views >= 100 && likes !== undefined && comments !== undefined && shares !== undefined
      ? Math.round(((likes + comments + shares) / views) * 10_000) / 10_000
      : undefined;
  return compactObject({
    ...v,
    hashtags: hashtags(v.caption),
    mentions: mentions(v.caption),
    // TikTok cuts read-back text at 150 characters.
    caption_truncated: v.caption.length === 150,
    posted_label: v.create_time !== undefined ? postedLabel(v.create_time, now) : undefined,
    aspect: aspect(v.width, v.height),
    engagement_rate: rate,
  }) as VideoDetails;
}

export function queryVideos(args: Args, deps: Deps, extra: ToolExtra): Promise<ToolResult> {
  return guarded("query_videos", deps, async () => {
    const signal = signalOf(extra);
    const ids = [...new Set(listOf(args.video_ids).map(str).filter(Boolean))].slice(0, 20);
    if (!ids.length) throw new TikTokError("INVALID_PARAM", { message: "Pass 1-20 post ids from list_videos." });
    await deps.client.assertAccount(signal);
    const data = await readExec(deps, "TIKTOK_QUERY_VIDEOS", { video_ids: ids }, signal);
    const now = deps.clock.now();
    const details = listOf(field(data, "videos")).map(videoOf).filter(isDefined).map((v) => detailsOf(v, now));
    const missing = ids.filter((id) => !details.some((d) => d.id === id));
    let summary: string;
    if (!details.length) {
      summary = "TikTok returned none of those posts. Only the account's public posts come back; Only me posts and drafts don't.";
    } else if (details.length === 1) {
      const d = details[0];
      const stats = [
        d.view_count !== undefined ? plural(d.view_count, "view") : "",
        d.like_count !== undefined ? plural(d.like_count, "like") : "",
      ].filter(Boolean);
      summary = stats.length ? `That post has ${stats.join(" and ")}.` : "TikTok returned that post's details without stats.";
    } else {
      const top = Math.max(...details.map((d) => d.view_count ?? -1));
      summary = `${details.length} posts.${top >= 0 ? ` The most viewed has ${plural(top, "view")}.` : ""}`;
    }
    if (details.length && missing.length) summary += ` TikTok didn't return ${missing.length} of the ids (only public posts come back).`;
    // One post: its cover, larger, and the channel's average views from a recent list_videos (no extra call).
    const single = details.length === 1 ? details[0] : undefined;
    const avg = single ? deps.channel.average(now) : undefined;
    const cover = single?.cover_image_url ? await deps.images.dataUri(single.cover_image_url, { width: DETAIL_COVER_WIDTH, signal }) : undefined;
    const covers = single ? {} : await coversFor(details.slice(0, CARD_COVERS), deps, signal);
    return ok(
      {
        count: details.length,
        videos: details.map((d) =>
          compactObject({
            ...videoJson(d, now),
            hashtags: d.hashtags.length ? d.hashtags : undefined,
            mentions: d.mentions.length ? d.mentions : undefined,
            caption_truncated: d.caption_truncated || undefined,
            aspect: d.aspect,
            engagement_rate: d.engagement_rate,
          }),
        ),
        ...(missing.length ? { missing_ids: missing } : {}),
        ...(avg ? { channel_avg_views: avg.views, channel_avg_posts: avg.posts } : {}),
        note: UNTRUSTED_NOTE,
        summary,
      },
      single
        ? postDetailsCard(single, now, { ...(cover ? { cover } : {}), ...(avg ? { channelAvgViews: avg.views } : {}) })
        : postsDetailsCard(details, now, { covers }),
    );
  });
}

// ---------------------------------------------------------------------------
// fetch_publish_status
// ---------------------------------------------------------------------------

type State = StatusCardInput["state"];

const STATUSES: ReadonlySet<string> = new Set<PublishStatus>([
  "PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED",
]);
export const isPublishStatus = (s: string): s is PublishStatus => STATUSES.has(s);

function stateOf(status: string): State {
  if (status === "SEND_TO_USER_INBOX") return "inbox";
  if (status === "PUBLISH_COMPLETE") return "posted";
  if (status === "FAILED") return "failed";
  return status ? "processing" : "unknown";
}

const NONE =
  "Nothing has been sent to TikTok through VoiceOS in the last 30 days. Pass the publish_id from a TikTok write to check that one.";
const EDIT_NOTE = "Posts can't be edited once they're up; a corrected copy can be posted (say what to change).";
/** A send the server restarted under before TikTok had it (ledger.ts INTERRUPTED). */
const INTERRUPTED_CARD = "VoiceOS restarted the TikTok tools while this was still uploading, so it never reached TikTok. Send it again to post it.";

/** The send as people say it: the video's name without its extension, or the photos' own folder. */
function spokenTitle(e: LedgerEntry | undefined): string {
  const t = sendTitle(e);
  // A photo set picked straight from Downloads or the Desktop has no name of its own.
  return e?.kind === "photos" && GENERIC_FOLDERS.has(t.toLowerCase()) ? e.details.title?.trim() || "" : t;
}
const GENERIC_FOLDERS = new Set(["downloads", "desktop", "documents", "pictures", "movies", "photos", "images", "screenshots", "home", "videos"]);

/** What the ledger knows about a write, for the result. Text is the user's own, as approved. */
function sentFacts(e: LedgerEntry): Record<string, unknown> {
  return compactObject({
    kind: e.kind,
    mode: e.mode,
    names: e.media.names,
    count: e.media.count,
    folder: e.kind === "photos" ? e.media.folder : undefined,
    started_at: e.created_at,
    privacy_level: e.details.privacy_level,
    privacy_label: e.details.privacy_level ? privacyLabel(e.details.privacy_level) : undefined,
    is_aigc: e.details.is_aigc,
    caption: e.details.caption,
    title: e.details.title,
    description: e.details.description,
    caption_copied: e.details.caption_copied,
  });
}

function cardBase(e: LedgerEntry | undefined, now: number): Omit<StatusCardInput, "state"> {
  if (!e) return { now };
  return compactObject({
    now,
    kind: e.kind,
    mode: e.mode,
    count: e.media.count,
    name: e.kind === "video" ? e.media.names[0] : undefined,
    started_at: e.created_at,
    privacy_label: e.details.privacy_level ? privacyLabel(e.details.privacy_level) : undefined,
    publish_id: e.publish_id,
    // The sent video's frame (kept in memory by the write); the card's picture only, never part of the data.
    poster: e.kind === "video" ? e.poster : undefined,
    motion: e.kind === "video" ? e.motion : undefined,
    // A photo post's photos, the same way.
    thumbs: e.kind === "photos" ? e.thumbs : undefined,
    cover_index: e.kind === "photos" ? e.media.cover_index : undefined,
  });
}

/** Why a failed or unconfirmed send went that way, from its error code. */
function entryError(e: LedgerEntry): TikTokError {
  if (e.error_code === INTERRUPTED) return new TikTokError("UNKNOWN", { message: INTERRUPTED_CARD });
  return knownError(e.error_code) ?? new TikTokError(e.stage === "unknown" ? "OUTCOME_UNKNOWN" : "UNKNOWN");
}
const entryReason = (e: LedgerEntry): string => (e.error_code === INTERRUPTED ? INTERRUPTED_CARD : entryError(e).card);

/**
 * A write's card from the ledger alone, without asking TikTok: the reminder's Show button when the job's own
 * completion card is gone (evicted).
 */
export function ledgerStatusCard(e: LedgerEntry, now: number): Widget {
  const base = cardBase(e, now);
  if (e.stage === "failed" || e.stage === "unknown") {
    return statusCard({ ...base, state: e.stage === "unknown" ? "unknown" : "failed", reason: entryReason(e) });
  }
  if (e.stage === "done") return statusCard({ ...base, state: e.last_status === "PUBLISH_COMPLETE" ? "posted" : "inbox" });
  return statusCard({ ...base, state: e.stage === "processing" ? "processing" : e.stage === "uploading" ? "uploading" : "staging" });
}

function knownError(code: string | undefined): TikTokError | undefined {
  if (!code) return undefined;
  try {
    return new TikTokError(code as TikTokErrorCode);
  } catch {
    return undefined;
  }
}

/** "I'll let you know …": only while the write is still running in the background (its call already answered). */
const LATER = (e: LedgerEntry) => ` I'll let you know when ${e.mode === "drafts" ? "it's in your inbox" : "it's posted"}.`;

interface Answer {
  data: Record<string, unknown>;
  card: Widget;
}

/** A write that has no publish_id yet: answered from its stage, without asking Composio (plan §6.4). */
function fromStage(e: LedgerEntry, now: number, running: boolean): Answer {
  const sent = sentFacts(e);
  const base = cardBase(e, now);
  if (e.stage === "failed" || e.stage === "unknown") {
    const err = entryError(e);
    const state: State = e.stage === "unknown" ? "unknown" : "failed";
    const summary =
      state === "unknown"
        ? "Not sure that one went through: TikTok may have received it. Check the TikTok drafts or profile before sending it again."
        : e.error_code === INTERRUPTED
          ? `It didn't go up: ${INTERRUPTED_CARD}`
          : `It didn't go up: ${err.spoken} ${err.card}`;
    return {
      data: { state, stage: e.stage, task_id: e.task_id, error: errorJson(err), ...sent, summary },
      card: statusCard({ ...base, state, reason: entryReason(e) }),
    };
  }
  // A send that TikTok already settled (in the inbox, posted) and has no id to ask about again.
  if (e.stage === "done") {
    const state: State = e.last_status === "PUBLISH_COMPLETE" || e.mode === "direct" ? "posted" : "inbox";
    const t = spokenTitle(e);
    const summary = state === "inbox" ? `${t ? `"${t}" is` : "It's"} in your TikTok inbox.` : `${t ? `"${t}" is` : "It's"} up.`;
    return { data: { state, stage: e.stage, task_id: e.task_id, ...sent, summary }, card: statusCard({ ...base, state }) };
  }
  // staging: the file is still going up (or waiting behind another upload); uploading: TikTok is taking the init.
  const state: State = e.stage === "staging" ? "staging" : "uploading";
  const summary = (e.stage === "staging" ? "Still uploading to TikTok." : "Uploaded; TikTok is taking it now.") + (running ? LATER(e) : "");
  return { data: { state, stage: e.stage, task_id: e.task_id, ...(running ? { running: true } : {}), ...sent, summary }, card: statusCard({ ...base, state }) };
}

/** Record what TikTok said about a send. Returns the failure TikTok reported, if any. */
function recordStatus(deps: Deps, entry: LedgerEntry | undefined, status: string, failReason: string): TikTokError | undefined {
  const state = stateOf(status);
  const err = state === "failed" ? failReasonError(failReason) : undefined;
  if (entry && isPublishStatus(status)) {
    deps.ledger.update(entry.task_id, {
      last_status: status,
      ...(state === "inbox" || state === "posted" ? { stage: "done" as const } : {}),
      ...(err ? { stage: "failed" as const, fail_reason: failReason || undefined, error_code: err.code } : {}),
    });
  }
  return err;
}

/** One send with a publish_id: TikTok's own status, enriched from the ledger. */
async function askTikTok(entry: LedgerEntry | undefined, id: string, deps: Deps, signal: AbortSignal, now: number): Promise<Answer> {
  if (!deps.limits.status.tryTake()) throw new TikTokError("RATE_LIMITED", {});
  await deps.client.assertAccount(signal);
  const data = await readExec(deps, "TIKTOK_FETCH_PUBLISH_STATUS", { publish_id: id }, signal);
  const status = str(field(data, "status")).toUpperCase();
  const state = stateOf(status);
  const failReason = str(field(data, "fail_reason"));
  entry = entry ?? deps.ledger.byPublishId(id);
  const err = recordStatus(deps, entry, status, failReason);
  const privacy = entry?.details.privacy_level ? privacyLabel(entry.details.privacy_level) : undefined;
  const t = spokenTitle(entry);
  let summary: string;
  switch (state) {
    case "inbox": {
      summary =
        `${t ? `"${t}" is` : "It's"} in your TikTok inbox. Tap the notification to finish it in TikTok, where the draft can still be changed. ` +
        "A draft can't be turned into a post from here; the same video can be posted directly (say 'post it').";
      break;
    }
    case "posted":
      summary =
        entry?.mode === "drafts"
          ? `It's posted: it was finished in the TikTok app. ${EDIT_NOTE}`
          : `${privacy ? `It's up, set to ${privacy}.` : "It's up."}${t ? ` That's "${t}".` : ""} ${EDIT_NOTE}`;
      break;
    case "failed":
      summary = `It didn't go up: ${err!.spoken} ${err!.card}`;
      break;
    case "unknown":
      summary = "TikTok didn't report a status for it yet. Ask again in a minute.";
      break;
    default:
      summary = "Still processing; that can take a few minutes.";
  }
  // A write still watching this post in the background will report its end itself.
  const running = entry ? deps.jobs.isRunning(entry.task_id) && (state === "processing" || state === "unknown") : false;
  if (running) summary += LATER(entry!);
  const postIds = listOf(field(data, "publicaly_available_post_id")).map(str).filter(Boolean);
  return {
    data: compactObject({
      publish_id: id,
      status: status || undefined,
      state,
      fail_reason: failReason || undefined,
      error: err ? errorJson(err) : undefined,
      publicaly_available_post_id: postIds.length ? postIds : undefined,
      uploaded_bytes: num(field(data, "uploaded_bytes")),
      downloaded_bytes: num(field(data, "downloaded_bytes")),
      editable_in_tiktok: state === "inbox" ? true : undefined,
      running: running || undefined,
      ...(entry ? { task_id: entry.task_id, ...sentFacts(entry) } : {}),
      summary,
    }),
    card: statusCard({ ...cardBase(entry, now), state, publish_id: id, ...(err ? { reason: err.card } : {}) }),
  };
}

/** One send: TikTok's word when it has a publish_id, else what the ledger knows. */
function answerFor(e: LedgerEntry, deps: Deps, signal: AbortSignal, now: number): Promise<Answer> | Answer {
  return e.publish_id ? askTikTok(e, e.publish_id, deps, signal, now) : fromStage(e, now, deps.jobs.isRunning(e.task_id));
}

/** At most this many status checks to bring a list up to date (one per send). */
export const REFRESH_MAX = 4;
/** All of them answer within this, or the rest keep their last known stage. */
export const REFRESH_BUDGET_MS = 5_000;

/**
 * Ask TikTok about sends whose status can still change (processing, not confirmed) and that no write in this
 * server is watching, so a list says "posted" rather than "processing" after a restart. One status call each,
 * at most REFRESH_MAX, only while the status bucket has room, all inside REFRESH_BUDGET_MS. Never throws: a send
 * that doesn't answer keeps its last known stage. Returns the entries as the ledger now has them.
 */
export async function refreshOpen(entries: LedgerEntry[], deps: Deps, signal: AbortSignal): Promise<LedgerEntry[]> {
  const open = entries.filter((e) => isOpen(e) && !deps.jobs.isRunning(e.task_id)).slice(0, REFRESH_MAX);
  if (!open.length) return entries;
  try {
    await deps.client.assertAccount(signal);
  } catch {
    return entries;
  }
  const box = new AbortController();
  const timer = setTimeout(() => box.abort(), REFRESH_BUDGET_MS);
  const stop = () => box.abort();
  signal.addEventListener("abort", stop, { once: true });
  const deadline = deps.clock.now() + REFRESH_BUDGET_MS;
  let asked = 0;
  try {
    await Promise.all(
      open.map(async (e) => {
        if (!deps.limits.status.tryTake()) return;
        asked++;
        try {
          const data = await deps.client.exec("TIKTOK_FETCH_PUBLISH_STATUS", { publish_id: e.publish_id }, { deadline, signal: box.signal });
          recordStatus(deps, e, str(field(data, "status")).toUpperCase(), str(field(data, "fail_reason")));
        } catch (err) {
          log(`fetch_publish_status refresh ${normalizeError(err, { slug: "TIKTOK_FETCH_PUBLISH_STATUS" }).code}`);
        }
      }),
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
  if (!asked) return entries;
  return entries.map((e) => deps.ledger.get(e.task_id) ?? e);
}

/**
 * A send TikTok still hasn't finished this long after it went out isn't "processing" any more: TikTok gives a
 * pull or an upload about an hour, and our own polling stops at 30 minutes. It reads "Didn't finish" instead.
 */
export const STALLED_AFTER_MS = 2 * 3_600_000;

const stalled = (e: LedgerEntry, now: number): boolean => {
  const at = Date.parse(e.created_at);
  return (e.stage === "processing" || e.stage === "uploading") && Number.isFinite(at) && now - at > STALLED_AFTER_MS;
};

/** The send's state for a row: settled (posted, inbox), still going, stalled, or not. */
function rowState(e: LedgerEntry, now: number): SendRow["state"] {
  if (e.stage === "done") return e.mode === "drafts" && e.last_status !== "PUBLISH_COMPLETE" ? "inbox" : "posted";
  if (e.stage === "failed") return "failed";
  if (e.stage === "unknown") return "unknown";
  if (stalled(e, now)) return "stalled";
  return e.stage === "processing" ? "processing" : "uploading";
}

const markAt = (e: LedgerEntry, now: number): string => (stalled(e, now) ? "Didn't finish" : sendMark(e));

/** One send for a list card (its picture from memory, when the write kept one). */
export function sendRow(e: LedgerEntry, now: number = Date.now()): SendRow {
  const cover = e.thumbs?.[Math.min(e.thumbs.length - 1, Math.max(0, e.media.cover_index ?? 0))];
  return compactObject({
    // A photo post shows the title the user gave it ("Meet the cast"); its folder name is the fallback.
    title: (e.kind === "photos" ? e.details.title?.trim() : "") || spokenTitle(e) || (e.kind === "photos" ? (e.media.count > 1 ? `${e.media.count}-photo carousel` : "Photo post") : "Video"),
    kind: e.kind,
    mode: e.mode,
    count: e.media.count,
    duration_sec: e.media.duration_sec,
    started_at: e.created_at,
    mark: markAt(e, now),
    state: rowState(e, now),
    poster: e.kind === "video" ? e.poster : undefined,
    thumb: e.kind === "photos" ? cover : undefined,
  }) as SendRow;
}

/** One send for a result's data: what it was, where it stands, and the user's own text. */
export function sendJson(e: LedgerEntry, now: number): Record<string, unknown> {
  const at = Date.parse(e.created_at);
  return compactObject({
    name: spokenTitle(e) || undefined,
    what: sendWhat(e),
    mark: markAt(e, now),
    state: rowState(e, now),
    stage: e.stage,
    sent_label: Number.isFinite(at) ? ago(at, now) : undefined,
    publish_id: e.publish_id,
    error_code: e.stage === "failed" || e.stage === "unknown" ? e.error_code : undefined,
    ...sentFacts(e),
    names: e.kind === "video" ? e.media.names : undefined,
  });
}

/** "9 videos and 1 carousel" */
function kindCount(list: LedgerEntry[]): string {
  const videos = list.filter((e) => e.kind === "video").length;
  const sets = list.length - videos;
  return [videos ? plural(videos, "video") : "", sets ? plural(sets, "carousel") : ""].filter(Boolean).join(" and ");
}

/** Named, newest first, at most `max`: “a”, “b” and “c”. */
function namesOf(list: LedgerEntry[], max = 3): string {
  const names = [...new Set(list.map((e) => spokenTitle(e)).filter(Boolean))];
  const shown = names.slice(0, max).map((n) => `“${n}”`);
  if (!shown.length) return "";
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
}

/**
 * The sends in words, grouped by where they stand: "9 videos and 1 carousel posted as Only me (“a”, “b” and 8
 * more); 1 video draft in your inbox; 1 still processing; 1 failed."
 */
export function sendsInWords(list: LedgerEntry[], now: number = Date.now()): string {
  const groups: Array<[string, LedgerEntry[]]> = [];
  const add = (label: string, keep: (e: LedgerEntry) => boolean) => {
    const g = list.filter(keep);
    if (g.length) groups.push([label, g]);
  };
  const state = (e: LedgerEntry) => rowState(e, now);
  const posted = (e: LedgerEntry) => state(e) === "posted";
  add("posted as Only me", (e) => posted(e) && sendMark(e) === "Only me");
  add("posted for others to see", (e) => posted(e) && sendMark(e) !== "Only me");
  add("waiting in your TikTok inbox as drafts", (e) => state(e) === "inbox");
  add("still uploading or processing", (e) => state(e) === "processing" || state(e) === "uploading");
  add("that TikTok never finished", (e) => state(e) === "stalled");
  add("not confirmed", (e) => state(e) === "unknown");
  add("failed or not sent", (e) => state(e) === "failed");
  return groups
    .map(([label, g], i) => {
      const names = namesOf(g, i === 0 ? 3 : 2);
      return `${kindCount(g)} ${label}${names ? ` (${names})` : ""}`;
    })
    .join("; ");
}

const DAY_WORDS: Record<NonNullable<AboutWords["day"]>, string> = { today: "today", yesterday: "yesterday", week: "in the last 7 days" };

/** Several sends fit the words: refresh the open ones, then list them (newest first). */
async function several(found: LedgerEntry[], deps: Deps, signal: AbortSignal, now: number, m: AboutMatch): Promise<Answer> {
  const list = await refreshOpen(found.slice(0, 10), deps, signal);
  const when = m.words.day ? ` ${DAY_WORDS[m.words.day]}` : "";
  const summary = m.plural
    ? `Through VoiceOS${when}: ${sendsInWords(list, now)}.${found.length > list.length ? ` Showing the newest ${list.length} of ${found.length}.` : ""}`
    : `${plural(found.length, "send")} fit that: ${list.map((e) => `“${spokenTitle(e) || sendWhat(e)}” (${sendWhat(e)}, ${sendMark(e)}, ${ago(Date.parse(e.created_at), now)})`).slice(0, 4).join("; ")}. Ask which one if it matters.`;
  return {
    data: { state: "several", count: found.length, sends: list.map((e) => sendJson(e, now)), summary },
    card: sendsCard(list.map((e) => sendRow(e, now)), now, { headline: m.plural ? `${plural(found.length, "send")}${when}` : `${plural(found.length, "send")} fit that` }),
  };
}

/** Nothing fits the words: say so, and show the latest sends so the user can pick. */
function noMatch(m: AboutMatch, all: LedgerEntry[], now: number): Answer {
  const recent = all.filter((e) => !isRefused(e)).slice(0, 4);
  const lead = m.empty_period && m.words.day ? `Nothing was sent through VoiceOS ${DAY_WORDS[m.words.day]}.` : "Nothing sent through VoiceOS in the last 30 days fits that.";
  const summary = recent.length ? `${lead} The latest: ${recent.map((e) => `“${spokenTitle(e) || sendWhat(e)}” (${sendWhat(e)}, ${sendMark(e)}, ${ago(Date.parse(e.created_at), now)})`).join("; ")}.` : lead;
  return {
    data: { state: "no_match", sends: recent.map((e) => sendJson(e, now)), summary },
    card: sendsCard(recent.map((e) => sendRow(e, now)), now, { headline: m.empty_period ? "Nothing sent then" : "No send fits that", note: recent.length ? "The latest sends" : "" }),
  };
}

/** "A newer video draft attempt, 2 min ago, wasn't sent: …": the one clause about a newer try that didn't go. */
function newerClause(e: LedgerEntry, now: number): string {
  const at = Date.parse(e.created_at);
  const when = Number.isFinite(at) ? ` ${ago(at, now)}` : "";
  const name = spokenTitle(e);
  const what = name ? `${sendWhat(e)} of “${name}”` : `${sendWhat(e)} attempt`;
  const why =
    e.error_code === "CONFIRMATION_REQUIRED"
      ? "it needs the card's button clicked, a yes in words sends nothing"
      : e.error_code === INTERRUPTED
        ? "the TikTok tools restarted during its upload"
        : entryError(e).title.toLowerCase();
  return ` Also: a newer ${what}${when} wasn't sent (${why}).`;
}

export function fetchPublishStatus(args: Args, deps: Deps, extra: ToolExtra): Promise<ToolResult> {
  return guarded("fetch_publish_status", deps, async () => {
    const signal = signalOf(extra);
    const now = deps.clock.now();
    const id = str(args.publish_id);
    const reply = (a: Answer) => ok(a.data, a.card);
    if (id) return reply(await askTikTok(deps.ledger.byPublishId(id), id, deps, signal, now));
    const all = deps.ledger.list();
    if (!all.length) return ok({ state: "none", summary: NONE }, statusCard({ state: "none", now }));
    const about = clipText(cleanText(args.about), 120);
    if (about) {
      const m = matchAbout(about, all, now);
      if (!m.entries.length) return reply(noMatch(m, all, now));
      if (m.entries.length > 1) return reply(await several(m.entries, deps, signal, now, m));
      return reply(await answerFor(m.entries[0], deps, signal, now));
    }
    // No words: "it" is the newest send that reached TikTok, not a refused "yes" or an upload a restart cut off;
    // a newer try that didn't go gets one clause.
    const pick = all.find((e) => !notSent(e)) ?? all[0];
    const a = await answerFor(pick, deps, signal, now);
    if (pick !== all[0]) {
      a.data.summary = `${String(a.data.summary ?? "")}${newerClause(all[0], now)}`;
      a.data.newer_not_sent = compactObject({ what: sendWhat(all[0]), started_at: all[0].created_at, error_code: all[0].error_code, title: spokenTitle(all[0]) || undefined });
    }
    return reply(a);
  });
}
