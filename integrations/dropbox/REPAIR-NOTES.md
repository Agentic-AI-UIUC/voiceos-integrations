# Dropbox startup repair

Current integration version: **2.0.13**. Startup marker: `dropbox-composio-v15-setup-startup-guard`. Manifest, package and MCP initialize response share the same version constant. The portable single-file packaging fix remains in place.

Version 2.0.3 removes all demo preview fixtures and dummy executable targets. Completed provider calls render a green success-check SVG in the existing widget shell. Error results never include this success widget. Empty successful collections have an explicit empty-state message. The 47 offline checks cover these feedback rules as well as portable startup, account checks and write-count regressions. User logs independently confirmed live folder listing, search and file read on version 2.0.2; they did not validate every action.

The previous helper-file copy was not portable across VoiceOS Studio generations. Two generated folders retained a five-tool manifest while server.ts imported absent catalog.ts and provider.ts. The v3 release embeds local code in server.ts and restores manifest/server parity at 14 tools.

Required Setup: Composio project API key plus the active Dropbox connected account ID. User ID is retrieved from the exact selected account, never guessed as default. Provider account retrieval must still prove Dropbox, OAuth2, raw owner and ACTIVE status; any explicit owner override is checked.

Current verification: 92 offline checks, including clean-folder stdio MCP startup, the portable OAuth page, 14-tool discovery, owner/account validation, expired and revoked account errors, write-count and cancellation regressions, and the cursorless revisions case. The November 10 Windows run exercised all 14 tools on the connected account; version 2.0.11 also passed the targeted live limit-10 revisions check. Native macOS VoiceOS QA is still pending.

VoiceOS also caches the manifest in config.json under installedIntegrations. The stale cached record explained the persistent 1.0.0/five-action UI after disk deployment. With VoiceOS fully stopped, repair-installed-record.mjs updates only the matching Dropbox cached manifest and the matching server's confirmation list, preserving all credentials, IDs, launch configuration and unrelated settings. It creates a backup, checks for concurrent writes, atomically replaces the file and verifies the parsed result. A remaining background VoiceOS process must be stopped first.

The separately saved Studio draft can still be older than the installed record. Retain the portable server, matching manifest and package in that draft; reapplying old source recreates the regression.

## Version 2.0.4 review

See docs/REVIEW-2026-11-09.md for the Excel comparison, confirmation/result layout changes, request/error guards and verification limits. Runtime, manifest and package versions must match. All writes still require confirmation; malformed lookups never authorize writes. Keep SDK notices off MCP stdout and do not infer live provider conformance from fake-schema tests.

## Version 2.0.5

Use the catalog-declared staged-file input and manual Composio files.upload before DROPBOX_UPLOAD_FILE execution. Preserve exact binary file bytes and approved Add/Overwrite behavior. Card headers must have one in-flow data-k-mk slot; never allow the automatic mark bar to overlap the status glyph. Deploy the PNG and widget kit along with the server and synchronize cached icon metadata. See docs/FIX-2026-11-09-UPLOAD-BRANDING.md for verification and live-test limits.

## Version 2.0.6

Word reads now fetch the Composio-returned file reference and extract DOCX text locally. Preserve host validation, bounded downloads/ZIP expansion, cancellation and error status; do not return a successful text-read card for a parser failure. Keep Mammoth/yauzl runtime dependencies in the deployed package and verify actual installed SDK/parser versions. See docs/WORD-READING-2026-11-09.md.


2.0.7: shared-link Open/Copy controls, exact query preservation, compact summaries and visible card overflow rail. See LINKS-OVERFLOW-NOTES.md for host limitations and validation.

2.0.8: platform-neutral clipboard fallback, Mac Chrome discovery for browser tests. Missing host Cancel control and native Mac acceptance checklist: CONFIRMATION-HOST-REPORT.md. Cancel is not fixed by this release.

2.0.10: action-specific conflict advice, repaired shared-link text, current native-card/manual-QA notes. No SDK/provider mapping changes. See docs/CONFLICT-FEEDBACK-2026-11-10.md.
2.0.11: accept valid partial revision pages with has_more=true and no cursor; other paginated collections still require a cursor. The November 10 Windows log showed limit 10 fail and limit 100 succeed. Built portable server and installed/cached manifest updated after 88 local tests passed. Native macOS execution remains unverified.
2.0.12: bundle the localhost Composio OAuth2 Connect/Disconnect page into the one-file server with a `--setup` mode. Its account ID appears after authorization. The shared package no longer depends on the source folder for setup. The VoiceOS host still needs a native Setup-panel launcher, toast API, and measured upload-progress API to satisfy the original UX request literally.

2.0.13: start the local OAuth page only for --setup; normal MCP startup now has a regression assertion that the page did not start. Windows VoiceOS loaded 2.0.12 and all 14 tools, exposing the unintended page startup. Node and Bun each pass 92 tests for 2.0.13.
