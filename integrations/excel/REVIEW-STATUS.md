# Review status: Microsoft Excel 1.0.4

Build: excel-review-fixed-v9-footer-layout. SDK 0.28.0, toolkit 20261029_00.
Published November 6 at 12:33 Chicago on the existing share channel.

## Addressed

- SDK version checking disabled and regression-tested to protect MCP stdout.
- Explicit mappings, fail-closed ownership and single-attempt unknown-outcome
  writes retained; no deprecated API fallback.
- Append Table Name, chart Worksheet and Series By appear on editable cards.
- Schema-to-card coverage checks all write properties, exempting only drive_id
  and Create Worksheet's worksheet_name alias.
- Matrices retain JSON row breaks and typed round-trip after edits.
- All six cards reserve a non-scrolling footer; long forms use compact columns.
  Browser geometry checks cover scroll/focus and conservative button positions.
- Readable dropdown options, Excel logo and full titles; neutral chart result.
- All six final confirmation screenshots and results are in the current gallery.
- Version/package numbers agree and author republished 1.0.4.
- 154 tests pass locally (443 assertions), including the available Chrome test.

See [November 6 evidence](docs/live-qa-2026-11-06.md) and
[the final screenshot gallery](docs/screenshots/README.md).

## Remaining release process / separate QA

CI and maintainer approval remain required. Native managed linking, credential
lifecycle, cancellation, fresh shared installation, actual scopes and chart
inspection in Excel are separate follow-ups, not claimed by these success cards.
No VoiceOS UI was opened or controlled by the agent.
