import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderCustom, markHtml, esc, clip } from "./widgetKit.ts";

const server = new McpServer({ name: "google-analytics", version: "1.0.0" });
const ACCENT = "#f9ab00"; // Google Analytics brand amber

const CSS = `
.ga{font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;padding:12px 14px;color:var(--ink-1)}
.ga-hd{display:flex;align-items:center;gap:8px;height:24px;margin-bottom:10px}
.ga-prop{font-size:11px;font-weight:500;color:var(--ink-3);letter-spacing:.02em;text-transform:uppercase}
.ga-prop-lg{font-size:12px;font-weight:600;color:var(--ink-2)}
.ga-prop-sm{font-size:10px;font-weight:500;color:var(--ink-4);margin-left:auto;letter-spacing:.02em}
.ga-scope{margin-left:auto;font-size:10px;font-weight:600;color:var(--ink-4);letter-spacing:.06em;text-transform:uppercase}
.ga-pill-amber{font-size:10px;font-weight:600;padding:2px 7px;border-radius:9999px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);letter-spacing:.02em;margin-left:auto}
.ga-pill-err{font-size:10px;font-weight:600;padding:2px 7px;border-radius:9999px;background:color-mix(in srgb,var(--bad) 20%,transparent);color:var(--bad);letter-spacing:.02em;margin-left:auto}

.ga-hero{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}
.ga-hero-val{font-size:28px;font-weight:700;line-height:1;letter-spacing:-.02em;color:var(--ink-1);font-variant-numeric:tabular-nums}
.ga-hero-lbl{font-size:12px;font-weight:500;color:var(--ink-3)}

.ga-div{height:1px;background:var(--line);margin:10px 0}

.ga-rw{display:flex;align-items:center;gap:8px;height:30px;padding:0 2px}
.ga-rw-dim{width:160px;min-width:0;font-size:12px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ga-rail{flex:1;min-width:50px;height:2px;border-radius:2px;background:var(--track);overflow:hidden}
.ga-rail-fill{height:100%;border-radius:2px;background:var(--accent)}
.ga-rw-cnt{min-width:44px;text-align:right;font-size:12px;font-weight:500;color:var(--ink-1);font-variant-numeric:tabular-nums}
.ga-more{font-size:11px;color:var(--ink-4);padding:6px 2px 0}

.ga-live-tag{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:600;color:var(--accent);letter-spacing:.08em;text-transform:uppercase}
.ga-pulse-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}
.ga-pulse-dot.ga-pulsing{box-shadow:0 0 6px var(--accent)}
@media(prefers-reduced-motion:no-preference){
  .ga-pulse-dot.ga-pulsing{animation:gaPulse 2s cubic-bezier(.4,0,.6,1) infinite}
}
@keyframes gaPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.85)}}
.ga-pulse-dot.ga-muted{background:var(--ink-4);box-shadow:none}

.ga-rt-focal{margin-bottom:8px}
.ga-rt-cnt{font-size:32px;font-weight:700;line-height:1.05;letter-spacing:-.02em;color:var(--ink-1);font-variant-numeric:tabular-nums}
.ga-rt-lbl{font-size:11px;font-weight:400;color:var(--ink-3);margin-top:3px}
.ga-rt-row{display:flex;align-items:center;justify-content:space-between;height:30px;padding:0 4px;border-radius:4px}
.ga-rt-row:nth-child(even){background:var(--fill-1)}
.ga-rt-path{max-width:240px;min-width:0;font-size:12px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ga-rt-val{font-size:12px;font-weight:600;color:var(--ink-1);font-variant-numeric:tabular-nums}

.ga-meta-focal{font-size:16px;font-weight:500;color:var(--ink-1);margin-bottom:12px}
.ga-meta-stats{display:flex;align-items:center;background:var(--fill-1);border-radius:6px;padding:8px 0;margin-bottom:12px}
.ga-stat-col{flex:1;text-align:center}
.ga-stat-num{font-size:20px;font-weight:700;line-height:1.1;color:var(--ink-1);font-variant-numeric:tabular-nums}
.ga-stat-lbl{font-size:11px;color:var(--ink-3);margin-top:2px}
.ga-stat-divider{width:1px;height:24px;background:var(--line)}
.ga-chip-section{margin-top:2px}
.ga-chip-lbl{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-4);margin-bottom:6px}
.ga-chips{display:flex;flex-wrap:wrap;gap:5px}
.ga-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:9999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(255,255,255,.85)}
.ga-chip-more{color:var(--ink-4);border-color:transparent;background:transparent}

.ga-empty{padding:14px 4px;text-align:center}
.ga-empty-txt{font-size:12px;font-weight:500;color:var(--ink-2)}
.ga-empty-sub{font-size:11px;color:var(--ink-4);margin-top:4px}

.ga-auth{padding:4px 0}
.ga-auth-title{font-size:14px;font-weight:600;color:var(--ink-1);margin-bottom:4px}
.ga-auth-sub{font-size:12px;color:var(--ink-3);line-height:1.45;margin-bottom:12px}
.ga-auth-btn{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 14px;border-radius:6px;background:var(--accent);color:#0d0e11;font-size:12px;font-weight:600;text-decoration:none}
.ga-auth-tip{font-size:10.5px;color:var(--ink-4);margin-top:10px;line-height:1.4}

.ga-err-title{font-size:13px;font-weight:600;color:var(--ink-1);margin-bottom:3px}
.ga-err-msg{font-size:12px;color:var(--bad);line-height:1.4;margin-bottom:6px}
.ga-err-tip{font-size:11px;color:var(--ink-4);line-height:1.4}
`;

