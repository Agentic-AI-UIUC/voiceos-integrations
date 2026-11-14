import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { renderCustom, renderWidget, vHeader, vList, vSpark, markHtml, esc, clip, textEms } from "./widgetKit.ts";
import type { Block, RowItem } from "./widgetKit.ts";

const server = new McpServer({ name: "amplitude", version: "1.0.0" });
const ACCENT = "#1e61f0"; // Amplitude brand blue

// --- Config ---
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1";
// Base URL of the Amplitude Dashboard REST API, which Composio's connected account calls.
const AMPLITUDE_BASE_URL = { us: "https://amplitude.com/api/2", eu: "https://analytics.eu.amplitude.com/api/2" } as const;

function getEnvConfig() {
  const composioKey = process.env.COMPOSIO_API_KEY?.trim() || "";
  const apiKey = process.env.AMPLITUDE_API_KEY?.trim() || "";
  const secretKey = process.env.AMPLITUDE_SECRET_KEY?.trim() || "";
  const region: "us" | "eu" = (process.env.AMPLITUDE_REGION?.trim() || "us").toLowerCase() === "eu" ? "eu" : "us";
  return { composioKey, apiKey, secretKey, region };
}

// --- Composio Fetch Wrapper: Reads response body exactly once ---
interface ComposioResponse {
  ok: boolean;
  status: number;
  rawText: string;
  json: any | null;
}

async function composioFetch(
  method: "GET" | "POST",
  pathAndQuery: string,
  composioKey: string,
  body?: unknown,
  timeoutMs = 30000
): Promise<ComposioResponse> {
  try {
    const res = await fetch(`${COMPOSIO_BASE}${pathAndQuery}`, {
      method,
      headers: { "x-api-key": composioKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawText = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(rawText);
    } catch {}
    return { ok: res.ok, status: res.status, rawText, json };
  } catch (err: any) {
    const message =
      err?.name === "TimeoutError" ? `Request timed out after ${timeoutMs / 1000}s` : err?.message || String(err);
    return { ok: false, status: 0, rawText: message, json: null };
  }
}

// Composio HTTP errors look like { error: { message, errors: [...], suggested_fix, request_id } }.
function composioHttpError(resp: ComposioResponse): string {
  if (resp.status === 401 || resp.status === 403) {
    return `Composio rejected the API key (status ${resp.status}). Create a key at platform.composio.dev -> API Keys in a Platform workspace (not For You) and update COMPOSIO_API_KEY in settings.`;
  }
  const e = resp.json?.error;
  if (e && typeof e === "object") {
    const parts = [e.message, ...(Array.isArray(e.errors) ? e.errors : []), e.suggested_fix].filter(
      (p) => typeof p === "string" && p.trim()
    );
    const msg = parts.join(" — ") || resp.rawText;
    return `Composio error (status ${resp.status}): ${msg}${e.request_id ? ` [Request ID: ${e.request_id}]` : ""}`;
  }
  if (typeof e === "string" && e.trim()) return `Composio error (status ${resp.status}): ${e.trim()}`;
  if (resp.status === 0) return `Could not reach Composio: ${resp.rawText}`;
  return `Composio error (status ${resp.status}): ${resp.rawText.trim() || "empty response"}`;
}

// The user's keys never reach logs or results, even if an upstream error echoes them back.
function redactSecrets(text: string): string {
  const { composioKey, apiKey, secretKey } = getEnvConfig();
  let out = text;
  for (const secret of [composioKey, apiKey, secretKey]) if (secret.length >= 8) out = out.replaceAll(secret, "[redacted]");
  return out.replace(/\bak_[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

// A tool that ran but failed upstream returns 200 with { successful: false, error, data: { status_code, message } }.
// Amplitude's own errors arrive as JSON text: {"error": {"http_code", "message", "metadata": {"details", "reason"}}}.
function toolFailureMessage(json: any): string {
  const status = json?.data?.status_code;
  const raw = json?.data?.message ?? json?.error;
  let detail = typeof raw === "string" ? raw.trim() : raw ? JSON.stringify(raw) : "";
  try {
    const e = JSON.parse(detail)?.error;
    if (e?.metadata?.reason === "event_type_not_found") {
      const name = String(e.metadata.details ?? "").replace(/^Invalid\s+/, "");
      return `Amplitude has no event named "${name}" in this project. Event names are case-sensitive.`;
    }
    if (e && typeof e === "object") {
      detail = [e.message, e.metadata?.details].filter((p) => typeof p === "string" && p.trim() && p !== "Unspecified Error").join(": ") || detail;
    }
  } catch {}
  // Composio's own input validation: "Invalid request data provided\n- <reason>".
  detail = detail.replace(/^Invalid request data provided\s*-?\s*/i, "Invalid input: ").replace(/\s*\n-\s*/g, "; ");
  const hint = status === 401 ? " Check that AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY are from the same Amplitude project." : "";
  return `Amplitude error${status ? ` (status ${status})` : ""}: ${detail || "tool execution failed"}${hint}`;
}

// --- Composio auth: one API_KEY auth config + one connected account per Amplitude key pair/region ---
interface ConnectedAccount {
  userId: string;
  connectedAccountId: string;
}
let accountPromise: { userId: string; promise: Promise<ConnectedAccount> } | null = null;

// Stable, non-reversible user_id: a new key pair or region gets its own connected account.
function composioUserId(apiKey: string, secretKey: string, region: string): string {
  return `voiceos-amplitude-${createHash("sha256").update(`${region}:${apiKey}:${secretKey}`).digest("hex").slice(0, 16)}`;
}

async function findOrCreateConnectedAccount(
  composioKey: string,
  apiKey: string,
  secretKey: string,
  region: "us" | "eu",
  userId: string
): Promise<ConnectedAccount> {
  const existing = await composioFetch(
    "GET",
    `/connected_accounts?toolkit_slugs=amplitude&user_ids=${encodeURIComponent(userId)}&statuses=ACTIVE`,
    composioKey
  );
  if (!existing.ok) throw new Error(composioHttpError(existing));
  const found = existing.json?.items?.[0]?.id;
  if (found) return { userId, connectedAccountId: String(found) };

  const configs = await composioFetch("GET", "/auth_configs?toolkit_slug=amplitude", composioKey);
  if (!configs.ok) throw new Error(composioHttpError(configs));
  let authConfigId: string | undefined = configs.json?.items?.find(
    (c: any) => c.auth_scheme === "API_KEY" && c.status !== "DISABLED"
  )?.id;

  if (!authConfigId) {
    const created = await composioFetch("POST", "/auth_configs", composioKey, {
      toolkit: { slug: "amplitude" },
      auth_config: { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} },
    });
    if (!created.ok) throw new Error(composioHttpError(created));
    authConfigId = created.json?.auth_config?.id;
    if (!authConfigId) throw new Error("Composio created an Amplitude auth config but returned no ID.");
  }

  // Field names come from GET /toolkits/amplitude → auth_config_details[API_KEY]:
  // full = API base URL, generic_api_key = API key, generic_id = secret key.
  const connected = await composioFetch("POST", "/connected_accounts", composioKey, {
    auth_config: { id: authConfigId },
    connection: {
      user_id: userId,
      state: {
        authScheme: "API_KEY",
        val: { status: "ACTIVE", full: AMPLITUDE_BASE_URL[region], generic_api_key: apiKey, generic_id: secretKey },
      },
    },
  });
  if (!connected.ok) throw new Error(composioHttpError(connected));
  if (!connected.json?.id) throw new Error("Composio created an Amplitude connection but returned no ID.");
  return { userId, connectedAccountId: String(connected.json.id) };
}

function getConnectedAccount(composioKey: string, apiKey: string, secretKey: string, region: "us" | "eu"): Promise<ConnectedAccount> {
  const userId = composioUserId(apiKey, secretKey, region);
  if (accountPromise?.userId !== userId) {
    // Shared promise so concurrent tool calls don't create duplicate connections.
    const promise = findOrCreateConnectedAccount(composioKey, apiKey, secretKey, region, userId);
    accountPromise = { userId, promise };
    promise.catch(() => {
      if (accountPromise?.promise === promise) accountPromise = null;
    });
  }
  return accountPromise.promise;
}

interface ToolCtx {
  composioKey: string;
  apiKey: string;
  secretKey: string;
  region: "us" | "eu";
}

// Every Composio call: the caller passes an explicit argument object, never the raw tool args.
async function executeComposioAction(
  ctx: ToolCtx,
  actionName: string,
  params: Record<string, any>
): Promise<{ ok: boolean; data?: any; error?: string }> {
  let account: ConnectedAccount;
  try {
    account = await getConnectedAccount(ctx.composioKey, ctx.apiKey, ctx.secretKey, ctx.region);
  } catch (err: any) {
    const error = redactSecrets(err.message);
    console.error(`[Composio] Connection setup failed: ${error}`);
    return { ok: false, error };
  }

  const resp = await composioFetch("POST", `/tools/execute/${actionName}`, ctx.composioKey, {
    connected_account_id: account.connectedAccountId,
    user_id: account.userId,
    arguments: params,
  });

  if (!resp.ok) {
    // The connection may have been removed in Composio; re-resolve it on the next call.
    accountPromise = null;
    const error = redactSecrets(composioHttpError(resp));
    console.error(`[Composio] ${actionName}: ${error}`);
    return { ok: false, error };
  }
  if (resp.json?.successful !== true) {
    const error = redactSecrets(toolFailureMessage(resp.json));
    console.error(`[Composio] ${actionName}: ${error}`);
    return { ok: false, error };
  }
  return { ok: true, data: resp.json.data };
}

// ============================================================================
// Shared plumbing for the tools below
// ============================================================================
const BASE_CSS = `
.am{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","SF Pro Text",sans-serif;padding:12px 14px 10px}
.am-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.am-eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4)}
.am-err{padding:10px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);background:color-mix(in srgb,var(--bad) 8%,transparent);color:var(--ink-1);font-size:12px;line-height:1.4}
`;

// --- Error result: full message in both the data and the card ---
function errorResult(eyebrow: string, err: string) {
  // ~52 chars per line at 12px in the notch card; grow the card instead of clipping the message.
  const lines = Math.max(1, Math.ceil(err.length / 52));
  const card = renderCustom({
    accent: ACCENT,
    css: BASE_CSS,
    body: `<div class="am"><div class="am-hd">${markHtml()}<span class="am-eyebrow">${esc(eyebrow)}</span></div><div class="am-err">${esc(err)}</div></div>`,
    height: Math.min(420, 86 + lines * 17),
  });
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: err, _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] } }) }],
  };
}

