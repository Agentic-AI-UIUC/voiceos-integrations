# Live issue reproductions - November 13, 2026

## Result: PASS

Real registered Excel tools were called through MCP stdio using the saved account context and a local API key supplied by the author. No VoiceOS UI was opened or controlled. Version 1.0.5; resolved SDK 0.28.0; toolkit 20261029_00. Credentials were read from the ignored .env file, never from decrypted app storage and never included in this report.

The workbook initially had neither QA Mac nor Лист1. The run created only QA Mac, QA Mac Blank and Лист1. It seeded disposable chart data, created charts, wrote and read back B2=123, then deleted only those three created sheets. The final worksheet-name inventory matched the initial inventory. Original worksheets were not targeted for writes.

| Check | workbook_id argument | Duration | Result |
| --- | --- | --- | --- |
| Initial worksheet inventory | omitted | 2384 ms | PASS |
| #25 create QA Mac with omitted ID | omitted | 1544 ms | PASS |
| #25 create with blank ID | blank | 2788 ms | PASS |
| Create disposable Cyrillic reproduction sheet | omitted | 3316 ms | PASS |
| Seed disposable chart source | omitted | 1416 ms | PASS |
| #25 exact Cyrillic chart with omitted ID | omitted | 2829 ms | PASS |
| #25 Cyrillic chart with blank ID | blank | 3194 ms | PASS |
| #27 exact Cyrillic B2 equals 123 | omitted | 1601 ms | PASS |
| #27 verify B2 readback | omitted | 1412 ms | PASS |
| Cleanup owned disposable sheet | omitted | 4117 ms | PASS |
| Cleanup owned disposable sheet | omitted | 3685 ms | PASS |
| Cleanup owned disposable sheet | omitted | 3128 ms | PASS |
| Verify original worksheet inventory restored | omitted | 1280 ms | PASS |

## Acceptance interpretation

- #25: both worksheet creation and Cyrillic chart creation used the actual saved default with workbook_id omitted, and with an explicitly blank workbook_id. Neither reported the original missing-workbook error.
- #27: the exact quoted Cyrillic B2 range and numeric [[123]] write succeeded, and a separate real read returned [[123]]. No timeout occurred and no retry was sent.
- This is a fresh Windows/direct-MCP reproduction, not a rerun of the original Mac VoiceOS UI or the original tester's account. It cannot retrospectively determine the original November 9 timed-out B2 value or provider/network cause. The old incident should not be described as proven impossible.
- The author separately confirmed all six Cancel actions leave the workbook unchanged; today's direct-MCP run does not exercise host Cancel.

No new commit, push, issue closure or republish was performed during this follow-up. Raw provider IDs, credentials and original worksheet names are omitted.
