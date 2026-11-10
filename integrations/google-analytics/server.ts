/**
 * Google Analytics — the MCP server VoiceOS launches via run.sh (stdio; stdout
 * is the MCP wire, so log with console.error). Tools: run_report,
 * run_realtime_report and get_metadata — the only three approved GA actions.
 * All are read-only, so none has a confirmation card.
 *
 * Why one file: VoiceOS "Publish" ships only server.ts, widgetKit.ts,
 * voiceos.integration.json, package.json and icon.png. Every runtime line
 * must live in those files, so the sections below stand in for modules:
 *
 *   1. .env loading        4. Errors in plain words
 *   2. Composio client     5. Glance cards
 *   3. GA queries          6. Tools (MCP wiring, entry point)
 *
 * Composio setup (credentials are the developer's, never VoiceOS setup fields):
 *   - Create a `.env` next to this file with
 *       COMPOSIO_API_KEY=<project key: platform.composio.dev → Settings → API Keys>
 *       COMPOSIO_USER_ID=default   # the user_id Google Analytics is connected under
 *     .env never ships with Publish; each developer keeps their own.
 *   - TEMPORARY, for testing: the Setup page also has an optional "Composio API
 *     key" field that wins over .env. Remove it from the manifest before release.
 *   - Connect Google Analytics (OAuth2, Composio-managed) for that user_id, e.g.
 *     `composio link google_analytics`. Composio refreshes the token.
 *
 * Tool names and input schemas must stay identical to voiceos.integration.json.
 * Descriptions differ on purpose: the manifest's is the short line the Actions
 * panel shows users; the one here is the agent's routing rules.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { esc, renderWidget, setIntegrationMark, vEmpty, vHeader, vList, vNote, vStats, type Block, type RenderedWidget, type Tone } from "./widgetKit.ts";

// ============================================================================
// 1. .env loading
// Hand-rolled on purpose: VoiceOS launches the server with its bundled Bun
// (1.3.x, no process.loadEnvFile) or with tsx/Node, and neither path can be
// relied on to read .env by itself. Supports KEY=value, KEY="value", blank lines
// and # comments. Non-empty variables already in the environment win (VoiceOS
// injects Setup fields as env vars, and a blank field arrives as "").
// ============================================================================

export function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue; // blank line, comment or junk
    vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars;
}

/** Loads `path` into process.env if it exists; a missing file is fine (calls then report the missing key). */
export function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

// ============================================================================
// 2. Composio client
//   execute(slug, args)        runs one Composio tool for the connected user
//                              and returns its `data`
//   request(method, path, b?)  plain REST call (e.g. listing connected accounts)
//
// API v3.1: tools run at their latest version when `version` is omitted.
// Knows nothing about Google Analytics.
// ============================================================================

const BASE_URL = "https://backend.composio.dev/api/v3.1";
const TIMEOUT_MS = 15_000;

/**
 * A failed Composio call.
 *  - source "composio": Composio itself refused (bad API key, no connected account, …);
 *    `status` is the HTTP status and `slug` Composio's error slug.
 *  - source "tool": the request reached Google and Google said no;
 *    `status` is Google's HTTP status (data.status_code).
 * A timeout is not a ComposioError: it rejects with `name === "TimeoutError"`.
 */
export class ComposioError extends Error {
  constructor(
    message: string,
    readonly source: "composio" | "tool",
    readonly status?: number,
    readonly slug?: string,
  ) {
    super(message);
    this.name = "ComposioError";
  }
}

/** Runs a Composio tool by slug and resolves to its `data`; rejects with a ComposioError. */
export type ExecuteTool = (slug: string, args: Record<string, unknown>) => Promise<any>;

/** A REST call against the Composio API; resolves to the parsed JSON body. */
export type ComposioRequest = (method: "GET" | "POST", path: string, body?: unknown) => Promise<any>;

