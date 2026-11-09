# Microsoft Excel: handoff

## Current release

- Integration and package version: 1.0.4.
- Build: excel-review-fixed-v9-footer-layout.
- Local folder: microsoft-excel-643af91a. Do not deploy older development copies.
- SDK: @composio/core pinned to 0.28.0; toolkit: 20261029_00.
- Published November 6, 2026, 12:33:07 America/Chicago.
- Share: https://api.voiceos.com/integration-share/09SN91amuePp/page
- Local verification: 160 tests, 607 assertions across six files (including
  headless Chrome geometry). See REVIEW-STATUS.md and docs/live-qa-2026-11-06.md.

## Implemented scope

Exactly ten public tools: get workbook, get worksheet, read range, list sheets,
create/rename/delete worksheet, update range, append table rows, create chart.
All six writes require a confirmation-button click. The [current gallery](docs/screenshots/README.md)
contains all six confirmation cards plus results and lower-field/option views.
The November 8 gallery shows the current target fields and scrollbar behavior.

## Connection setup

Composio stores Microsoft OAuth credentials. v1 QA uses temporary API-key,
User-ID and required Connected-Account-ID Setup fields. The runtime validates
account ownership, ACTIVE status and Excel toolkit; missing ownership or failed
retrieval blocks execution. Manual setup was approved for v1 QA. Managed account
linking and removal of temporary keys are production follow-ups for VoiceOS.

## Preserve these fixes

- Always set disableVersionCheck: true on Composio construction. The SDK's npm
  upgrade notice must never write into MCP stdout. An exact dependency pin alone
  does not prevent this. Debug logs use stderr.
- Use current raw account retrieval and tools.execute; no deprecated v1 REST or
  alternate SDK fallback. Keep explicit per-action mappings and pinned-schema
  validation. Get Worksheet/Chart use worksheet; ranges use worksheet_id and
  address. Rename uses EXCEL_UPDATE_WORKSHEET.
- Use readExcelCollection for complete normalized lookups. Malformed,
  conflicting, missing or paginated responses block writes. Resolve the exact
  approved table name to its returned ID before append; validate chart sheets.
- Execute each approved write once. Timeout means outcome unknown: inspect
  Excel before retrying. No automatic write retries or invented target IDs.
- Protect the last visible worksheet before deletion.
- Every write input has an editable confirmation field except drive_id and
  Create Worksheet's worksheet_name alias (required name takes priority).
- Append exposes table_name and table_id. Chart exposes worksheet_name and
  Auto/Columns/Rows series_by. Edited values travel through the normal bridge.
- Matrix fields display editable JSON with one row per line and retain types.
- Icons and titles share a flex row. Short inputs use compact columns; only the
  form scrolls, with a separate 112px footer band and 28px end padding. The
  browser regression covers focused fields at two widths/two rail lifts.
- Use the supplied Excel PNG and compact mark; provenance is in ICON-SOURCE.md.
  The chart result is a neutral icon, never fabricated source-data bars.

## Deferred and excluded

List Named Items still needs a verified populated result. Create Workbook needs
pinned path/data-schema verification. Create Table needs verified range-based
creation. None is exposed. Delete Workbook, Delete Table and Create Pivot Table
remain excluded. Do not add another toolkit/OAuth flow without scope approval.

## Evidence limits and production follow-up

November 4 sanitized logs and the 1.0.2 smoke test are historical. November 6
captures are manual author UI evidence for 1.0.4; no raw v9 transcript was supplied.
The agent ran local automated checks and did not control VoiceOS. Success cards
are not proof of cancellation, fresh shared installation, token refresh/revoke
behavior, actual auth scopes or every chart property inside Excel. Verify these
separately. Maintainer review and CI are still required for merging.

Before production, migrate tester keys to managed configuration; implement
verified zero/one/multiple-account selection; document actual requested scopes;
test account lifecycle and cancellation; inspect charts in Excel; review publisher
metadata and a fresh shared installation. Older audit scope lists are unverified.

## Development/deployment

Read AGENTS.md and IMPLEMENTATION-NOTES.md. Run bun install --frozen-lockfile
and bun test. Chrome/Chromium is required for confirmation-layout.test.ts; use
CHROME_BIN to select it. That test skips when no browser is available.
Tests run on demand, never on MCP startup. Keep generated launchers unchanged.
A GitHub push does not republish VoiceOS. Never ship the one-time reload stub or
local recovery backups. No credentials, real .env, private raw logs or node_modules
belong in Git. The Pictures originals remain unchanged.

## November 8 follow-up

See [current changes and evidence](docs/review-follow-up-2026-11-08.md). MCP, package, and manifest versions now all report 1.0.4. The latest local confirmation layout uses conditional scrollbars and a 64px opaque button footer. The previous published 1.0.4 evidence remains historical; republishing the latest changes is pending.
