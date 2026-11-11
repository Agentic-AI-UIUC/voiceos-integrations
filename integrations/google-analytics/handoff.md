# Google Analytics: handoff

This VoiceOS integration reads Google Analytics 4 through Composio, using Composio-managed
OAuth2. It is read-only, and its tools are the three approved ones: Run report, Run realtime
report, Get metadata. All runtime code is in `server.ts`. `AGENTS.md` has the file layout,
Composio setup and the dev loop.

## Terms

- **Property ID**: the number for one GA4 site or app (Admin → Property → Property details).
  Every query needs it. It is not the `G-…` Measurement ID on a data stream.
- **Metric / dimension**: what to count (activeUsers, screenPageViews) and what to group by
  (pagePath, country). They must be GA4 API names; `get_metadata` lists them.
- **Composio / user_id / connected account**: Composio stores the Google OAuth token under a
  user_id and runs GA calls with it. We never see the token. Each install has its own user_id
  (`voiceos-<id>`).
- **Glance card**: the card VoiceOS shows in the notch after a tool runs (`_voiceos_glance`).
- **`shortcut:` comment**: a known limit in the code, with when to fix it.

## Before you ship

1. Remove the temporary `COMPOSIO_API_KEY` Setup field from `preferences` in
   `voiceos.integration.json`. Asana has the same field.
2. Copy `.env.example` to `.env` and set your `COMPOSIO_API_KEY`.
3. In platform.composio.dev → Auth Configs, create a Google Analytics auth config (OAuth2,
   Composio managed) in the key's project. Users connect from the reconnect link on the error card.
4. Run `bun test`.
5. Read the open question at the end. It needs an answer from the ticket owner.

## What we built

| Approved | Tool | What the user can ask | Card |
|---|---|---|---|
| Run report | `run_report` | Visitors, views, top pages, sources over any dates; vs an earlier period; one value via a filter | Period, totals (with change when comparing), top 5 rows |
| Run realtime report | `run_realtime_report` | Who is on the site now and on which pages | Active users now, top 5 rows |
| Get metadata | `get_metadata` | What metrics and dimensions they can ask about | Counts, plus every field in a scrolling list |

- No confirmation cards: every tool only reads.
- Empty data and errors have their own cards. When the Google connection is broken (never
  connected, expired, or revoked), the error card has a **Reconnect Google Analytics** link.
  It re-authorizes the existing Composio account, so a dead account is never left beside a new one.
- Loading feedback comes from VoiceOS itself ("Google Analytics: <tool>" in the notch).
- Disconnecting is left to the app store's integration removal (the ticket owner agreed).

## Verified (2026-11-10, macOS, VoiceOS)

- All three tools, by voice, one call per question: realtime by page, realtime with a filter,
  period comparison, an event-count filter, metadata by category, and a property the account
  can't access (403, no reconnect prompt).
- Revoked the Google access at myaccount.google.com/connections, got the card's reconnect link,
  signed in again, and the next question worked on the same Composio account.
- 52 tests (`bun test`), including one that keeps manifest and server schemas in sync and one
  that checks the Studio preview samples against them.

## Not yet verified

- **A standard report with real numbers.** The test property is new, and GA had no standard
  report data on the day. The request and response shapes (totals, comparison, filter) come from
  real GA responses, and realtime (same row and totals code) works with real data.
- **Recovery from a wrong field name** (400 → get_metadata → retry). The agent used the right
  names in every test, so this path never ran.
- **Expired token** (Composio status EXPIRED). It can't be forced. It goes through the same
  classification and reconnect link as the revoke, which was verified.
- **Windows.** No code is OS-specific, and run.cmd is the Studio's own.

## Dev notes

- After a Google revoke, Composio **still reports ACTIVE**, and Google answers 401. So "needs
  reconnect" comes from the 401, not from the status. `POST /connected_accounts/{id}/refresh`
  returns a sign-in link and sets the account to INITIATED; tool calls then return 404 until
  the user finishes.
- A raw metadata response is ~140 KB. `get_metadata` returns only names (~10 KB).
- VoiceOS runs its own copy of the folder and caches the manifest, confirmTools, Setup values
  and icon in its config.json. See AGENTS.md.
- Each card is ~19.5K characters of Widget Kit HTML inside the result. VoiceOS removes
  `_voiceos_glance` before the model reads the result (`extractGlanceFromMcpResult` in the app),
  so cards cost no model tokens. The reconnect link is therefore only on the card, not in the JSON.

## GA4 features in and out of scope

| GA4 capability | Scope | Why |
|---|---|---|
| Standard report (metrics × dimensions over a date range) | `run_report` | Approved |
| Realtime report (last 30 minutes) | `run_realtime_report` | Approved |
| Field metadata (dimensions/metrics a property supports) | `get_metadata` | Approved |
| Batch, pivot, funnel reports; compatibility check | Out | Not approved. Composio has BATCH_RUN_REPORTS and CHECK_COMPATIBILITY; pivot and funnel are not wrapped |
| Listing accounts and properties (Admin API) | Out | Not approved (Composio has LIST_ACCOUNT_SUMMARIES). See open question 1 |
| Writes: properties, settings, custom definitions, audiences | Out | The ticket is read-only |
| Measurement Protocol, BigQuery export, Explorations | Out | Not part of the reporting API |

