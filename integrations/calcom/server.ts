import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderCustom, markHtml, esc, clip } from "./widgetKit.ts";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared disclosure helpers live here because Studio regenerates widgetKit.ts.

/** Shared native disclosure: opening details never performs a booking action. */
export function detailRow(summary: string, pairs: [string, unknown][], link: { url: string; label: string }, className = "cal-rw"): string {
  const fields = pairs.filter(([, value]) => value !== undefined && value !== null && value !== "").map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  return `<details class="cal-detail"><summary class="${esc(className)}">${summary}<span class="cal-chevron" aria-hidden="true">›</span></summary><div class="cal-detail-body"><dl>${fields}</dl><a class="cal-btn" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)} ↗</a></div></details>`;
}

export function eventTypeLink(id: unknown): { url: string; label: string } {
  const value = String(id ?? "");
  return { url: /^\d+$/.test(value) && Number(value) > 0 ? `https://app.cal.com/event-types/${encodeURIComponent(value)}` : "https://app.cal.com/event-types", label: "Open in Cal.com" };
}

// Open the authenticated bookings page; do not invent a public meeting URL from a UID.
export const bookingsLink = { url: "https://app.cal.com/bookings", label: "Open Cal.com bookings" };

export const DETAIL_CSS = `
.cal-detail+.cal-detail{border-top:1px solid var(--line)}
.cal-detail summary{list-style:none;cursor:pointer;position:relative}
.cal-detail summary::-webkit-details-marker{display:none}
.cal-detail summary:hover{background:var(--fill-1)}
.cal-detail summary:active{background:var(--fill-2)}
.cal-detail summary:focus-visible,.cal-detail a:focus-visible{outline:2px solid var(--ink-1);outline-offset:-3px;border-radius:6px}
.cal-chevron{font-size:20px;color:var(--ink-3);margin-left:auto;flex:none;line-height:1}
.cal-detail[open] .cal-chevron{transform:rotate(90deg)}
.cal-detail-body{padding:4px 14px 14px;background:var(--fill-1);overflow-wrap:anywhere}
.cal-detail-body dl{margin:0;font-size:12px;line-height:1.5}
.cal-detail-body dl>div{padding-top:8px;display:grid;grid-template-columns:68px minmax(0,1fr);gap:8px}
.cal-detail-body dt{color:var(--ink-3);font-size:11px}
.cal-detail-body dd{margin:0;color:var(--ink-1);white-space:pre-wrap;user-select:text}
.cal-detail-body a{cursor:pointer;max-width:100%;height:auto;min-height:28px;padding:5px 10px;white-space:normal}
.cal-detail-body a:hover{background:var(--fill-3,var(--fill-2));text-decoration:underline}
.cal-detail-body a:active{opacity:.8}
.cal-detail-scroll{max-height:330px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin!important;scrollbar-color:var(--ink-4) transparent}
.cal-detail-scroll::-webkit-scrollbar{display:block!important;width:5px}
.cal-detail-scroll::-webkit-scrollbar-thumb{background:var(--ink-4);border-radius:5px}
.cal-detail-scroll::-webkit-scrollbar-track{background:transparent}
`;

export function detailTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

const server = new McpServer({ name: "calcom-composio", version: "1.0.0" });
const ACCENT = "#292929";

// --- Icons ---
const I = (d: string, s = 14) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICON = {
  calendar: I('<rect x="2" y="3.2" width="12" height="10.6" rx="1.6"/><path d="M2 6.4h12M5.4 1.8v2.4M10.6 1.8v2.4"/>', 18),
  clock: I('<circle cx="8" cy="8" r="6.1"/><path d="M8 4.6V8l2.4 1.6"/>'),
  clockLg: I('<circle cx="8" cy="8" r="6.1"/><path d="M8 4.6V8l2.4 1.6"/>', 18),
  video: I('<path d="M10.5 5.5l3.5-2.2v9.4l-3.5-2.2z"/><rect x="2" y="4" width="8.5" height="8" rx="1.5"/>'),
  user: I('<circle cx="8" cy="5.6" r="2.7"/><path d="M2.8 13.6a5.2 5.2 0 0 1 10.4 0"/>'),
  check: I('<path d="m3.5 8.4 2.9 2.8L12.5 5"/>', 12),
  x: I('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', 12),
  alert: I('<path d="M8 2.4 1.9 13.2h12.2z"/><path d="M8 6.2v3.1M8 11.2h.01"/>'),
  alertLg: I('<path d="M8 2.4 1.9 13.2h12.2z"/><path d="M8 6.2v3.1M8 11.2h.01"/>', 16),
  plug: I('<path d="M6 1.8v3M10 1.8v3M4 4.8h8v2.6a4 4 0 0 1-8 0zM8 11.4v2.8"/>', 16),
  move: I('<path d="M8 3v10M4.5 9.5 8 13l3.5-3.5"/>', 12),
  quote: I('<path d="M3 4.5h10M3 8h7M3 11.5h5"/>'),
  link: I('<path d="M6.6 9.4a2.9 2.9 0 0 1 0-4.1l1.6-1.6a2.9 2.9 0 0 1 4.1 4.1l-.8.8"/><path d="M9.4 6.6a2.9 2.9 0 0 1 0 4.1l-1.6 1.6a2.9 2.9 0 0 1-4.1-4.1l.8-.8"/>'),
  linkLg: I('<path d="M6.6 9.4a2.9 2.9 0 0 1 0-4.1l1.6-1.6a2.9 2.9 0 0 1 4.1 4.1l-.8.8"/><path d="M9.4 6.6a2.9 2.9 0 0 1 0 4.1l-1.6 1.6a2.9 2.9 0 0 1-4.1-4.1l.8-.8"/>', 18),
  external: I('<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>', 12),
};

