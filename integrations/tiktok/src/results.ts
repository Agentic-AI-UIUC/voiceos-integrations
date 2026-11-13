/**
 * Tool results in the VoiceOS integration shape: one text block holding the JSON the model reads, with the
 * notch card spread in under `_voiceos_glance` (VoiceOS strips that key before
 * the model sees the result). Everything a card shows is also in the JSON.
 */
import type { TikTokError } from "./errors.ts";
import type { Widget } from "./types.ts";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const glance = (widget: Widget) => ({ _voiceos_glance: { blocks: [widget] } });

/** A successful result: the facts plus one card. */
export function ok(data: Record<string, unknown>, widget: Widget): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data, ...glance(widget) }) }] };
}

/**
 * Detail fields the model may see. Errors only ever carry our own facts (never
 * paths, keys or tokens), but this list keeps it that way if one slips in.
 */
const SAFE_DETAIL = [
  "nothing_sent", "reason", "options", "chosen", "max", "dur", "n", "name", "field", "length", "limit",
  "fail_reason", "retry", "log_id", "tiktok_code", "scope", "folders", "kind", "status", "size",
] as const;

/** What the model reads about an error: our code, the card's title and text, and the safe facts behind them. */
export function errorJson(error: TikTokError): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const key of SAFE_DETAIL) {
    const v = error.detail[key];
    // An empty `chosen` is a fact too: no privacy was picked.
    if (v !== undefined && v !== null && (v !== "" || key === "chosen")) facts[key] = v;
  }
  return { code: error.code, title: error.title, message: error.spoken, detail: error.card, ...facts };
}

/** A failed or refused result: isError, the error in plain words, any extra facts, and one card. */
export function fail(error: TikTokError, widget: Widget, extra: Record<string, unknown> = {}): ToolResult {
  const data = { ok: false, error: errorJson(error), summary: `${error.spoken} ${error.card}`.trim(), ...extra };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ...data, ...glance(widget) }) }] };
}

/**
 * Failed background writes: VoiceOS 0.1.40's task panel prints a failed task's text blocks verbatim (all of them,
 * joined) and doesn't render its card, so raw JSON looked broken there. A failed write's text is therefore only
 * plain words (what happened + what to do); the usual JSON (card included) moves to `structuredContent`, which the
 * panel doesn't print and which parseResult, tests and verify.ts read. Successes and non-write results keep the
 * single JSON block.
 */
export function leadWithWords(result: ToolResult): ToolResult {
  if (!result.isError) return result;
  const json = parseResult(result);
  const lead = String(json.summary ?? json.error?.message ?? "").trim();
  let more = String(json.message ?? json.error?.detail ?? "").trim();
  // The card body often ends with its own "nothing was sent" line; the lead already says so.
  if (/nothing (reached|was sent to) tiktok/i.test(lead)) more = more.replace(/\s*Nothing was sent to TikTok\.?$/i, "").trim();
  const words = [lead, more && !lead.includes(more) ? more : ""].filter(Boolean).join(" ") || "Not sent.";
  const { content: _content, ...rest } = result;
  return { ...rest, isError: true, content: [{ type: "text", text: words }], structuredContent: json };
}

/** The JSON inside a result (tests and verify.ts read results back this way): structuredContent, else the first JSON text block. */
export function parseResult(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }): Record<string, any> {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Record<string, any>;
  const texts = (result.content ?? []).filter((c) => c.type === "text");
  const text = texts.find((c) => (c.text ?? "").trimStart().startsWith("{"))?.text ?? texts[0]?.text ?? "{}";
  return JSON.parse(text);
}
