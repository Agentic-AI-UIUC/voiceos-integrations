/**
 * Shared pieces of the tool handlers: argument normalizers, read deadlines,
 * creator-info parsing, the error wrapper and logging. Logs carry the tool,
 * our code, TikTok's log_id and a duration: never ids, paths or user text.
 */
import { errorCard } from "../cards.ts";
import { cleanText, clipText } from "../captions.ts";
import { TikTokError, normalizeError } from "../errors.ts";
import type { Deps } from "../mcpServer.ts";
import { log } from "../proc.ts";
import { fail, type ToolResult } from "../results.ts";
import type { ToolExtra } from "../tools.ts";

/** Reads stay well under VoiceOS's sync budget (plan §5.3 SYNC_TOOL_BUDGET_MS). */
export const READ_BUDGET_MS = 20_000;

export const signalOf = (extra: ToolExtra): AbortSignal => extra.signal ?? new AbortController().signal;

/** A trimmed string, or "" for anything that isn't a string or a finite number. */
export const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

/** A finite number, or a numeric string as a number; anything else is undefined. */
export function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

export const truthy = (v: unknown): boolean => v === true || v === "true";
export const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
export const isDefined = <T>(v: T | undefined): v is T => v !== undefined;
export const iso = (ms: number | undefined): string | undefined =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

/** An array, or [] for anything else. */
export const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A field of Composio's unwrapped data, looking one `data` level deeper when the body is nested once more. */
export function field(d: unknown, key: string): unknown {
  if (!d || typeof d !== "object") return undefined;
  const o = d as Record<string, unknown>;
  if (o[key] !== undefined) return o[key];
  const inner = o.data;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>)[key] : undefined;
}

/** Drop undefined, null and "" values, so results stay trimmed. */
export function compactObject<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out as Partial<T>;
}

/** An https URL TikTok returned, else undefined (cards and results only ever carry https links). */
export const httpsUrl = (v: unknown): string | undefined => (typeof v === "string" && /^https:\/\/\S+$/.test(v.trim()) ? v.trim() : undefined);

/** A read through Composio, inside the read budget. */
export function readExec<T = unknown>(deps: Deps, slug: string, args: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  return deps.client.exec<T>(slug, args, { deadline: deps.clock.now() + READ_BUDGET_MS, signal });
}

/** The folder as the user knows it ("Downloads", "Movies/Exports"), never an absolute path. */
export function folderLabel(folder: string, home: string): string {
  const f = String(folder ?? "").trim();
  if (!f.startsWith("/")) return f;
  const h = home.replace(/\/+$/, "");
  if (h && (f === h || f.startsWith(`${h}/`))) return f.slice(h.length + 1) || "Home";
  return f.split("/").filter(Boolean).pop() ?? "";
}

/** TikTok's creator info, under the write tools' input names. */
export interface Creator {
  creator_nickname: string;
  creator_username?: string;
  privacy_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_duration_sec?: number;
}

export function creatorOf(data: unknown): Creator {
  const username = cleanText(field(data, "creator_username")).replace(/^@+/, "");
  const nickname = clipText(cleanText(field(data, "creator_nickname")), 80) || username;
  if (!nickname) throw new TikTokError("UNKNOWN", { message: "TikTok didn't return the account's nickname, so a post can't be prepared." });
  const options: string[] = [];
  for (const o of listOf(field(data, "privacy_level_options"))) {
    const v = str(o).toUpperCase();
    if (v && !options.includes(v)) options.push(v);
  }
  const max = num(field(data, "max_video_post_duration_sec"));
  return {
    creator_nickname: nickname,
    ...(username ? { creator_username: username } : {}),
    privacy_options: options,
    comment_disabled: truthy(field(data, "comment_disabled")),
    duet_disabled: truthy(field(data, "duet_disabled")),
    stitch_disabled: truthy(field(data, "stitch_disabled")),
    ...(max !== undefined && max > 0 ? { max_duration_sec: Math.floor(max) } : {}),
  };
}

/** One stderr line per tool call. */
export function logCall(tool: string, outcome: string, startedMs: number, deps: Deps, error?: TikTokError): void {
  const logId = typeof error?.detail.log_id === "string" ? ` log_id=${error.detail.log_id}` : "";
  log(`${tool} ${outcome} ${Math.max(0, deps.clock.now() - startedMs)}ms${logId}`);
}

/** Run a read or helper: failures become an isError result with the error card, never a thrown protocol error. */
export async function guarded(tool: string, deps: Deps, run: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = deps.clock.now();
  try {
    const result = await run();
    logCall(tool, result.isError ? "error" : "ok", started, deps);
    return result;
  } catch (e) {
    const err = normalizeError(e, { slug: tool });
    logCall(tool, err.code, started, deps, err);
    return fail(err, errorCard(err));
  }
}

/** A progress notification, only when VoiceOS asked for them (a progressToken); VoiceOS shows its own loading state otherwise. */
export function progress(extra: ToolExtra, done: number, total: number, message: string): void {
  const token = extra._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) return;
  extra
    .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } })
    .catch(() => {});
}