// --- Shared stylesheet for every Cal.com result card ---
// One header, one row, one tile, one chip: every card is built from the same
// five parts so the set reads as a single product in the notch.
const CARD_CSS = `
html{--warn:#ffb340}
html[data-k-theme=light]{--warn:#b25f00}
.cal{font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,Roboto,sans-serif;color:var(--ink-1);padding-bottom:6px;font-variant-numeric:tabular-nums}
.cal-bar{display:flex;align-items:center;gap:8px;height:42px;padding:0 14px 0 13px}
.cal-bar b{font-size:13px;font-weight:620;letter-spacing:-.01em;white-space:nowrap}
.cal-bar em{font-style:normal;font-size:12px;color:var(--ink-3);white-space:nowrap}
.cal-end{margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0}
.cal-meta{font-size:11.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;background:var(--fill-2);color:var(--ink-2)}
.cal-chip svg{flex:none}
.cal-chip.good{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)}
.cal-chip.bad{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}
.cal-chip.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.cal-list{border-top:1px solid var(--line)}
.cal-rw{display:flex;align-items:center;gap:12px;height:52px;padding:0 14px}
.cal-rw+.cal-rw{border-top:1px solid var(--line)}
.cal-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;width:36px;height:38px;border-radius:9px;background:var(--fill-2);flex:none;line-height:1}
.cal-tile small{font-size:9.5px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3)}
.cal-tile strong{font-size:16px;font-weight:650;margin-top:3px;letter-spacing:-.02em}
.cal-tile.lg{width:46px;height:50px;border-radius:11px}
.cal-tile.lg small{font-size:10px}
.cal-tile.lg strong{font-size:21px}
.cal-tile.dim{opacity:.55}
.cal-m{min-width:0;flex:1}
.cal-t{display:block;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-.005em}
.cal-s{display:block;font-size:12px;color:var(--ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-s i{font-style:normal;color:var(--ink-4);padding:0 4px}
.cal-x .cal-t{color:var(--ink-3);text-decoration:line-through;text-decoration-color:var(--ink-4)}
.cal-sc{overflow-y:auto;overscroll-behavior-y:auto;-webkit-mask-image:linear-gradient(#000 calc(100% - 36px),transparent);mask-image:linear-gradient(#000 calc(100% - 36px),transparent)}
.cal-sc.end{-webkit-mask-image:none;mask-image:none}
.cal-more{display:block;font-size:11.5px;color:var(--ink-3);padding:9px 14px 4px;border-top:1px solid var(--line)}
.cal-hero{display:flex;gap:13px;align-items:flex-start;padding:4px 14px 10px}
.cal-ht{font-size:15px;font-weight:650;letter-spacing:-.015em;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cal-hm{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.cal-hr{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-2);min-width:0}
.cal-hr svg{flex:none;color:var(--ink-3)}
.cal-hr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-hr s{color:var(--ink-3);text-decoration-color:var(--ink-4)}
.cal-move{margin:2px 14px 10px;border-radius:12px;background:var(--fill-1);border:1px solid var(--line);padding:9px 12px}
.cal-mv{display:flex;align-items:baseline;gap:10px;font-size:12.5px}
.cal-mv small{width:30px;flex:none;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-4)}
.cal-mv.old span{color:var(--ink-3);text-decoration:line-through;text-decoration-color:var(--ink-4)}
.cal-mv.new span{font-weight:650;font-size:13.5px}
.cal-mv+.cal-mv{margin-top:5px}
.cal-day{display:flex;align-items:baseline;justify-content:space-between;padding:8px 14px 6px;font-size:12px;font-weight:600;color:var(--ink-2)}
.cal-day span{font-weight:500;font-size:11.5px;color:var(--ink-4)}
.cal-slots{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:0 14px 6px}
.cal-slot{height:28px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--fill-1);border:1px solid var(--line);font-size:12px;font-weight:550;white-space:nowrap}
.cal-slot.more{color:var(--ink-3);background:transparent;border-style:dashed}
.cal-dur{display:flex;flex-direction:column;align-items:center;justify-content:center;width:36px;height:38px;border-radius:9px;background:var(--fill-2);flex:none;line-height:1}
.cal-dur strong{font-size:15px;font-weight:650;letter-spacing:-.02em}
.cal-dur small{font-size:9.5px;font-weight:600;color:var(--ink-3);margin-top:3px;text-transform:uppercase;letter-spacing:.04em}
.cal-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:10px 24px 14px}
.cal-ei{display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:var(--fill-1);color:var(--ink-3);margin-bottom:9px}
.cal-et{font-size:13px;font-weight:600;color:var(--ink-1)}
.cal-es{font-size:12px;color:var(--ink-3);margin-top:2px}
.cal-note{display:flex;gap:10px;margin:2px 14px 8px;padding:11px 12px;border-radius:12px;background:color-mix(in srgb,var(--tone) 10%,transparent);border:1px solid color-mix(in srgb,var(--tone) 22%,transparent)}
.cal-note.bad{--tone:var(--bad)}
.cal-note.warn{--tone:var(--warn)}
.cal-note>svg{flex:none;color:var(--tone);margin-top:1px}
.cal-note b{display:block;font-size:12.5px;font-weight:620;color:var(--ink-1)}
.cal-note p{font-size:12px;color:var(--ink-2);margin-top:2px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.cal-btn{display:inline-flex;align-items:center;gap:5px;margin-top:9px;height:26px;padding:0 10px;border-radius:999px;background:var(--fill-2);color:var(--ink-1);font-size:11.5px;font-weight:600;text-decoration:none}
@media(prefers-reduced-motion:no-preference){
  .cal-rw,.cal-hero,.cal-move,.cal-slots,.cal-note,.cal-empty{animation:cal-in .28s cubic-bezier(.22,.61,.36,1) both}
  .cal-rw:nth-child(2){animation-delay:.03s}
  .cal-rw:nth-child(3){animation-delay:.06s}
  .cal-rw:nth-child(n+4){animation-delay:.09s}
}
@keyframes cal-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
`;

// --- Composio HTTP Client (v3.1) ---
// Composio retired its v1/v2 APIs (HTTP 410). The Cal.com toolkit in Composio
// is slugged "cal" and its tools are CAL_*.
const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3.1";
const TOOLKIT = "cal";
const TIMEOUT_MS = 15000;

const log = (...a: unknown[]) => console.error("[calcom]", ...a);

/** Errors the user fixes in Composio (key, connection) rather than by retrying. */
class ComposioSetupError extends Error {}

/** Composio tools that change Cal.com (vs. read it). */
const WRITE_SLUGS = new Set(["CAL_POST_NEW_BOOKING_REQUEST", "CAL_CANCEL_BOOKING_VIA_UID", "CAL_RESCHEDULE_BOOKING_BY_UID"]);
const UNCERTAIN_WRITE =
  "Composio stopped responding partway through, so this may or may not have gone through. Check your Cal.com bookings before trying again.";

