/**
 * Carrying the conversation across VoiceOS turns: the transcript hook.
 *
 * Why it exists (read from VoiceOS 0.1.40's own code, SP notes 2026-11-05): the agent runs on VoiceOS's
 * backend and starts many turns afresh. A new turn gets only the last five exchanges as plain text, with no
 * tool calls, results or tokens. When the user speaks over a confirmation card, the card is dropped. So after
 * "ai data center power final" → (card) → "actually make it a post", the agent no longer holds the video's
 * file_token and has to guess which video was meant. VoiceOS also never reads MCP `instructions`.
 *
 * VoiceOS calls `voiceos_hook_transcript` (a hidden MCP tool: VoiceOS keeps every `voiceos_hook_*` tool out of
 * the agent's tool list) with each utterance before the agent sees it, within 500 ms. When the words plausibly
 * concern TikTok and this server has fresh TikTok state, the hook returns one short `additionalContext` note.
 * VoiceOS adds it to that turn as "App context from the user's integrations (hooks)". The note names the video
 * in progress, what was last prepared or sent, and how to get its token back. It never blocks or rewrites the
 * user's words.
 *
 * Rules: memory only (no network, no file reads), well under the budget; plain titles and folder names, never
 * paths; at most the caption the user approved; nothing is logged but the note's length.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { privacyLabel } from "./errors.ts";
import { log } from "./proc.ts";
import { spokenTitle, type FocusSnapshot } from "./session.ts";
import type { Clock, LedgerEntry } from "./types.ts";

/** The hidden hook tools this server serves. VoiceOS keeps `voiceos_hook_*` out of the agent's catalog. */
export const HOOK_PREFIX = "voiceos_hook_";
export const TRANSCRIPT_HOOK = "voiceos_hook_transcript";
export const isHookTool = (name: string): boolean => name.startsWith(HOOK_PREFIX);

/** The video the conversation is about, as the finder's focus memory reports it (src/session.ts): no path, no token. */
export type { FocusSnapshot };

/** Anything that can answer "which video is in focus?" synchronously, from memory. */
export interface FocusReader {
  current(now: number): FocusSnapshot | undefined;
}

export interface HookState {
  clock: Pick<Clock, "now">;
  ledger: { latest(): LedgerEntry | undefined };
  session?: Partial<FocusReader>;
  /** find_recent_videos takes pick: "current" (the finder's option); without it the note names a query instead. */
  pickCurrent?: boolean;
}

/** How long TikTok state counts as "the conversation" for a clearly TikTok-shaped utterance, and for a bare "it". */
export const FRESH_MS = 45 * 60_000;
export const PRONOUN_FRESH_MS = 15 * 60_000;
/** VoiceOS takes up to 2,000 chars per hook; one short note (about 400) reads best. */
export const NOTE_MAX = 450;

const TIKTOK_WORDS =
  /\b(tik ?tok|tiktoks?|videos?|vids?|clips?|reels?|posts?|posted|posting|publish\w*|drafts?|inbox|upload\w*|captions?|hashtags?|tags|privacy|private|public|only me|just me|friends|followers|everyone|ai[- ]?(generated|made|label)|label|finder|went up|go up|gone up|go live|put it up|repost)\b/i;
const PRONOUNS = /\b(it|that|this|those|these|same|other|instead|actually|again|one|change|switch|make)\b/i;

/**
 * "post it instead of drafts", "not a post": the negated mode is dropped before the drafts and post intents are
 * matched, so the step follows the mode the user wants.
 */
const NEGATED_MODE =
  /\b(?:instead of|rather than|not|no longer|do(?:n.?t| not))\s+(?:(?:a|an|the|to|my|it|as|in|be|want|need|put|send|make|have|keep|just)\s+)*(?:drafts?|drafting|inbox|posts?|posting|publish\w*)\b/gi;

/** The step for one utterance: the first matching intent; none when drafts and post both still match (ambiguous). */
function intentStep(said: string): string | undefined {
  const positive = said.replace(NEGATED_MODE, " ");
  const drafts = INTENTS[2].re.test(positive);
  const post = INTENTS[3].re.test(positive);
  for (const [i, intent] of INTENTS.entries()) {
    if (i === 2 || i === 3) {
      if (drafts && post) continue;
      if (intent.re.test(positive)) return intent.step;
      continue;
    }
    if (intent.re.test(said)) return intent.step;
  }
  return undefined;
}

