# Excel 1.0.5 review status - November 13, 2026

Share: https://api.voiceos.com/integration-share/09SN91amuePp/page (page reports v1.0.5, updated November 13).

Build: excel-qa-v11-compact-confirmations. MCP/package/manifest versions agree. Exactly ten tools and six native Cancel/Confirm cards. SDK pin: 0.28.0, toolkit 20261029_00.

## Current evidence

- **192 offline tests pass**, zero failures, 1312 assertions across nine files. This includes ten exact-input MCP issue reproductions, resolved-SDK/pin checks, and 36 native-component layout cases. The installed-renderer audit explicitly skips when its local extract is unavailable.
- [Manual author screenshots](docs/screenshots/2026-11-13/README.md) show all ten results and all six native confirmations/cancellation responses. The author separately confirmed that Cancel on each write leaves the workbook unchanged. This is author-reported manual verification, not agent observation of the host UI.
- [Real provider reproduction on SDK 0.28.0](docs/live-reproduction-2026-11-13/README.md) verifies creation/chart calls with workbook_id omitted and blank, Cyrillic B2=123 update and readback, and cleanup of all three disposable sheets. Original worksheet inventory was restored.
- [SDK package drift investigation](docs/issue-reproduction-2026-11-13.md) found fresh Studio previews and the local shared package declaring latest. Their package/lockfiles were aligned and frozen installs verified. All five local source/install folders now declare and resolve 0.28.0.
- [Earlier all-ten-tool live log](docs/live-qa-2026-11-13.txt) installed 0.29.0. It remains historical evidence, not a live 0.28.0 run.
- [Local visual audit](docs/local-ui-audit/README.md) distinguishes component measurements from the full host overlay.

## Issue disposition

| Issue | Evidence and limits |
| --- | --- |
| #25 default workbook ignored | Omitted and blank ID creation/chart calls pass against the real provider. Tests exercise the registered MCP handlers. Original Mac host UI was not independently rerun. |
| #26 clipped IDs/fields | Full workbook IDs and visible native footers appear in current manual screenshots. Component geometry checks pass at three widths. |
| #27 Windows range timeout | Exact quoted Cyrillic B2=123 write/readback passes live now. Simulated accepted-write timeout stays unknown with no retry. The original tester's past B2 state and provider cause remain unknown. |
| #33 missing Cancel | Native Cancel/Confirm on all six writes; screenshots show cancellation responses and author confirms workbook unchanged. |

## Release and reviewer limits

- Fresh Studio generation can overwrite package metadata again. Local repair does not modify VoiceOS's generator or prove the remote archive's dependency pin. A future fresh install must retain the reviewed package.
- Single-line JSON was chosen at the author's request to keep footers visible. It preserves JSON nesting/types but trades multiline readability for horizontal caret navigation. Series By uses editable text to avoid unreadable native dropdown options. Reviewer acceptance of this compact alternative remains appropriate.
- These findings do not close the issues automatically or prove the original external incidents impossible. Maintainer approval and CI on the new commit remain required. No additional tools were exposed.