function normalizeBaseUrl(raw?: string): string {
  const v = (raw || "").trim().replace(/\/+$/, "");
  // Saved settings from older versions point at the retired v1/v2 APIs.
  if (!v || /\/api\/v[12]$/.test(v)) return DEFAULT_BASE_URL;
  return v;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

/** Peel Composio / Cal.com v2 envelopes ({ data }, { status, data }, { response_data }) down to the payload. */
function unwrap(d: any): any {
  let x = d;
  for (let i = 0; i < 4; i++) {
    if (!x || typeof x !== "object" || Array.isArray(x)) break;
    if ("response_data" in x) { x = x.response_data; continue; }
    if ("data" in x && (("status" in x) || Object.keys(x).length <= 2)) { x = x.data; continue; }
    break;
  }
  return x;
}

function errorText(body: any, fallback: string, depth = 0): string {
  // Cal.com errors often arrive as a JSON string inside Composio's error field.
  if (typeof body === "string" && /^\s*\{/.test(body) && depth < 3) {
    try { return errorText(JSON.parse(body), fallback, depth + 1); } catch { /* fall through */ }
  }
  const e = body?.error ?? body?.message ?? body;
  if (e !== body && depth < 3 && (typeof e === "object" || /^\s*\{/.test(String(e)))) return errorText(e, fallback, depth + 1);
  if (typeof e === "string") return /^\s*</.test(e) ? fallback : clip(humanizeCode(e), 300);
  if (e && typeof e === "object") return e.message || e.error || JSON.stringify(e);
  return fallback;
}

/** Cal.com answers some failures with snake_case codes; say them in words. */
function humanizeCode(msg: string): string {
  const known: Record<string, string> = {
    email_domain_cannot_receive_emails: "That attendee's email domain can't receive email. Use a real address.",
    no_available_users_found_error: "That time isn't available. Pick an open slot from your availability.",
  };
  const code = msg.trim();
  if (known[code]) return known[code];
  return /^[a-z]+(_[a-z]+)+$/.test(code) ? code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + "." : msg;
}

class ComposioClient {
  private baseUrl: string;
  private accountId?: string;
  /** Composio user the Cal.com account was connected under (setting, or looked up). */
  private userId?: string;

  constructor(private apiKey: string, baseUrl?: string, connectedAccountId?: string, userId?: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.accountId = connectedAccountId?.trim() || undefined;
    this.userId = userId?.trim() || undefined;
  }

  /**
   * `write` marks calls that change Cal.com. If one of those times out or hits
   * a 5xx, Cal.com may already have acted — so never say "try again" there.
   */
  private async request(path: string, init: { method: string; body?: unknown; write?: boolean }): Promise<any> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e: any) {
      log(`${init.method} ${path} network error after ${Date.now() - started}ms:`, e?.message);
      if (e?.name === "TimeoutError") throw new Error(init.write ? UNCERTAIN_WRITE : "Composio did not respond in time. Try again.");
      throw new Error(`Could not reach Composio: ${e?.message || e}`);
    }
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    log(`${init.method} ${path} -> ${res.status} (${Date.now() - started}ms)`);
    if (res.ok) return body;

    const msg = errorText(body, `HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new ComposioSetupError(`Composio rejected the API key: ${msg}. Check COMPOSIO_API_KEY in the integration settings.`);
    }
    if (res.status === 410) {
      throw new ComposioSetupError(`This Composio API version is retired (${msg}). Clear the "Composio API Base URL" setting to use ${DEFAULT_BASE_URL}.`);
    }
    if (res.status === 404 && path.startsWith("/connected_accounts/")) {
      throw new ComposioSetupError(
        `Composio has no connected account "${decodeURIComponent(path.split("/")[2].split("?")[0])}". ` +
        "Clear the \"Connected Account ID\" setting to auto-detect it, or copy the right ID from platform.composio.dev (Connected Accounts).",
      );
    }
    if (res.status === 429) throw new Error("Composio is rate-limiting requests right now. Wait a minute and try again.");
    if (res.status >= 500) throw new Error(init.write ? `${UNCERTAIN_WRITE} (HTTP ${res.status})` : `Composio is having trouble right now (HTTP ${res.status}). Try again shortly.`);
    throw new Error(`Composio error ${res.status}: ${msg}`);
  }

  /**
   * Composio v3.1 requires the connection's user_id alongside connected_account_id
   * ("User ID is required with connected account"), so resolve both together.
   */
  async getAccount(): Promise<{ connected_account_id: string; user_id: string }> {
    if (this.accountId && this.userId) return { connected_account_id: this.accountId, user_id: this.userId };

    if (!this.accountId) {
      const active = await this.request(`/connected_accounts?toolkit_slugs=${TOOLKIT}&statuses=ACTIVE&limit=5`, { method: "GET" });
      const item = active?.items?.[0];
      if (!item?.id) return this.explainMissingAccount();
      this.accountId = item.id;
      this.userId ||= item.user_id || "";
    }

    // Composio is phasing user_id out of the list response; the single-account endpoint is the next source.
    if (!this.userId) {
      const acct = await this.request(`/connected_accounts/${encodeURIComponent(this.accountId!)}`, { method: "GET" });
      this.userId = acct?.user_id || acct?.userId || "";
    }
    if (!this.userId) {
      throw new ComposioSetupError(
        "Composio needs the user ID your Cal.com account was connected under, and didn't return one. " +
        "Find it on the Cal connection in platform.composio.dev (Connected Accounts → User ID) and put it in the integration's \"Composio User ID\" setting.",
      );
    }
    log(`using connected account ${this.accountId} (user ${this.userId})`);
    return { connected_account_id: this.accountId!, user_id: this.userId };
  }

  /** Nothing active: say why, so the user knows what to fix. */
  private async explainMissingAccount(): Promise<never> {
    const any = await this.request(`/connected_accounts?toolkit_slugs=${TOOLKIT}&limit=5`, { method: "GET" });
    const other = any?.items?.[0];
    if (other) {
      throw new ComposioSetupError(`Your Cal.com connection in Composio is ${other.status}${other.status_reason ? ` (${other.status_reason})` : ""}. Reconnect Cal.com at platform.composio.dev.`);
    }
    throw new ComposioSetupError("No Cal.com account is connected in Composio. Connect the Cal toolkit at platform.composio.dev, then try again.");
  }

  /** Run a Composio CAL_* tool and return its unwrapped payload. Throws on any failure. */
  async run(slug: string, args: Record<string, unknown>): Promise<any> {
    const account = await this.getAccount();
    const r = await this.request(`/tools/execute/${slug}`, {
      method: "POST",
      body: { ...stripUndefined(account), arguments: stripUndefined(args) },
      write: WRITE_SLUGS.has(slug),
    });
    if (r?.successful === false || r?.error) {
      log(`${slug} failed; log_id=${r?.log_id ?? "?"}`);
      const detail = errorText(r?.error, "unknown error");
      if (looksLikeAuthFailure(detail)) throw reconnectError(detail);
      throw new Error(`Cal.com refused ${slug}: ${detail}`);
    }
    return unwrap(r?.data);
  }

  /** Call the Cal.com API directly through Composio's proxy, for actions with no CAL_* tool. */
  async proxy(method: string, endpoint: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
    // Same rule as run(): Composio wants user_id alongside connected_account_id.
    const { connected_account_id, user_id } = await this.getAccount();
    const r = await this.request(`/tools/execute/proxy`, {
      method: "POST",
      write: method.toUpperCase() !== "GET",
      body: {
        connected_account_id,
        user_id,
        endpoint,
        method,
        body: body ?? null,
        parameters: Object.entries(headers).map(([name, value]) => ({ name, value, type: "header" })),
      },
    });
    const status = Number(r?.status ?? 200);
    if (status >= 400) {
      const detail = errorText(r?.data, "request failed");
      if (status === 401 || status === 403 || looksLikeAuthFailure(detail)) throw reconnectError(detail);
      throw new Error(`Cal.com error ${status}: ${detail}`);
    }
    return unwrap(r?.data);
  }
}

/** Cal.com's OAuth token behind the Composio connection expired or was revoked. */
function looksLikeAuthFailure(text: string): boolean {
  return /invalid_grant|token (has )?(expired|revoked)|expired token|revoked|unauthori[sz]ed|re-?auth|reconnect|\b401\b|connection (is )?(expired|inactive)/i.test(text);
}

function reconnectError(detail: string): ComposioSetupError {
  return new ComposioSetupError(
    `Cal.com no longer accepts the saved login — the connection expired or was revoked (${clip(detail, 120)}). Reconnect Cal.com at platform.composio.dev, then try again.`,
  );
}

/** Cal.com answered, but not in a shape this integration understands — never shown as "nothing found". */
class UnexpectedShapeError extends Error {
  constructor(what: string) { super(`Cal.com returned ${what} in an unexpected format, so it couldn't be read. Try again; if it keeps happening the integration needs an update.`); }
}

let cachedClient: ComposioClient | undefined;

/** One client per server process, so the connected-account lookup happens once, not on every call. */
function getComposio(): ComposioClient {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new ComposioSetupError("Missing COMPOSIO_API_KEY. Add your Composio API key in the integration settings.");
  }
  cachedClient ??= new ComposioClient(
    apiKey,
    process.env.COMPOSIO_BASE_URL,
    process.env.CALCOM_CONNECTED_ACCOUNT_ID,
    process.env.COMPOSIO_USER_ID,
  );
  return cachedClient;
}

// --- Cal.com helpers ---
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** YYYY-MM-DD plus or minus whole days. */
function shiftDay(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function toIsoOrThrow(value: string, field: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new Error(`${field} must be an ISO 8601 date-time like 2026-11-12T15:30:00-06:00 (got "${value}").`);
  }
  return d.toISOString();
}

/** The list inside a Cal.com payload, or null when the payload isn't a recognisable list. */
function findArray(x: any, ...keys: string[]): any[] | null {
  if (Array.isArray(x)) return x;
  for (const k of keys) if (Array.isArray(x?.[k])) return x[k];
  return null;
}

function asArray(x: any, what: string, ...keys: string[]): any[] {
  const list = findArray(x, ...keys);
  if (!list) throw new UnexpectedShapeError(what);
  return list;
}

function prettyLocation(loc: unknown): string {
  if (typeof loc !== "string" || !loc) return "";
  if (loc.startsWith("integrations:")) {
    const app = loc.slice("integrations:".length);
    if (app === "daily") return "Cal Video";
    return app.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  try {
    const host = new URL(loc).hostname.replace(/^www\./, "");
    if (host === "app.cal.com" || host === "cal.com" || host.endsWith(".cal.video")) return "Cal Video";
    if (host.endsWith("zoom.us")) return "Zoom";
    if (host === "meet.google.com") return "Google Meet";
    if (host.endsWith("teams.microsoft.com")) return "Microsoft Teams";
    return host;
  } catch { return clip(loc, 40); }
}

interface EventTypeLite { id: number; title: string; slug: string; length: number; description: string; hidden: boolean }

async function listEventTypes(c: ComposioClient, username?: string): Promise<EventTypeLite[]> {
  const map = (list: any[]): EventTypeLite[] =>
    list.map((e: any) => ({
      id: Number(e.id),
      title: e.title || "Untitled",
      slug: e.slug || "",
      length: Number(e.lengthInMinutes ?? e.length ?? 30),
      description: e.description || "",
      hidden: !!e.hidden,
    }));

  // Cal.com answers either with a flat list or grouped by profile/team:
  // { eventTypeGroups: [{ teamId, eventTypes: [...] }, ...] }.
  const extract = (x: any): any[] | null =>
    findArray(x, "eventTypes", "event_types", "items") ??
    (Array.isArray(x?.eventTypeGroups) ? x.eventTypeGroups.flatMap((g: any) => (Array.isArray(g?.eventTypes) ? g.eventTypes : [])) : null);
  let raw = extract(await c.run("CAL_LIST_EVENT_TYPES", stripUndefined({ username })));
  if ((!raw || raw.length === 0) && !username) {
    // Some accounts only return event types when asked by username.
    const me = unwrap(await c.run("CAL_RETRIEVE_MY_INFORMATION", {}));
    if (me?.username) raw = extract(await c.run("CAL_LIST_EVENT_TYPES", { username: me.username })) ?? raw;
  }
  if (!raw) throw new UnexpectedShapeError("your event types");
  return map(raw);
}

/** Turn an id, a slug, or nothing (pick by duration, else first) into a numeric event type. */
async function resolveEventType(c: ComposioClient, ref?: string, duration?: number, username?: string): Promise<EventTypeLite> {
  const asNum = ref && /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : undefined;
  const list = await listEventTypes(c, username);
  if (asNum !== undefined) {
    return list.find((e) => e.id === asNum) ?? { id: asNum, title: "Event", slug: "", length: duration ?? 30, description: "", hidden: false };
  }
  if (list.length === 0) throw new Error("This Cal.com account has no event types. Create one first (create_event_type).");
  if (ref) {
    const hit = list.find((e) => e.slug === ref.trim() || e.title.toLowerCase() === ref.trim().toLowerCase());
    if (!hit) throw new Error(`No Cal.com event type matches "${ref}". Available: ${list.map((e) => e.slug).join(", ")}.`);
    return hit;
  }
  const visible = list.filter((e) => !e.hidden);
  const pool = visible.length ? visible : list;
  if (duration !== undefined) {
    // An explicit length must match a real booking link; never silently book a different length.
    const exact = pool.find((e) => e.length === duration);
    if (exact) return exact;
    const lengths = [...new Set(pool.map((e) => e.length))].sort((x, y) => x - y).join(", ");
    throw new Error(`No booking link is ${duration} minutes long. Available lengths: ${lengths} min. Pick one of those, or create a ${duration}-minute booking link first.`);
  }
  return pool.find((e) => e.length === 30) ?? pool[0];
}

// --- Date & Formatting Helpers ---
interface CalDate { valid: boolean; weekday: string; day: string; month: string; time: string; date: string; full: string; key: string }

function parseCalDate(str?: string): CalDate {
  const d = str ? new Date(str) : new Date(NaN);
  if (isNaN(d.getTime())) {
    const raw = str ? clip(str, 24) : "Unscheduled";
    return { valid: false, weekday: "", day: "–", month: "", time: raw, date: raw, full: raw, key: "" };
  }
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const day = String(d.getDate());
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const key = d.toLocaleDateString("en-CA");
  const date = relativeDay(key) ?? `${weekday}, ${month} ${day}`;
  return { valid: true, weekday, day, month, time, date, full: `${date} · ${time}`, key };
}

/** "Today" / "Tomorrow" for the two days a glance most often asks about. */
function relativeDay(key: string): string | undefined {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (key === today.toLocaleDateString("en-CA")) return "Today";
  if (key === tomorrow.toLocaleDateString("en-CA")) return "Tomorrow";
  return undefined;
}

/** YYYY-MM-DD (a date-only string) → "Thu, Nov 12", without the UTC-midnight off-by-one. */
function prettyDay(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd || "";
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return relativeDay(ymd) ?? dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Date(d.getTime() + minutes * 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Cal.com's raw booking status → the word and tone a person expects. */
function statusInfo(raw?: string): { label: string; tone: "good" | "bad" | "warn" | "" } {
  const s = String(raw || "accepted").toLowerCase();
  if (s.includes("reschedul")) return { label: "Moved", tone: "" };
  if (s.includes("cancel")) return { label: "Cancelled", tone: "bad" };
  if (s.includes("reject")) return { label: "Declined", tone: "bad" };
  if (s.includes("pending") || s.includes("await") || s.includes("unconfirmed")) return { label: "Pending", tone: "warn" };
  if (s.includes("accept") || s.includes("confirm") || s === "upcoming") return { label: "Confirmed", tone: "good" };
  return { label: raw ? clip(raw, 14) : "Confirmed", tone: "" };
}

// --- Card parts ---
const LINE_H = 18; // body text line
const TITLE_H = 20; // 15px hero title line

function header(title: string, end = "", sub = ""): string {
  return `<div class="cal-bar">${markHtml()}<b>${esc(title)}</b>${sub ? `<em>${esc(sub)}</em>` : ""}${end ? `<div class="cal-end">${end}</div>` : ""}</div>`;
}
const chip = (label: string, tone = "", icon = "") => `<span class="cal-chip ${tone}">${icon}${esc(label)}</span>`;
const meta = (text: string) => `<span class="cal-meta">${esc(text)}</span>`;

function dateTile(dt: CalDate, o: { lg?: boolean; dim?: boolean } = {}): string {
  const cls = ["cal-tile", o.lg ? "lg" : "", o.dim ? "dim" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}"><small>${esc(dt.valid ? dt.month : "")}</small><strong>${esc(dt.day)}</strong></div>`;
}

function emptyState(icon: string, title: string, hint: string): string {
  return `<div class="cal-empty"><div class="cal-ei">${icon}</div><div class="cal-et">${esc(title)}</div><div class="cal-es">${esc(hint)}</div></div>`;
}
const EMPTY_H = 42 + 114;

/** 15px hero title: clamp at 2 lines; ~36 chars fit one line beside a large tile. */
const heroTitleH = (t: string) => (t.length > 36 ? 2 : 1) * TITLE_H;

function card(body: string, height: number) {
  return renderCustom({ accent: ACCENT, css: CARD_CSS + DETAIL_CSS, body: `<div class="cal${body.includes('class="cal-detail"') ? ' cal-detail-scroll' : ''}">${body}</div>${SCROLL_JS}`, height });
}

/**
 * A list that scrolls inside the card once it outgrows `maxH`. The kit hides
 * scrollbars, so the bottom edge fades out until the user reaches the end —
 * that fade is the only "there's more" cue. `maxH` should land mid-row so a
 * cut-off row also hints at scrolling.
 */
function scroller(inner: string, contentH: number, maxH: number): { html: string; h: number } {
  if (contentH <= maxH) return { html: `<div class="cal-list">${inner}</div>`, h: 1 + contentH };
  return { html: `<div class="cal-list cal-sc" style="max-height:${maxH}px">${inner}</div>`, h: 1 + maxH };
}

/** Drops the fade once a list is scrolled to its end. */
const SCROLL_JS = `<script>(function(){var l=document.querySelectorAll('.cal-sc');for(var i=0;i<l.length;i++){(function(el){var u=function(){el.classList.toggle('end',el.scrollTop+el.clientHeight>=el.scrollHeight-2)};el.addEventListener('scroll',u,{passive:true});u()})(l[i])}})();</script>`;
const ROW_H = 53; // .cal-rw 52px + 1px divider

// --- Card Authoring Functions ---

/** Strip the internal tool slug from errors before a person reads them; the model still gets the full text. */
function humanError(message: string): string {
  return message
    .replace(/^Cal\.com refused CAL_[A-Z0-9_]+:\s*/, "")
    .replace(/^(Composio|Cal\.com) error \d+:\s*/, "");
}

/** The one thing the user has to go and fix, as the card's heading. */
function setupTitle(message: string): string {
  if (/API key/i.test(message)) return /Missing/i.test(message) ? "Add your Composio API key" : "Check your Composio API key";
  if (/user ID/i.test(message)) return "Composio User ID needed";
  if (/Connected Account ID/.test(message)) return "Check the Connected Account ID";
  if (/API version is retired/i.test(message)) return "Update the Composio API URL";
  if (/No Cal\.com account is connected/i.test(message)) return "Connect Cal.com in Composio";
  return "Reconnect Cal.com";
}

/** `setup` = the user must fix their Composio key/connection (shows the dashboard link); otherwise a plain failure. */
function renderAuthErrorCard(message: string, setup = true) {
  const text = clip(humanError(message), 280);
  const lines = Math.min(6, Math.ceil(text.length / 46));
  const body = `
    ${header("Cal.com", setup ? chip("Setup needed", "warn") : chip("Failed", "bad", ICON.x))}
    <div class="cal-note ${setup ? "warn" : "bad"}">
      ${setup ? ICON.plug : ICON.alertLg}
      <div>
        <b>${setup ? setupTitle(message) : "Couldn't complete that"}</b>
        <p>${esc(text)}</p>
        ${setup ? `<a class="cal-btn" href="https://platform.composio.dev" target="_blank">Open Composio ${ICON.external}</a>` : ""}
      </div>
    </div>`;
  return card(body, 42 + 2 + 24 + 18 + 2 + lines * 17 + (setup ? 35 : 0) + 8 + 6);
}

function renderBookingsCard(bookings: any[], status = "upcoming") {
  const noun = status === "upcoming" ? "Upcoming" : status === "past" ? "Past meetings" : "Cancelled";
  if (!bookings || bookings.length === 0) {
    const body = `${header(noun)}${emptyState(ICON.calendar, `No ${status} bookings`, status === "upcoming" ? "Your calendar is open" : "Nothing to show here")}`;
    return card(body, EMPTY_H);
  }

  const bookingDetails = (b: any): [string, unknown][] => [
    ["Meeting", b.title || b.description || "Meeting"],
    ["Starts", detailTime(b.startTime || b.start)], ["Ends", detailTime(b.endTime || b.end)],
    ["Attendee", b.attendees?.[0]?.name || b.attendeeName || b.name],
    ["Email", b.attendees?.[0]?.email || b.attendeeEmail || b.email],
    ["Location", b.location || b.videoPlatform], ["Status", statusInfo(b.status).label],
  ];

  // One booking: the hero, with everything a person needs to act on it.
  if (bookings.length === 1) {
    const b = bookings[0];
    const dt = parseCalDate(b.startTime || b.start);
    const end = b.endTime ? ` – ${parseCalDate(b.endTime).time}` : "";
    const attendee = b.attendees?.[0]?.name || b.attendeeName || b.name || "Attendee";
    const email = b.attendees?.[0]?.email || b.attendeeEmail || b.email || "";
    const loc = b.location || b.videoPlatform || "";
    const st = statusInfo(b.status);
    const title = clip(b.title || "Meeting", 80);
    const metaRows = 2 + (loc ? 1 : 0);
    const body = `
      ${header(noun, chip(st.label, st.tone))}
      ${detailRow(`
        ${dateTile(dt, { lg: true })}
        <div class="cal-m">
          <div class="cal-ht">${esc(title)}</div>
          <div class="cal-hm">
            <div class="cal-hr">${ICON.clock}<span>${esc(dt.date)} · ${esc(dt.time)}${esc(end)}</span></div>
            <div class="cal-hr">${ICON.user}<span>${esc(attendee)}${email && email !== attendee ? ` <i style="font-style:normal;color:var(--ink-3)">· ${esc(clip(email, 30))}</i>` : ""}</span></div>
            ${loc ? `<div class="cal-hr">${ICON.video}<span>${esc(loc)}</span></div>` : ""}
          </div>
        </div>`, bookingDetails(b), bookingsLink, "cal-hero")}`;
    return card(body, 42 + 4 + Math.max(50, heroTitleH(title) + 6 + metaRows * 17 + (metaRows - 1) * 4) + 10 + 6);
  }

  // Several: one row each, status only where it isn't the default. Past 5 the list scrolls.
  const rows = bookings.map((b) => {
    const dt = parseCalDate(b.startTime || b.start);
    const attendee = b.attendees?.[0]?.name || b.attendeeName || b.name || "";
    const st = statusInfo(b.status);
    const quiet = st.label === "Confirmed";
    return `
      ${detailRow(`
        ${dateTile(dt, { dim: st.tone === "bad" })}
        <div class="cal-m">
          <span class="cal-t">${esc(clip(b.title || b.description || "Meeting", 60))}</span>
          <span class="cal-s">${esc(dt.valid ? `${dt.weekday} ${dt.time}` : dt.time)}${attendee ? `<i>·</i>${esc(clip(attendee, 28))}` : ""}</span>
        </div>
        ${quiet ? "" : chip(st.label, st.tone)}`, bookingDetails(b), bookingsLink, `cal-rw${st.tone === "bad" ? " cal-x" : ""}`)}`;
  }).join("");
  const list = { html: `<div class="cal-list">${rows}</div>`, h: Math.min(bookings.length * ROW_H, 5.5 * ROW_H) };
  const body = `
    ${header(noun, meta(`${bookings.length} meeting${bookings.length === 1 ? "" : "s"}`))}
    ${list.html}`;
  return card(body, 42 + list.h + 6);
}

function renderCreateBookingCard(booking: any) {
  const dt = parseCalDate(booking.startTime || booking.start);
  const mins = Number(booking.duration || 30);
  const endTime = addMinutes(booking.startTime || booking.start, mins);
  const attendee = booking.attendees?.[0]?.name || booking.name || "Attendee";
  const email = booking.attendees?.[0]?.email || booking.email || "";
  const title = clip(booking.title || "Meeting", 80);
  const body = `
    ${header("Booked", chip("Confirmed", "good", ICON.check))}
    <div class="cal-hero">
      ${dateTile(dt, { lg: true })}
      <div class="cal-m">
        <div class="cal-ht">${esc(title)}</div>
        <div class="cal-hm">
          <div class="cal-hr">${ICON.clock}<span>${esc(dt.date)} · ${esc(dt.time)}${endTime ? ` – ${esc(endTime)}` : ""} <i style="font-style:normal;color:var(--ink-3)">(${mins} min)</i></span></div>
          <div class="cal-hr">${ICON.user}<span>${esc(attendee)}${email ? ` <i style="font-style:normal;color:var(--ink-3)">· ${esc(clip(email, 30))}</i>` : ""}</span></div>
        </div>
      </div>
    </div>`;
  return card(body, 42 + 4 + Math.max(50, heroTitleH(title) + 6 + 2 * 17 + 4) + 10 + 6);
}

function renderCancelBookingCard(details: any) {
  const title = clip(details.title || "Meeting", 80);
  const dt = parseCalDate(details.startTime);
  const rows = (details.startTime ? 1 : 0) + (details.reason ? 1 : 0);
  const body = `
    ${header("Cancelled", chip("Cancelled", "bad", ICON.x))}
    <div class="cal-hero">
      ${dateTile(dt, { lg: true, dim: true })}
      <div class="cal-m">
        <div class="cal-ht">${esc(title)}</div>
        ${rows ? `<div class="cal-hm">
          ${details.startTime ? `<div class="cal-hr">${ICON.clock}<span><s>${esc(dt.full)}</s></span></div>` : ""}
          ${details.reason ? `<div class="cal-hr">${ICON.quote}<span>${esc(clip(details.reason, 60))}</span></div>` : ""}
        </div>` : ""}
      </div>
    </div>`;
  return card(body, 42 + 4 + Math.max(50, heroTitleH(title) + (rows ? 6 + rows * 17 + (rows - 1) * 4 : 0)) + 10 + 6);
}

function renderRescheduleCard(details: any) {
  const title = clip(details.title || "Meeting", 70);
  const hasOld = !!details.currentStartTime;
  const oldDt = parseCalDate(details.currentStartTime);
  const newDt = parseCalDate(details.newStartTime);
  const body = `
    ${header("Rescheduled", chip("Moved", "good", ICON.check))}
    <div style="padding:0 14px 8px"><span class="cal-t" style="font-size:14px">${esc(title)}</span></div>
    <div class="cal-move">
      ${hasOld ? `<div class="cal-mv old"><small>Was</small><span>${esc(oldDt.full)}</span></div>` : ""}
      <div class="cal-mv new"><small>${hasOld ? "Now" : "New"}</small><span>${esc(newDt.full)}</span></div>
    </div>`;
  return card(body, 42 + 26 + 2 + 20 + (hasOld ? 23 : 0) + 20 + 10 + 6);
}

function renderEventTypesCard(eventTypes: any[], total = eventTypes?.length ?? 0) {
  if (!eventTypes || eventTypes.length === 0) {
    const body = `${header("Booking links")}${emptyState(ICON.linkLg, "No booking links yet", "Ask me to create one, like a 30-minute call")}`;
    return card(body, EMPTY_H);
  }
  const rows = eventTypes.map((e) => {
    const len = Number(e.length || e.lengthInMinutes || 30);
    const dur = len >= 60 && len % 60 === 0 ? { n: String(len / 60), u: len === 60 ? "hr" : "hrs" } : { n: String(len), u: "min" };
    return `
    ${detailRow(`
      <div class="cal-dur"><strong>${esc(dur.n)}</strong><small>${dur.u}</small></div>
      <div class="cal-m">
        <span class="cal-t">${esc(clip(e.title || "Untitled", 60))}</span>
        <span class="cal-s">/${esc(clip(e.slug || "link", 40))}</span>
      </div>
      ${e.hidden ? chip("Hidden") : ""}`, [["Title", e.title || "Untitled"], ["Duration", `${len} minutes`], ["Slug", e.slug], ["Description", e.description], ["Visibility", e.hidden ? "Hidden" : "Public"], ["Cal.com", eventTypeLink(e.id).url]], eventTypeLink(e.id))}`;
  }).join("");
  // Only reached when the tool was asked for fewer links than exist.
  const more = Math.max(total, eventTypes.length) - eventTypes.length;
  const list = { html: `<div class="cal-list">${rows}${more > 0 ? `<span class="cal-more">+${more} more not loaded</span>` : ""}</div>`, h: Math.min(eventTypes.length * ROW_H + (more > 0 ? 29 : 0), 5.5 * ROW_H) };
  const body = `
    ${header("Booking links", meta(`${Math.max(total, eventTypes.length)} total`))}
    ${list.html}`;
  return card(body, 42 + list.h + 6);
}

function renderAvailabilityCard(slots: any[], dateFrom?: string, dateTo?: string, eventType?: { title?: string; length?: number }) {
  // Which link the slots are for: lengths differ, so "9:00 open" means nothing without it.
  const forWhat = eventType?.length ? `${eventType.length} min` : "";
  const range = dateFrom ? `${prettyDay(dateFrom)}${dateTo && dateTo !== dateFrom ? ` – ${prettyDay(dateTo)}` : ""}` : "";
  if (!slots || slots.length === 0) {
    const body = `${header("Availability", meta(range), forWhat)}${emptyState(ICON.clockLg, "No open times", `Nothing open on ${range || "those dates"}`)}`;
    return card(body, EMPTY_H);
  }

  // Group by day so the same "9:00 AM" on two dates can never be confused.
  const groups = new Map<string, string[]>();
  for (const s of slots) {
    const t = s?.time ?? s?.start ?? s;
    const dt = typeof t === "string" && t.includes("T") ? parseCalDate(t) : undefined;
    const key = dt?.valid ? dt.key : String(s?.date || dateFrom || "");
    const label = dt?.valid ? dt.time : String(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(label);
  }
  // Every day, every slot; past ~3 rows of chips the list scrolls.
  let contentH = 0;
  const sections = [...groups.entries()].map(([key, times]) => {
    const chips = times.map((t) => `<div class="cal-slot">${esc(t)}</div>`).join("");
    const rowsN = Math.ceil(times.length / 4);
    contentH += 32 + rowsN * 28 + (rowsN - 1) * 6 + 6;
    return `<div class="cal-day">${esc(prettyDay(key))}<span>${times.length} open</span></div><div class="cal-slots">${chips}</div>`;
  }).join("");
  const list = scroller(sections, contentH, 250);
  const body = `
    ${header("Availability", meta(`${slots.length} open${range ? ` · ${range}` : ""}`), forWhat)}
    ${list.html}`;
  return card(body, 42 + list.h + 6);
}

function renderCreateEventTypeCard(eventType: any) {
  const len = Number(eventType.length || 30);
  const title = clip(eventType.title || "Untitled", 80);
  const body = `
    ${header("Booking link", chip("Created", "good", ICON.check))}
    <div class="cal-hero">
      <div class="cal-dur" style="width:46px;height:50px;border-radius:11px"><strong style="font-size:19px">${len}</strong><small>min</small></div>
      <div class="cal-m">
        <div class="cal-ht">${esc(title)}</div>
        <div class="cal-hm">
          <div class="cal-hr">${ICON.link}<span>/${esc(clip(eventType.slug, 40))}</span></div>
          ${eventType.description ? `<div class="cal-hr">${ICON.quote}<span>${esc(clip(eventType.description, 60))}</span></div>` : ""}
        </div>
      </div>
    </div>`;
  const rows = 1 + (eventType.description ? 1 : 0);
  return card(body, 42 + 4 + Math.max(50, heroTitleH(title) + 6 + rows * 17 + (rows - 1) * 4) + 10 + 6);
}

// ============================================================================
// Tool Registrations
// ============================================================================

type Card = { html: string; height: number };
const glance = (card: Card) => ({ _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] } });

function ok(data: Record<string, unknown>, card: Card) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ...data, ...glance(card) }) }] };
}