// Every card follows one layout: a single-line header (what + when), one headline answer with a plain-English
// caption, then at most one supporting chart or list. The kit has no headline block, so this one reuses its
// tokens (ink colors, tabular numbers) and reports its own height the way kit blocks do.
// 12.5px text on the kit's 358px content column. vNote uses 28.6; 26 leaves room for wide glyphs so a
// caption never wraps onto a line the card didn't make room for.
const CAPTION_EMS_PER_LINE = 26;
function vHeadline(value: string, caption: string, o: { small?: boolean } = {}): Block {
  const size = o.small ? 18 : 30;
  const lines = caption ? Math.max(1, Math.ceil(textEms(caption) / CAPTION_EMS_PER_LINE)) : 0;
  const html =
    `<div style="padding-top:2px">` +
    `<div class="k-num" style="font-size:${size}px;font-weight:600;letter-spacing:-.02em;line-height:1.1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(clip(value, 40))}</div>` +
    (caption ? `<div style="font-size:12.5px;line-height:1.4;color:var(--ink-3);margin-top:3px;overflow-wrap:anywhere">${esc(clip(caption, 160))}</div>` : "") +
    `</div>`;
  return { html, h: Math.ceil(2 + size * 1.1 + (lines ? 3 + lines * 17.5 : 0)) + 1 };
}

function glanceResult(payload: Record<string, any>, blocks: Array<Block | null | false | undefined>) {
  const card = renderWidget({ blocks, accent: ACCENT });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ...payload, _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] } }),
      },
    ],
  };
}

// Keys, or a ready-made error result.
function toolContext(eyebrow: string): { ctx: ToolCtx; fail?: undefined } | { ctx?: undefined; fail: ReturnType<typeof errorResult> } {
  const { composioKey, apiKey, secretKey, region } = getEnvConfig();
  if (!composioKey) {
    return { fail: errorResult(eyebrow, "Missing Composio API key. Add COMPOSIO_API_KEY in settings (platform.composio.dev -> API Keys, Platform workspace).") };
  }
  if (!apiKey || !secretKey) {
    return { fail: errorResult(eyebrow, "Missing Amplitude API key or secret key. Add both in settings (Amplitude: Settings -> Projects -> your project -> API keys).") };
  }
  return { ctx: { composioKey, apiKey, secretKey, region } };
}

