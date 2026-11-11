# Google Analytics integration — implementation plan

Approved tools only: Run report, Run realtime report, Get metadata (via Composio, OAuth2).
Test property: 563733408 (traffic from a local test site). Its time zone is America/Los_Angeles;
reports return it as `time_zone` and the agent states it, so the property setting stays as is.

## Stage 1: Composio layer, data shaping, tools return JSON

**Goal**: Rewrite server.ts in the Asana section layout: .env loading, Composio v3.1 client,
GA queries (property ID resolution, rows → objects, slim metadata), errors in plain words,
and the 3 tools wired to them (JSON only, no glance cards yet). Manifest input schemas match.
**Success Criteria**: `bun test` passes; the 3 tools return real data for the test property
when called through the MCP server.
**Tests**: property ID parsing; report rows → objects with numeric metrics; empty report;
order_by → GA orderBys; metadata slimming + category/search filters; error classification
(no connection, 401, 403 no access, 400 bad field, bad API key).
**Status**: Complete
**Notes**: Raw metadata is ~140 KB, slimmed to ~10 KB. The Google account must be connected in
the same Composio project as COMPOSIO_API_KEY (`composio link` uses the CLI's own project);
auth config `ac_JJrwvDywwsHH` (Composio-managed OAuth2) was created there for user `default`.

## Stage 1.5: Run the repo in local VoiceOS

**Goal**: VoiceOS loads this folder, not its own copy.
**Status**: Complete
**Notes**: custom-mcps/google-analytics-06dc2061 is a symlink to this folder. VoiceOS caches
the manifest, confirmTools, Setup values and the icon (`iconDataUrl`) in config.json; after
changing the manifest or icon.png run `bun ~/voiceos-dev/sync-voiceos.ts integrations/google-analytics`
(kept out of this repo on purpose). Changes to server.ts alone need only a restart.

## Stage 2: Descriptions and routing

**Goal**: Short user-facing manifest descriptions (≤2 lines in the Actions panel); full agent
routing rules in server.ts registerTool descriptions; setupGuide rewritten (Composio key in
.env like Asana; GA4_PROPERTY_ID kept, with where to find it). Add the three query features
decided in "Scope and design decisions" below: totals, one equality filter, and an optional
comparison period.
**Routing fixes found in VoiceOS testing**:
- "How many people are on my site and which pages?" made two realtime calls (first without
  dimensions). The description should say to include dimensions in the same call when the user
  asks *which* pages, countries or devices.
**Success Criteria**: Each manifest description fits two lines; the 5 VoiceOS test questions
route to the right tool in one call.
**Tests**: manifest and server.ts list the same tool names and input schemas; only the 3
approved tools, none with a confirmation card; Actions panel descriptions ≤80 chars; network
permission is only backend.composio.dev; totals, filter and comparison request/response shapes
(taken from real GA responses).
**Status**: Complete. The user checked VoiceOS: the Actions panel fits, and all 4 voice tests
took one call each. The Setup guide was then shortened to two short sections at the user's request.

## Stage 3: Glance cards (UI)

**Goal**: Result cards for report / realtime / metadata, empty-data state, error and
reconnect cards. Minimalist style (user's choice).
**Design**: Only the Widget Kit's stock blocks (vHeader, vStats, vList, vEmpty, vNote), with
no custom CSS and no accent. vHeader draws `title` as a small eyebrow and `subtitle` large, so
the eyebrow names the card type (Report / Right now / Fields / Google Analytics) and the large
line names the period or scope. Each card has at most 3 blocks: header, GA's totals as stats
(up to 3, with the change vs the previous period when comparing), and up to 5 top rows.
Counts are compact (12.3k), rates shown as %, durations as 2m 5s. Empty data uses vEmpty and an
error uses vNote plus "Reconnect needed" when relevant, so neither looks like a normal result.
The card logo is set from icon.png at startup (setIntegrationMark), so INTEGRATION_MARK in
widgetKit.ts no longer matters. If rendering a card fails, the data still goes out, without a card.
**Unverified**: each card is ~19.5K chars of HTML inside the result. Per AGENTS.md VoiceOS
shows `_voiceos_glance` and does not pass it to the model, but the logs can't confirm that.
**Tests**: number/rate/duration formatting, change vs previous, period labels; the text each
card shows for normal, comparison, empty, metadata and error results (cards.test.ts).
**Status**: In Progress. Code and tests (44) are done, and previews were checked in a browser.
Waiting on the user's visual check in the VoiceOS notch.

## Stage 4: Connection and token UX

**Goal**: Not-connected, expired and revoked OAuth each show the right message and a way to
reconnect that an end user can follow.
**Found by revoking access at myaccount.google.com/connections**:
- After a revoke, Composio **still reports ACTIVE**, and a failed call doesn't change that.
  Google answers 401 (successful:false, status_code 401). So "needs reconnect" comes from the
  tool-level 401, not from the account status alone.
- POST /connected_accounts/{id}/refresh re-authorizes the same account: it returns a
  redirect_url and sets the status to INITIATED. While INITIATED, execute returns 404
  ActionExecute_ConnectedAccountNotFound, which reads as "isn't connected yet".
- Token refresh itself needs no code: Composio refreshes expired access tokens. Only a dead
  refresh token (revoked or expired) reaches us, as the 401 above.
**Built**: when reconnecting is the fix, the result carries `reconnect_url` and the error card
has a "Reconnect Google Analytics" row that opens it. Re-authorizing reuses the newest
existing account, so no dead ACTIVE account is left next to a new one; with no account, a
first link goes through the project's enabled auth config. The agent is told to point the user
to the link and not to retry until they have signed in. If no link can be made, the
developer-facing dashboard message is used.
**Loading feedback** is built into VoiceOS: while a tool runs, the notch shows
"<integration>: <tool name>" (AGENT_STATUS_TOOL_EXECUTING).
**Disconnect** is out of scope by the user's decision: the app store handles integration
removal.
**Verified 2026-11-10 in VoiceOS**: after the revoke, the card showed the reconnect row. The
link opened Google sign-in, and the next question worked on the same account (ca_OsEQpxe1HAoc).
**Tests**: link generation (re-auth newest / first link / no auth config), fallback message, no
link for errors reconnecting won't fix, error card link row.
**Status**: Complete

## Stage 5: End-to-end in VoiceOS

**Goal**: The full flow by voice on Mac (and Windows if available).
**Done 2026-11-10**: revoke → reconnect link → working again (Stage 4); realtime by page, metadata by category, empty 7-day report (answered
honestly), 403 on a property without access (no reconnect prompt). There were no failed calls,
and each answer came 3–6 s after the question.
**Still to check**: a report with data (needs about a day after the property was created);
recovery from a wrong field name (400, then get_metadata, then retry), which didn't trigger
because the agent already used the right name; the OAuth flow from Stage 4.
**Success Criteria**: All acceptance criteria in the ticket checked.
**Status**: In Progress

---

# Scope and design decisions (handoff)

Decided 2026-11-10. Parameter lists checked against the Composio tool schemas
(GOOGLE_ANALYTICS_RUN_REPORT, _RUN_REALTIME_REPORT, _GET_METADATA) and server.ts.

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
| dateRanges | `start_date`, `end_date`; Stage 2 adds `compare_start_date`, `compare_end_date` | Default 7daysAgo → today. At most two ranges, named `current` and `previous` |
| orderBys | `order_by`, `descending` | One sort key. Default: first metric, descending |
| limit | `limit` 1–100 | Default 10 |
| metricAggregations | Stage 2: always TOTAL, returned as `totals` | |
| dimensionFilter | Stage 2: `filter: {dimension, value}` | Exact match, one condition |
| metricFilter, offset, comparisons, cohortSpec, currencyCode, keepEmptyRows, returnPropertyQuota | Not supported | |

**run_realtime_report**

| GA4 parameter | Supported as | Notes |
|---|---|---|
| property, metrics, dimensions | same as run_report | `metrics` defaults to `["activeUsers"]` |
| orderBys, limit | same as run_report | |
| metricAggregations, dimensionFilter | Stage 2: same as run_report | |
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
4. **Totals on every report (Stage 2).** Without them, the agent adds up rows cut off by the
   limit and confidently reports a total that is too low. This is a correctness fix, so it comes
   before any feature.
5. **One equality filter (Stage 2).** It covers "how many from the US" and "how many
   sign_up_click events" even when that row is outside the top N. Full filter expressions
   (and/or/not, numeric, regex) are left out: rarely asked by voice, and easy for the agent to get wrong.
6. **One comparison period (Stage 2), not up to 4 ranges.** "This week vs last week" is the
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
2. **Every user shares one Google connection.** The Composio key is the developer's (.env), and
   VoiceOS passes no user identity, so all installs use the same Composio project and
   user_id `default`. Once more than one person installs it from the app store, they would all
   read the same Google account's data, and one person's reconnect replaces everyone's. The
   Asana integration has the same issue. Fixing it needs a per-user ID from VoiceOS (or a
   per-user Composio key), which this integration cannot provide.