/** Failures are real MCP errors (isError) so the model never mistakes them for success; the card explains them. */
function fail(tool: string, err: any) {
  const message = err?.message || String(err);
  log(`${tool} failed:`, message);
  // The user is about to fix a key or reconnect: look the account up afresh next time.
  if (err instanceof ComposioSetupError) cachedClient = undefined;
  const card = renderAuthErrorCard(message, err instanceof ComposioSetupError);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...glance(card) }) }] };
}

// 1. Get bookings (READ - No Confirmation)
server.registerTool(
  "get_bookings",
  {
    title: "Get bookings",
    description: "Retrieve upcoming scheduled Cal.com bookings and meetings for the authenticated user. Use when the user asks what meetings, calls, or appointments are scheduled; for my next meeting pass limit 1. Each booking's id is its Cal.com UID, used by cancel_booking and reschedule_booking.",
    inputSchema: {
      status: z.enum(["upcoming", "past", "cancelled"]).optional().describe("Booking status filter (default: 'upcoming')."),
      limit: z.number().min(1).max(10).optional().describe("Number of bookings to retrieve (default: 10, max 10)."),
      attendeeEmail: z.string().email().optional().describe("Optional attendee email filter."),
    } as any,
  },
  async (args: any) => {
    try {
      const c = getComposio();
      const status = args?.status ?? "upcoming";
      const limit = Math.min(Math.max(args?.limit ?? 10, 1), 10);

      const raw = await c.run("CAL_FETCH_ALL_BOOKINGS", {
        status: [status],
        take: limit,
        attendeeEmail: args?.attendeeEmail,
        sortStart: status === "past" ? "desc" : "asc",
      });

      const bookings = asArray(raw, "your bookings", "bookings", "items").slice(0, limit).map((b: any) => ({
        id: String(b.uid ?? b.id ?? ""),
        title: b.title || "Meeting",
        startTime: b.start || b.startTime || "",
        endTime: b.end || b.endTime || "",
        // Cal.com cancels the original slot of a moved meeting and links it to the new one.
        status: b.rescheduledToUid ? "rescheduled" : b.status || "accepted",
        attendeeName: b.attendees?.[0]?.name || "Attendee",
        attendeeEmail: b.attendees?.[0]?.email || "",
        location: prettyLocation(b.location || b.meetingUrl),
      }));

      return ok({ count: bookings.length, status, bookings }, renderBookingsCard(bookings, status));
    } catch (err) {
      return fail("get_bookings", err);
    }
  },
);

