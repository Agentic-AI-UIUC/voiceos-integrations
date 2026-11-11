# Dropbox VoiceOS integration

Version 2.0.15. Build: dropbox-composio-v17-studio-package-parity. Exactly 14 approved Dropbox tools through Composio OAuth2, with write confirmations and green success icons for completed calls. No demo preview targets or placeholder cards.

The November 10 Studio preview for 2.0.14 logged the correct build marker but installed `@composio/core@0.29.0` and `ajv@8.20.0`. The reviewed package pins `0.28.0` and `8.17.1`. Studio retains a separate draft package, so a matching server marker alone does not establish package parity. For 2.0.15, put this release's root `package.json` into the Studio draft along with the root `server.ts` and `voiceos.integration.json`. Save and republish, then check a fresh share-link first-launch log with `node scripts/verify-install-log.mjs <log-file>`. Do not present the share link as package-verified until that check passes.

The root server.ts is the portable runtime: all local helpers are bundled. Keep it with voiceos.integration.json, package.json, icon.png, and the generated launchers when deploying to VoiceOS. The editable code, OAuth setup utility, build scripts, and the offline/browser regression suite are in source/.

## Development

Run npm install at the root and npm install --prefix source. Run npm test for the regression suite, and npm run build to regenerate the root portable server and matching manifest. Rebuild after editing source/; changes there do not modify the deployed bundle automatically. Node 24 is required for the build scripts; VoiceOS runs the packaged server with its bundled Bun.

## Account setup

Enter COMPOSIO_API_KEY and the active Dropbox COMPOSIO_CONNECTED_ACCOUNT_ID in VoiceOS Setup. No separate user ID is required: the selected account owner is retrieved from Composio. Never commit API keys, OAuth tokens, connection.json, or catalog snapshots.

A local OAuth setup screen is embedded in the portable server. From the integration folder, run `npm run setup` (or `node server.ts --setup`) and open the printed localhost URL. Connect or disconnect through Composio there. After authorization, Check connection displays the active account ID; copy it into VoiceOS Setup with your API key and Reload. The page saves only connection identifiers in the local ignored `connection.json`. The VoiceOS host does not currently launch this page from its Setup panel.

## Deployment

Updating repository files does not update VoiceOS automatically. Back up the selected installed folder and deploy the root runtime files, preserving its generated identity and runtime. VoiceOS also caches the installed manifest separately, so its displayed version and action count must match the new manifest. Do not copy credentials or a complete user config into this repository. See REPAIR-NOTES.md for the previous packaging and cache regressions.

Historical 2.0.2 and 2.0.3 checks covered early reads, feedback, and startup. The later Windows 2.0.10 run exercised all 14 tools; the 2.0.11 limit-10 revisions fix has separate live evidence in [the QA report](docs/QA-2026-11-10.md).

## Canonical source and maintenance

This folder is the canonical Dropbox checkout. See CONSOLIDATION.md for the comparison with the former excel/dropbox-work directory. Edit source/, then run npm run build and npm test here.

After building, reusable maintenance commands are:

- node scripts/deploy-portable.mjs "<installed Dropbox folder>" — backs up and deploys the portable release.
- node scripts/verify-installed.mjs "<installed Dropbox folder>" — checks startup, version and 14-tool manifest parity. Set DROPBOX_QA_RUNTIME to the bundled Bun executable to verify that runtime.
- node scripts/repair-installed-record.mjs — dry-run comparison of the cached installed manifest; --apply requires VoiceOS fully stopped and creates a backup. Credentials and unrelated settings are preserved.

Do not commit generated credential/account state or VoiceOS config backups.

## November 9 review

See [review details and evidence limits](docs/REVIEW-2026-11-09.md). Release 2.0.4 applies the Excel confirmation-footer fixes, scrollable result cards, edited-field bridge checks, readable background failures, cancellation and request guards. Run npm run build and npm test from this folder. Live Dropbox actions require separate manual QA; the test suite does not prove token lifecycle or every provider action.

## Upload and branding follow-up

Version 2.0.5 fixes the local-file staging pipeline and overlapping card marks. See [repair details](docs/FIX-2026-11-09-UPLOAD-BRANDING.md), [icon provenance](ICON-SOURCE.md), and [offline card screenshot](docs/screenshots/cards-2.0.5-offline.png). Local file uploads support up to 50 MiB, with exact paths entered without surrounding brackets. SDK staging and the final approved Dropbox upload are separate phases; only the final action changes Dropbox.

## Word document reading

Version 2.0.6 reads text from .docx documents up to 20 MiB. Ask Read a file normally; no conversion or pasted document text is required. Plain text is extracted locally and appears in the card and agent result. See [Word reader and log review](docs/WORD-READING-2026-11-09.md) for limits and verification. Older binary-retrieval-only notes describe historical versions.


## Current native confirmations and live QA

All eight write actions use native card roots with explicit Cancel and Confirm footer actions and bound editable fields. The complete Windows 2.0.10 manual run passed all 14 tools; 2.0.11 fixed revision pages with no continuation cursor and passed a targeted live test. Version 2.0.15 keeps the OAuth setup page behind --setup and pins Composio 0.28.0 across the release packages and lockfiles. See [live QA evidence](docs/QA-2026-11-10.md) and [remaining VoiceOS host UX work](docs/HOST-UX-GAPS.md). Native Mac QA and fresh shared-install verification remain pending. Tool feedback appears as cards and narration; VoiceOS controls any separate native toast. Upload notifications identify phases, not measured byte percentages.
