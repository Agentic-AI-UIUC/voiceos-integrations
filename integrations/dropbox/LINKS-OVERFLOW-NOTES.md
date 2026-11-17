# Shared links and overflow � 2.0.7

Build: dropbox-composio-v9-links-overflow.

The supplied live trace reports completed create/list/revoke shared-link calls. The formatting error in the screenshots occurs in the surrounding VoiceOS narration, after provider success. Do not repeat a completed share operation because narration failed. The final deletion of /temp reported unavailable; this is an actual failed lookup/delete, not a successful deletion. Live Word reading returned extracted text. Raw logs and signed URLs are deliberately excluded from this repository.

Cards now offer Open/Copy controls and optional exact URL display. Query bytes are preserved. Clipboard denial selects the URL with manual-copy instructions rather than claiming it was copied. Unsafe URLs are not clickable. Shared-link content sent to the formatter is compact, with original provider metadata retained in structuredContent.provider_data. Routing guidance requests a brief summary instead of a second formatted link/list. This mitigates the host formatter issue; a fresh VoiceOS retest is still required.

Overflowing card results have a visible translucent vertical slider, keyboard navigation and a More below cue. Short results omit the slider. Native scrolling is retained when scripts cannot run.

Host handoff: the integration iframe cannot modify the parent conversation pane. VoiceOS should add a persistent vertical scrollbar and translucent track to its outer response scroller, plus an overflow cue; verify that revisions below the widget remain reachable at small window heights. Its narration formatter must accept valid Dropbox share URLs without converting a completed action into a retry prompt. No app source is available in this workspace, so these parent changes are not implemented here.

Validation: 82 offline tests pass, including real headless Chrome checks across narrow/wide, light/dark cards, no-overflow and overflow, range/keyboard/resize, clipboard success/denial/unavailability, URL safety and MCP single-execution/provider preservation. Existing 64 confirmation geometry combinations still pass. A rendered revision card was visually inspected. These are offline checks, not live OAuth, provider, or host-formatting certification. No Dropbox writes were made during this repair.

Manual retest after reopening: verify version 2.0.7 and 14 actions; create a link for a disposable existing file (approve once), then list its links. Both should show green completion, Open/Copy controls and a short spoken reply. Test Copy and Show link. List revisions with enough rows to overflow and drag the translucent rail to the final row. If the outside formatting error persists, inspect the successful card and do not repeat the write; it requires the VoiceOS host fix above.