// 2. Create booking (ACTING - Has Confirmation)
server.registerTool(
  "create_booking",
  {
    title: "Create booking",
    description: "Schedule a new meeting on Cal.com for an attendee (name, email) at a start time. Use when the user requests to schedule or book a meeting. Cal.com names the booking after its event type; the title is added to the booking notes. Without eventTypeId, the event type whose length matches duration is used.",
    inputSchema: {
      title: z.string().min(1).describe("Meeting title or topic (added to the booking notes)."),
      start: z.string().min(1).describe("Start time as ISO 8601 with timezone (e.g. 2026-11-12T15:30:00-06:00)."),
      name: z.string().min(1).describe("Attendee full name."),
      email: z.string().email().describe("Attendee email address."),
      duration: z.number().optional().describe("Duration in minutes, used to pick the event type (default: 30)."),
      eventTypeId: z.string().optional().describe("Optional Cal.com event type ID or slug (from get_event_types)."),
      notes: z.string().optional().describe("Optional meeting notes."),
    } as any,
  },
  async (args: any) => {
    try {
      const c = getComposio();
      const start = toIsoOrThrow(args.start, "start");
      const et = await resolveEventType(c, args.eventTypeId, args.duration);
      const notes = [et.title.toLowerCase() === String(args.title).toLowerCase() ? "" : args.title, args.notes]
        .filter(Boolean).join(" — ");

      const raw = await c.run("CAL_POST_NEW_BOOKING_REQUEST", {
        start,
        eventTypeId: et.id,
        timeZone: LOCAL_TZ,
        language: "en",
        responses: stripUndefined({ name: args.name, email: args.email, notes: notes || undefined }),
      });
      const b = Array.isArray(raw) ? raw[0] : raw;
      if (!b || (!b.uid && !b.id)) throw new Error("Cal.com did not return the new booking.");

      const created = {
        id: String(b.uid ?? b.id),
        title: b.title || args.title,
        startTime: b.start || start,
        duration: Number(b.duration ?? et.length),
        eventType: et.slug || et.title,
        name: args.name,
        email: args.email,
        status: b.status || "accepted",
      };
      return ok({ status: "created", booking: created }, renderCreateBookingCard(created));
    } catch (err) {
      return fail("create_booking", err);
    }
  },
);

