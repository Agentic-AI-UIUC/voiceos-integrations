import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderCustom, markHtml, esc, clip } from "./widgetKit.ts";

const server = new McpServer({ name: "calendly", version: "1.0.0" });
const ACCENT = "#006bff"; // Calendly brand blue

// --- Shared SVG Icons (16x16, currentColor) ---
const I = (d: string) =>
  `<svg class="i" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICON = {
  calendar: I('<rect x="2" y="3.2" width="12" height="10.6" rx="1.6"/><path d="M2 6.4h12M5.4 1.8v2.4M10.6 1.8v2.4"/>'),
  clock: I('<circle cx="8" cy="8" r="6.1"/><path d="M8 4.6V8l2.4 1.6"/>'),
  user: I('<circle cx="8" cy="5.6" r="2.7"/><path d="M2.8 13.6a5.2 5.2 0 0 1 10.4 0"/>'),
  video: I('<rect x="1.8" y="3.8" width="8.4" height="8.4" rx="1.4"/><path d="m10.2 6.6 4-2.4v7.6l-4-2.4"/>'),
  phone: I('<path d="M3.2 2.5a1.2 1.2 0 0 1 1.3-.2l2.1 1.2a1.2 1.2 0 0 1 .4 1.4L6.3 6a7.7 7.7 0 0 0 3.7 3.7l1.1-.7a1.2 1.2 0 0 1 1.4.4l1.2 2.1a1.2 1.2 0 0 1-.2 1.3l-1.3 1.3c-.9.9-2.3 1.1-3.5.4a12.8 12.8 0 0 1-5.7-5.7c-.7-1.2-.5-2.6.4-3.5l1.3-1.3z"/>'),
  pin: I('<circle cx="8" cy="6.2" r="2.2"/><path d="M8 2.2a4 4 0 0 0-4 4c0 3 4 7.6 4 7.6s4-4.6 4-7.6a4 4 0 0 0-4-4z"/>'),
  link: I('<path d="M6.6 9.4a2.9 2.9 0 0 1 0-4.1l1.6-1.6a2.9 2.9 0 0 1 4.1 4.1l-.8.8"/><path d="M9.4 6.6a2.9 2.9 0 0 1 0 4.1l-1.6 1.6a2.9 2.9 0 0 1-4.1-4.1l.8-.8"/>'),
  alert: I('<path d="M8 2.4 1.9 13.2h12.2z"/><path d="M8 6.2v3.1M8 11.2h.01"/>'),
  check: I('<path d="m3 8.4 3.3 3.2L13 4.8"/>'),
  close: I('<circle cx="8" cy="8" r="6.1"/><path d="m5.5 5.5 5 5M10.5 5.5l-5 5"/>'),
};

// --- Helper Functions ---
function extractUuid(idOrUri: string): string {
  if (!idOrUri) return "";
  const cleaned = idOrUri.trim();
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    const parts = cleaned.split("?")[0].split("/").filter(Boolean);
    return parts[parts.length - 1] || cleaned;
  }
  return cleaned;
}

function formatEventTime(isoString: string): {
  label: string;
  month: string;
  day: string;
  weekday: string;
  timeStr: string;
  fullDate: string;
} {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    return { label: isoString || "TBD", month: "TBD", day: "--", weekday: "", timeStr: "", fullDate: "" };
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const month = months[d.getMonth()];
  const day = String(d.getDate());
  const weekday = days[d.getDay()];

  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const fullDate = `${weekday}, ${month} ${day}`;

  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  let label = `${fullDate} · ${timeStr}`;
  if (isToday) {
    label = `Today · ${timeStr}`;
  } else if (isTomorrow) {
    label = `Tomorrow · ${timeStr}`;
  }

  return { label, month: month.toUpperCase(), day, weekday, timeStr, fullDate };
}

function formatDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return "30m";
  const mins = Math.round((end - start) / 60000);
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60}h`;
  if (mins > 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

function getLocationDetails(loc?: { type?: string; location?: string; join_url?: string }): { label: string; icon: string; url?: string } {
  if (!loc) return { label: "Web Conference", icon: ICON.video };
  const type = loc.type || "";
  const url = loc.join_url || (loc.location?.startsWith("https://") ? loc.location : undefined);

  if (type === "zoom") return { label: "Zoom", icon: ICON.video, url };
  if (type === "google_conference") return { label: "Google Meet", icon: ICON.video, url };
  if (type === "microsoft_teams") return { label: "Microsoft Teams", icon: ICON.video, url };
  if (type === "phone") return { label: loc.location || "Phone Call", icon: ICON.phone, url };
  if (type === "in_person") return { label: loc.location || "In Person", icon: ICON.pin, url };

  return { label: loc.location || "Web Conference", icon: ICON.video, url };
}

async function fetchCalendly(endpoint: string, apiKey: string, options: RequestInit = {}) {
  const url = endpoint.startsWith("https://") ? endpoint : `https://api.calendly.com${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    let errMsg = `Calendly API error: ${res.status} ${res.statusText}`;
    try {
      const errJson = await res.json();
      if (errJson.message) errMsg = errJson.message;
      else if (errJson.errors && errJson.errors[0]?.message) errMsg = errJson.errors[0].message;
    } catch {
      // ignore JSON parse error
    }
    const err = new Error(errMsg);
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

function renderErrorCard(title: string, message: string, height = 110) {
  const css = `
.cal-err{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px 14px}
.cal-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.cal-hd b{font-size:13px;font-weight:600;color:var(--ink-1)}
.cal-err-box{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--fill-1);border-radius:8px;border:1px solid var(--line)}
.cal-err-icon{color:var(--bad);flex:none;display:flex}
.cal-err-text{font-size:12px;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
  return renderCustom({
    accent: ACCENT,
    css,
    body: `<div class="cal-err">
      <div class="cal-hd">${markHtml()}<b>Calendly</b></div>
      <div class="cal-err-box">
        <span class="cal-err-icon">${ICON.alert}</span>
        <span class="cal-err-text">${esc(message)}</span>
      </div>
    </div>`,
    height,
  });
}

// ==========================================
// TOOL 1: upcoming_events (Read)
// ==========================================
server.registerTool(
  "upcoming_events",
  {
    title: "Upcoming events",
    description: "Fetch upcoming scheduled Calendly meetings. Use when the user asks what meetings they have scheduled, what's on their Calendly calendar, or who they are meeting with next.",
    inputSchema: {
      count: z.number().min(1).max(10).optional().describe("Number of upcoming events to retrieve (default 5)"),
    } as any,
  },
  async (args: any) => {
    const apiKey = process.env.CALENDLY_API_KEY;
    if (!apiKey) {
      const errCard = renderErrorCard("Setup Required", "Add your Calendly Personal Access Token in settings.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "Missing CALENDLY_API_KEY",
            message: "Please configure your Calendly Personal Access Token in settings.",
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }

    try {
      const count = Math.min(Math.max(args?.count ?? 5, 1), 10);
      const userRes = await fetchCalendly("/users/me", apiKey);
      const user = userRes?.resource;
      const userUri = user?.uri;
      const schedulingUrl = user?.scheduling_url || "";

      if (!userUri) {
        throw new Error("Unable to identify Calendly user from access token.");
      }

      const nowIso = new Date().toISOString();
      const eventsRes = await fetchCalendly(
        `/scheduled_events?user=${encodeURIComponent(userUri)}&status=active&min_start_time=${encodeURIComponent(nowIso)}&sort=start_time:asc&count=${count}`,
        apiKey
      );
      const rawEvents = eventsRes?.collection || [];

      // Fetch invitees for every returned event (≤10) in parallel so the model
      // gets the full list; the card below still only renders the first 4.
      const events = await Promise.all(
        rawEvents.map(async (ev: any) => {
          const uuid = extractUuid(ev.uri);
          let invitees: any[] = [];
          try {
            const invRes = await fetchCalendly(`/scheduled_events/${encodeURIComponent(uuid)}/invitees?count=2`, apiKey);
            invitees = invRes?.collection || [];
          } catch {
            // non-fatal
          }
          return {
            uuid,
            name: ev.name || "Scheduled Meeting",
            start_time: ev.start_time,
            end_time: ev.end_time,
            location: ev.location,
            invitees,
          };
        })
      );

      const CSS = `
.cal-card{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:11px 13px 12px}
.cal-hd{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.cal-hd b{font-size:13px;font-weight:600;color:var(--ink-1);letter-spacing:-.01em}
.cal-hd-count{margin-left:auto;font-size:11px;color:var(--ink-3);font-variant-numeric:tabular-nums;background:var(--fill-1);padding:2px 7px;border-radius:9999px}
.cal-hero{position:relative;background:var(--fill-1);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0 10px 10px 0;padding:8px 11px;display:flex;flex-direction:column;justify-content:center;min-height:54px;margin-bottom:8px}
.cal-hero-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px}
.cal-hero-time{font-size:14px;font-weight:600;color:var(--ink-1);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.cal-hero-dur{font-size:10.5px;font-weight:600;color:var(--accent);background:color-mix(in srgb,var(--accent) 15%,transparent);padding:2px 6px;border-radius:6px;font-variant-numeric:tabular-nums}
.cal-hero-btm{display:flex;align-items:center;gap:6px;min-width:0}
.cal-hero-title{font-size:13px;font-weight:500;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-hero-who{font-size:11.5px;color:var(--ink-3);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
.cal-hero-exp{padding:10px 12px;margin-bottom:0}
.cal-hero-meta{display:flex;align-items:center;gap:12px;margin-top:7px;padding-top:7px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-3)}
.cal-hero-meta span{display:flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-rw{display:flex;align-items:center;gap:9px;height:44px;padding:0 2px;border-top:1px solid var(--line)}
.cal-badge{width:28px;height:28px;border-radius:6px;background:var(--fill-1);display:flex;flex-direction:column;align-items:center;justify-content:center;flex:none;font-variant-numeric:tabular-nums;line-height:1.05}
.cal-badge-mo{font-size:8px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.02em}
.cal-badge-day{font-size:12px;font-weight:700;color:var(--ink-1)}
.cal-rw-mid{flex:1;min-width:0}
.cal-rw-title{display:block;font-size:13px;font-weight:500;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-rw-sub{display:block;font-size:11px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.cal-rw-time{flex:none;font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums;text-align:right}
.cal-empty{padding:18px 12px 14px;text-align:center;background:var(--fill-1);border-radius:10px;border:1px dashed var(--line)}
.cal-empty-icon{color:var(--ink-4);margin-bottom:6px;display:flex;justify-content:center}
.cal-empty-text{font-size:13px;font-weight:500;color:var(--ink-2)}
.cal-empty-link{font-size:11px;color:var(--accent);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-more{font-size:11px;color:var(--ink-4);text-align:center;padding-top:7px}
`;

      let body = "";
      let height = 150;

      if (events.length === 0) {
        body = `
<div class="cal-card">
  <div class="cal-hd">${markHtml()}<b>Calendly</b><span class="cal-hd-count">0 upcoming</span></div>
  <div class="cal-empty">
    <div class="cal-empty-icon">${ICON.calendar}</div>
    <div class="cal-empty-text">No upcoming meetings scheduled</div>
    ${schedulingUrl ? `<div class="cal-empty-link">${esc(clip(schedulingUrl, 38))}</div>` : ""}
  </div>
</div>`;
        height = 140;
      } else if (events.length === 1) {
        const first = events[0];
        const time = formatEventTime(first.start_time);
        const dur = formatDuration(first.start_time, first.end_time);
        const inviteeName = first.invitees?.[0]?.name || "";
        const inviteeEmail = first.invitees?.[0]?.email || "";
        const locInfo = getLocationDetails(first.location);

        body = `
<div class="cal-card">
  <div class="cal-hd">${markHtml()}<b>Calendly</b><span class="cal-hd-count">Next up</span></div>
  <div class="cal-hero cal-hero-exp">
    <div class="cal-hero-top">
      <span class="cal-hero-time">${esc(time.label)}</span>
      <span class="cal-hero-dur">${esc(dur)}</span>
    </div>
    <div class="cal-hero-title">${esc(clip(first.name, 48))}</div>
    <div class="cal-hero-meta">
      ${inviteeName ? `<span>${ICON.user} ${esc(clip(inviteeName, 22))}</span>` : ""}
      ${inviteeEmail ? `<span>${esc(clip(inviteeEmail, 26))}</span>` : ""}
      <span>${locInfo.icon} ${esc(clip(locInfo.label, 20))}</span>
    </div>
  </div>
</div>`;
        height = 160;
      } else {
        const first = events[0];
        const firstTime = formatEventTime(first.start_time);
        const dur = formatDuration(first.start_time, first.end_time);
        const firstInvitee = first.invitees?.[0]?.name || first.invitees?.[0]?.email || "";

        const subsequent = events.slice(1, 4).map((ev) => {
          const t = formatEventTime(ev.start_time);
          const who = ev.invitees?.[0]?.name || ev.invitees?.[0]?.email || "";
          return `
          <div class="cal-rw">
            <div class="cal-badge">
              <span class="cal-badge-mo">${esc(t.month)}</span>
              <span class="cal-badge-day">${esc(t.day)}</span>
            </div>
            <div class="cal-rw-mid">
              <span class="cal-rw-title">${esc(clip(ev.name, 32))}</span>
              ${who ? `<span class="cal-rw-sub">${esc(clip(who, 26))}</span>` : ""}
            </div>
            <span class="cal-rw-time">${esc(t.timeStr)}</span>
          </div>`;
        }).join("");

        const moreCount = rawEvents.length > 4 ? rawEvents.length - 4 : 0;
        body = `
<div class="cal-card">
  <div class="cal-hd">${markHtml()}<b>Calendly</b><span class="cal-hd-count">${rawEvents.length} upcoming</span></div>
  <div class="cal-hero">
    <div class="cal-hero-top">
      <span class="cal-hero-time">${esc(firstTime.label)}</span>
      <span class="cal-hero-dur">${esc(dur)}</span>
    </div>
    <div class="cal-hero-btm">
      <span class="cal-hero-title">${esc(clip(first.name, 32))}</span>
      ${firstInvitee ? `<span class="cal-hero-who">· ${esc(clip(firstInvitee, 20))}</span>` : ""}
    </div>
  </div>
  ${subsequent}
  ${moreCount > 0 ? `<div class="cal-more">+${moreCount} more meetings</div>` : ""}
</div>`;
        height = 36 + 64 + (Math.min(events.length, 4) - 1) * 44 + (moreCount > 0 ? 24 : 0) + 24;
      }

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height });
      const payload = {
        total_events: rawEvents.length,
        events: events.map((e) => ({
          uuid: e.uuid,
          name: e.name,
          start_time: e.start_time,
          end_time: e.end_time,
          invitees: e.invitees?.map((i: any) => ({ name: i.name, email: i.email })),
        })),
        _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    } catch (err: any) {
      const errCard = renderErrorCard("Upcoming Events", err.message || "Failed to fetch scheduled events.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: err.message,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  }
);

// ==========================================
// TOOL 2: event_types (Read)
// ==========================================
server.registerTool(
  "event_types",
  {
    title: "Event types",
    description: "List active Calendly event types and booking links. Use when the user asks for their Calendly links, meeting types, or booking URLs.",
    inputSchema: {
      active_only: z.boolean().optional().describe("Whether to only return active event types (default true)"),
    } as any,
  },
  async (args: any) => {
    const apiKey = process.env.CALENDLY_API_KEY;
    if (!apiKey) {
      const errCard = renderErrorCard("Setup Required", "Add your Calendly Personal Access Token in settings.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "Missing CALENDLY_API_KEY",
            message: "Please configure your Calendly Personal Access Token in settings.",
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }

    try {
      const userRes = await fetchCalendly("/users/me", apiKey);
      const user = userRes?.resource;
      const userUri = user?.uri;

      if (!userUri) {
        throw new Error("Unable to identify Calendly user from access token.");
      }

      const activeOnly = args?.active_only ?? true;
      const etRes = await fetchCalendly(
        `/event_types?user=${encodeURIComponent(userUri)}${activeOnly ? "&active=true" : ""}`,
        apiKey
      );
      const eventTypes = etRes?.collection || [];

      const CSS = `
.et-card{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:11px 13px 12px}
.et-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.et-hd b{font-size:13px;font-weight:600;color:var(--ink-1)}
.et-hd-count{margin-left:auto;font-size:11px;color:var(--ink-3);font-variant-numeric:tabular-nums;background:var(--fill-1);padding:2px 7px;border-radius:9999px}
.et-rw{display:flex;align-items:center;gap:10px;height:44px;padding:0 2px;border-top:1px solid var(--line)}
.et-rw:first-of-type{border-top:0}
.et-pill{width:32px;height:22px;border-radius:6px;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;flex:none}
.et-mid{flex:1;min-width:0}
.et-name{display:block;font-size:13px;font-weight:600;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.et-slug{display:block;font-size:11px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.et-lnk{margin-left:auto;flex:none;display:flex;align-items:center;gap:4px;font-size:11px;font-weight:500;color:var(--accent);text-decoration:none;padding:4px 8px;border-radius:6px;background:color-mix(in srgb,var(--accent) 10%,transparent)}
.et-empty{padding:18px 12px 14px;text-align:center;background:var(--fill-1);border-radius:10px;border:1px dashed var(--line)}
.et-empty-text{font-size:13px;font-weight:500;color:var(--ink-2)}
.et-empty-sub{font-size:11px;color:var(--accent);margin-top:4px}
`;

      let body = "";
      let height = 150;

      if (eventTypes.length === 0) {
        body = `
<div class="et-card">
  <div class="et-hd">${markHtml()}<b>Booking Links</b><span class="et-hd-count">0 types</span></div>
  <div class="et-empty">
    <div class="et-empty-text">No active event types found in Calendly</div>
    <div class="et-empty-sub"><a href="https://calendly.com/event_types/user/me" style="color:var(--accent);text-decoration:none">Create an event type in Calendly</a></div>
  </div>
</div>`;
        height = 140;
      } else {
        const rows = eventTypes.slice(0, 4).map((et: any) => {
          const dur = et.duration ? `${et.duration}m` : "30m";
          const slug = et.slug ? `/${et.slug}` : "";
          return `
          <div class="et-rw">
            <span class="et-pill">${esc(dur)}</span>
            <div class="et-mid">
              <span class="et-name">${esc(clip(et.name, 34))}</span>
              <span class="et-slug">${esc(clip(slug, 26))}</span>
            </div>
            ${et.scheduling_url ? `<a class="et-lnk" href="${esc(et.scheduling_url)}"><span>Link</span>${ICON.link}</a>` : ""}
          </div>`;
        }).join("");

        body = `
<div class="et-card">
  <div class="et-hd">${markHtml()}<b>Booking Links</b><span class="et-hd-count">${eventTypes.length} active</span></div>
  ${rows}
</div>`;
        height = 36 + Math.min(eventTypes.length, 4) * 44 + 20;
      }

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height });
      const payload = {
        total_event_types: eventTypes.length,
        event_types: eventTypes.map((et: any) => ({
          name: et.name,
          slug: et.slug,
          duration: et.duration,
          scheduling_url: et.scheduling_url,
          active: et.active,
        })),
        _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    } catch (err: any) {
      const errCard = renderErrorCard("Booking Types", err.message || "Failed to fetch event types.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: err.message,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  }
);

// ==========================================
// TOOL 3: event_details (Read)
// ==========================================
server.registerTool(
  "event_details",
  {
    title: "Event details",
    description: "Inspect deep details for a specific scheduled meeting including invitees, video conferencing link, and responses. Use when the user asks for details about a specific booking.",
    inputSchema: {
      event_uuid: z.string().describe("The Calendly event UUID or URI (e.g. from upcoming_events)"),
    } as any,
  },
  async (args: any) => {
    const apiKey = process.env.CALENDLY_API_KEY;
    if (!apiKey) {
      const errCard = renderErrorCard("Setup Required", "Add your Calendly Personal Access Token in settings.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "Missing CALENDLY_API_KEY",
            message: "Please configure your Calendly Personal Access Token in settings.",
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }

    const uuid = extractUuid(args.event_uuid);
    if (!uuid) {
      const errCard = renderErrorCard("Missing Event UUID", "Please provide a valid event UUID.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: "Missing event_uuid parameter.",
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }

    try {
      const eventRes = await fetchCalendly(`/scheduled_events/${encodeURIComponent(uuid)}`, apiKey);
      const ev = eventRes?.resource;

      if (!ev) {
        throw new Error("Meeting not found or already cancelled.");
      }

      let invitees: any[] = [];
      try {
        const invRes = await fetchCalendly(`/scheduled_events/${encodeURIComponent(uuid)}/invitees`, apiKey);
        invitees = invRes?.collection || [];
      } catch {
        // non-fatal
      }

      const invitee = invitees[0];
      const inviteeName = invitee?.name || "Attendee";
      const inviteeEmail = invitee?.email || "";

      // Check for custom answers / responses
      let customResponse = "";
      if (invitee?.questions_and_answers && invitee.questions_and_answers.length > 0) {
        const qa = invitee.questions_and_answers[0];
        customResponse = qa.answer ? `${qa.question ? qa.question + ": " : ""}${qa.answer}` : "";
      }

      const tStart = formatEventTime(ev.start_time);
      const tEnd = formatEventTime(ev.end_time);
      const stampLabel = `${tStart.weekday}, ${tStart.month} ${tStart.day} · ${tStart.timeStr} – ${tEnd.timeStr}`;
      const locInfo = getLocationDetails(ev.location);

      const CSS = `
.ed-card{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px 14px 13px}
.ed-top{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.ed-top b{font-size:12px;font-weight:600;color:var(--ink-3);text-transform:uppercase;letter-spacing:.03em}
.ed-status{margin-left:auto;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:9999px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.ed-status.canceled{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}
.ed-title{font-size:15px;font-weight:600;color:var(--ink-1);letter-spacing:-.015em;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ed-stamp{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-2);font-variant-numeric:tabular-nums;margin-bottom:11px}
.ed-bullet{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}
.ed-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:9px 10px;background:var(--fill-1);border:1px solid var(--line);border-radius:8px}
.ed-col{min-width:0}
.ed-col-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-4);margin-bottom:3px}
.ed-col-val{font-size:13px;font-weight:500;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ed-col-sub{font-size:11px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.ed-note{margin-top:9px;padding:8px 10px;border-radius:8px;background:var(--fill-1);border:1px solid var(--line);font-size:11.5px;line-height:1.45;color:var(--ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
`;

      const isCanceled = ev.status === "canceled";
      const body = `
<div class="ed-card">
  <div class="ed-top">${markHtml()}<b>Meeting Details</b><span class="ed-status${isCanceled ? " canceled" : ""}">${isCanceled ? "Cancelled" : "Active"}</span></div>
  <div class="ed-title">${esc(clip(ev.name || "Scheduled Meeting", 45))}</div>
  <div class="ed-stamp"><span class="ed-bullet"></span>${esc(stampLabel)}</div>
  <div class="ed-grid">
    <div class="ed-col">
      <div class="ed-col-lbl">Invitee</div>
      <div class="ed-col-val">${esc(clip(inviteeName, 22))}</div>
      ${inviteeEmail ? `<div class="ed-col-sub">${esc(clip(inviteeEmail, 26))}</div>` : ""}
    </div>
    <div class="ed-col">
      <div class="ed-col-lbl">Location</div>
      <div class="ed-col-val">${locInfo.icon} ${esc(clip(locInfo.label, 18))}</div>
      ${locInfo.url ? `<div class="ed-col-sub"><a href="${esc(locInfo.url)}" style="color:var(--accent);text-decoration:none">Join link</a></div>` : ""}
    </div>
  </div>
  ${customResponse ? `<div class="ed-note">${esc(clip(customResponse, 180))}</div>` : ""}
</div>`;

      const height = customResponse ? 225 : 180;
      const card = renderCustom({ accent: ACCENT, css: CSS, body, height });

      const payload = {
        uuid,
        name: ev.name,
        status: ev.status,
        start_time: ev.start_time,
        end_time: ev.end_time,
        location: ev.location,
        invitee: { name: inviteeName, email: inviteeEmail },
        response: customResponse,
        _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    } catch (err: any) {
      const errCard = renderErrorCard("Meeting Details", err.message || "Meeting not found or already cancelled.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: err.message || "Meeting not found or already cancelled.",
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  }
);

// ==========================================
// TOOL 4: cancel_event (Act)
// ==========================================
server.registerTool(
  "cancel_event",
  {
    title: "Cancel event",
    description: "Cancel a scheduled Calendly meeting with an optional reason. Use when the user asks to cancel a booking.",
    inputSchema: {
      event_uuid: z.string().describe("The Calendly event UUID or URI to cancel"),
      reason: z.string().optional().describe("Optional cancellation reason shown to the invitee"),
      event_name: z.string().optional().describe("Optional title of the meeting being cancelled (for confirmation display)"),
    } as any,
  },
  async (args: any) => {
    const apiKey = process.env.CALENDLY_API_KEY;
    if (!apiKey) {
      const errCard = renderErrorCard("Setup Required", "Add your Calendly Personal Access Token in settings.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "Missing CALENDLY_API_KEY",
            message: "Please configure your Calendly Personal Access Token in settings.",
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }

    const uuid = extractUuid(args.event_uuid);
    if (!uuid) {
      const errCard = renderErrorCard("Missing UUID", "Please provide the event UUID to cancel.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: "Missing event_uuid parameter.",
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }

    try {
      const reason = args.reason?.trim() || "Cancelled by host";
      await fetchCalendly(`/scheduled_events/${encodeURIComponent(uuid)}/cancellation`, apiKey, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });

      const meetingTitle = args.event_name?.trim() || "Scheduled Meeting";
      const CSS = `
.cn-res{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px 14px 14px}
.cn-res-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.cn-res-badge{font-size:10.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;padding:2px 7px;border-radius:9999px;background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}
.cn-res-title{font-size:14.5px;font-weight:600;color:var(--ink-1);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cn-res-box{padding:9px 11px;border-radius:8px;background:var(--fill-1);border:1px solid var(--line);margin-top:8px}
.cn-res-lbl{font-size:10px;font-weight:600;text-transform:uppercase;color:var(--ink-4);letter-spacing:.03em;margin-bottom:2px}
.cn-res-msg{font-size:11.5px;color:var(--ink-2);line-height:1.4}
`;

      const body = `
<div class="cn-res">
  <div class="cn-res-hd">${markHtml()}<span class="cn-res-badge">Meeting Cancelled</span></div>
  <div class="cn-res-title">${esc(clip(meetingTitle, 40))}</div>
  <div class="cn-res-box">
    <div class="cn-res-lbl">Reason</div>
    <div class="cn-res-msg">${esc(clip(reason, 120))}</div>
  </div>
</div>`;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 145 });
      const payload = {
        canceled: true,
        uuid,
        reason,
        _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    } catch (err: any) {
      const errCard = renderErrorCard("Cancellation Failed", err.message || "Failed to cancel meeting.");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: err.message,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  }
);

// Connect server
await server.connect(new StdioServerTransport());
