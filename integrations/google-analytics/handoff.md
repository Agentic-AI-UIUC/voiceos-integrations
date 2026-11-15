# Google Analytics: handoff

Ask VoiceOS about website or app traffic in Google Analytics 4 (GA4). Read-only. Google
access goes through Composio (OAuth2, Composio managed). All runtime code is in `server.ts`;
`AGENTS.md` covers the files and dev loop.

**Install (published):** https://api.voiceos.com/integration-share/s6AoDEX6OGGX/page

## Setup

1. **Composio key.** Required for now (see #24). At platform.composio.dev, switch the
   workspace to **Platform** (not For You), then **API Keys → Create API key** with Write All.
   Paste it into the Setup page's "Composio API key" field (local dev can use `.env` instead).
   Nothing else to set up in Composio: the first connect creates the Google Analytics auth
   config if the project has none.
2. **Property ID (required).** On the Setup page, enter the GA4 property ID: Google Analytics → Admin →
   Property → Property details. It's digits only. The `G-…` code is the Measurement ID and won't work.
3. **Connect.** Say "connect Google Analytics" (or just ask a GA question). The card has a
   **Connect Google Analytics** link; open it and sign in to Google. Each install has its own Composio user, so
   installs never share a Google account.

The Google account needs at least Viewer access to the property.

## What users can ask

| Tool | Example | Card |
|---|---|---|
| `run_report` | "Top pages last week", "Page views this week vs last week", "How many sign-ups this month?" | Period, totals (± vs previous period), top 5 rows |
| `run_realtime_report` | "How many people are on my site right now, and on which pages?" | Active users now, top 5 rows |
| `get_metadata` | "What metrics can I ask about?" | Field counts and a scrolling list of every field |
| `connect_account` | "Connect Google Analytics" | Connect Google Analytics link, or "connected" |
| `connection_status` | "Is Google Analytics connected?" | Connected / not connected, and why |
| `disconnect_account` | "Disconnect Google Analytics" | Asks first (Cancel / Disconnect), then "disconnected" |

The first three are the approved GA tools, all read-only. The account tools are the
connect/disconnect UI the task asks for; they manage the connection only. Only Disconnect asks
for confirmation.

## QA checklist

| # | Say or do | Expect |
|---|---|---|
| 1 | Fresh install, ask a GA question | Card with **Connect Google Analytics**; after signing in, just ask again and it works |
| 2 | "How many page views in the last 7 days?" | One total, no list of rows |
| 3 | "Top pages in the last 7 days" | Total plus up to 5 pages, largest first |
| 4 | "Page views this week vs last week" | Totals with a +/− % change, or "from 0" if last week had none |
| 5 | "How many people are on my site right now?" | Live count (last 30 minutes) |
| 6 | "What metrics can I query?" | Field card; the list scrolls |
| 7 | Type: "Run a report with the metric pageViews" | Agent fixes it by itself (pageViews → screenPageViews) and answers |
| 8 | Ask about a property the account can't see | "Can't access this GA4 property", with no connect link |
| 9 | A new property with no data yet | "No data for this period" (standard reports lag up to a day) |
| 10 | Revoke access at myaccount.google.com/connections, then ask again | "Access was revoked" + Connect Google Analytics; after signing in again, asking again works |
| 11 | "Is Google Analytics connected?" | "Connected"; no sign-in starts |
| 12 | "Disconnect Google Analytics", then Cancel | Nothing changes; reports still work |
| 13 | "Disconnect Google Analytics", then Disconnect | "Disconnected"; Composio is gone from myaccount.google.com/connections; a report now asks to connect |
| 14 | "Connect Google Analytics" | Connect Google Analytics link; after signing in, reports work |

While a tool runs, the notch shows "Google Analytics: <tool>". That's VoiceOS's own loading state.

## Known limits

- **Not supported:** comparing more than two periods, sorting by more than one field,
  filters other than one exact match, paging past 100 rows, custom realtime windows, and the
  other GA4 APIs (funnels, pivots, admin, writes).
- **Connect and disconnect are by voice.** The cards have no buttons; the Connect link opens
  Google sign-in in the browser.
- **After a revoke outside VoiceOS, Composio still says connected**, so `connection_status` can
  say "connected" until a report fails with "Access was revoked" and a Connect link.
- **No toasts.** VoiceOS gives integrations no toast API; success and failure show as notch cards.
- **Dates follow the property's time zone**, which the answer states when it matters.

## Open questions for the ticket owner

1. **How does a user find their property ID?** Every query needs it, and most users don't know
   where it is. Either approve `GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES` so the agent can list
   properties, or keep relying on the Setup hint (step 2 above).

## Notes for maintainers

- **Two descriptions per tool, on purpose.** The manifest's short line is what users see in
  the Actions panel (cut off after two lines). The one in `server.ts` is the agent's routing
  rules. `tests/manifest.test.ts` keeps their names and input schemas in sync.
- **After a Google revoke, Composio still reports ACTIVE**; Google returns 401. The code treats
  the 401 as "reconnect".
- **The connect link appears only on the card.** VoiceOS strips the card before the model
  reads a result, so the agent never sees the link.
- **The Composio user ID lives in `~/.voiceos/google-analytics-composio-user.json`**, not the
  integration folder, so an update can't lose it (as in Granola 1.0.4). 1.0.0 saved it next to
  `server.ts`; on first start the old ID is copied over, so existing connections keep working.
- **GA totals count each user once**, so a grouped query's totals are the real user count.
- Run `bun test` before every change. The tests use response shapes captured from real GA calls.