// 3. Cancel booking (ACTING - Has Confirmation)
server.registerTool(
  "cancel_booking",
  {
    title: "Cancel booking",
    description: "Cancel an existing Cal.com booking by its UID (the id from get_bookings) with an optional reason. Use when the user requests to cancel or remove a meeting; call get_bookings first if you don't have the UID.",
    inputSchema: {
      bookingId: z.string().min(1).describe("Booking UID to cancel (the id returned by get_bookings)."),
      title: z.string().optional().describe("Meeting title for verification."),
      startTime: z.string().optional().describe("Scheduled start time string."),
      attendeeName: z.string().optional().describe("Attendee name for confirmation."),
      reason: z.string().optional().describe("Cancellation reason."),
    } as any,
  },
  async (args: any) => {
    try {
      const c = getComposio();
      const raw = await c.run("CAL_CANCEL_BOOKING_VIA_UID", {
        bookingUid: args.bookingId.trim(),
        cancellationReason: args.reason,
      });
      const b = Array.isArray(raw) ? raw[0] : raw;
      const details = {
        bookingId: args.bookingId,
        title: b?.title || args.title || "Meeting",
        startTime: b?.start || args.startTime,
        reason: args.reason,
      };
      return ok({ status: "cancelled", bookingId: args.bookingId, title: details.title }, renderCancelBookingCard(details));
    } catch (err) {
      return fail("cancel_booking", err);
    }
  },
);

