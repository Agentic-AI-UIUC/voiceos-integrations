# Google Analytics: handoff

Ask VoiceOS about website or app traffic in Google Analytics 4 (GA4). Read-only. Google
access goes through Composio (OAuth2, Composio managed). All runtime code is in `server.ts`;
`AGENTS.md` covers the files and dev loop.

## Setup

1. **Composio key.** Copy `.env.example` to `.env` and set `COMPOSIO_API_KEY` (a full-access
   project key). The Setup page also has a temporary "Composio API key" field; remove it from
   `voiceos.integration.json` before release. Nothing to set up in the Composio dashboard: the
   first connect creates the Google Analytics auth config if the project has none.
2. **Property ID.** On the Setup page, enter the GA4 property ID: Google Analytics → Admin →
   Property → Property details. It's digits only. The `G-…` code is the Measurement ID and won't work.
3. **Connect.** Ask any GA question. The first answer is a card with a **Connect Google
   Analytics** link; open it and sign in to Google. Each install has its own Composio user, so
   installs never share a Google account.

The Google account needs at least Viewer access to the property.

## What users can ask

| Tool | Example | Card |
|---|---|---|
| `run_report` | "Top pages last week", "Page views this week vs last week", "How many sign-ups this month?" | Period, totals (± vs previous period), top 5 rows |
| `run_realtime_report` | "How many people are on my site right now, and on which pages?" | Active users now, top 5 rows |
| `get_metadata` | "What metrics can I ask about?" | Field counts and a scrolling list of every field |

These are the only three tools (the approved ones). None asks for confirmation, because none changes anything.

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

While a tool runs, the notch shows "Google Analytics: <tool>". That's VoiceOS's own loading state.

## Known limits

- **Not supported:** comparing more than two periods, sorting by more than one field,
  filters other than one exact match, paging past 100 rows, custom realtime windows, and the
  other GA4 APIs (funnels, pivots, admin, writes).
- **No disconnect button.** Removing the integration disconnects it. See open question 2.
- **No toasts.** VoiceOS gives integrations no toast API; success and failure show as notch cards.
- **Dates follow the property's time zone**, which the answer states when it matters.

## Open questions for the ticket owner

1. **How does a user find their property ID?** Every query needs it, and most users don't know
   where it is. Either approve `GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES` so the agent can list
   properties, or keep relying on the Setup hint (step 2 above).
2. **How should disconnect work?** The ticket asks for a connect/disconnect UI and also for
   exactly three tools; today an integration can't have both. VoiceOS's manifest schema
   already defines `auth: { kind: "oauth2", provider, authorizationUrl, tokenUrl, scopes, pkce }`,
   which looks meant to give integrations the same Connect/Disconnect button as built-in apps.
   But VoiceOS 0.1.40 only reads `auth.kind === "apiKey"`; `oauth2` is not implemented yet.
   Options:
   - **Wait** for VoiceOS to implement `auth.oauth2`, then declare it and drop our own connect code.
   - **Add connection tools** (`connect_account`, `connection_status`, `disconnect_account`),
     as Todoist and Teams do. They manage the connection only, but go beyond the three approved tools.
   - **Add a Setup toggle**, as GitHub does: switching it off revokes the Composio connection.

## Notes for maintainers

- **Two descriptions per tool, on purpose.** The manifest's short line is what users see in
  the Actions panel (cut off after two lines). The one in `server.ts` is the agent's routing
  rules. `tests/manifest.test.ts` keeps their names and input schemas in sync.
- **After a Google revoke, Composio still reports ACTIVE**; Google returns 401. The code treats
  the 401 as "reconnect".
- **The connect link appears only on the card.** VoiceOS strips the card before the model
  reads a result, so the agent never sees the link.
- **GA totals count each user once**, so a grouped query's totals are the real user count.
- Run `bun test` before every change. The tests use response shapes captured from real GA calls.
