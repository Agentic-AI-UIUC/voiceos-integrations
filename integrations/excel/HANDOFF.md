# Microsoft Excel: handoff

For the current review outcome, read [REVIEW-STATUS.md](REVIEW-STATUS.md) and [LIVE-QA.md](LIVE-QA.md). Earlier version sections below are historical.

## Previously live-tested version

- Build marker: `excel-manual-account-restored-v1`.
- Original live-tested folder: `microsoft-excel-461badac`; current setup-corrected export: `microsoft-excel-8d2ea718` (same runtime code).
- Composio Excel toolkit version: `20261029_00`.
- Ten exposed actions have successful live responses against a real workbook.
- The previous build ran 32 embedded verification checks at startup. The current build runs those checks only under bun test.

The original runtime and manifest came from that folder. Review fixes now change the execution boundary and require a fresh live run. Do not treat previous live results as proof of the current build. Do not use the older `microsoft-excel-d96d8761` development copy. Do not attribute the older copy's 65-test suite to this release.

## What is implemented

Get workbook properties; get worksheet; read range; list worksheets; create, rename, and delete worksheet; update range values; append table rows; create chart. Composio holds the Microsoft OAuth credentials. VoiceOS Setup supplies the temporary project API key and account context. Reads have no confirmation declaration; all six write actions have confirmation cards.

## Current connection setup

The verified flow passes `COMPOSIO_CONNECTED_ACCOUNT_ID` directly to Composio with the configured User ID. Automated User-ID account discovery caused regressions and was reverted for the successful test run.

Dario explicitly approved manual Connected Account ID setup for v1 QA. The manifest now requires the ID and explains where to copy it. Automatic User-ID lookup remains deferred production work.

Dario approved temporary paste-key setup for v1/QA and advised not blocking release on a native OAuth UI. The production managed-key and account-linking migration belongs to the VoiceOS team.

## Deferred and excluded functionality

| Functionality | Evidence / follow-up |
| --- | --- |
| List Named Items | Calls returned empty despite a name visible in Excel. Verify exact workbook, Workbook-level name scope, saving/synchronization, and response parsing. Not live verified for a populated result. |
| Create Workbook | Last shared live attempt failed on missing `path`. Check the exact pinned schema before choosing structured generation or file-content upload. Current-docs examples were not a verified snapshot of `20261029_00`. |
| Create Table | No verified live creation. Inspect the pinned schema; do not fabricate an existing `table_id` to satisfy a broken create contract. |
| Delete Workbook / Delete Table | Excluded under agreed v1 scope. Do not introduce another toolkit/OAuth connection without approval. |
| Create Pivot Table | Excluded under agreed v1 scope. |
| User-ID connection discovery | Not verified after lookup/ownership regressions. Retain manual account selection for QA. |

## Before production

1. Replace tester credentials with the VoiceOS team's managed configuration and remove the temporary `COMPOSIO_API_KEY` Setup field when that flow is ready. It remains intentionally available for QA today.
2. Implement account selection/linking with verified ownership and zero/one/multiple-match handling; never select another user's account or interpret an absent owner field as a proven mismatch.
3. Record the actual Microsoft scopes requested by this project's Composio auth config. **Pending verification.** The older audit mentioned `Files.ReadWrite`, `Sites.ReadWrite.All`, `offline_access`, and `User.Read`; do not represent those as confirmed current scopes.
4. Republish the setup-corrected integration and verify the share-link installation requires the Connected Account ID. The GitHub update alone does not update VoiceOS hosting.
5. Confirm cancellation makes no change, confirmations display the resolved target, and loading/success/error notifications behave correctly in VoiceOS.
6. Test expired/revoked tokens and reconnection. Existing-account success does not prove token refresh or the full account lifecycle.
7. Publish, test a fresh installation, and add the VoiceOS share URL, source repository URL, and test evidence to UIUC-15. Review publisher metadata before public distribution; it currently uses the generated publisher identity.

## Known operational details

- Different actions use different parameter names. Get Worksheet uses `worksheet`; range actions use `worksheet_id` and `address`. Parse quoted sheet-qualified ranges before mapping.
- Rename uses `EXCEL_UPDATE_WORKSHEET`. `EXCEL_RENAME_WORKSHEET` produced a live 404 and is not a valid substitute for this release.
- Reading a nonexistent sheet returns `ItemNotFound`. Resolve actual sheet names before concluding the range implementation failed.
- A recreated worksheet has no table until one is explicitly created. An existing table name/ID is required to append rows.
- An empty worksheet relationship in Get Workbook does not establish that the workbook has no sheets; use List Worksheets.
- On write timeout, inspect the workbook before retrying; completion may be uncertain. Avoid duplicate appends and charts.
- Do not infer that a chart's title/type/grouping is verified solely from a creation ID; visually inspect the chart.

