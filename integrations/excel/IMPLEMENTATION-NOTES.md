> Update November 11: the v5 collection/mapping safeguards below remain relevant. The current 1.0.5 candidate uses native confirmation cards, SDK 0.28.0, and separate request deadlines. See docs/QA-FIXES-1.0.5.md for current tests and live-QA limits.

# Excel integration: working implementation reference

Recorded November 1, 2026. Working build: `excel-review-fixed-v5-collections`.
SDK: `@composio/core` 0.27.0. Default Excel toolkit version: `20261029_00`.

The user confirmed that the implementation is now working after retesting in
VoiceOS. This is user-reported live validation, not an independently recorded
provider trace. The locally observed checks were 130 passing offline tests and
MCP discovery of exactly 10 tools. Do not infer cancellation, token refresh, or
every chart property was verified from this general confirmation.

## Preserve this approach

1. Keep explicit per-action parameter mappings. Get Worksheet, Delete Worksheet,
   List Tables, and Create Chart use `worksheet`; range actions use
   `worksheet_id` and `address`. Rename uses `EXCEL_UPDATE_WORKSHEET`. Validate
   mappings against the fetched version-specific schema before execution. Do
   not guess new aliases or treat the latest public docs as the pinned schema.
2. Use `readExcelCollection` for worksheet cards and write preflights. Supported
   responses include `value`, `worksheets`, `sheets`, `tables`, direct arrays,
   and `data`/`response_data` wrappers. Reject malformed, conflicting, error,
   and paginated responses; never interpret an unknown response as an empty list.
3. Before chart creation, verify the exact worksheet exists. Before append,
   resolve the approved table name/ID to the stable ID returned by the internal
   read-only `EXCEL_LIST_TABLES` lookup. Never silently choose another target.
4. Before deletion, verify the requested worksheet and protect the last visible
   sheet. Lookup failures must stop deletion, not fall through to a write.
5. Execute each approved write once. On timeout, report outcome unknown and ask
   the user to inspect Excel before retrying. No automatic write retries,
   worksheet-name suffixing, or duplicate appends/charts.
6. Preserve manual account selection for v1 QA and raw account ownership,
   toolkit, and ACTIVE-status validation. Keep secrets in Setup/environment.
   Do not introduce discovery or OAuth changes during unrelated fixes.
7. Keep all six write confirmation cards and exactly ten exposed MCP tools.
   Internal table lookup adds no public tool or second OAuth connection.
8. Interactive preview sample arguments must omit workbook/drive IDs so saved
   defaults apply. Dummy IDs belong only in isolated illustrative fixtures.

## Why earlier fixes regressed

The target preflight accepted only Graph's `value` array, while the working
worksheet reader already handled other collection formats. Tests using only
`value` passed but missed the live response mismatch. Delete also reused the
range action's `worksheet_id` parameter, which its catalog rejected.

## Regression workflow

- Run `bun test`: `server.test.ts` and `collections.test.ts` currently total
  130 offline tests. Tests run on demand, not on MCP server startup.
- Cover complete lookup-to-SDK-execution sequences as well as pure helpers.
  Include every supported collection envelope, empty and malformed data,
  incomplete pages, duplicate targets, lookup failures, and single-write count.
- Fake-client schema fixtures are test contracts, not live schema evidence.
  When a real response reveals a new shape, add a sanitized regression fixture
  and verify it through the execution boundary before changing production code.
- Test MCP initialization and `tools/list`; verify ten tools and manifest parity.
- Deploy to the actual VoiceOS folder selected by Show in File Explorer, reload,
  and confirm the startup build marker. Compare file hashes with the PR checkout.
  A GitHub push alone does not update the installed/published VoiceOS app.
- Finally retest the affected actions in VoiceOS against a disposable sheet and
  real table. Inspect changes in Excel, use unique append markers, and delete
  the disposable sheet only after explicit confirmation.

This reference documents a working baseline, not a guarantee against future
provider schema changes. Keep the previous version backed up before edits.

## November 13 follow-up: exact issue inputs and SDK drift

Current validation is 192 offline tests plus real 0.28.0 MCP reproductions of omitted/blank default workbook creation/chart calls and quoted Cyrillic B2=123 update/readback. See docs/live-reproduction-2026-11-13/README.md. The tested disposable sheets were cleaned up and original inventory restored. Fresh Studio preview packages were found declaring latest despite the canonical pin; align package.json AND bun.lock, run a frozen install, and verify the resolved dependency rather than trusting a server build marker. A local fix does not change the host generator or remote share archive. Do not automatically retry writes or claim a past provider incident is explained by a passing current run.
