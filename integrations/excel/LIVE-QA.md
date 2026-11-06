# Historical live QA - November 4, 2026

Current release evidence: [version 1.0.4, November 6](docs/live-qa-2026-11-06.md).

Build: excel-review-fixed-v7-inline-brand. Integration/package version: 1.0.2.
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

## Post-publication smoke test - version 1.0.2

Saved publication metadata confirms 2026-11-05T01:48:03.985Z
(November 4, 19:48:03 America/Chicago), using the existing share channel.
The real local server was verified byte-identical to the repository; no reload
stub or recovery backup is committed.

The author's supplied subsequent log reports SDK 0.28.0 and ten discovered
tools at 19:48:25. Results:

| Time | Action | Observed result |
| --- | --- | --- |
| 19:49:27 | List worksheets | Successful list |
| 19:50:23 | Create Publish QA 102 | Created |
| 19:50:51 | List worksheets | Publish QA 102 present |
| 19:51:11 | Delete Publish QA 102 | Deleted; raw success true |

No Upgrade available notice occurs in the supplied excerpt. The disabled SDK
version-check option, not absence of a notice alone, protects future starts.
Deletion was acknowledged; no final list after deletion was supplied. Logs do
not independently capture button clicks. All six confirmation layouts and
successful earlier live writes are documented in the November 4 gallery/logs.

Republishing and the requested minimum live read/write test are complete.
Maintainer approval/CI remain merge requirements. Cancellation, fresh shared
installation, credential lifecycle, actual scopes and chart appearance inside
Excel remain separate QA and are not established by these logs.