export interface ComposioConfig {
  /** Project API key (COMPOSIO_API_KEY: Setup field, else .env). Checked per call, so a missing key becomes a tool error, not a crash at startup. */
  apiKey?: string;
  /** The Composio user_id Google Analytics is connected under. */
  userId: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function createComposio(config: ComposioConfig): { execute: ExecuteTool; request: ComposioRequest } {
  const request: ComposioRequest = async (method, path, body) => {
    if (!config.apiKey) throw new ComposioError("Missing Composio API key — set COMPOSIO_API_KEY in this integration's .env (or, for testing, its Setup page).", "composio");

    const res = await (config.fetch ?? fetch)(`${BASE_URL}${path}`, {
      method,
      headers: { "x-api-key": config.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      // Errors look like { error: { message, slug, status, ... } }.
      const e = json?.error;
      throw new ComposioError(
        `Composio HTTP ${res.status}: ${e?.message || e || res.statusText}`,
        "composio",
        res.status,
        e?.slug,
      );
    }
    return json;
  };

  const execute: ExecuteTool = async (slug, args) => {
    const json = await request("POST", `/tools/execute/${slug}`, { user_id: config.userId, arguments: args });
    // Google's own failures come back as HTTP 200 with successful: false.
    if (!json?.successful) {
      throw new ComposioError(json?.error || `${slug} failed`, "tool", json?.data?.status_code);
    }
    return json.data;
  };

  return { execute, request };
}

/**
 * True when the failure means the user's Google connection is missing, expired
 * or revoked — i.e. reconnecting is the fix. A bad Composio API key is not one.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof ComposioError)) return false;
  if (err.source === "tool") return err.status === 401; // Google rejected the stored token
  return /ConnectedAccount/i.test(err.slug ?? ""); // e.g. ActionExecute_ConnectedAccountNotFound
}

// ============================================================================
// 3. GA queries
// Turns tool arguments into GA4 Data API requests and GA's column-split
// responses (headers + string values) into plain rows the agent can read.
// ============================================================================

const DEFAULT_LIMIT = 10;

/** "123", "properties/123" or the Setup default → "properties/123"; throws a fixable message otherwise. */
export function propertyName(id?: string, fallback?: string): string {
  const raw = (id?.trim() || fallback?.trim() || "").replace(/^properties\//, "");
  if (!raw) throw new Error("No GA4 property ID. Ask the user for it (Google Analytics → Admin → Property settings), or set a default in this integration's Setup.");
  if (/^G-/i.test(raw)) throw new Error(`${raw} is a Measurement ID (from a data stream), not a property ID. The property ID is the number in Google Analytics → Admin → Property settings.`);
  if (!/^\d+$/.test(raw)) throw new Error(`"${raw}" is not a GA4 property ID; it is digits only, e.g. 123456789.`);
  return `properties/${raw}`;
}

const idOf = (name: string) => name.slice("properties/".length);
const named = (names: string[] = []) => names.map((name) => ({ name }));

/** Sorts by a metric when `field` is one of this request's metrics, otherwise by that dimension. */
function orderBys(metrics: string[], field = metrics[0], descending = true) {
  return [metrics.includes(field)
    ? { metric: { metricName: field }, desc: descending }
    : { dimension: { dimensionName: field }, desc: descending }];
}

/** GA rows ({dimensionValues, metricValues} matched to headers by position) → {field: value}, metrics as numbers. */
function toRows(data: any): Record<string, string | number>[] {
  const dims: string[] = (data?.dimensionHeaders ?? []).map((h: any) => h.name);
  const mets: string[] = (data?.metricHeaders ?? []).map((h: any) => h.name);
  return (data?.rows ?? []).map((r: any) => {
    const row: Record<string, string | number> = {};
    dims.forEach((name, i) => (row[name] = r.dimensionValues?.[i]?.value ?? ""));
    mets.forEach((name, i) => (row[name] = Number(r.metricValues?.[i]?.value ?? 0)));
    return row;
  });
}

/**
 * GA's TOTAL rows → {metric: n}, or {current: {…}, previous: {…}} for a comparison.
 * Totals are computed by GA over every matching row, so unlike a sum of `rows`
 * they are not cut short by the limit. Empty totals ({}, no data) count as 0.
 */
function toTotals(data: any, periods?: string[]) {
  const mets: string[] = (data?.metricHeaders ?? []).map((h: any) => h.name);
  const totals: any[] = data?.totals ?? [];
  const one = (t: any) => Object.fromEntries(mets.map((name, i) => [name, Number(t?.metricValues?.[i]?.value ?? 0)]));
  if (!periods) return one(totals[0]);
  // Each totals entry names its period in dimensionValues; fall back to request order.
  return Object.fromEntries(periods.map((p, i) => [p, one(totals.find((t) => t?.dimensionValues?.some((v: any) => v.value === p)) ?? totals[i])]));
}

/** One exact-match condition on a dimension, which needn't be one of the request's dimensions. */
export interface Filter {
  dimension: string;
  value: string;
}

const dimensionFilter = (f?: Filter) =>
  f ? { dimensionFilter: { filter: { fieldName: f.dimension, stringFilter: { matchType: "EXACT", value: f.value } } } } : {};

/** Field names grouped by category, kept only when `keep` says so (the full metadata is ~140 KB). */
function byCategory(fields: any[] = [], keep: (f: any) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fields) if (keep(f)) (out[f.category || "Other"] ??= []).push(f.apiName);
  return out;
}

export interface ReportArgs {
  property_id?: string;
  metrics: string[];
  dimensions?: string[];
  start_date?: string;
  end_date?: string;
  /** Both set → a second, "previous" period; rows and totals then say which period they are. */
  compare_start_date?: string;
  compare_end_date?: string;
  filter?: Filter;
  order_by?: string;
  descending?: boolean;
  limit?: number;
}

export type RealtimeArgs = Omit<ReportArgs, "metrics" | "start_date" | "end_date" | "compare_start_date" | "compare_end_date"> & { metrics?: string[] };

export interface MetadataArgs {
  property_id?: string;
  category?: string;
  search?: string;
}

export function createGa(execute: ExecuteTool, defaultPropertyId?: string) {
  return {
    async runReport(a: ReportArgs) {
      const property = propertyName(a.property_id, defaultPropertyId);
      const start_date = a.start_date || "7daysAgo";
      const end_date = a.end_date || "today";
      const { compare_start_date, compare_end_date } = a;
      if (!compare_start_date !== !compare_end_date) throw new Error("A comparison needs both compare_start_date and compare_end_date.");
      const compare = !!compare_start_date;
      const data = await execute("GOOGLE_ANALYTICS_RUN_REPORT", {
        property,
        dateRanges: compare
          ? [{ startDate: start_date, endDate: end_date, name: "current" }, { startDate: compare_start_date, endDate: compare_end_date, name: "previous" }]
          : [{ startDate: start_date, endDate: end_date }],
        metrics: named(a.metrics),
        dimensions: named(a.dimensions),
        ...dimensionFilter(a.filter),
        orderBys: orderBys(a.metrics, a.order_by, a.descending),
        metricAggregations: ["TOTAL"],
        limit: a.limit ?? DEFAULT_LIMIT,
      });
      const rows = toRows(data);
      return {
        property_id: idOf(property), start_date, end_date,
        ...(compare ? { compare_start_date, compare_end_date } : {}),
        time_zone: data?.metadata?.timeZone,
        row_count: data?.rowCount ?? rows.length,
        totals: toTotals(data, compare ? ["current", "previous"] : undefined),
        rows,
      };
    },

    async runRealtimeReport(a: RealtimeArgs) {
      const property = propertyName(a.property_id, defaultPropertyId);
      const metrics = a.metrics?.length ? a.metrics : ["activeUsers"];
      const data = await execute("GOOGLE_ANALYTICS_RUN_REALTIME_REPORT", {
        property,
        metrics: named(metrics),
        dimensions: named(a.dimensions),
        ...dimensionFilter(a.filter),
        orderBys: orderBys(metrics, a.order_by, a.descending),
        metricAggregations: ["TOTAL"],
        limit: a.limit ?? DEFAULT_LIMIT,
      });
      const rows = toRows(data);
      return { property_id: idOf(property), window: "last 30 minutes", row_count: data?.rowCount ?? rows.length, totals: toTotals(data), rows };
    },

    async getMetadata(a: MetadataArgs) {
      const property = propertyName(a.property_id, defaultPropertyId);
      const data = await execute("GOOGLE_ANALYTICS_GET_METADATA", { name: `${property}/metadata` });
      const category = a.category?.trim().toLowerCase();
      const search = a.search?.trim().toLowerCase();
      const keep = (f: any) =>
        (!category || String(f.category).toLowerCase() === category) &&
        (!search || [f.apiName, f.uiName].some((s) => String(s ?? "").toLowerCase().includes(search)));
      return { property_id: idOf(property), dimensions: byCategory(data?.dimensions, keep), metrics: byCategory(data?.metrics, keep) };
    },
  };
}

// ============================================================================
// 4. Errors in plain words
// The Google account shows up in Composio as a "connected account" for a
// user_id and toolkit "google_analytics"; Composio refreshes its OAuth token.
// Tools only work while it is ACTIVE.
// ============================================================================

const DASHBOARD = "platform.composio.dev → Connected accounts";

/**
 * Why the Google Analytics link isn't working: ACTIVE if any account of the
 * user is, otherwise the newest account's Composio status (INITIALIZING /
 * INITIATED = sign-in unfinished; FAILED / EXPIRED / INACTIVE = link again), or NONE.
 */
export async function gaLinkStatus(request: ComposioRequest, userId: string): Promise<string> {
  const query = new URLSearchParams({ toolkit_slugs: "google_analytics", user_ids: userId });
  const list: { status: string; created_at?: string }[] = (await request("GET", `/connected_accounts?${query}`))?.items ?? [];
  if (list.some((a) => a.status === "ACTIVE")) return "ACTIVE";
  const newest = [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return newest?.status ?? "NONE";
}

/**
 * Turns a failure into words the user (and agent) can act on. `reconnect` is
 * true when linking Google Analytics again is the fix.
 */
export async function describeError(err: any, linkStatus: () => Promise<string>): Promise<{ error: string; reconnect: boolean }> {
  const fail = (error: string, reconnect = false) => ({ error, reconnect });
  // GA's messages start with Composio's wrapper; keep only Google's part.
  const gaMessage = String(err?.message ?? "").replace(/^API request failed with status \d+\.\s*/, "");

  if (err?.name === "TimeoutError") {
    return fail("Google Analytics did not answer in time. Try again, or ask for a shorter date range or fewer fields.");
  }
  if (isConnectionError(err)) {
    // Ask Composio why, so the message can say "expired" vs "never connected" vs "revoked".
    const status = await linkStatus().catch(() => "UNKNOWN");
    const why = ["NONE", "INITIALIZING", "INITIATED"].includes(status) ? "Google Analytics isn't connected yet."
      : status === "EXPIRED" ? "The Google Analytics connection has expired."
      : "Google Analytics access was revoked.";
    return fail(`${why} Reconnect the Google account in ${DASHBOARD}.`, true);
  }
  if (err instanceof ComposioError && err.source === "composio" && err.status === 401) {
    return fail("The Composio API key was rejected. Check COMPOSIO_API_KEY in this integration's .env.");
  }
  if (err instanceof ComposioError && err.source === "tool") {
    if (err.status === 403) return fail("The connected Google account can't access this GA4 property. Check the property ID, or ask for at least Viewer access to it.");
    if (err.status === 429) return fail("Google Analytics' query quota for this property is used up. Try again later.");
    // GA's "Did you mean …?" guesses are often wrong (pageViews → itemsViewed), so send the agent to the real list.
    if (err.status === 400) return fail(`Google Analytics rejected the query: ${gaMessage} If a field name is wrong, call get_metadata for the valid names.`);
  }
  return fail(gaMessage || "Network error while connecting to Composio.");
}

// ============================================================================
// 5. Glance cards
// Minimal on purpose: only the Widget Kit's stock blocks, no custom CSS, no
// accent. A header names the period, GA's totals are the stats, then up to 5
// top rows. Empty data and errors each look different from a normal result.
// Everything on a card is also in the JSON beside it.
// ============================================================================

const MAX_CARD_ROWS = 5;

const LABELS: Record<string, string> = {
  screenPageViews: "Views", activeUsers: "Active users", newUsers: "New users", totalUsers: "Total users",
  sessions: "Sessions", eventCount: "Events", keyEvents: "Key events", engagementRate: "Engagement rate",
  bounceRate: "Bounce rate", averageSessionDuration: "Avg. session",
};

/** A metric's name as people say it; unknown names are split from camelCase ("userEngagementDuration" → "User engagement duration"). */
const label = (field: string) =>
  LABELS[field] ?? field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();

/** Compact counts (12.3k, 2.5M); GA rates are fractions, shown as %; durations are seconds, shown as 2m 5s. */
export function fmtMetric(field: string, n: number): string {
  if (/Rate$/.test(field)) return `${+(n * 100).toFixed(1)}%`;
  if (/Duration$/.test(field)) {
    const s = Math.round(n);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(+n.toFixed(2));
}

/** Change from the previous period as a signed percent; up is good, except for bounce rate. No baseline, no percent. */
export function change(field: string, current: number, previous: number): { delta?: string; tone?: Tone } {
  if (!previous) return {};
  const pct = Math.round(((current - previous) / previous) * 100);
  const better = field === "bounceRate" ? pct < 0 : pct > 0;
  return { delta: `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`, tone: pct === 0 ? "neutral" : better ? "good" : "bad" };
}

const dateWord = (d: string) => (/^\d+daysAgo$/.test(d) ? `${parseInt(d)} days ago` : d);

/** GA's date words spelled out: "7daysAgo"/"today" → "7 days ago – today"; one day → "Yesterday". */
export function periodLabel(start: string, end: string): string {
  if (start !== end) return `${dateWord(start)} – ${dateWord(end)}`;
  const w = dateWord(start);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

type Totals = Record<string, number>;
type Row = Record<string, string | number>;

const card = (blocks: Parameters<typeof renderWidget>[0]["blocks"]) => renderWidget({ blocks, label: "Google Analytics" });

/** The result key VoiceOS shows in the notch. */
export const glance = (c: RenderedWidget) => ({ blocks: [{ type: "widget", html: c.html, height: c.height }] });

/** Up to three totals as stats, with their change when there is a previous period. */
const statsOf = (totals: Totals, previous?: Totals) =>
  vStats(Object.entries(totals).slice(0, 3).map(([f, v]) => ({ label: label(f), value: fmtMetric(f, v), ...(previous ? change(f, v, previous[f] ?? 0) : {}) })));

/** Top rows: dimension values as the title, the first metric on the right. */
const rowsList = (rows: Row[], metric: string) =>
  vList(rows.slice(0, MAX_CARD_ROWS).map((r) => ({
    title: Object.entries(r).filter(([k, v]) => typeof v === "string" && k !== "dateRange").map(([, v]) => v).join(" · ") || "(not set)",
    trailing: fmtMetric(metric, Number(r[metric] ?? 0)),
  })));

/**
 * Every row in a scrollable window. vList stops at 5 rows by design, which is
 * too few for "what can I query"; the kit hides scrollbars but keeps wheel and
 * trackpad scrolling inside the card.
 * shortcut: reuses vList's row classes (k-list, k-rw, …) for an identical look; if the kit renames them, rows lose their style — switch to a kit scroll block if one is added.
 */
const SCROLL_ROW_H = 32;
const SCROLL_MAX_H = 8 * SCROLL_ROW_H;
function scrollList(rows: { title: string; trailing: string }[]): Block {
  const h = Math.min(rows.length * SCROLL_ROW_H, SCROLL_MAX_H);
  const html = rows.map((r) =>
    `<div class="k-rw"><div class="k-rw-m"><div class="k-rw-t">${esc(r.title)}</div></div><div class="k-rw-tr"><span class="k-num">${esc(r.trailing)}</span></div></div>`).join("");
  return { html: `<div class="k-list" style="max-height:${h}px;overflow-y:auto;overscroll-behavior:contain">${html}</div>`, h };
}

const allZero = (...totals: (Totals | undefined)[]) => totals.every((t) => !t || Object.values(t).every((v) => !v));

export interface ReportResult {
  start_date: string;
  end_date: string;
  compare_start_date?: string;
  compare_end_date?: string;
  totals: any;
  rows: Row[];
}

export function reportCard(r: ReportResult): RenderedWidget {
  const compare = !!r.compare_start_date;
  const totals: Totals = compare ? r.totals.current : r.totals;
  const previous: Totals | undefined = compare ? r.totals.previous : undefined;
  // The kit draws title as a small eyebrow and subtitle large: kind above, period below.
  const header = vHeader({ title: "Report", subtitle: periodLabel(r.start_date, r.end_date), trailing: compare ? "vs previous" : undefined });
  if (r.rows.length === 0 && allZero(totals, previous)) {
    return card([header, vEmpty({ title: "No data for this period", hint: "A new property can take a day to show reports." })]);
  }
  const rows = compare ? r.rows.filter((x) => x.dateRange === "current") : r.rows;
  return card([header, statsOf(totals, previous), rows.length > 0 && rowsList(rows, Object.keys(totals)[0])]);
}

export function realtimeCard(r: { totals: Totals; rows: Row[] }): RenderedWidget {
  const header = vHeader({ title: "Right now", subtitle: "Last 30 minutes" });
  if (r.rows.length === 0 && allZero(r.totals)) return card([header, vEmpty({ title: "No one on the site right now" })]);
  return card([header, statsOf(r.totals), r.rows.length > 0 && rowsList(r.rows, Object.keys(r.totals)[0])]);
}

export function metadataCard(r: { dimensions: Record<string, string[]>; metrics: Record<string, string[]> }, a: MetadataArgs): RenderedWidget {
  const metrics = Object.values(r.metrics).flat();
  const dimensions = Object.values(r.dimensions).flat();
  const header = vHeader({ title: "Fields", subtitle: a.category || (a.search ? `Matching “${a.search}”` : "All") });
  if (metrics.length + dimensions.length === 0) return card([header, vEmpty({ title: "No matching fields" })]);
  return card([
    header,
    vStats([{ label: "Metrics", value: String(metrics.length) }, { label: "Dimensions", value: String(dimensions.length) }]),
    scrollList([...metrics.map((title) => ({ title, trailing: "Metric" })), ...dimensions.map((title) => ({ title, trailing: "Dimension" }))]),
  ]);
}

export function errorCard(error: string, reconnect: boolean): RenderedWidget {
  return card([vHeader({ title: "Google Analytics", trailing: reconnect ? "Reconnect needed" : undefined }), vNote(error)]);
}

// ============================================================================
// 6. Tools (MCP wiring, entry point)
// createServer registers the three tools; tests drive it over an in-memory
// transport. main() only runs when this file is the program (VoiceOS /
// run.sh), not when tests import it. import.meta.main is missing under tsx,
// so compare paths instead.
//
// Descriptions here are the agent's routing rules. The manifest's are the short
// lines users see in the Actions panel, which cuts text off after two lines.
// ============================================================================

const fieldList = (what: string) => z.array(z.string()).describe(what);
const propertyArg = z.string().optional().describe("GA4 property ID (digits, e.g. 123456789). Omit to use the default from Setup.");
const dateArg = (fallback: string) => z.string().optional().describe(`YYYY-MM-DD, "today", "yesterday" or "NdaysAgo". Default "${fallback}".`);
const filterArg = z.object({
  dimension: z.string().describe("Dimension API name, e.g. \"country\" or \"eventName\". It need not be in dimensions."),
  value: z.string().describe("Exact value to keep, e.g. \"United States\" or \"sign_up_click\"."),
}).optional().describe("Keep only rows where this dimension equals this value.");
const sortArgs = {
  order_by: z.string().optional().describe("A metric or dimension from this request to sort by. Default: the first metric."),
  descending: z.boolean().optional().describe("Sort high to low (default true). Use false for dates in time order."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum rows (default 10). totals and row_count always cover every matching row."),
};

// Shared by both report tools: how to read what comes back.
const READING_RESULTS = "Results: rows are {field: value}; totals are GA's own totals over every matching row, so use them for \"how many in total\" rather than adding up rows (rows stop at limit, row_count says how many matched). User counts can repeat across rows (one person viewing two pages), so for unique users overall, query without dimensions. Rates such as bounceRate and engagementRate are fractions (0.42 = 42%); durations are seconds.";

export function createServer(ga: ReturnType<typeof createGa>, linkStatus: () => Promise<string>): McpServer {
  const server = new McpServer({ name: "google-analytics", version: "1.0.0" });

  /** A tool result: JSON the model reads. */
  const textResult = (payload: unknown, isError = false) => ({
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  });

  /** A card must never cost the user their answer: if rendering fails, the data goes out without one. */
  const withCard = (payload: object, render: () => RenderedWidget) => {
    try {
      return { ...payload, _voiceos_glance: glance(render()) };
    } catch (err) {
      console.error("card failed:", err);
      return payload;
    }
  };

  /**
   * Wraps a tool body: its result goes out with its glance card; a failure is
   * logged and turned into plain words, with an error card.
   */
  const guarded = <A, R extends object>(tool: string, body: (args: A) => Promise<R>, render: (result: R, args: A) => RenderedWidget) =>
    async (args: A) => {
      try {
        const result = await body(args);
        return textResult(withCard(result, () => render(result, args)));
      } catch (err) {
        console.error(`${tool} failed:`, err);
        const described = await describeError(err, linkStatus);
        return textResult(withCard(described, () => errorCard(described.error, described.reconnect)), true);
      }
    };

  server.registerTool(
    "run_report",
    {
      title: "Run report",
      description: [
        "Run a Google Analytics (GA4) report over a date range: metrics (what to count) grouped by optional dimensions. Use when the user asks about visitors, users, sessions, page views, top pages, traffic sources, countries, devices or events over days, weeks or months. For \"right now\" or the last 30 minutes use run_realtime_report instead.",
        "Use exact GA4 API names. Common metrics: activeUsers, newUsers, sessions, screenPageViews, eventCount, engagementRate, averageSessionDuration, keyEvents. Common dimensions: pagePath, pageTitle, country, city, deviceCategory, sessionSource, sessionDefaultChannelGroup, eventName, date. If unsure of a name, or a query fails on an invalid field, call get_metadata first.",
        "Answer in one call: when the user asks which pages, countries or sources, put that dimension in this call. To compare with an earlier period (\"vs last week\"), set compare_start_date/compare_end_date: rows gain a dateRange field (\"current\"/\"previous\") and totals split by period. For one value (\"how many from the US\", \"how many sign-ups\"), use filter instead of hunting through rows. For trends over months use dimension yearMonth, over weeks isoYearIsoWeek, rather than date with a large limit.",
        READING_RESULTS,
        "Dates are in the property's time zone, returned as time_zone; say so when the user's \"today\" may differ. Empty rows with zero totals means no data for that period, not an error; a new property takes up to a day before reports have data.",
      ].join(" "),
      inputSchema: {
        property_id: propertyArg,
        metrics: fieldList("Metric API names to count, 1 to 10, e.g. [\"activeUsers\"]").min(1).max(10),
        dimensions: fieldList("Dimension API names to group by, up to 9, e.g. [\"pagePath\"]. Omit for totals only.").max(9).optional(),
        start_date: dateArg("7daysAgo"),
        end_date: dateArg("today"),
        compare_start_date: z.string().optional().describe("Start of an earlier period to compare with, same formats. Set together with compare_end_date."),
        compare_end_date: z.string().optional().describe("End of the earlier period to compare with."),
        filter: filterArg,
        ...sortArgs,
      } as any,
    },
    guarded("run_report", (args: ReportArgs) => ga.runReport(args), reportCard),
  );

  server.registerTool(
    "run_realtime_report",
    {
      title: "Run realtime report",
      description: [
        "Show live Google Analytics (GA4) activity from the last 30 minutes. Use when the user asks how many people are on the site or app right now, or what they are doing. For anything older than 30 minutes use run_report.",
        "Answer in one call: when the user asks which pages, countries or devices, put that dimension in this call (pages: unifiedScreenName; also country, city, deviceCategory, platform, eventName). Metrics: activeUsers (default), screenPageViews, eventCount, keyEvents. To count one thing, use filter (e.g. eventName = sign_up_click).",
        READING_RESULTS,
      ].join(" "),
      inputSchema: {
        property_id: propertyArg,
        metrics: fieldList("Metric API names, up to 10. Default [\"activeUsers\"].").max(10).optional(),
        dimensions: fieldList("Dimension API names to group by, up to 9, e.g. [\"unifiedScreenName\"]. Omit for totals only.").max(9).optional(),
        filter: filterArg,
        ...sortArgs,
      } as any,
    },
    guarded("run_realtime_report", (args: RealtimeArgs) => ga.runRealtimeReport(args), realtimeCard),
  );

  server.registerTool(
    "get_metadata",
    {
      title: "Get metadata",
      description: "List the dimension and metric API names a GA4 property supports, grouped by category, including its custom ones. Use before run_report or run_realtime_report when unsure of a field's exact name, after a query fails on an invalid field (GA's own \"Did you mean\" guess is often wrong), or when the user asks what they can measure. The full list is long: narrow it with category (e.g. \"Page / Screen\", \"User\", \"Session\", \"Traffic Source\", \"Event\") or search (words in the API or display name, e.g. \"view\").",
      inputSchema: {
        property_id: propertyArg,
        category: z.string().optional().describe("Only this category, e.g. \"Page / Screen\", \"User\", \"Session\", \"Geography\", \"Traffic Source\", \"Event\"."),
        search: z.string().optional().describe("Only fields whose API or display name contains these words, e.g. \"view\"."),
      } as any,
    },
    guarded("get_metadata", (args: MetadataArgs) => ga.getMetadata(args), metadataCard),
  );

  return server;
}

async function main(): Promise<void> {
  loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
  // The cards' logo comes from icon.png, so it can never drift from the icon VoiceOS shows.
  setIntegrationMark(`data:image/png;base64,${readFileSync(new URL("icon.png", import.meta.url)).toString("base64")}`);

  const userId = process.env.COMPOSIO_USER_ID?.trim() || "default";
  const composio = createComposio({ apiKey: process.env.COMPOSIO_API_KEY?.trim(), userId });
  const ga = createGa(composio.execute, process.env.GA4_PROPERTY_ID?.trim() || undefined);
  await createServer(ga, () => gaLinkStatus(composio.request, userId)).connect(new StdioServerTransport());
}

const isEntryPoint = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntryPoint) await main();
