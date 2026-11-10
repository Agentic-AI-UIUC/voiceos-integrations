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
.env like Asana; GA4_PROPERTY_ID kept).
**Routing fixes found in VoiceOS testing**:
- "How many people are on my site and which pages?" made two realtime calls (first without
  dimensions). The description should say to include dimensions in the same call when the user
  asks *which* pages, countries or devices.
**Success Criteria**: Each manifest description fits two lines; the 5 VoiceOS test questions
route to the right tool in one call.
**Tests**: manifest and server.ts list the same tool names and input schemas.
**Status**: Not Started

## Stage 3: Glance cards (UI)

**Goal**: Result cards for report / realtime / metadata, empty-data state, error and
reconnect cards (designed with the user).
**Context**: With no card returned, the VoiceOS agent improvises its own ```ui list block
(seen for get_metadata), so our cards must read better than that. widgetKit.ts's
INTEGRATION_MARK still embeds the old icon; update it to match icon.png.
**Success Criteria**: Each card reads in 2 seconds; empty and error states are distinct.
**Tests**: card renders for normal, empty and error results.
**Status**: Not Started

## Stage 4: Connection and token UX

**Goal**: Not-connected, expired and revoked OAuth each show the right message and a way to
reconnect (revoke access in the Google account to reproduce expired/revoked). Decide how an end
user connects: auth config + POST /connected_accounts/link returns a redirect URL for a
Connect button.
**Already known**: Loading feedback is built into VoiceOS. While a tool runs, the notch
shows "<integration>: <tool name>" (AGENT_STATUS_TOOL_EXECUTING), so the integration adds none.
**Success Criteria**: Each auth failure shows the right message and a reconnect path.
**Tests**: error classification against the real responses captured here.
**Status**: Not Started

## Stage 5: End-to-end in VoiceOS

**Goal**: The full flow by voice on Mac (and Windows if available).
**Done 2026-11-10**: realtime by page, metadata by category, empty 7-day report (answered
honestly), 403 on a property without access (no reconnect prompt). There were no failed calls,
and each answer came 3–6 s after the question.
**Still to check**: a report with data (needs about a day after the property was created);
recovery from a wrong field name (400, then get_metadata, then retry), which didn't trigger
because the agent already used the right name; the OAuth flow from Stage 4.
**Success Criteria**: All acceptance criteria in the ticket checked.
**Status**: In Progress
