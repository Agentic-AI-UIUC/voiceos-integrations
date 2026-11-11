# Resolved for Dropbox: native confirmation cards

Since 2.0.9, all eight Dropbox writes use native card confirmations with explicit Cancel/Confirm footer actions. Windows live checks verified Cancel sends no request and edited folder paths reach execution. The full manual run supplied on November 10 covers all 14 tools. Native Mac acceptance remains pending. See docs/CONFLICT-FEEDBACK-2026-11-10.md.

## Historical widget issue (superseded)

# Missing Cancel control and macOS verification

Observed on Windows: the pre-execution Create folder widget displays editable destination and a host-owned Create folder button, but no Cancel control. This is the actual confirmation, not a completed result. Manifest confirmations exist for all eight write actions. The bundled Widget Kit explicitly says no card may draw its own approve/cancel control; the documented bridge exposes no cancellation command. Therefore do not add a decorative Cancel button, invent a postMessage API, or dispatch a second confirmation from the server.

Message for Dario:

> The Dropbox Create folder confirmation appears before execution with an editable destination and a Create folder button, but no Cancel button (Windows screenshot attached). Our manifest declares the confirmation, and the bundled Widget Kit says VoiceOS owns the buttons and integrations must not draw their own. Is Cancel supported for root.type=widget confirmations on both Windows and macOS? Please confirm the supported dismissal mechanism or fix the missing host control. Cancelling must dismiss the pending call without sending an MCP request.

## 2.0.8 portability update

Clipboard fallback wording is platform-neutral. Browser regression tests discover Chrome/Chromium on macOS as well as Windows/Linux, or use CHROME_BIN. Production provider/file code uses Node filesystem and URL APIs; launchers retain the generated zsh/Bun and Windows entry points. UI is inline HTML/CSS in the VoiceOS webview, without OS-specific cancellation logic. No native macOS execution was available here, so platform support is not certified by Windows-only tests.

## Native Mac acceptance check

1. Install the portable integration and confirm startup version 2.0.8, 14 tools and OAuth account selection.
2. Request creation of a disposable folder; verify pending destination edits, host Confirm and an actual cancellation/dismissal route. Cancel and verify no create_folder MCP request and no new folder. Repeat and approve once.
3. Repeat cancel checks for all write confirmations, including overwrite, restore, share and revoke. Read tools must not ask for approval.
4. Test upload from a real /Users/... path containing spaces; then read the Word text. Windows paths are not valid Mac local paths.
5. Test shared-link Open/Copy (including denied clipboard permissions), light/dark rendering, narrow cards, trackpad/range/keyboard scrolling and the final revision row. Use Command+C if copying manually.
6. Confirm no action is sent twice after cancellation, timeout or narration failure. Inspect Dropbox before retrying any unknown write outcome.

The host must supply the outer conversation scroller and Cancel behavior. A Windows screenshot or simulated macOS user agent cannot prove native Mac behavior.
