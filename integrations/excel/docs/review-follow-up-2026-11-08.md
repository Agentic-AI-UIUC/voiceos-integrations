# November 8 review follow-up

- All three advertised release versions (MCP, package, manifest) are 1.0.4.
- SDK remains pinned to 0.28.0 with disableVersionCheck: true.
- Six confirmation forms use conditional native scrollbars and consistent 64px opaque button footers. Long forms use compact two-column layouts. No scroll-instruction banner or forced scrollbar on short forms.
- Append retains Table Name/ID; chart retains Worksheet and Series By; matrices retain readable JSON rows.
- Headless browser checks cover every editable field after focus/scroll, button backdrop before and after scrolling, and absence of unnecessary scrolling on Create/Rename. Test host button lifts are 40px and 56px at widths 320/480.
- MCP-version parity, target coverage and matrix round-trip regression tests pass. Latest full run: 160 tests, 607 assertions, zero failures.
- Result cards retain all returned range cells and worksheet entries, with overflow scrolling for large responses. The forced result-card scrollbar and text cue were reverted; the outer VoiceOS response is controlled by the host.

## Evidence and deployment

The [November 8 gallery](screenshots/README.md) contains 16 unchanged author captures, including all six write confirmations. These are manual screenshots, not an agent-operated live run. SDK 0.28.0 live read/write verification and publication were recorded previously. The latest source/confirmation layout needs republishing to the same share channel; this commit does not prove the published payload changed.

Share: https://api.voiceos.com/integration-share/09SN91amuePp/page
