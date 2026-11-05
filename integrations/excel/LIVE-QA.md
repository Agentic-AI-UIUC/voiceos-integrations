# Live QA - November 4, 2026

Build: excel-review-fixed-v7-inline-brand. Integration/package version: 1.0.1.
SDK: @composio/core 0.28.0; toolkit: 20261029_00.
Share: https://api.voiceos.com/integration-share/09SN91amuePp/page

The author supplied fresh VoiceOS logs from 19:23:44-19:33:11 America/Chicago.
Startup discovered ten tools; subsequent results cover all four reads and all
six writes. This meets the requested minimum of one live read and one live
write on the SDK-updated implementation. The local server contains
`disableVersionCheck: true`; the reused build marker alone does not prove
which source bytes ran. No SDK upgrade notice appears in the supplied log.

| Action | Selected successful result time |
| --- | --- |
| Get workbook | 19:24:53 |
| List worksheets | 19:25:16 |
| Get worksheet | 19:25:42 |
| Create worksheet | 19:27:02 |
| Update range | 19:27:26 |
| Read range | 19:27:42 |
| Rename worksheet | 19:28:11 |
| Append table rows | 19:29:13 |
| Create chart | 19:29:38 |
| Delete worksheet | 19:30:12 |

See [sanitized successful results](docs/live-qa-2026-11-04.md) and the
[ordered screenshot gallery](docs/screenshots/README.md). The excerpt removes
repeated calls and error traces, with omitted failures explicitly disclosed.
Original logs/screenshots remain unchanged outside the repository.

All six current confirmation cards are pictured. Confirmation action buttons
require user clicks. The append screenshot has an empty Table ID field; the
execution trace includes the correct table_name. This remains a UI binding
follow-up, not evidence that every confirmation field is populated.

Local verification: 141 tests pass, including the version-check regression.
The agent did not open VoiceOS or run live calls.

**Republishing after this test remains pending**, confirmed by the author.
The earlier share version 1.0.1 predates this SDK stdout fix. After republishing,
record the share's updated timestamp. Cancellation, fresh installation,
expired/revoked credentials, actual scopes, and chart inspection in Excel
remain separate QA; tool success and result screenshots do not prove them.