## Development and deployment

Read `AGENTS.md`, retain `bun.lock`, and use `bun install --frozen-lockfile` followed by `bun server.ts`. Embedded checks do not replace live QA. The generated launchers must remain unchanged.

Keep all runtime assets together, especially `widgetKit.ts`. A GitHub upload does not publish or update the installed VoiceOS integration. Compare the actual running build marker with the source being reviewed.

Do not commit credentials, private execution logs, `.env`, or `node_modules`. Review Studio fixtures and Git history for sensitive values before making the repository public.

## CI regression tests

Run `bun install --frozen-lockfile` and `bun test` from `integrations/excel`. `server.test.ts` runs 66 offline tests, including the 32 embedded checks, tool/manifest consistency, confirmation declarations, and range/chart mappings. These checks do not execute Composio actions or replace the previously reported live VoiceOS QA. Importing `server.ts` does not open the MCP transport; direct launcher execution still does.

## Review fixes: excel-review-fixed-v2

- Pin @composio/core to 0.27.0 and use its current raw connected-account retrieval and tools.execute APIs. Deprecated v1 HTTP and alternate SDK execution paths were removed.
- Require the configured account's raw user_id to match COMPOSIO_USER_ID, with matching account ID, Excel toolkit and ACTIVE status. Missing owner data or failed retrieval blocks execution; no ownership bypass or cached approval.
- Use explicit per-action mappings. The pinned provider schema validates fields and required inputs; it does not choose aliases. A contract mismatch blocks the call.
- Write timeouts report an unknown outcome and tell users to inspect Excel before retrying. No automatic create-name suffixing or delete retry.
- Run regression checks only via bun test. Current automated result: 66 offline tests passed. Account and execution-boundary tests use injected fake clients, not live Composio results.
- Studio fixtures use dummy workbook/drive identifiers. Historical commits may still contain the former identifiers.
- Manual QA setup remains intentional; native OAuth changes should be coordinated with the VoiceOS team rather than introduced during this fix.

Fresh live validation is REQUIRED before merge: create a disposable sheet; write and read back a small range; rename it; append one uniquely marked row to a real test table; create and visually inspect a chart; delete the disposable sheet after confirmation. Record build marker, action, arguments, result, visible workbook change, and confirmation/cancellation behavior. No fresh live results have been recorded for this revision yet.
## Target-resolution follow-up: excel-review-fixed-v4-targets

Fresh v3 logs confirmed reads, worksheet creation and range updates. The chart request named a worksheet that had not been renamed in that run. Table append returned a provider 404 despite the table being visible in Excel; the underlying provider/name issue is not independently proven.

Charts now validate the requested sheet against the current workbook worksheet list. They report available names instead of silently substituting another sheet. Table append internally reads EXCEL_LIST_TABLES for the workbook's worksheets and resolves the exact approved table name/ID to a provider-returned stable ID before one append attempt. This is a read-only implementation helper, not an additional exposed MCP tool. It uses the same account and pinned schema validation; no proxy or new OAuth connection. Missing, ambiguous or incomplete lookup results block the write.

74 offline tests pass, including missing sheets, stable table-ID resolution, missing tables, lookup failures and pagination safety. A successful live append/chart on this build has not yet been recorded. Use the actual worksheet name from List Worksheets when retesting; do not claim permanent live success from these tests.
## Current working baseline: excel-review-fixed-v5-collections
On November 1, 2026, the user confirmed the integration is working after live VoiceOS retesting. Local verification: 130 offline tests passed and MCP discovery returned 10 tools. Earlier v2/v4 pending-live notes above are historical. This confirmation does not independently establish every acceptance criterion. See IMPLEMENTATION-NOTES.md for the implementation method and regression safeguards.

## SDK upgrade — November 3, 2026

Current dependency pin: `@composio/core` **0.28.0**, with regenerated `bun.lock`.
The 0.27.0 references above record the earlier reviewed baseline. No action
mapping, toolkit version, ownership validation, or confirmation behavior changed.
Offline regression tests and an actual SDK API-shape check pass. Fresh live
Microsoft/Composio execution on 0.28.0 is pending author testing; older live
results do not establish live compatibility of this upgrade.

## Published branding update — November 4, 2026

The author republished version `1.0.1` at the existing share URL:
https://api.voiceos.com/integration-share/09SN91amuePp/page

The local server was verified byte-identical to the reviewed real implementation
before committing. The temporary one-time reload stub and recovery backups are
local recovery artifacts and are not included in this repository.
