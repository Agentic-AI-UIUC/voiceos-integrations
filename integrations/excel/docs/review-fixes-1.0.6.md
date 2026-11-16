# Scoped review fixes - 1.0.6 (November 16, 2026)

Only the three blocking review changes and version bump are included.

1. Range visibility: chose the reviewer's description-based alternative. Both manifest and MCP descriptions explicitly require an address-only range (A1:B4) and a separate worksheet_name for write confirmations. Removed conflicting sheet-qualified examples. Legacy sheet-qualified requests remain accepted by the runtime for compatibility; routing guidance does not guarantee every model request will comply.
2. Unsupported chart title: removed title from the chart input schema, helper-generated metadata and JSON result. The result card displays the provider-returned chart name (or neutral Excel Chart fallback) without claiming a title was set. Chart creation mapping is unchanged.
3. Strict values: JSON-looking malformed arrays/objects are rejected instead of treated as CSV; parsed non-array JSON and empty/zero-width matrices are rejected. Legitimate CSV and typed JSON arrays remain supported. Update and append reject before any provider execution; actual stdio MCP regression tests assert zero calls.
4. MCP, package and manifest now report 1.0.6; build excel-review-v12-strict-values. SDK remains pinned 0.28.0.

Validation: 227 passing tests, zero failures, one explicit skip across ten files. The skipped installed-renderer audit needs a local renderer extract that is no longer present. The agent made no live provider calls for this revision. Author-run VoiceOS logs and original screenshots now verify address-only routing, update/readback, chart creation, and empty/malformed-value rejection.

Published page verified as v1.0.6 on November 16. Current screenshots 07 and 17 are in [the November 16 gallery](screenshots/2026-11-16/README.md). The coding agent did not open/control VoiceOS.

#25 remains open for Mac saved-default/reload QA; the fallback already existed and the historical configuration cause is not proven. #27 remains open for Windows VoiceOS retest; direct-MCP evidence does not replace host testing. #33 can close on merge per reviewer.

Non-blocking no-op renderCustom wrapper and setup wording are intentionally untouched by this scoped request. No issue closure or fabricated live screenshot is included.

## Latest author execution evidence

- 10:31 build: excel-review-v12-strict-values; ten tools; host installed SDK 0.29.0.
- 10:34 update A1:B4: four rows/two columns; 10:35 readback matches Product/Quantity, Laptop/2, Mouse/5, Keyboard/3.
- 10:36 valid [[123]] writes B2 successfully.
- 10:37 empty [] rejected with isError=true and No write attempted.
- 10:39 chart creation succeeds; provider name Chart 1 is displayed, no unsupported title claim.
- 10:41 malformed [[123] rejected with isError=true and No write attempted. Author reports B2 unchanged.
- 11:02 an experimental runtime SDK equality guard blocked initialization. It was removed; it is not part of this commit.
- 11:04 reload / 11:05 List Worksheets succeeds with count=3 after removing that guard.

Repository package/lock pin remains 0.28.0 and disableVersionCheck remains true. The host logs install 0.29.0; this is an unresolved packaging discrepancy, not verified dependency parity. Local tests resolve 0.28.0. No claim is made that the original Mac incident or Windows timeout incident is closed.
