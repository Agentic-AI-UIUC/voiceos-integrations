# Microsoft Excel: handoff

## Local candidate and published evidence

- Local version: **1.0.5** in MCP server, package and manifest.
- Build: **excel-qa-v11-compact-confirmations**.
- SDK pinned to **0.28.0**, with disableVersionCheck: true. Toolkit: **20261029_00**.
- Local source: microsoft-excel-643af91a; PR checkout: integrations/excel on feat/excel-ui-fixes.
- Existing share: https://api.voiceos.com/integration-share/09SN91amuePp/page
- Earlier live evidence and November 8 screenshots describe 1.0.4 widget confirmations. They do **not** verify the new native confirmations or establish the latest shared payload.
- The share page reports **1.0.5**, updated November 13. Today's manual live log and screenshots are linked in REVIEW-STATUS.md; the local SDK drift has been corrected and real 0.28.0 reproduction evidence is now recorded in REVIEW-STATUS.md.

## What changed

See [QA-FIXES-1.0.5](docs/QA-FIXES-1.0.5.md) for issue-by-issue limits and retest steps.
All six writes now use native card confirmations with editable fields and explicit Cancel/Confirm footer actions. Widget confirmation HTML, footer placeholders, fixed heights and their clipping workarounds are no longer shipped in the manifest. Result cards still use widgetKit.ts and retain the supplied Excel logo.

All ten tools share call-time default-workbook resolution. A blank confirmed ID retains Setup; explicit ID overrides it. Full IDs wrap on workbook/list cards and in read-only native workbook text. Timeouts distinguish schema from execution, use separate bounds, and never retry a write. Update-range timeout responses include a read-only verification request. Background execution is declared for bounded requests that may exceed 20 seconds; it is not a promise that VoiceOS supports arbitrarily long calls.

## Scope and connection

Exactly ten actions: Get Workbook, Get Worksheet, Get Range, List Worksheets, Create/Rename/Delete Worksheet, Update Range, Add Table Rows, Create Chart. No new public helper capabilities were added. Manual API key, owning User ID, and Connected Account ID remain the approved v1 QA setup. Composio holds Microsoft OAuth credentials. Ownership, Excel toolkit and ACTIVE status must verify before execution; unknown ownership fails closed.

List Named Items, Create Workbook and Create Table remain deferred/unverified. Delete Workbook, Delete Table and pivot creation remain excluded. Do not add a second toolkit connection or automatic account discovery during unrelated fixes.

## Validation and limits

Local tests cover explicit mappings, target collection envelopes, account validation, blank/default ID handling, stdio discovery/version parity, timeout stages/no retries, native field bindings/actions, typed JSON parsing and large result scrolling. Native views also passed an offline check against the installed host UI schema. These do not prove a live Cancel response, a provider write, or the original Windows B2 outcome. Do not close #25/#26/#27/#33 solely on these tests.

A fresh disposable-sheet reproduction now writes and reads back Cyrillic B2=123 successfully. This cannot retrospectively determine the original tester's November 9 B2 state. Never repeat a past uncertain write merely to infer its outcome; a late completion is possible.

## Production and handoff

- VoiceOS team owns managed-key/account-linking migration; remove the temporary tester API-key field when that is ready. Current paste-key setup is intentional.
- Actual Microsoft scopes remain pending verification. Historical audit mentioned Files.ReadWrite, Sites.ReadWrite.All, offline_access and User.Read; do not label them confirmed current scopes.
- The author verified cancellation leaves the workbook unchanged for all six writes. Fresh shared installation, token expiry/revocation/refresh and independent macOS host behavior remain production/environment checks.
- November 13 native-form screenshots and all-ten-tool live results are included. Preserve earlier captures as historical evidence.
- Check publisher metadata before production. A GitHub push is not a VoiceOS publication.
- Keep generated launchers/runtime unchanged; never commit credentials, private logs, config backups or node_modules.

## Operational details

Get Worksheet and chart use worksheet; range tools use worksheet_id/address. Rename uses EXCEL_UPDATE_WORKSHEET, not a guessed rename slug. A table must exist before appending; a named range is insufficient. Get Workbook may return no worksheet relationship; use List Worksheets. Neutral chart-result artwork is not a preview of the actual created chart.

Current local validation: **192 tests passed, zero failed, 1312 assertions across nine files**. Actual offline stdio initialization reports version 1.0.5 and ten tools.

## Current confirmation UX

All six action targets are editable with labels above inputs. Related fields share compact horizontal rows; Workbook stays read-only on its own line. Update/append JSON is single-line to avoid the native fixed-height textarea. Series By is an editable text field labeled Auto, Columns, Rows to avoid unreadable host select options. Cancel/Confirm are native footer actions. No widget placeholder or forced scrollbar is used. See REVIEW-STATUS.md for current evidence and limitations.

## SDK package repair and exact issue inputs

[November 13 reproduction report](docs/issue-reproduction-2026-11-13.md) records corrected preview/shared latest dependency declarations, frozen installs, and ten new offline MCP reproduction cases. Latest total: 192 tests pass. The initial offline phase made no live Excel writes and decrypted no stored key. The subsequent live phase below used the author-supplied ignored .env key. Future Studio regeneration and remote archive dependency parity still need checking before claiming a permanent host-level packaging fix.

## Live default-workbook and Cyrillic update verification

[November 13 direct MCP run](docs/live-reproduction-2026-11-13/README.md) now verifies real provider execution on pinned SDK 0.28.0: omitted/blank workbook ID creation and chart calls succeed; quoted Cyrillic B2=123 writes and reads back. All three disposable test sheets were removed and original worksheet inventory restored. No app UI was controlled. This supersedes the earlier offline-only follow-up; historical Mac/provider-incident limits remain explicit.
