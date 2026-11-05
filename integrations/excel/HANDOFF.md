# Microsoft Excel: handoff

## Current version and evidence

- Integration/package: 1.0.1; build: excel-review-fixed-v7-inline-brand.
- Local folder: microsoft-excel-643af91a. Avoid older development exports.
- @composio/core: exactly 0.28.0; Excel toolkit: 20261029_00.
- 141 local tests pass. Regression checks run under bun test, not startup.
- November 4 author-supplied live logs contain successes for all ten actions.
  See [LIVE-QA.md](LIVE-QA.md), [sanitized results](docs/live-qa-2026-11-04.md),
  and [ordered screenshots](docs/screenshots/README.md).
- Share: https://api.voiceos.com/integration-share/09SN91amuePp/page
- **Republish after the latest stdout fix/test is pending.** The author will
  do this manually; the earlier 1.0.1 publication does not include this fix.

## Implemented

Get workbook, get worksheet, read range, list worksheets, create/rename/delete
worksheet, update range, append table rows, and create chart. Exactly ten
public tools are exposed. All six writes require a confirmation-button click;
reads do not. Results include structured data and VoiceOS cards.

Composio stores Microsoft OAuth credentials. v1 QA uses temporary Setup fields
for the project API key, user ID, and required Connected Account ID. Ownership,
ACTIVE status and toolkit are checked; missing ownership or retrieval failure
blocks execution. Automatic discovery and managed linking are production work.

## Preserve these fixes

- Always set disableVersionCheck: true on Composio construction. Otherwise a
  newer npm release can cause upgrade notices to corrupt MCP stdout. An SDK
  version pin alone does not prevent this. Keep the exact 0.28.0 dependency pin.
- Use current SDK retrieval and tools.execute; no deprecated v1 REST fallback.
- Keep explicit action mappings and validate against the pinned catalog schema.
  Get Worksheet/Chart use worksheet; ranges use worksheet_id and address.
  Rename uses EXCEL_UPDATE_WORKSHEET, not a guessed rename action.
- Read collections through readExcelCollection. Unknown, incomplete, conflicting
  or paginated results must block writes. See IMPLEMENTATION-NOTES.md.
- Resolve the approved table name to its returned ID before appending; validate
  the exact chart worksheet. Never substitute another target or invent IDs.
- Execute each approved write once; on timeout report outcome unknown and tell
  the user to inspect Excel before retrying. Never auto-retry writes.
- Protect the last visible sheet when deleting.
- Keep confirmation icons and titles in a normal flex row. The supplied Excel
  PNG is used throughout; ICON-SOURCE.md documents the assets.
- Chart result uses a neutral icon and tells users to open Excel. Never present
  fabricated bars as a preview of actual workbook data.

## Deferred scope

List Named Items needs a verified populated response; Create Workbook requires
checking the pinned path/data schema; Create Table needs verified range-based
creation. None is exposed. Delete Workbook, Delete Table and Create Pivot Table
remain excluded. Do not add another toolkit/OAuth flow without scope approval.

## Before production / separate QA

- Republish this tested source, then verify a fresh share-link installation.
- Replace tester API-key Setup with managed configuration when ready.
- Implement verified account selection/linking with zero/one/multiple matches.
- Record actual requested Microsoft scopes. Older audit scopes are not proof
  of the project's current auth configuration.
- Test cancellation with no side effect, notifications, expired/revoked tokens,
  reconnection and refresh. Existing-account successes do not prove lifecycle.
- Inspect chart properties in Excel; a creation ID/card is not visual proof.
- Append confirmation currently shows a blank Table ID field in the supplied
  screenshot, although the logged call contains the correct table_name. Treat
  full target-field display as a UI binding follow-up.
- Review publisher metadata before public distribution.

## Development and deployment

Read AGENTS.md. Run bun install --frozen-lockfile and bun test. Keep generated
launchers and all runtime assets together. A GitHub push does not republish
VoiceOS. Never ship the one-time reload stub or local recovery backups.

No secrets, real .env files, node_modules or private raw execution logs belong
in Git. The current public log excerpt is sanitized and selected; it discloses
omitted duplicate-name and preflight-timeout attempts rather than claiming the
entire session was error-free. Original source evidence stays with the author.