function formatNumber(num: number | string): string {
  const n = typeof num === "string" ? parseFloat(num) : num;
  if (isNaN(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
  if (n >= 10_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + "k";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}

function getHumanLabel(key: string): string {
  const map: Record<string, string> = {
    activeUsers: "Active users",
    sessions: "Sessions",
    screenPageViews: "Page views",
    eventCount: "Event count",
    totalUsers: "Total users",
    newUsers: "New users",
    conversions: "Conversions",
    bounceRate: "Bounce rate",
    pagePath: "Page path",
    unifiedScreenName: "Screen name",
    sessionSource: "Source",
    country: "Country",
    city: "City",
    deviceCategory: "Device",
    eventName: "Event name",
  };
  return map[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

function getDateRangeInfo(range?: string): { startDate: string; endDate: string; label: string } {
  switch (range) {
    case "today":
      return { startDate: "today", endDate: "today", label: "TODAY" };
    case "yesterday":
      return { startDate: "yesterday", endDate: "yesterday", label: "YESTERDAY" };
    case "28daysAgo":
      return { startDate: "28daysAgo", endDate: "today", label: "LAST 28 DAYS" };
    case "30daysAgo":
      return { startDate: "30daysAgo", endDate: "today", label: "LAST 30 DAYS" };
    case "7daysAgo":
    default:
      return { startDate: "7daysAgo", endDate: "today", label: "LAST 7 DAYS" };
  }
}

function extractResultData(resJson: any): any {
  let target = resJson?.data ?? resJson?.response_data ?? resJson?.result ?? resJson;
  if (typeof target === "string") {
    try {
      target = JSON.parse(target);
    } catch {}
  }
  if (target?.data && typeof target.data === "object") {
    return target.data;
  }
  return target;
}

function isAuthenticationError(msg: string, status?: number): boolean {
  if (status === 401 || status === 403) return true;
  const lower = (msg || "").toLowerCase();
  return (
    lower.includes("unauthenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("not connected") ||
    lower.includes("no connected account") ||
    lower.includes("connected account not found") ||
    lower.includes("token expired") ||
    lower.includes("expired or revoked") ||
    lower.includes("oauth") ||
    lower.includes("auth required") ||
    lower.includes("re-authenticate") ||
    lower.includes("insufficient permissions")
  );
}

async function getOAuthConnectUrl(apiKey: string, entityId: string): Promise<string> {
  try {
    const res = await fetch("https://backend.composio.dev/api/v1/connectedAccounts", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        integrationId: "google_analytics",
        entityId: entityId || "default",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.redirectUrl) return json.redirectUrl;
      if (json?.connectionUrl) return json.connectionUrl;
      if (json?.url) return json.url;
    }
  } catch (e) {
    console.error("Failed to generate Composio OAuth URL:", e);
  }
  return "https://dashboard.composio.dev/connected-accounts";
}

interface ComposioExecuteOptions {
  actionName: string;
  input: Record<string, any>;
  entityId: string;
  apiKey: string;
}

async function executeComposioAction(
  opts: ComposioExecuteOptions,
): Promise<{ ok: boolean; data?: any; error?: string; isAuthError?: boolean }> {
  const url = `https://backend.composio.dev/api/v1/actions/${opts.actionName}/execute`;
  const body = {
    entityId: opts.entityId || "default",
    input: opts.input,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });

    const resJson = await res.json().catch(() => null);

    if (!res.ok || resJson?.successful === false || resJson?.status === "FAILED") {
      const errText = resJson?.error || resJson?.message || `HTTP ${res.status}`;
      const isAuth = isAuthenticationError(errText, res.status);
      return { ok: false, error: errText, isAuthError: isAuth, data: resJson };
    }

    const payload = extractResultData(resJson);
    return { ok: true, data: payload };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { ok: false, error: msg, isAuthError: isAuthenticationError(msg, 0) };
  }
}

function renderAuthCard(authUrl: string, reason: string): { html: string; height: number } {
  const body = `
    <div class="ga">
      <div class="ga-hd">
        ${markHtml()}
        <span class="ga-prop">Google Analytics</span>
        <span class="ga-pill-amber">OAuth 2.0</span>
      </div>
      <div class="ga-auth">
        <div class="ga-auth-title">Account Linking Required</div>
        <div class="ga-auth-sub">${esc(reason || "Connect your Google Analytics account via Composio OAuth2 to access GA4 properties and reports.")}</div>
        <a class="ga-auth-btn" href="${esc(authUrl)}" target="_blank">Connect with Google →</a>
        <div class="ga-auth-tip">After authorizing in your browser, ask your question again. Manage accounts at <a href="https://dashboard.composio.dev/connected-accounts" style="color:var(--ink-2);text-decoration:underline;">Composio</a>.</div>
      </div>
    </div>`;
  return renderCustom({
    accent: ACCENT,
    css: CSS,
    body,
    height: 195,
  });
}

function renderErrorCard(title: string, message: string, tip?: string): { html: string; height: number } {
  const body = `
    <div class="ga">
      <div class="ga-hd">
        ${markHtml()}
        <span class="ga-prop">Google Analytics</span>
        <span class="ga-pill-err">Error</span>
      </div>
      <div class="ga-err">
        <div class="ga-err-title">${esc(title)}</div>
        <div class="ga-err-msg">${esc(message)}</div>
        <div class="ga-err-tip">${esc(tip || "Verify Property ID in GA4 Admin -> Property Settings and check user roles.")}</div>
      </div>
    </div>`;
  return renderCustom({
    accent: ACCENT,
    css: CSS,
    body,
    height: 165,
  });
}

// 1. Tool: run_report
server.registerTool(
  "run_report",
  {
    title: "Run report",
    description: "Query GA4 metrics such as sessions, active users, and page paths.",
    inputSchema: {
      property_id: z.string().optional().describe("9-digit GA4 Property ID. Uses default if omitted."),
      metric: z.string().optional().describe("Metric to query (e.g. 'sessions', 'activeUsers', 'screenPageViews'). Defaults to 'sessions'."),
      dimension: z.string().optional().describe("Breakdown dimension (e.g. 'pagePath', 'country', 'sessionSource'). Defaults to 'pagePath'."),
      date_range: z.enum(["today", "yesterday", "7daysAgo", "28daysAgo", "30daysAgo"]).optional().describe("Date range to query. Defaults to '7daysAgo' (last 7 days)."),
      limit: z.number().min(1).max(20).optional().describe("Maximum rows to return (default 5)."),
    } as any,
  },
  async (args: any) => {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) {
      throw new Error("Missing Composio API key — add it in integration settings.");
    }

    const rawProp = args?.property_id || process.env.GA4_PROPERTY_ID;
    if (!rawProp) {
      const card = renderErrorCard(
        "Property ID Required",
        "No GA4 Property ID provided.",
        "Pass property_id or configure a default Property ID in this integration's settings.",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Property ID required",
              message: "Please provide a GA4 Property ID or set a default in settings.",
              _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
            }),
          },
        ],
      };
    }

    const cleanPropId = String(rawProp).replace(/^properties\//, "").trim();
    const entityId = process.env.COMPOSIO_ENTITY_ID || "default";
    const dateRangeKey = args?.date_range || process.env.GA4_DEFAULT_DATE_RANGE || "7daysAgo";
    const dateInfo = getDateRangeInfo(dateRangeKey);
    const metric = args?.metric || "sessions";
    const dimension = args?.dimension || "pagePath";
    const limit = Math.min(Math.max(args?.limit ?? 5, 1), 20);

    const composioInput = {
      property: `properties/${cleanPropId}`,
      property_id: cleanPropId,
      propertyId: cleanPropId,
      dateRanges: [{ startDate: dateInfo.startDate, endDate: dateInfo.endDate }],
      metrics: [{ name: metric }],
      dimensions: [{ name: dimension }],
      metric,
      dimension,
      limit,
    };

    const res = await executeComposioAction({
      actionName: "GOOGLE_ANALYTICS_RUN_REPORT",
      input: composioInput,
      entityId,
      apiKey,
    });

    if (!res.ok) {
      if (res.isAuthError) {
        const authUrl = await getOAuthConnectUrl(apiKey, entityId);
        const card = renderAuthCard(authUrl, res.error || "OAuth connection required or expired.");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "OAuth connection required",
                authUrl,
                message: "Please connect your Google Analytics account via the link in the notch.",
                _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
              }),
            },
          ],
        };
      }
      const card = renderErrorCard("Report Query Failed", res.error || "Composio action failed");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: res.error,
              _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
            }),
          },
        ],
      };
    }

    const data = res.data;
    const rawRows: any[] = Array.isArray(data?.rows) ? data.rows : [];
    const rows = rawRows.map((r: any) => {
      const dimVal =
        r.dimensionValues?.[0]?.value ??
        r.dimension_values?.[0]?.value ??
        r.dimensions?.[0] ??
        "Direct / None";
      const metValStr =
        r.metricValues?.[0]?.value ??
        r.metric_values?.[0]?.value ??
        r.metrics?.[0] ??
        "0";
      const num = parseFloat(metValStr) || 0;
      return {
        dimension: String(dimVal),
        value: num,
        formatted: formatNumber(num),
      };
    });

    let totalVal = 0;
    if (data?.totals?.[0]?.metricValues?.[0]?.value) {
      totalVal = parseFloat(data.totals[0].metricValues[0].value) || 0;
    } else {
      totalVal = rows.reduce((acc, curr) => acc + curr.value, 0);
    }
    const formattedTotal = formatNumber(totalVal);
    const metricLabel = getHumanLabel(metric);
    const maxVal = Math.max(...rows.map((r) => r.value), 1);
    const shownRows = rows.slice(0, 4);

    let contentHtml = "";
    if (rows.length === 0) {
      contentHtml = `
        <div class="ga-empty">
          <div class="ga-empty-txt">No data recorded for this period</div>
          <div class="ga-empty-sub">Try expanding your date range or checking property filters.</div>
        </div>`;
    } else {
      const rowsHtml = shownRows
        .map((r) => {
          const pct = Math.max(4, Math.min(100, Math.round((r.value / maxVal) * 100)));
          return `
            <div class="ga-rw">
              <span class="ga-rw-dim" title="${esc(r.dimension)}">${esc(clip(r.dimension, 24))}</span>
              <div class="ga-rail"><div class="ga-rail-fill" style="width:${pct}%"></div></div>
              <span class="ga-rw-cnt">${esc(r.formatted)}</span>
            </div>`;
        })
        .join("");
      const moreHtml =
        rows.length > 4
          ? `<div class="ga-more">+${rows.length - 4} more ${esc(getHumanLabel(dimension).toLowerCase())}s</div>`
          : "";
      contentHtml = rowsHtml + moreHtml;
    }

    const cardHeight =
      rows.length === 0 ? 155 : 145 + shownRows.length * 30 + (rows.length > 4 ? 24 : 0);

    const body = `
      <div class="ga">
        <div class="ga-hd">
          ${markHtml()}
          <span class="ga-prop">Property ${esc(cleanPropId)}</span>
          <span class="ga-scope">${esc(dateInfo.label)}</span>
        </div>
        <div class="ga-hero">
          <div class="ga-hero-val">${esc(formattedTotal)}</div>
          <div class="ga-hero-lbl">${esc(metricLabel)}</div>
        </div>
        <div class="ga-div"></div>
        ${contentHtml}
      </div>`;

    const card = renderCustom({
      accent: ACCENT,
      css: CSS,
      body,
      height: cardHeight,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            propertyId: cleanPropId,
            dateRange: dateInfo.label,
            metric: metricLabel,
            total: totalVal,
            rows: rows.map((r) => ({ dimension: r.dimension, count: r.value })),
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        },
      ],
    };
  },
);