// 4. Reschedule booking (ACTING - Has Confirmation)
server.registerTool(
  "reschedule_booking",
  {
    title: "Reschedule booking",
    description: "Move an existing Cal.com booking (by UID, the id from get_bookings) to a new start time. Use when the user asks to reschedule, move, or postpone an appointment. Cal.com issues a new UID for the moved booking.",
    inputSchema: {
      bookingId: z.string().min(1).describe("Booking UID to reschedule (the id returned by get_bookings)."),
      newStartTime: z.string().min(1).describe("New start time as ISO 8601 with timezone (e.g. 2026-11-12T15:30:00-06:00)."),
      title: z.string().optional().describe("Meeting title for verification."),
      attendeeName: z.string().optional().describe("Attendee name."),
      currentStartTime: z.string().optional().describe("Current scheduled time."),
      reason: z.string().optional().describe("Optional reason for rescheduling."),
    } as any,
  },
  async (args: any) => {
    try {
      const c = getComposio();
      const start = toIsoOrThrow(args.newStartTime, "newStartTime");
      const raw = await c.run("CAL_RESCHEDULE_BOOKING_BY_UID", {
        bookingUid: args.bookingId.trim(),
        start,
        reschedulingReason: args.reason,
      });
      const b = Array.isArray(raw) ? raw[0] : raw;
      const details = {
        bookingId: args.bookingId,
        title: b?.title || args.title || "Meeting",
        currentStartTime: args.currentStartTime,
        newStartTime: b?.start || start,
        reason: args.reason,
      };
      return ok(
        { status: "rescheduled", previousBookingId: args.bookingId, bookingId: String(b?.uid ?? args.bookingId), newStartTime: details.newStartTime },
        renderRescheduleCard(details),
      );
    } catch (err) {
      return fail("reschedule_booking", err);
    }
  },
);