// --- Dates: Amplitude takes YYYYMMDD; tools accept YYYYMMDD or YYYY-MM-DD ---
const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const prettyDate = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

// Card-only date formatting ("Nov 9", "Nov 9 – Nov 14"); results keep ISO dates for the agent.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(value: string, withYear = false): string {
  const m = String(value).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return String(value);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}${withYear ? `, ${m[1]}` : ""}`;
}
function shortRange(start: string, end: string): string {
  const thisYear = String(new Date().getUTCFullYear());
  const withYear = start.slice(0, 4) !== end.slice(0, 4) || start.slice(0, 4) !== thisYear;
  return start === end ? shortDate(start, withYear) : `${shortDate(start, withYear)} – ${shortDate(end, withYear)}`;
}

function parseDate(value: unknown, field: string): { date?: string; error?: string } {
  const s = String(value ?? "").trim();
  if (!s) return {};
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || ymd(d) !== `${m[1]}${m[2]}${m[3]}`) return { error: `${field} must be a date like 2026-05-01 (got "${s}").` };
  return { date: ymd(d) };
}

// Explicit dates win; otherwise the last `days` days ending today (UTC).
function resolveRange(args: any, defaultDays: number, maxDays = 365): { start: string; end: string; error?: undefined } | { error: string } {
  const startArg = parseDate(args.start_date, "start_date");
  if (startArg.error) return { error: startArg.error };
  const endArg = parseDate(args.end_date, "end_date");
  if (endArg.error) return { error: endArg.error };
  const days = args.days === undefined || args.days === null || args.days === "" ? defaultDays : Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > maxDays) return { error: `days must be a whole number from 1 to ${maxDays} (got ${args.days}).` };

  const end = endArg.date ?? ymd(new Date());
  const endDate = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8))));
  const start = startArg.date ?? ymd(new Date(endDate.getTime() - (days - 1) * DAY_MS));
  if (start > end) return { error: `start_date (${prettyDate(start)}) is after end_date (${prettyDate(end)}).` };
  return { start, end };
}

const dateInputs = {
  days: z.number().optional().describe("Number of past days to cover, ending today (UTC). Ignored when start_date is given."),
  start_date: z.string().optional().describe("Optional start date, YYYY-MM-DD or YYYYMMDD."),
  end_date: z.string().optional().describe("Optional end date, YYYY-MM-DD or YYYYMMDD. Default today (UTC)."),
};

function formatNumber(val: unknown): string {
  const n = Number(val);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 100) / 100);
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function formatDuration(ms: unknown): string {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s <= 0) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const eventLabel = (e: string) => ({ _all: "Any event", _active: "Any active event", _new: "New user" } as Record<string, string>)[e] ?? e;

// Glance cards show at most this many rows (vList adds "+N more"); the data returned to the model is not capped by it.
const MAX_SERIES = 10;
const MAX_POINTS = 92;

// ============================================================================
// Tool 1: get_event_segmentation
// ============================================================================
// Verified live: Amplitude's segmentation `i` is the bucket size: "1" daily, "7" weekly, "30" monthly,
// "-300000" realtime (5-minute buckets). Composio's description of "1" as hourly is wrong, and Composio
// rejects Amplitude's hourly value "-3600000".
const SEGMENTATION_INTERVALS = { realtime: "-300000", daily: "1", weekly: "7", monthly: "30" } as const;

server.registerTool(
  "get_event_segmentation",
  {
    title: "Event segmentation",
    description:
      "Count an Amplitude event over time: unique users, total events, % of daily active users, or average per user, bucketed by day, week, month, or 5-minute realtime, optionally grouped by a property. Use when the user asks how many times an event happened, how many users did something, or for an event's trend in Amplitude.",
    inputSchema: {
      event_type: z.string().describe("Exact event name (case-sensitive), or '_all' for any event, '_active' for any active event."),
      metric: z.enum(["uniques", "totals", "pct_dau", "average"]).optional().describe("'uniques' (unique users, default), 'totals' (event count), 'pct_dau' (% of daily active users), or 'average' (events per user)."),
      interval: z.enum(["daily", "weekly", "monthly", "realtime"]).optional().describe("Bucket size. Default 'daily'. 'realtime' is 5-minute buckets for the last day or two."),
      group_by: z.string().optional().describe("Optional property to group by, e.g. 'platform' or 'country'. Prefix custom user properties with 'gp:'."),
      ...dateInputs,
    } as any,
  },
  async (args: any) => {
    const EYEBROW = "EVENT SEGMENTATION";
    const eventType = String(args.event_type ?? "").trim();
    if (!eventType) return errorResult(EYEBROW, "Name the event to count, e.g. \"Sign Up\", or use \"_all\" for any event.");
    const metric = args.metric ?? "uniques";
    const interval: keyof typeof SEGMENTATION_INTERVALS = args.interval ?? "daily";
    if (!(interval in SEGMENTATION_INTERVALS)) return errorResult(EYEBROW, `interval must be daily, weekly, monthly, or realtime (got "${interval}").`);
    const groupBy = String(args.group_by ?? "").trim();
    const range = resolveRange(args, interval === "realtime" ? 1 : 7);
    if (range.error !== undefined) return errorResult(EYEBROW, range.error);

    const { ctx, fail } = toolContext(EYEBROW);
    if (fail) return fail;

    const res = await executeComposioAction(ctx, "AMPLITUDE_GET_EVENT_SEGMENTATION", {
      e: JSON.stringify({ event_type: eventType }),
      m: metric,
      i: SEGMENTATION_INTERVALS[interval],
      start: range.start,
      end: range.end,
      ...(groupBy ? { g: groupBy } : {}),
    });
    if (!res.ok) return errorResult(EYEBROW, res.error || "Failed to get event segmentation.");

    const d = res.data?.data?.data ?? {};
    const xValues: string[] = Array.isArray(d.xValues) ? d.xValues.map(String) : [];
    const rawSeries: any[] = Array.isArray(d.series) ? d.series : [];
    const labels: any[] = Array.isArray(d.seriesLabels) ? d.seriesLabels : [];
    const collapsed: any[] = Array.isArray(d.seriesCollapsed) ? d.seriesCollapsed : [];
    const series = rawSeries.map((values: any[], k: number) => {
      const label = labels[k];
      const name = groupBy ? String(Array.isArray(label) ? label[label.length - 1] : label ?? `Group ${k + 1}`) : eventLabel(eventType);
      const nums = (Array.isArray(values) ? values : []).map((v) => Number(v) || 0);
      // seriesCollapsed is Amplitude's own total for the range (deduplicated for uniques).
      const total = Number(collapsed[k]?.[0]?.value ?? nums.reduce((a, b) => a + b, 0));
      return { name, total, points: nums.map((value, j) => ({ time: xValues[j] ?? null, value })) };
    });
    series.sort((a, b) => b.total - a.total);
    const shown = series.slice(0, MAX_SERIES).map((s) => ({
      ...s,
      points: s.points.slice(-MAX_POINTS),
      ...(s.points.length > MAX_POINTS ? { points_truncated_to_latest: MAX_POINTS } : {}),
    }));

    const main = series[0];
    const total = groupBy ? null : main?.total ?? 0;
    const payload = {
      event_type: eventType,
      metric,
      interval,
      start_date: prettyDate(range.start),
      end_date: prettyDate(range.end),
      ...(groupBy ? { group_by: groupBy, group_count: series.length } : { total }),
      series: shown,
      ...(series.length > MAX_SERIES ? { series_truncated_to_top: MAX_SERIES } : {}),
    };

    // Card wording: what the headline number counts, said the way a person would.
    const when = shortRange(range.start, range.end);
    const name = eventType === "_all" ? "" : eventType === "_active" ? "active" : eventType;
    const counts = {
      totals: name ? `${name} events` : "events of any type",
      uniques: eventType === "_all" ? "users did anything" : eventType === "_active" ? "active users" : `users did ${name}`,
      pct_dau: `of daily active users did ${name || "anything"}, on average`,
      average: `${name ? `${name} events` : "events"} per user`,
    }[metric as "totals" | "uniques" | "pct_dau" | "average"];
    const show = (v: number) => (metric === "pct_dau" ? `${formatNumber(v)}%` : formatNumber(v));
    const bucketName = (t: unknown) => {
      const v = String(t ?? "");
      if (interval === "realtime") return `the 5 minutes at ${v.match(/[T ](\d{2}:\d{2})/)?.[1] ?? v}`;
      if (interval === "weekly") return `the week of ${shortDate(v)}`;
      if (interval === "monthly") return `${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}`;
      return shortDate(v);
    };
    const header = (title: string) => vHeader({ title, trailing: when });

    if (series.length === 0 || series.every((s) => s.total === 0)) {
      return glanceResult(payload, [header("Events"), vHeadline(show(0), `${counts} — nothing recorded in this date range.`)]);
    }
    if (groupBy) {
      const top = series[0];
      const noun = { totals: "events", uniques: "users", pct_dau: "of daily active users", average: "events per user" }[metric as "totals" | "uniques" | "pct_dau" | "average"];
      const scope = name ? `for ${name}` : "across all events";
      const caption =
        series.length === 1
          ? `The only ${groupBy} with data: ${show(top.total)} ${noun} ${scope}.`
          : `Most ${noun} of any ${groupBy} ${scope}: ${show(top.total)}.`;
      return glanceResult(payload, [
        header(`Events by ${groupBy}`),
        vHeadline(top.name || "(none)", caption, { small: true }),
        series.length > 1 ? vList(series.map((s) => ({ title: s.name || "(none)", trailing: show(s.total) }))) : null,
      ]);
    }
    const peak = main.points.reduce((best, p) => (p.value > best.value ? p : best), main.points[0]);
    const busiest = main.points.length > 1 && (metric === "totals" || metric === "uniques") ? ` Busiest: ${bucketName(peak.time)} (${show(peak.value)}).` : "";
    return glanceResult(payload, [
      header("Events"),
      vHeadline(show(total ?? 0), `${counts}.${busiest}`),
      vSpark({ points: main.points.map((p) => p.value).slice(-60) }),
    ]);
  }
);

// ============================================================================
// Tool 2: get_funnel
// ============================================================================
server.registerTool(
  "get_funnel",
  {
    title: "Get funnel",
    description:
      "Run an Amplitude conversion funnel over 2 to 4 events in order and return how many users reached each step, the conversion rates, and the average time between steps. Use when the user asks about conversion, drop-off, or a funnel between events in Amplitude.",
    inputSchema: {
      steps: z.array(z.string()).describe("2 to 4 exact event names in funnel order, e.g. ['Page View', 'Sign Up']."),
      conversion_window_days: z.number().optional().describe("Days a user has to complete the funnel (1-90, default 30)."),
      mode: z.enum(["ordered", "unordered", "sequential"]).optional().describe("'ordered' (default): steps in this order, other events allowed between; 'sequential': no other events between steps; 'unordered': any order."),
      ...dateInputs,
    } as any,
  },
  async (args: any) => {
    const EYEBROW = "FUNNEL";
    const steps = (Array.isArray(args.steps) ? args.steps : []).map((s: any) => String(s).trim()).filter(Boolean);
    if (steps.length < 2 || steps.length > 4) {
      return errorResult(EYEBROW, `An Amplitude funnel needs 2 to 4 steps; got ${steps.length}. Name the events in order, e.g. "Page View" then "Sign Up".`);
    }
    const windowDays = args.conversion_window_days === undefined ? 30 : Number(args.conversion_window_days);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) {
      return errorResult(EYEBROW, `conversion_window_days must be a whole number from 1 to 90 (got ${args.conversion_window_days}).`);
    }
    const mode = args.mode ?? "ordered";
    const range = resolveRange(args, 30);
    if (range.error !== undefined) return errorResult(EYEBROW, range.error);

    const { ctx, fail } = toolContext(EYEBROW);
    if (fail) return fail;

    const res = await executeComposioAction(ctx, "AMPLITUDE_GET_FUNNEL_DATA", {
      events: steps.map((event_type: string) => ({ event_type })),
      start: range.start,
      end: range.end,
      cs: windowDays * 86400,
      mode,
    });
    if (!res.ok) return errorResult(EYEBROW, res.error || "Failed to run the funnel.");

    // No one entered the funnel → Amplitude returns an empty list; report every step as 0 rather than inventing numbers.
    const f = Array.isArray(res.data?.data) ? res.data.data[0] ?? {} : {};
    const counts = steps.map((_: string, i: number) => Number(f.cumulativeRaw?.[i] ?? 0));
    const times = Array.isArray(f.avgTransTimes) ? f.avgTransTimes : [];
    const first = counts[0];
    const stepRows = steps.map((event: string, i: number) => ({
      step: i + 1,
      event,
      users: counts[i],
      conversion_from_first_pct: pct(counts[i], first),
      conversion_from_previous_pct: i === 0 ? 100 : pct(counts[i], counts[i - 1]),
      ...(i > 0 && Number(times[i]) > 0 ? { avg_time_from_previous: formatDuration(times[i]) } : {}),
    }));
    const overall = pct(counts[counts.length - 1], first);

    // Rows: users at each step, and the share kept from the step before. (The kit sizes rows by their
    // subtitle, not trailingSub, so secondary text goes in the subtitle.)
    const rows: RowItem[] = stepRows.map((s: any) => ({
      title: `${s.step}. ${s.event}`,
      subtitle: s.step === 1 ? "Start" : `${s.conversion_from_previous_pct}% of step ${s.step - 1}${s.avg_time_from_previous ? ` · took ${s.avg_time_from_previous} on average` : ""}`,
      trailing: `${formatNumber(s.users)} ${s.users === 1 ? "user" : "users"}`,
    }));
    const lastStep = steps[steps.length - 1];
    const caption =
      first === 0
        ? `No one did ${steps[0]} in this date range, so no one entered the funnel.`
        : `of the ${formatNumber(first)} ${first === 1 ? "user" : "users"} who did ${steps[0]} went on to ${lastStep} within ${windowDays} days.`;
    return glanceResult(
      { start_date: prettyDate(range.start), end_date: prettyDate(range.end), mode, conversion_window_days: windowDays, overall_conversion_pct: overall, steps: stepRows },
      [
        vHeader({ title: "Funnel", trailing: shortRange(range.start, range.end) }),
        vHeadline(first === 0 ? "0 users" : `${overall}%`, caption),
        vList(rows),
      ]
    );
  }
);

// ============================================================================
// Tool 3: get_retention
// ============================================================================
const RETENTION_INTERVALS = { daily: 1, weekly: 7, monthly: 30 } as const;
const RETENTION_UNIT = { daily: "Day", weekly: "Week", monthly: "Month" } as const;
const MAX_PERIODS = 12;

server.registerTool(
  "get_retention",
  {
    title: "Get retention",
    description:
      "Calculate Amplitude retention: of the users who did a starting event, how many came back and did a return event in each later day, week, or month. Use when the user asks about retention, churn, stickiness, or whether users come back.",
    inputSchema: {
      start_event: z.string().optional().describe("Event that puts a user into a cohort. Default '_new' (new users); '_active' means any active user; otherwise an exact event name."),
      return_event: z.string().optional().describe("Event that counts as coming back. Default '_all' (any event); otherwise an exact event name."),
      interval: z.enum(["daily", "weekly", "monthly"]).optional().describe("Retention period. Default 'daily'."),
      retention_mode: z.enum(["n-day", "rolling"]).optional().describe("'n-day' (default): came back exactly in that period; 'rolling': came back in that period or later."),
      ...dateInputs,
    } as any,
  },
  async (args: any) => {
    const EYEBROW = "RETENTION";
    const startEvent = String(args.start_event || "_new").trim();
    const returnEvent = String(args.return_event || "_all").trim();
    const interval: keyof typeof RETENTION_INTERVALS = args.interval ?? "daily";
    if (!(interval in RETENTION_INTERVALS)) return errorResult(EYEBROW, `interval must be daily, weekly, or monthly (got "${interval}").`);
    const mode = args.retention_mode ?? "n-day";
    const range = resolveRange(args, interval === "daily" ? 14 : interval === "weekly" ? 56 : 180);
    if (range.error !== undefined) return errorResult(EYEBROW, range.error);

    const { ctx, fail } = toolContext(EYEBROW);
    if (fail) return fail;

    const res = await executeComposioAction(ctx, "AMPLITUDE_GET_RETENTION", {
      se: JSON.stringify({ event_type: startEvent }),
      re: JSON.stringify({ event_type: returnEvent }),
      start: range.start,
      end: range.end,
      i: RETENTION_INTERVALS[interval],
      // Verified live: Amplitude rejects rm="n-day" ("Invalid retention method"); n-day is its default when rm is omitted.
      ...(mode === "rolling" ? { rm: "rolling" } : {}),
    });
    if (!res.ok) return errorResult(EYEBROW, res.error || "Failed to calculate retention.");

    const unit = RETENTION_UNIT[interval];
    const s = res.data?.data?.series?.[0] ?? {};
    const combined: any[] = Array.isArray(s.combined) ? s.combined : [];
    // combined[k] is period k across all cohorts: count retained out of users whose cohort is old enough to measure it.
    const periods = combined
      .map((c: any, k: number) => ({ period: `${unit} ${k}`, retained: Number(c?.count ?? 0), out_of: Number(c?.outof ?? 0), incomplete: Boolean(c?.incomplete) }))
      .filter((p) => p.out_of > 0)
      .slice(0, MAX_PERIODS + 1)
      .map((p) => ({ ...p, retained_pct: pct(p.retained, p.out_of) }));
    const values = s.values && typeof s.values === "object" ? s.values : {};
    const cohorts = Object.keys(values)
      .map((date) => {
        const row = Array.isArray(values[date]) ? values[date] : [];
        const size = Number(row[0]?.outof ?? row[0]?.count ?? 0);
        const back = row[1] && !row[1].incomplete ? Number(row[1].count ?? 0) : null;
        return { cohort: date, users: size, [`${unit.toLowerCase()}_1_retained_pct`]: back === null ? null : pct(back, size) };
      })
      .filter((c) => c.users > 0)
      .sort((a, b) => Date.parse(a.cohort) - Date.parse(b.cohort))
      .slice(-MAX_PERIODS);

    const cohortUsers = periods[0]?.out_of ?? 0;
    const p1 = periods.find((p) => p.period === `${unit} 1`);
    const payload = {
      start_event: startEvent,
      return_event: returnEvent,
      interval,
      retention_mode: mode,
      start_date: prettyDate(range.start),
      end_date: prettyDate(range.end),
      users_in_cohorts: cohortUsers,
      [`${unit.toLowerCase()}_1_retention_pct`]: p1 ? p1.retained_pct : null,
      periods,
      cohorts,
    };

    // Card wording: "100% of 6 new users came back 1 day later."
    const word = unit.toLowerCase();
    const who = startEvent === "_new" ? "new users" : startEvent === "_active" ? "active users" : `users who did ${startEvent}`;
    const back = returnEvent === "_all" || returnEvent === "_active" ? "came back" : `did ${returnEvent}`;
    const later = (k: number) => `${k} ${word}${k === 1 ? "" : "s"} later${mode === "rolling" ? " or after" : ""}`;
    const caption =
      cohortUsers === 0
        ? `No ${who} in this date range.`
        : p1
          ? `of ${formatNumber(cohortUsers)} ${who} ${back} ${later(1)}.`
          : `${formatNumber(cohortUsers)} ${who} so far — too recent to measure who ${back}.`;
    return glanceResult(payload, [
      vHeader({ title: "Retention", trailing: shortRange(range.start, range.end) }),
      vHeadline(cohortUsers === 0 ? "0 users" : p1 ? `${p1.retained_pct}%` : formatNumber(cohortUsers), caption),
      cohortUsers > 0 && periods.length > 1
        ? vList(
            // A glance: the first three periods and the latest one measured; the full curve is in the data.
            periods
              .map((p) => ({ ...p, n: Number(p.period.split(" ")[1]) }))
              .filter((p, i, all) => p.n >= 1 && (p.n <= 3 || i === all.length - 1))
              .map((p) => ({
                title: `After ${p.n} ${word}${p.n === 1 ? "" : "s"}`,
                subtitle: `${formatNumber(p.retained)} of ${formatNumber(p.out_of)} users${p.incomplete ? " so far" : ""}`,
                trailing: `${p.retained_pct}%`,
              }))
          )
        : null,
    ]);
  }
);

// ============================================================================
// Tool 4: get_user_activity
// ============================================================================
// Location and device details are never returned: only these profile fields and event fields are copied out.
const PRIVATE_KEY = /^\$?(ip|ip_?address|city|region|country|dma|location.*|lat(itude)?|lng|lon(gitude)?|device.*|carrier|idfa|idfv|adid|android_id|os.*|platform)$/i;
const MAX_EVENTS = 50;

function publicProps(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  return Object.fromEntries(Object.entries(props as Record<string, unknown>).filter(([k]) => !PRIVATE_KEY.test(k)));
}

// Speech splits IDs into words ("voiceos-test-1" is heard as "User Voice OS Test 1"). When the exact text
// finds no one, try the words lowercased and rejoined with "-", "_" or nothing, after dropping a leading
// "user"/"device"/"ID". Capped so a miss costs at most a few quick lookups.
const MAX_SPOKEN_VARIANTS = 16;
const SPOKEN_BATCH = 4; // Amplitude allows 5 concurrent Dashboard API requests
function spokenIdVariants(input: string): string[] {
  let words = input.toLowerCase().split(/\s+/).filter(Boolean);
  while (words.length > 1 && ["user", "device", "id", "the"].includes(words[0])) words = words.slice(1);
  if (words.length < 2) return words.length === 1 && words[0] !== input ? [words[0]] : [];
  // Most likely first: speech splits brand-like words ("voiceos" → "voice os"), so short letter fragments
  // rejoin the word before them, and the rest are hyphenated.
  const merged = words.reduce<string[]>((acc, w) => (acc.length && /^[a-z]{1,2}$/.test(w) ? [...acc.slice(0, -1), acc[acc.length - 1] + w] : [...acc, w]), []);
  const variants = [merged.join("-"), words.join("-"), words.join(""), words.join("_")];
  if (words.length <= 5) {
    // Every mix of "-" and "" between words, e.g. voice|os|test|1 → "voiceos-test-1".
    for (let mask = 0; mask < 1 << (words.length - 1); mask++) {
      variants.push(words.reduce((acc, w, i) => (i === 0 ? w : acc + (mask & (1 << (i - 1)) ? "-" : "") + w), ""));
    }
  }
  return [...new Set(variants)].filter((v) => v !== input).slice(0, MAX_SPOKEN_VARIANTS);
}

function summarizeUser(u: any, amplitudeId: number) {
  return {
    user_id: u?.user_id ?? null,
    amplitude_id: Number(u?.canonical_amplitude_id ?? amplitudeId),
    first_seen: u?.first_used || null,
    last_seen: u?.last_used || null,
    total_events: Number(u?.num_events ?? 0),
    sessions: Number(u?.num_sessions ?? 0),
    purchases: Number(u?.purchases ?? 0),
    revenue: Number(u?.revenue ?? 0),
    properties: publicProps(u?.properties),
  };
}

function summarizeEvent(e: any) {
  return {
    event_type: e?.event_type,
    time: typeof e?.event_time === "string" ? e.event_time.replace(" ", "T").replace(/\.\d+$/, "") + "Z" : null,
    session_id: e?.session_id > 0 ? e.session_id : null,
    properties: publicProps(e?.event_properties),
  };
}

server.registerTool(
  "get_user_activity",
  {
    title: "Get user activity",
    description:
      "Look up one Amplitude user by their user ID or device ID (not email, unless email is their user ID) and return their profile summary and most recent events. Location and device details are left out. Use when the user asks what a specific user did or when they were last seen.",
    inputSchema: {
      user: z.string().describe("The user's Amplitude user ID or device ID, or their numeric Amplitude ID."),
      limit: z.number().optional().describe(`Number of recent events to return (1-${MAX_EVENTS}, default 10).`),
    } as any,
  },
  async (args: any) => {
    const EYEBROW = "USER ACTIVITY";
    const user = String(args.user ?? "").trim();
    if (!user) return errorResult(EYEBROW, "Give the user's user ID or device ID.");
    const limit = args.limit === undefined ? 10 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS) return errorResult(EYEBROW, `limit must be a whole number from 1 to ${MAX_EVENTS} (got ${args.limit}).`);

    const { ctx, fail } = toolContext(EYEBROW);
    if (fail) return fail;

    const found = await executeComposioAction(ctx, "AMPLITUDE_FIND_USER", { user });
    if (!found.ok) return errorResult(EYEBROW, found.error || "Failed to search for the user.");
    const toCandidate = (m: any) => ({ user_id: m.user_id ?? null, amplitude_id: Number(m.amplitude_id) });
    let candidates = (Array.isArray(found.data?.matches) ? found.data.matches : []).map(toCandidate);

    // Spoken-ID fallback: only exact user/device ID hits count, never prefix matches of a guessed spelling.
    let matchedAs: string | null = null;
    const variants = candidates.length === 0 ? spokenIdVariants(user) : [];
    for (let i = 0; i < variants.length && candidates.length === 0; i += SPOKEN_BATCH) {
      const batch = variants.slice(i, i + SPOKEN_BATCH);
      const results = await Promise.all(batch.map((v) => executeComposioAction(ctx, "AMPLITUDE_FIND_USER", { user: v })));
      const failed = results.find((r) => !r.ok);
      if (failed) return errorResult(EYEBROW, failed.error || "Failed to search for the user.");
      results.forEach((r, k) => {
        if (r.data?.type !== "match_user_or_device_id") return;
        const hits = (Array.isArray(r.data?.matches) ? r.data.matches : []).map(toCandidate);
        if (hits.length && !matchedAs) matchedAs = batch[k];
        for (const h of hits) if (!candidates.some((c: any) => c.amplitude_id === h.amplitude_id)) candidates.push(h);
      });
    }
    const heard = matchedAs ? { heard: user, matched_as: matchedAs } : {};

    if (candidates.length === 0) {
      const tried = variants.length ? ` I also tried ${variants.length} spellings without spaces.` : "";
      return glanceResult({ query: user, found: false, matches: [], ...(variants.length ? { also_tried: variants } : {}) }, [
        vHeader({ title: "User" }),
        vHeadline("No match", `No Amplitude user has the user ID or device ID "${user}".${tried} Amplitude can't search by email unless email is the user ID.`, { small: true }),
      ]);
    }
    // A prefix search can return several users; an exact user ID match among them is unambiguous.
    const exact = candidates.filter((c: any) => c.user_id === user || (matchedAs && c.user_id === matchedAs));
    const target = candidates.length === 1 ? candidates[0] : exact.length === 1 ? exact[0] : null;
    if (!target) {
      return glanceResult({ query: user, ...heard, found: false, multiple_matches: true, matches: candidates }, [
        vHeader({ title: "Users", trailing: `${candidates.length} matches` }),
        vHeadline("Which one?", `Several users match "${user}". Say the full user ID.`, { small: true }),
        vList(candidates.map((c: any) => ({ title: c.user_id || "(no user ID)", trailing: `ID ${c.amplitude_id}` }))),
      ]);
    }

    const res = await executeComposioAction(ctx, "AMPLITUDE_GET_USER_ACTIVITY", { user: String(target.amplitude_id), limit, direction: "latest" });
    if (!res.ok) return errorResult(EYEBROW, res.error || "Failed to get the user's activity.");
    const profile = summarizeUser(res.data?.userData, target.amplitude_id);
    const events = (Array.isArray(res.data?.events) ? res.data.events : []).slice(0, limit).map(summarizeEvent);

    return glanceResult({ query: user, ...heard, found: true, user: profile, events }, [
      vHeader({ title: "User", trailing: `${formatNumber(profile.total_events)} events in total` }),
      vHeadline(
        profile.user_id || `Amplitude ID ${profile.amplitude_id}`,
        (matchedAs ? `Heard "${user}". ` : "") +
          [profile.last_seen && `Last seen ${shortDate(profile.last_seen)}`, profile.first_seen && `first seen ${shortDate(profile.first_seen)}`].filter(Boolean).join(", ") +
          (events.length ? `. Latest ${events.length === 1 ? "event" : `${events.length} events`}, times in UTC:` : ". No events recorded."),
        { small: true }
      ),
      events.length
        ? vList(events.map((e: any) => ({ title: e.event_type ?? "(unnamed event)", trailing: e.time ? `${shortDate(e.time)}, ${e.time.slice(11, 16)}` : "" })))
        : null,
    ]);
  }
);

