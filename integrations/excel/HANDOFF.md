# Microsoft Excel: handoff

## Verified version

- Build marker: `excel-manual-account-restored-v1`.
- Original live-tested folder: `microsoft-excel-461badac`; current setup-corrected export: `microsoft-excel-8d2ea718` (same runtime code).
- Composio Excel toolkit version: `20261029_00`.
- Ten exposed actions have successful live responses against a real workbook.
- Shared startup logs report 32 embedded verification checks passed. These are separate from live execution evidence.

The runtime and manifest in this repository come from that folder, not the older `microsoft-excel-d96d8761` development copy. Do not attribute the older copy's 65-test suite to this release.

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

Run `bun install --frozen-lockfile` and `bun test` from `integrations/excel`. `server.test.ts` runs 49 offline tests, including the 32 embedded checks, tool/manifest consistency, confirmation declarations, and range/chart mappings. These checks do not execute Composio actions or replace the previously reported live VoiceOS QA. Importing `server.ts` does not open the MCP transport; direct launcher execution still does.