/** The intent words the note answers with one next step. Order matters: the first match wins (drafts is [2], post [3]). */
const INTENTS: Array<{ re: RegExp; step: string }> = [
  {
    re: /\b(go(ne)? up|went up|is it up|did it (go|post|send|upload|work)|status|is it there|did that work)\b/i,
    step: "Status: fetch_publish_status.",
  },
  {
    re: /\b(other one|different (one|video)|wrong (one|video)|not (that|this) one|another (one|video))\b/i,
    step: "A different video: find_recent_videos, offer the others.",
  },
  {
    re: /\b(draft|drafts|inbox|save it|send it to my phone|finish it in the app)\b/i,
    step: "Drafts: upload_video, same video and caption.",
  },
  {
    // "apost": how the owner typed it ("acctualli i want it to be apost").
    re: /\b((?:a ?)?posts?|publish|put it up|go live|share it on my profile|on my profile|make it public)\b/i,
    step: "Post: query_creator_info, then publish_video, same video and caption.",
  },
  {
    re: /\b(captions?|hashtags?|tags|trending|title)\b/i,
    step: "Write the caption/hashtags yourself from the title and their words; same card otherwise.",
  },
  {
    re: /\b(only me|just me|private|friends|followers|public|everyone)\b/i,
    step: "Change only the privacy; same card otherwise.",
  },
  {
    re: /\bai\b/i,
    step: "AI label: is_aigc on publish_video (drafts: set in TikTok).",
  },
];

const minutesAgo = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "just now" : m === 1 ? "1 min ago" : `${m} min ago`;
};

const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** A file name as people say it: no extension, no folder. */
/** A file name as people say it (src/session.ts): no folder, no extension, underscores and joining hyphens as spaces. */
export const plainTitle = (name: string): string => clip(spokenTitle(name.replace(/^.*[\\/]/, "")), 80);

