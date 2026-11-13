# Excel 1.0.5 review status - November 13, 2026

Share: https://api.voiceos.com/integration-share/09SN91amuePp/page (page reports v1.0.5, updated Nov 13).

Build: excel-qa-v11-compact-confirmations. MCP/package/manifest versions agree. Exactly ten tools and six native Cancel/Confirm cards.

## Evidence

- 180 offline tests pass, zero failures, 1257 assertions across eight files. Native-component browser audit covers 36 width/content cases; the installed renderer extract is local-only and the test skips when unavailable.
- [Today's manual screenshots](screenshots/2026-11-13/README.md) show every tool result, all six confirmations, and all six cancellation responses.
- [Sanitized live log](live-qa-2026-11-13.txt) has successful responses from all ten actions, including six writes and update readback. It installs Composio 0.29.0; repository/active package declarations pin 0.28.0. This dependency mismatch is unresolved; do not label that run a 0.28.0 live test.
- [Local visual audit](local-ui-audit/README.md) separates component measurements from real host evidence.

## Remaining acceptance limits

- #25: default fallback has offline coverage; today's live calls explicitly include workbook_id. Original Mac blank-ID behavior needs targeted verification.
- #26: full workbook IDs and visible native footers are shown in the new screenshots.
- #27: today's Windows update/readback succeeds. The original timed-out B2 write and provider cause remain unknown; no retry or false-success behavior was introduced.
- #33: native cancellation is implemented and Cancel responses are shown. Add provider readback or correlated host logs to prove cancelled writes leave data unchanged.
- SDK 0.28.0 remains pinned with disableVersionCheck:true. Resolve the reported 0.29.0 installed-runtime discrepancy before asserting source/published dependency parity.
- Maintainer approval and CI on the new commit remain required. Issues are not closed by this evidence update.