## Parameters per tool

The agent gets flat arguments; server.ts builds GA's nested request.

**run_report**

| GA4 parameter | Supported as | Notes |
|---|---|---|
| property | `property_id` | `123`, `properties/123`, or the Setup default |
| metrics (≤10), dimensions (≤9) | `metrics`, `dimensions` (string arrays) | |
| dateRanges | `start_date`, `end_date`, `compare_start_date`, `compare_end_date` | Default 7daysAgo → today. At most two ranges, named `current` and `previous` |
| orderBys | `order_by`, `descending` | One sort key. Default: first metric, descending |
| limit | `limit` 1–100 | Default 10 |
| metricAggregations | always TOTAL, returned as `totals` | |
| dimensionFilter | `filter: {dimension, value}` | Exact match, one condition |
| metricFilter, offset, comparisons, cohortSpec, currencyCode, keepEmptyRows, returnPropertyQuota | Not supported | |

**run_realtime_report**

| GA4 parameter | Supported as | Notes |
|---|---|---|
| property, metrics, dimensions | same as run_report | `metrics` defaults to `["activeUsers"]` |
| orderBys, limit | same as run_report | |
| metricAggregations, dimensionFilter | same as run_report | |
| minuteRanges | Not supported | Always the whole 30-minute window |
| metricFilter | Not supported | |

**get_metadata**

| Item | Supported as | Notes |
|---|---|---|
| name (`properties/{id}/metadata`) | built from `property_id` | |
| (ours) `category`, `search` | filters applied after GA answers | GA has no filter of its own |
| Output | `apiName` grouped by category, custom fields included | uiName (searchable but not returned), descriptions, types, comparisons and deprecated names are dropped: ~140 KB → ~10 KB |

## Design decisions

1. **Flat arguments, nested request built in server.ts.** The agent makes fewer mistakes with
   `metrics: ["activeUsers"]` than with GA's `[{name}]` objects and orderBy unions. The cost is
   less expressiveness: one sort key, two date ranges at most.
2. **Default sort by the first metric, descending, limit 10.** Voice questions are mostly
   "top N", and GA does not guarantee row order without orderBys.
3. **Limit capped at 100.** Voice and the notch can't use more rows, and they cost tokens.
   `row_count` is GA's total number of matching rows, so the agent can tell when rows were cut.
   For long trends, the description tells the agent to group by week (`isoYearIsoWeek`) or
   month (`yearMonth`) instead of raising the limit.
4. **Totals on every report.** Without them, the agent adds up rows cut off by the
   limit and confidently reports a total that is too low. This is a correctness fix, so it comes
   before any feature.
5. **One equality filter.** It covers "how many from the US" and "how many
   sign_up_click events" even when that row is outside the top N. Full filter expressions
   (and/or/not, numeric, regex) are left out: rarely asked by voice, and easy for the agent to get wrong.
6. **One comparison period, not up to 4 ranges.** "This week vs last week" is the
   most common analytics comparison. Doing it in one call saves about 3 s of voice latency.
   GA adds a `dateRange` column, which the row mapper already handles.
7. **No minuteRanges, multiple orderBys or offset paging.** These are rarely needed in voice,
   and each one adds an argument the agent can misuse.
8. **Rows as `{field: value}`, metrics as numbers.** GA returns values separately from their
   headers, as strings. Rates such as bounceRate are fractions (0.42, not 42%); the description
   must say so (taken from GA docs, not yet seen in our data).
9. **Dates passed through in GA's own formats** (YYYY-MM-DD, today, yesterday, NdaysAgo). The
   agent turns "last month" into dates. Reports return the property's `time_zone` so the agent
   can say which "today" it means, and the property setting is never changed.
10. **Metadata returns names only.** This keeps it at ~10 KB. `search` also matches display
    names, so "views" finds screenPageViews.
11. **Errors are grouped by what the user can do about them, not by HTTP code.** Reconnect
    (`reconnect: true`) when the account is not connected, expired or revoked. No access to the
    property, wrong field name (send the agent to get_metadata; GA's "Did you mean" guess is often
    wrong), quota used up, bad Composio key, or a Measurement ID given instead of a property ID
    each get a message the user can act on.
12. **No confirmation cards.** All three tools only read data.
13. **Loading feedback comes from VoiceOS.** The notch shows "<integration>: <tool>" while a
    tool runs, so the integration adds no loading UI of its own.

## Open questions for the ticket owner

1. **How does a user find their property ID?** Every query needs it, and an app-store user
   usually doesn't know where to look. The options are approving GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES
   so the agent can list properties, or relying on the Setup guide (GA → Admin → Property
   settings). Until it is decided, the Setup guide explains where to find it.
