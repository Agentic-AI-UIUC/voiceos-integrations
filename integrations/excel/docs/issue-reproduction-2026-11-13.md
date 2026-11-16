# SDK alignment and exact-input issue reproductions - November 13, 2026

## SDK mismatch: local cause identified and corrected

The repository and active microsoft-excel-643af91a folder both declared/resolved Composio 0.28.0. Two fresh Studio preview folders (microsoft-excel-39da17e3 and microsoft-excel-fec2f8a0) declared latest with package version 1.0.0. The local shared-install package also declared latest. This explains how fresh Studio installs could report 0.29.0 while the reviewed source stayed at 0.28.0.

Copied the reviewed package.json and bun.lock to those three preview/shared folders, after backing up the originals outside the repository. Frozen-lockfile installs succeeded. Repository, active folder, both preview folders, and local shared install now all declare/resolve SDK 0.28.0 and package version 1.0.5. Generated launchers and credentials were not changed.

New SDK tests assert the exact package pin, lockfile pin and actual resolved module version. A newly generated Studio folder or remote package may still need the same package correction; this local repair does not modify the VoiceOS generator or republish its remote archive. Already-running child processes need a normal restart to reload dependencies.

## Exact issue reproduction coverage

All calls below execute the real registered handlers through stdio MCP. The external Composio class alone is replaced by a deterministic test fixture. Schema fixtures are offline contracts, not live catalog validation. No provider calls or workbook mutations occurred.

| Issue/input | Result |
| --- | --- |
| #25 Create worksheet named QA Mac, workbook_id omitted | One create request uses saved default item_id |
| #25 same request, workbook_id empty string or whitespace | Saved default retained; one request each |
| #25 ColumnClustered chart from Лист1!A1:B3, workbook_id omitted/blank/whitespace | Worksheet preflight succeeds; chart maps worksheet, sourcedata, type and seriesby correctly; saved default used throughout |
| #25 no configured default and no explicit ID | Clear DEFAULT_WORKBOOK_ID error; zero provider execution |
| #27 update 'Лист1'!B2 to [[123]], array input | One mapped update, successful readback [[123]] |
| #27 same update, JSON string input from native confirmation | Parsed types preserved; same request and readback |
| #27 provider accepts update then reports a transport timeout | Result remains outcome unknown; no write retry; suggested read-only verification returns [[123]] |

Result: the reported missing-default error is not reproduced with a configured default in these exact-input offline tests. Cyrillic B2 update mapping and timeout recovery behavior pass. This cannot establish the original tester's B2 contents or reproduce a provider/network incident on their account. User selected offline checks only after saved credentials were found encrypted. No decryption/recovery was performed.

## Verification

192 tests pass, zero fail, 1312 assertions across nine files, including the 36-case native-component layout audit. Run bun test in integrations/excel. The new test file is issue-reproduction.test.ts. SDK drift checks are in sdk.test.ts.

This follow-up is local only; no new Git commit, push, issue closure or republish was performed. The earlier November 13 live logs remain separately labeled as SDK 0.29.0 evidence.

## Later live verification

The author subsequently supplied the API key through an ignored .env file. The [live reproduction report](live-reproduction-2026-11-13/README.md) records successful omitted/blank default-workbook creation/chart calls and actual Cyrillic B2=123 update/readback on SDK 0.28.0, with owned-sheet cleanup. The earlier offline-only limitation above describes the previous phase.