// ============================================================================
// Tool 5: export_cohort
// ============================================================================
// Export is asynchronous: request → poll status → download. Polling stays under VoiceOS's 20s foreground
// budget; a slow export returns its request_id so the next call resumes instead of starting over.
const POLL_BUDGET_MS = Number(process.env.AMPLITUDE_POLL_BUDGET_MS) || 15_000;
const POLL_INTERVAL_MS = 1_000;
const SAMPLE_ROWS = 3;

// Splits one CSV line, honoring quoted fields.
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") cells.push(cur), (cur = "");
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

type CohortFile =
  | { file_name: string; rows: number; columns: string[]; sample: Record<string, string>[] }
  | { error: string; fileStage?: boolean };

// `fileStage` marks failures reading the file link itself (after Composio succeeded), so the caller can
// still report the cohort's listed size instead of failing the whole export.
async function downloadCohort(ctx: ToolCtx, requestId: string): Promise<CohortFile> {
  const dl = await executeComposioAction(ctx, "AMPLITUDE_DOWNLOAD_COHORT_FILE", { request_id: requestId });
  if (!dl.ok) return { error: dl.error || "Failed to download the cohort file." };
  const file = dl.data?.file ?? {};
  const url = String(file.s3url ?? "");
  if (!url.startsWith("https://")) return { error: "Composio returned no download link for the cohort file." };
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return { fileStage: true, error: `The cohort file link failed (status ${resp.status}); it expires about a minute after export.` };
    const text = await resp.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = lines.length ? csvCells(lines[0]) : [];
    const keep = header.map((h, i) => (PRIVATE_KEY.test(h.replace(/^gp:/, "")) ? -1 : i)).filter((i) => i >= 0);
    const sample = lines.slice(1, 1 + SAMPLE_ROWS).map((l) => {
      const cells = csvCells(l);
      return Object.fromEntries(keep.map((i) => [header[i], cells[i] ?? ""]));
    });
    return { file_name: String(file.name ?? "cohort.csv"), rows: Math.max(0, lines.length - 1), columns: keep.map((i) => header[i]), sample };
  } catch (err: any) {
    return { fileStage: true, error: `Could not read the cohort file: ${err?.name === "TimeoutError" ? "timed out" : err?.message || String(err)}` };
  }
}