// 2. Tool: run_realtime_report
server.registerTool(
  "run_realtime_report",
  {
    title: "Run realtime report",
    description: "View live active site visitors in the last 30 minutes and top pages.",
    inputSchema: {
      property_id: z.string().optional().describe("9-digit GA4 Property ID. Uses default if omitted."),
      dimension: z.string().optional().describe("Breakdown dimension (e.g. 'pagePath', 'country', 'unifiedScreenName'). Defaults to 'pagePath'."),
      limit: z.number().min(1).max(10).optional().describe("Maximum rows to return (default 4)."),
    } as any,
  },
  async (args: any) => {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) {
      throw new Error("Missing Composio API key — add it in integration settings.");
    }

    const rawProp = args?.property_id || process.env.GA4_PROPERTY_ID;
    if (!rawProp) {
      const card = renderErrorCard(
        "Property ID Required",
        "No GA4 Property ID provided.",
        "Pass property_id or configure a default Property ID in this integration's settings.",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Property ID required",
              message: "Please provide a GA4 Property ID or set a default in settings.",
              _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
            }),
          },
        ],
      };
    }

    const cleanPropId = String(rawProp).replace(/^properties\//, "").trim();
    const entityId = process.env.COMPOSIO_ENTITY_ID || "default";
    const dimension = args?.dimension || "pagePath";
    const limit = Math.min(Math.max(args?.limit ?? 4, 1), 10);

    const composioInput = {
      property: `properties/${cleanPropId}`,
      property_id: cleanPropId,
      propertyId: cleanPropId,
      dimensions: [{ name: dimension }],
      metrics: [{ name: "activeUsers" }],
      metric: "activeUsers",
      dimension,
      limit,
    };

    const res = await executeComposioAction({
      actionName: "GOOGLE_ANALYTICS_RUN_REALTIME_REPORT",
      input: composioInput,
      entityId,
      apiKey,
    });

    if (!res.ok) {
      if (res.isAuthError) {
        const authUrl = await getOAuthConnectUrl(apiKey, entityId);
        const card = renderAuthCard(authUrl, res.error || "OAuth connection required or expired.");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "OAuth connection required",
                authUrl,
                message: "Please connect your Google Analytics account via the link in the notch.",
                _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
              }),
            },
          ],
        };
      }
      const card = renderErrorCard("Realtime Query Failed", res.error || "Composio realtime action failed");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: res.error,
              _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
            }),
          },
        ],
      };
    }

    const data = res.data;
    const rawRows: any[] = Array.isArray(data?.rows) ? data.rows : [];
    const rows = rawRows.map((r: any) => {
      const dimVal =
        r.dimensionValues?.[0]?.value ??
        r.dimension_values?.[0]?.value ??
        r.dimensions?.[0] ??
        "/";
      const metValStr =
        r.metricValues?.[0]?.value ??
        r.metric_values?.[0]?.value ??
        r.metrics?.[0] ??
        "0";
      const num = parseInt(metValStr, 10) || 0;
      return {
        dimension: String(dimVal),
        count: num,
      };
    });

    let totalUsers = 0;
    if (data?.totals?.[0]?.metricValues?.[0]?.value) {
      totalUsers = parseInt(data.totals[0].metricValues[0].value, 10) || 0;
    } else {
      totalUsers = rows.reduce((acc, curr) => acc + curr.count, 0);
    }

    const shownRows = rows.slice(0, 4);
    const hasUsers = totalUsers > 0;
    const pulseDotClass = hasUsers ? "ga-pulse-dot ga-pulsing" : "ga-pulse-dot ga-muted";
    const caption = hasUsers ? "Users active now" : "No active visitors in the last 30 minutes";

    let rowsHtml = "";
    if (shownRows.length > 0) {
      rowsHtml = `
        <div class="ga-div"></div>
        ${shownRows
          .map(
            (r) => `
            <div class="ga-rt-row">
              <span class="ga-rt-path" title="${esc(r.dimension)}">${esc(clip(r.dimension, 30))}</span>
              <span class="ga-rt-val">${esc(String(r.count))}</span>
            </div>`,
          )
          .join("")}`;
    }

    const cardHeight = !hasUsers || shownRows.length === 0 ? 140 : 145 + shownRows.length * 30;

    const body = `
      <div class="ga">
        <div class="ga-hd">
          ${markHtml()}
          <div class="ga-live-tag">
            <span class="${pulseDotClass}"></span>
            <span>REALTIME · PAST 30 MIN</span>
          </div>
          <span class="ga-prop-sm">${esc(cleanPropId)}</span>
        </div>
        <div class="ga-rt-focal">
          <div class="ga-rt-cnt">${esc(String(totalUsers))}</div>
          <div class="ga-rt-lbl">${esc(caption)}</div>
        </div>
        ${rowsHtml}
      </div>`;

    const card = renderCustom({
      accent: ACCENT,
      css: CSS,
      body,
      height: cardHeight,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            propertyId: cleanPropId,
            activeUsersNow: totalUsers,
            topActivePages: rows.map((r) => ({ page: r.dimension, users: r.count })),
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        },
      ],
    };
  },
);