// 5. Get event types (READ - No Confirmation)
server.registerTool(
  "get_event_types",
  {
    title: "Get event types",
    description: "Fetch configured Cal.com event types showing durations and booking link slugs. Use when the user asks what booking links or event types are set up.",
    inputSchema: {
      limit: z.number().min(1).max(15).optional().describe("Max event types to return (default: 15)."),
    } as any,
  },
  async (args: any) => {
    try {
      const c = getComposio();
      const limit = Math.min(Math.max(args?.limit ?? 15, 1), 15);
      const all = await listEventTypes(c);
      const eventTypes = all.slice(0, limit).map((e) => ({ ...e, id: String(e.id) }));
      return ok({ count: all.length, eventTypes }, renderEventTypesCard(eventTypes, all.length));
    } catch (err) {
      return fail("get_event_types", err);
    }
  },
);

// 6. Get availability (READ - No Confirmation)
server.registerTool(
  "get_availability",
  {
    title: "Get availability",
    description: "Check open Cal.com time slots for an event type between two dates. Use when the user asks what times they are free or available for meetings. Without eventTypeId, the default 30-minute (or first) event type is used.",
    inputSchema: {
      eventTypeId: z.string().optional().describe("Optional event type ID or slug (from get_event_types)."),
      dateFrom: z.string().optional().describe("Start date in YYYY-MM-DD format (default: today)."),
      dateTo: z.string().optional().describe("End date in YYYY-MM-DD format (default: dateFrom)."),
      username: z.string().optional().describe("Optional Cal.com username whose event types to look up."),
    } as any,
  },
  async (args: any) => {
    try {
      const c = getComposio();
      const today = new Date().toLocaleDateString("en-CA", { timeZone: LOCAL_TZ });
      const dateFrom = args?.dateFrom || today;
      const dateTo = args?.dateTo || dateFrom;
      for (const [k, v] of [["dateFrom", dateFrom], ["dateTo", dateTo]]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${k} must be YYYY-MM-DD (got "${v}").`);
      }
      const et = await resolveEventType(c, args?.eventTypeId, undefined, args?.username);

      const raw = await c.run("CAL_GET_AVAILABLE_SLOTS_INFO", {
        eventTypeId: et.id,
        // Ask a day wider on each side (UTC), then keep only slots on the user's local dates below.
        startTime: `${shiftDay(dateFrom, -1)}T00:00:00.000Z`,
        endTime: `${shiftDay(dateTo, 1)}T23:59:59.999Z`,
        timeZone: LOCAL_TZ,
      });

      // Cal.com returns { "YYYY-MM-DD": [{ start | time }] }, sometimes nested under "slots".
      const byDate = raw?.slots && !Array.isArray(raw.slots) ? raw.slots : raw;
      const isDateMap = byDate && typeof byDate === "object" && !Array.isArray(byDate) &&
        Object.keys(byDate).every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
      if (!Array.isArray(byDate) && !isDateMap) throw new UnexpectedShapeError("availability");
      const allSlots: { date: string; time: string }[] = Array.isArray(byDate)
        ? byDate.map((s: any) => ({ date: String(s.date ?? ""), time: String(s.start ?? s.time ?? s) }))
        : Object.entries(byDate || {}).flatMap(([date, times]) =>
            Array.isArray(times) ? times.map((t: any) => ({ date, time: String(t?.start ?? t?.time ?? t) })) : []);
      const localDay = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { timeZone: LOCAL_TZ }); };
      const slots = allSlots.filter((s) => { const k = localDay(s.time) || s.date; return k >= dateFrom && k <= dateTo; });

      return ok(
        { count: slots.length, dateFrom, dateTo, timeZone: LOCAL_TZ, eventType: { id: String(et.id), title: et.title, length: et.length }, slots: slots.slice(0, 60) },
        renderAvailabilityCard(slots.slice(0, 60), dateFrom, dateTo, et),
      );
    } catch (err) {
      return fail("get_availability", err);
    }
  },
);

// 7. Create event type (ACTING - Has Confirmation)
// Composio's Cal toolkit only has a team event-type creator, so personal event
// types go to Cal.com's v2 API through Composio's authenticated proxy.
server.registerTool(
  "create_event_type",
  {
    title: "Create event type",
    description: "Create a new Cal.com booking link and event type with a title, slug, and duration. Use when the user asks to create or set up a new booking link.",
    inputSchema: {
      title: z.string().min(1).describe("Event type title (e.g. Quick Chat)."),
      slug: z.string().min(1).describe("URL slug (e.g. quick-chat)."),
      length: z.number().min(5).max(480).describe("Meeting duration in minutes (e.g. 15, 30, 45, 60)."),
      description: z.string().optional().describe("Optional description for this booking link."),
    } as any,
  },
  async (args: any) => {
    try {
      const c = getComposio();
      const raw = await c.proxy(
        "POST",
        "https://api.cal.com/v2/event-types",
        stripUndefined({ title: args.title, slug: args.slug, lengthInMinutes: args.length, description: args.description }),
        { "cal-api-version": "2024-06-14" },
      );
      const e = Array.isArray(raw) ? raw[0] : raw;
      if (!e?.id) throw new Error("Cal.com did not return the new event type.");

      const created = {
        id: String(e.id),
        title: e.title || args.title,
        slug: e.slug || args.slug,
        length: Number(e.lengthInMinutes ?? e.length ?? args.length),
        description: e.description ?? args.description,
      };
      return ok({ status: "created", eventType: created }, renderCreateEventTypeCard(created));
    } catch (err) {
      return fail("create_event_type", err);
    }
  },
);

// Importable for renderer tests; normal Bun and tsx launches still start stdio.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await server.connect(new StdioServerTransport());
  log(`server ready (Composio ${normalizeBaseUrl(process.env.COMPOSIO_BASE_URL)}, tz ${LOCAL_TZ})`);
}
export { renderBookingsCard, renderEventTypesCard };