server.registerTool(
  "export_cohort",
  {
    title: "Export cohort",
    description:
      "Export an Amplitude cohort by name or ID and return its size and a short sample of members. Only cohorts marked discoverable in Amplitude can be exported. Use when the user asks who is in a cohort, how big a cohort is, or to export or pull a cohort's members.",
    inputSchema: {
      cohort: z.string().optional().describe("Cohort name or ID, e.g. 'Power users' or 'a1b2c3d4'. Leave blank to list the cohorts."),
      request_id: z.string().optional().describe("Request ID from an earlier export that was still processing; resumes it instead of starting over."),
    } as any,
  },
  async (args: any) => {
    const EYEBROW = "COHORT EXPORT";
    const query = String(args.cohort ?? "").trim();
    let requestId = String(args.request_id ?? "").trim();
    if (requestId && !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return errorResult(EYEBROW, `request_id looks invalid (got "${requestId}").`);

    const { ctx, fail } = toolContext(EYEBROW);
    if (fail) return fail;

    let cohort: { id: string; name: string; size: number | null } | null = null;
    if (!requestId) {
      const list = await executeComposioAction(ctx, "AMPLITUDE_LIST_COHORTS", {});
      if (!list.ok) return errorResult(EYEBROW, list.error || "Failed to list cohorts.");
      const all = (Array.isArray(list.data?.cohorts) ? list.data.cohorts : [])
        .filter((c: any) => !c.archived)
        .map((c: any) => ({ id: String(c.id), name: String(c.name ?? "Untitled"), size: typeof c.size === "number" ? c.size : null }));
      const noneHint = "Amplitude only shows cohorts marked discoverable through the API. Open the cohort in Amplitude and turn on Discoverable (Share settings).";
      if (query && all.length === 0) return errorResult(EYEBROW, `No discoverable cohort matches "${query}". ${noneHint}`);
      if (!query) {
        return glanceResult({ cohorts: all, total_cohorts: all.length, ...(all.length === 0 ? { note: noneHint } : {}) }, [
          vHeader({ title: "Cohorts", trailing: `${all.length} discoverable` }),
          all.length === 0
            ? vHeadline("None found", noneHint, { small: true })
            : vList(all.map((c: any) => ({ title: c.name, trailing: c.size === null ? "" : `${formatNumber(c.size)} ${c.size === 1 ? "user" : "users"}` }))),
        ]);
      }
      const lower = query.toLowerCase();
      const byId = all.filter((c: any) => c.id === query);
      const byName = all.filter((c: any) => c.name.toLowerCase() === lower);
      const partial = all.filter((c: any) => c.name.toLowerCase().includes(lower));
      const hits = byId.length ? byId : byName.length ? byName : partial;
      if (hits.length === 0) {
        return errorResult(EYEBROW, `No discoverable cohort matches "${query}". Cohorts: ${all.slice(0, 10).map((c: any) => `"${c.name}"`).join(", ")}${all.length > 10 ? `, +${all.length - 10} more` : ""}.`);
      }
      if (hits.length > 1) {
        return glanceResult({ query, multiple_matches: true, matches: hits }, [
          vHeader({ title: "Cohorts", trailing: `${hits.length} matches` }),
          vHeadline("Which one?", `Several cohorts match "${query}". Say the full name.`, { small: true }),
          vList(hits.map((c: any) => ({ title: c.name, trailing: c.size === null ? "" : `${formatNumber(c.size)} ${c.size === 1 ? "user" : "users"}` }))),
        ]);
      }
      cohort = hits[0];
      const req = await executeComposioAction(ctx, "AMPLITUDE_GET_COHORT", { cohort_id: cohort!.id });
      if (!req.ok) {
        // Verified live: a free-plan project gets this 403 even for a discoverable cohort.
        if (/\b403\b/.test(req.error ?? "")) {
          const size = cohort!.size === null ? "" : ` Amplitude's cohort list shows it has ${formatNumber(cohort!.size)} ${cohort!.size === 1 ? "user" : "users"}.`;
          return errorResult(
            EYEBROW,
            `Amplitude won't export the members of "${cohort!.name}". Exporting cohorts through its API needs a Growth or Enterprise plan.${size} (Amplitude 403: Unauthorized Request for Cohort Download)`
          );
        }
        return errorResult(EYEBROW, req.error || "Failed to start the cohort export.");
      }
      requestId = String(req.data?.request_id ?? "");
      if (!requestId) return errorResult(EYEBROW, "Amplitude accepted the export but returned no request ID.");
    }

    // Bounded polling; the first check is immediate.
    const deadline = Date.now() + POLL_BUDGET_MS;
    let status = "";
    for (;;) {
      const st = await executeComposioAction(ctx, "AMPLITUDE_CHECK_COHORT_STATUS", { request_id: requestId });
      if (!st.ok) return errorResult(EYEBROW, st.error || "Failed to check the cohort export status.");
      status = String(st.data?.async_status ?? "");
      if (status === "JOB COMPLETED" || Date.now() + POLL_INTERVAL_MS > deadline) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    const name = cohort?.name ?? null;
    if (status !== "JOB COMPLETED") {
      return glanceResult({ cohort: cohort ?? null, request_id: requestId, status: "processing", note: "Amplitude is still preparing this export. Call export_cohort again with this request_id to finish it." }, [
        vHeader({ title: "Cohort export", trailing: "In progress" }),
        vHeadline(name ?? "Still preparing", "Amplitude is still preparing this export. Ask again in a moment to finish it.", { small: true }),
      ]);
    }

    // The download link expires about a minute after it is issued, so fetch it straight away.
    const file = await downloadCohort(ctx, requestId);
    if ("error" in file) {
      if (!file.fileStage || cohort?.size == null) return errorResult(EYEBROW, file.error);
      // Export finished but the file couldn't be read: report the size Amplitude lists, and say the sample is missing.
      return glanceResult({ cohort, request_id: requestId, status: "done", members: cohort.size, sample: null, sample_unavailable: `${file.error} Members are from Amplitude's cohort list.` }, [
        vHeader({ title: "Cohort" }),
        vHeadline(formatNumber(cohort.size), `members in ${cohort.name}. The member file couldn't be read, so there's no sample.`),
      ]);
    }
    return glanceResult({ cohort: cohort ?? { id: null, name: null }, request_id: requestId, status: "done", members: file.rows, file_name: file.file_name, columns: file.columns, sample: file.sample }, [
      vHeader({ title: "Cohort" }),
      vHeadline(formatNumber(file.rows), file.rows === 0 ? `members in ${name ?? "this cohort"} right now.` : `${file.rows === 1 ? "member" : "members"} in ${name ?? "this cohort"}. A few of them:`),
      file.rows > 0
        ? vList(file.sample.map((row: Record<string, string>) => {
            const first = Object.values(row).find(Boolean) ?? "(blank)";
            return { title: row.user_id || first, trailing: row.user_id && row.amplitude_id ? `ID ${row.amplitude_id}` : "" };
          }))
        : null,
    ]);
  }
);

await server.connect(new StdioServerTransport());