// 3. Tool: get_metadata
server.registerTool(
  "get_metadata",
  {
    title: "Get metadata",
    description: "List available dimensions and metrics for a Google Analytics property.",
    inputSchema: {
      property_id: z.string().optional().describe("9-digit GA4 Property ID. Uses default if omitted."),
    } as any,
  },
  async (args: any) => {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) {
      throw new Error("Missing Composio API key — add it in integration settings.");
    }

    const rawProp = args?.property_id || process.env.GA4_PROPERTY_ID;
    if (!rawProp) {
      const card = renderErrorCard(
        "Property ID Required",
        "No GA4 Property ID provided.",
        "Pass property_id or configure a default Property ID in this integration's settings.",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Property ID required",
              message: "Please provide a GA4 Property ID or set a default in settings.",
              _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
            }),
          },
        ],
      };
    }

    const cleanPropId = String(rawProp).replace(/^properties\//, "").trim();
    const entityId = process.env.COMPOSIO_ENTITY_ID || "default";

    const composioInput = {
      property: `properties/${cleanPropId}`,
      property_id: cleanPropId,
      propertyId: cleanPropId,
    };

    const res = await executeComposioAction({
      actionName: "GOOGLE_ANALYTICS_GET_METADATA",
      input: composioInput,
      entityId,
      apiKey,
    });

    if (!res.ok) {
      if (res.isAuthError) {
        const authUrl = await getOAuthConnectUrl(apiKey, entityId);
        const card = renderAuthCard(authUrl, res.error || "OAuth connection required or expired.");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "OAuth connection required",
                authUrl,
                message: "Please connect your Google Analytics account via the link in the notch.",
                _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
              }),
            },
          ],
        };
      }
      const card = renderErrorCard("Metadata Query Failed", res.error || "Composio metadata action failed");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: res.error,
              _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
            }),
          },
        ],
      };
    }

    const data = res.data;
    const rawDimensions: any[] = Array.isArray(data?.dimensions) ? data.dimensions : [];
    const rawMetrics: any[] = Array.isArray(data?.metrics) ? data.metrics : [];

    const dimensions = rawDimensions.map((d: any) => d.apiName || d.name || String(d));
    const metrics = rawMetrics.map((m: any) => m.apiName || m.name || String(m));
    const totalDim = dimensions.length;
    const totalMet = metrics.length;

    let body = "";
    let cardHeight = 235;

    if (totalDim === 0 && totalMet === 0) {
      cardHeight = 165;
      body = `
        <div class="ga">
          <div class="ga-hd">
            ${markHtml()}
            <span class="ga-prop-lg">Property ${esc(cleanPropId)}</span>
            <span class="ga-pill-amber">GA4 Data API v1</span>
          </div>
          <div class="ga-empty">
            <div class="ga-empty-txt">Empty or inaccessible property schema</div>
            <div class="ga-empty-sub">Verify that your Google account has Viewer permissions on this Property.</div>
          </div>
        </div>`;
    } else {
      const focalText = `${totalMet} Metrics · ${totalDim} Dimensions`;
      const sampleMet = metrics.slice(0, 3);
      const sampleDim = dimensions.slice(0, 3);
      const combined = [...sampleMet, ...sampleDim];
      const chipsHtml = combined
        .map((attr) => `<span class="ga-chip">${esc(clip(attr, 18))}</span>`)
        .join("");
      const remaining = Math.max(0, totalDim + totalMet - combined.length);
      const moreChip = remaining > 0 ? `<span class="ga-chip ga-chip-more">+${remaining} more</span>` : "";

      body = `
        <div class="ga">
          <div class="ga-hd">
            ${markHtml()}
            <span class="ga-prop-lg">Property ${esc(cleanPropId)}</span>
            <span class="ga-pill-amber">GA4 Data API v1</span>
          </div>
          <div class="ga-meta-focal">${esc(focalText)}</div>
          <div class="ga-meta-stats">
            <div class="ga-stat-col">
              <div class="ga-stat-num">${esc(String(totalDim))}</div>
              <div class="ga-stat-lbl">Dimensions</div>
            </div>
            <div class="ga-stat-divider"></div>
            <div class="ga-stat-col">
              <div class="ga-stat-num">${esc(String(totalMet))}</div>
              <div class="ga-stat-lbl">Metrics</div>
            </div>
          </div>
          <div class="ga-chip-section">
            <div class="ga-chip-lbl">Queryable attributes</div>
            <div class="ga-chips">${chipsHtml}${moreChip}</div>
          </div>
        </div>`;
    }

    const card = renderCustom({
      accent: ACCENT,
      css: CSS,
      body,
      height: cardHeight,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            propertyId: cleanPropId,
            metricsCount: totalMet,
            dimensionsCount: totalDim,
            sampleMetrics: metrics.slice(0, 10),
            sampleDimensions: dimensions.slice(0, 10),
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
