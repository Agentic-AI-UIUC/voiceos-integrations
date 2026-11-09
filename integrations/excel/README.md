# VoiceOS Microsoft Excel integration

Microsoft Excel Cloud tools for VoiceOS Agent Mode, executed through Composio with a Microsoft 365 OAuth-connected account. VoiceOS selects tools and narrates results; this integration does not run a separate LLM agent.

## Release status

Current release: **1.0.4**, build `excel-review-fixed-v9-footer-layout`, SDK **0.28.0**. It is republished on the existing share channel. See [current QA evidence](docs/live-qa-2026-11-06.md) and [today's ordered screenshots](docs/screenshots/README.md). All six confirmation cards expose approved inputs and separate scrolling fields from the floating footer. Credential lifecycle, cancellation and fresh installation remain separate QA.

The verified setup uses a manually configured Connected Account ID. Automatic discovery by User ID is not a verified replacement. The API-key field is intentionally temporary for v1/QA.

## Supported actions

| VoiceOS action | Composio action | Approval |
| --- | --- | --- |
| Get workbook | `EXCEL_GET_WORKBOOK` | Read only |
| Get worksheet | `EXCEL_GET_WORKSHEET` | Read only |
| Get cell range | `EXCEL_GET_RANGE` | Read only |
| List worksheets | `EXCEL_LIST_WORKSHEETS` | Read only |
| Create worksheet | `EXCEL_ADD_WORKSHEET` | Confirmation |
| Rename worksheet | `EXCEL_UPDATE_WORKSHEET` | Confirmation |
| Delete worksheet | `EXCEL_DELETE_WORKSHEET` | Destructive confirmation |
| Update cell range | `EXCEL_UPDATE_RANGE` | Confirmation |
| Add table rows | `EXCEL_ADD_TABLE_ROW` | Confirmation |
| Create chart | `EXCEL_ADD_CHART` | Confirmation |

List Named Items, Create Workbook, and Create Table are deferred. Delete Workbook, Delete Table, and pivot creation are excluded. See [HANDOFF.md](HANDOFF.md) for limitations and production work.

## Setup in VoiceOS

1. Connect Excel/Microsoft 365 in the Composio dashboard using your own account and project.
2. In the VoiceOS integration Setup fields, enter your tester project API key, the connection's owning Composio User ID, and its active Connected Account ID. Use the same project for the key and connection.
3. Optionally set the workbook driveItem ID and drive ID. Use actual IDs, not file URLs or Auth Config IDs.
4. Keep the Excel toolkit version at the live-tested `20261029_00` unless separately validating a migration.
5. Check that startup reports `excel-review-fixed-v9-footer-layout` and discovery reports ten tools.

The execution path reads tool schemas and executes tools through the current Composio SDK. Connected Accounts Read is used to verify ownership and ACTIVE status. No proxy execution is used. Do not broaden key permissions without identifying the endpoint that needs them.

Do not paste secrets into code, issue comments, screenshots, or Git history. `.env.example` contains empty placeholders only. VoiceOS injects Setup values as environment variables; an `.env` file does not populate the VoiceOS Setup page.

## Local development

```sh
bun install --frozen-lockfile
bun server.ts
```

The MCP server uses standard input/output and logs its build marker to stderr. It waits for a client; exit with Ctrl+C. Regression checks run only through `bun test`, not on startup. Starting the server does not prove live Excel execution.

Keep the generated runtime declaration and launchers unchanged. Runtime dependencies are declared in `package.json`; retain `bun.lock` when sharing the source.

## Files

- `server.ts`: tool handlers, Composio execution, and embedded verification checks.
- `voiceos.integration.json`: tools, setup preferences, permissions, and confirmations.
- `widgetKit.ts`: existing result/confirmation HTML utilities.
- `studio-meta.json`: Studio metadata and illustrative preview fixtures; not proof of live execution.
- `run.cmd` / `run.sh`: generated Windows/macOS launchers.
- `icon.png`, `package.json`, `bun.lock`, `AGENTS.md`: generated assets, dependencies, and development contract.
- `HANDOFF.md`, `.env.example`, `.gitignore`: handoff, configuration reference, and Git exclusions.

## QA

Use a disposable worksheet and a workbook you can modify. Verify reads against Excel, then test create/rename/write/chart/delete with approval. Cancel a write first and verify no change. For Add Rows, manually create a real Excel table over the test data, use its exact name/ID, append once, and read back. Creating a worksheet or writing cells does not create a table. Delete the disposable worksheet only after testing its other operations.

Publish through VoiceOS separately from uploading this source to GitHub. Verify a fresh installation, tool count, confirmations, and build marker; local edits may not replace the installed copy automatically. Published share: https://api.voiceos.com/integration-share/09SN91amuePp/page

## CI regression tests

Run `bun install --frozen-lockfile` and `bun test`. There are 160 tests across six files, covering account validation, ten-tool parity, explicit mappings, complete lookups, write timeouts, SDK stdout protection, confirmation input coverage, edit round-trips and footer geometry. The headless layout test requires Chrome/Chromium (`CHROME_BIN` may specify its path); it skips if unavailable. Fake-client tests do not call Composio. The browser test loads local HTML only. Importing the server does not open the MCP transport.

Read [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md) before modifying the working
flow. Keep the SDK pinned to 0.28.0, including after Studio regenerates an export.

## November 8 follow-up

See [current changes and evidence](docs/review-follow-up-2026-11-08.md). MCP, package, and manifest versions now all report 1.0.4. The latest local confirmation layout uses conditional scrollbars and a 64px opaque button footer. The previous published 1.0.4 evidence remains historical; republishing the latest changes is pending.