const durationWords = (sec: number | undefined): string => {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const FOCUS_HOW: Record<string, string> = {
  picked: "picked",
  shown: "found",
  post_prepared: "post card being prepared",
  sent_draft: "sent to drafts",
  sent_post: "sent as a post",
  draft_not_sent: "drafts card not sent (needs a click on the card)",
  post_not_sent: "post card not sent (needs a click on the card)",
};

/** What the user last asked for with the focused video (mode, privacy, AI label, caption), in a few words. */
function intentWords(f: FocusSnapshot): string {
  const bits = [
    f.mode === "post" ? "post" : f.mode === "draft" ? "drafts" : "",
    f.privacy_level ? privacyLabel(f.privacy_level) : "",
    f.is_aigc ? "AI label on" : "",
    f.caption ? `caption "${clip(f.caption, 90)}"` : "",
  ].filter(Boolean);
  return bits.length ? ` Last asked: ${bits.join(", ")}.` : "";
}

/** What the ledger's newest write means for the conversation, in a few words. */
function writeWords(e: LedgerEntry): string {
  const where = e.mode === "drafts" ? "drafts" : "a direct post";
  const privacy = e.details.privacy_level ? `, ${privacyLabel(e.details.privacy_level)}` : "";
  const ai = e.details.is_aigc ? ", AI label on" : "";
  switch (e.stage) {
    case "staging":
    case "uploading":
    case "processing":
      return `being sent as ${where}${privacy}${ai} now`;
    case "done":
      return e.last_status === "PUBLISH_COMPLETE" ? `posted${privacy}${ai}` : "in the TikTok inbox (drafts)";
    case "unknown":
      return `sent as ${where}, outcome unknown (check TikTok before sending again)`;
    default:
      return e.error_code === "CONFIRMATION_REQUIRED"
        ? `not sent: the ${e.mode === "drafts" ? "drafts" : "post"} card wasn't clicked`
        : `not sent as ${where} (${e.error_code ?? "failed"})`;
  }
}

/**
 * The note for one utterance, or undefined when it isn't about TikTok or there's nothing fresh to say.
 * Pure and synchronous: the hook's whole cost.
 */
export function transcriptContext(transcript: string, state: HookState): string | undefined {
  const said = String(transcript ?? "").slice(0, 2_000);
  if (!said.trim()) return undefined;
  const now = state.clock.now();
  let focus: FocusSnapshot | undefined;
  try {
    focus = state.session?.current?.(now);
  } catch {
    focus = undefined;
  }
  const last = state.ledger.latest();
  const lastAt = last ? Date.parse(last.updated_at) : NaN;
  const freshest = Math.max(focus?.at ?? -Infinity, Number.isFinite(lastAt) ? lastAt : -Infinity);
  if (!Number.isFinite(freshest)) return undefined;
  const age = now - freshest;
  const tiktokShaped = TIKTOK_WORDS.test(said);
  if (!(tiktokShaped ? age <= FRESH_MS : PRONOUNS.test(said) && age <= PRONOUN_FRESH_MS)) return undefined;

  const parts: string[] = [];
  const lastName = last?.kind === "video" && last.media.names[0] ? plainTitle(last.media.names[0]) : "";
  const focusTitle = focus?.title ? clip(focus.title, 70) : "";
  if (focusTitle) {
    const facts = [focus!.folder, durationWords(focus!.duration_sec), focus!.orientation].filter(Boolean).join(", ");
    const how = focus!.how ? FOCUS_HOW[focus!.how] ?? focus!.how : "found";
    parts.push(`In progress: "${focusTitle}"${facts ? ` (${facts})` : ""}, ${how} ${minutesAgo(now - focus!.at)}.${intentWords(focus!)}`);
  }
  if (last && Number.isFinite(lastAt) && now - lastAt <= FRESH_MS) {
    const subject = lastName && lastName !== focusTitle ? `"${clip(lastName, 70)}"` : lastName ? "It" : last.kind === "photos" ? "Photo post" : "Last send";
    // Another video's caption is noise for this one: the caption only rides along when it's the same video.
    const otherVideo = Boolean(focusTitle && lastName && lastName !== focusTitle);
    // The focus already carries the caption it was last asked with.
    const caption = otherVideo || focus?.caption ? undefined : last.details.caption ?? last.details.description ?? last.details.title;
    parts.push(`${subject}: ${writeWords(last)}, ${minutesAgo(now - lastAt)}${caption ? `, caption "${clip(caption, 90)}"` : ""}.`);
  }
  if (!parts.length) return undefined;
  const step = intentStep(said);
  if (step) parts.push(step);
  const title = focusTitle || lastName;
  if (title) {
    // pick "current" exists only alongside the finder's focus memory; a query on the title works either way.
    const again = focusTitle && state.pickCurrent !== false ? `pick "current"` : `query "${clip(title, 60)}"`;
    parts.push(`"It/that one" = "${clip(title, 70)}" unless they name another; if its file_token is gone: find_recent_videos ${again}.`);
  }
  parts.push("Change only what they mention.");
  return clip(`TikTok: ${parts.join(" ")}`, NOTE_MAX);
}

/** The hook tool's answer: always "continue" (never blocks or rewrites), with the note when there is one. */
export function transcriptHook(args: Record<string, unknown>, state: HookState): { content: Array<{ type: "text"; text: string }> } {
  let transcript = "";
  try {
    const payload = JSON.parse(String(args?.payload_json ?? "{}"));
    if (payload && typeof payload === "object" && typeof payload.transcript === "string") transcript = payload.transcript;
  } catch {
    // An unreadable payload is no reason to hold up the user's turn.
  }
  let note: string | undefined;
  try {
    note = transcriptContext(transcript, state);
  } catch {
    note = undefined;
  }
  if (note) log(`transcript hook: ${note.length} chars`);
  return { content: [{ type: "text", text: JSON.stringify(note ? { decision: "continue", additionalContext: note } : { decision: "continue" }) }] };
}

/** Registers the hidden hook tools. Called by createServer; TOOL_META (the agent's twelve) is untouched. */
export function registerHooks(server: McpServer, state: HookState): void {
  server.registerTool(
    TRANSCRIPT_HOOK,
    {
      title: "Transcript hook",
      description: "VoiceOS transcript hook endpoint, called by VoiceOS before each turn and hidden from the agent's tool list.",
      inputSchema: { payload_json: z.string().max(100_000) } as any,
      annotations: { title: "Transcript hook", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ((args: Record<string, unknown>) => transcriptHook(args ?? {}, state)) as any,
  );
}
