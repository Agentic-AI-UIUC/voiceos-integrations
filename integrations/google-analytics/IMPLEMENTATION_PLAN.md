# Google Analytics integration — implementation plan

Approved tools only: Run report, Run realtime report, Get metadata (via Composio, OAuth2).
Test property: 563733408 (traffic from a local test site).

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

## Stage 2: Descriptions and setup

**Goal**: Short user-facing manifest descriptions (≤2 lines in the Actions panel); full agent
routing rules in server.ts registerTool descriptions; preferences cleaned up (Composio key in
.env like Asana; GA4_PROPERTY_ID kept); setupGuide updated.
**Success Criteria**: Each manifest description fits two lines; agent picks the right tool for
sample questions in VoiceOS.
**Tests**: manifest/server tool names and input schemas stay in sync.
**Status**: Not Started

## Stage 3: Glance cards (UI)

**Goal**: Result cards for report / realtime / metadata, empty-data state, error and
reconnect cards (designed with the user).
**Success Criteria**: Each card reads in 2 seconds; empty and error states are distinct.
**Tests**: card renders for normal, empty and error results.
**Status**: Not Started

## Stage 4: Connection and token UX

**Goal**: Verify and handle not-connected, expired and revoked OAuth (revoke access in the
Google account to reproduce); confirm what loading feedback VoiceOS shows during a tool call.
**Success Criteria**: Each auth failure shows the right message and a reconnect path.
**Tests**: error classification against the real responses captured here.
**Status**: Not Started

## Stage 5: End-to-end in VoiceOS

**Goal**: Reload in Integration Studio and run the full flow by voice on Mac (and Windows if available).
**Success Criteria**: All acceptance criteria in the ticket checked.
**Status**: Not Started
