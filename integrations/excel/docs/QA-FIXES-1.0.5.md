# Excel QA fixes: 1.0.5 (November 11, 2026)

Build: excel-qa-v11-compact-confirmations. SDK: 0.28.0. Excel toolkit: 20261029_00.
This is a local candidate, not a published or live-verified release.

## Open issue audit

| Issue | Local implementation | What remains |
| --- | --- | --- |
| #25 Default workbook | All ten handlers and the SDK argument mapping use one call-time resolver. Omitted, null, empty and whitespace-only IDs retain DEFAULT_WORKBOOK_ID. Explicit IDs win. Real offline stdio calls for Create Worksheet and Create Chart with blank IDs reach the credential boundary instead of the missing-workbook error. Tool descriptions instruct the agent to resolve the default via Get Workbook and include it on write cards. | The reported Mac failure was not reproduced against the old live payload. Retest Setup saving/reload and the new shared build; do not claim its original deployment cause is established. |
| #26 Clipped IDs / fields | Get Workbook and List Worksheets show an escaped full ID in a wrapping block. Compact read-only workbook summaries replace large workbook input boxes. All six confirmation forms use host-managed layout and actions, with no custom footer mask or fixed iframe height. | Native form scrolling, long IDs, and footer visibility need Mac/Windows visual QA. |
| #27 Windows timeout | Schema lookup gets its own 8-second budget; execution gets 30 seconds instead of sharing a 19-second timer. Abort/race handling bounds SDK calls even if abort is ignored. Schema timeout explicitly means no execution; execute/network timeout on a write remains unknown. No write retries. A timed-out range result includes an exact read-only verification request. Longer operations declare background execution. | We cannot inspect the tester's workbook or know the original B2 outcome. Read B2 from the same workbook, compare Excel Online and Composio logs, and rerun on Windows. These changes mitigate avoidable timeout and improve diagnosis; they do not prove the network/provider incident is solved. |
| #33 Cancel missing | Every write now has a native card footer with exactly one Cancel and one Confirm. Cancel is not gated by required inputs. All target/value fields and delete warning remain present. | Click Cancel in VoiceOS on both platforms and prove no tool/provider write. This cannot be established by manifest tests alone. |

All six native confirmation views were accepted by the installed VoiceOS UI schema in an offline audit. The docs explicitly forbid actions alongside a widget, so adding a fake HTML Cancel to the old cards is not used.

## References

- https://docs.voiceos.com/integrations/reference/ui-blocks.md
- https://docs.voiceos.com/integrations/reference/manifest.md
- https://github.com/Agentic-AI-UIUC/voiceos-integrations/issues/25
- https://github.com/Agentic-AI-UIUC/voiceos-integrations/issues/26
- https://github.com/Agentic-AI-UIUC/voiceos-integrations/issues/27
- https://github.com/Agentic-AI-UIUC/voiceos-integrations/issues/33

## Manual retest order (disposable workbook)

1. Save the Setup default workbook ID, reload, and confirm startup build/version 1.0.5. Get Workbook and List Worksheets must target that workbook and show its full ID. Log only redacted evidence.
2. Request Create Worksheet named QA Cancel 105. Click Cancel. Verify no worksheet and no execution in provider logs. Repeat Cancel for rename, delete, update range, append and chart; before/after data must match.
3. Create worksheet QA Native 105. Test both omitted workbook_id and manually cleared Workbook ID. Confirm once and check Excel. Supply an explicit second workbook ID once to prove it overrides the default; use only disposable targets.
4. Write A1:B3 with [["Name","Value"],["Apple",10],["Pear",20]], read it back, and compare with Excel Online. Change the native multiline JSON input and verify edited values, not the original request, execute.
5. Create a ColumnClustered chart on QA Native 105 with series grouped by Columns. Verify target fields, full long IDs, editing, native footer, and actual Excel chart. Repeat with Rows.
6. Manually create a real two-column table, then append one unique marker row after checking Table Name/ID on the card. Confirm one click produces exactly one row. Do not retry a timed-out append.
7. Rename and delete the disposable sheet after testing Cancel. Check the warning and correct target before confirming.
8. For #27, the original tester must first read 'Лист1'!B2 from their original workbook. Do not repeat B2=123 to discover what happened. Record current value, installed build, timings, and redacted Composio logs. If another update times out, use the returned verification request to read back; a matching value verifies current state, not necessarily which earlier request wrote it.
9. Republish manually, reinstall from the share link, and repeat one read, one confirmed write, and one cancellation. Capture new native-form screenshots; November 8 widget screenshots remain historical.

## Local checks

Run bun test against the seven Excel test files. Tests use fake clients or an actual stdio server with credentials explicitly empty; they never write a real workbook. Headless Chrome tests cover result-grid scrolling only. Native-form field/action contracts replace obsolete custom widget geometry tests. Tests are not invoked at server startup.

Local validation on November 11: **174 tests passed, zero failed, 477 assertions across seven files**. Actual offline stdio initialization reports version 1.0.5 and ten tools.

## Compact native confirmations — November 12

Following the updated UIUC-15 guidance, optional setup fields are no longer editable confirmation inputs. Tool schemas and execution arguments are unchanged. Workbook IDs remain visible in compact keyValue summaries, not multiline input boxes. Drive IDs and optional chart titles remain arguments without adding form rows.

| Confirmation | Editable | Fixed context |
| --- | --- | --- |
| Create Worksheet | New name | Workbook |
| Rename Worksheet | New name | Existing worksheet, workbook |
| Delete Worksheet | None | Destructive warning, exact worksheet, workbook |
| Update Range | Full-width range; multiline values | Selected worksheet when supplied, workbook |
| Add Table Rows | Multiline rows | Table name/ID, worksheet when supplied, workbook |
| Create Chart | Full-width source range | Selected worksheet, chart type + grouping, workbook |

The forms have no custom scrollbar, spacer/footer mask, or explanatory review banner. Native Cancel/Confirm remains unchanged. Type/grouping changes for a chart should be requested in chat before approval. Long matrices stay in bounded multiline inputs.

Local contracts limit editable fields to three, reject optional setup inputs, and ensure fixed write targets remain visible. These reduce overflow by construction but are not a live macOS/Windows height guarantee for arbitrary long IDs or translated labels. Retest each form without scrolling; if any still overflows, record the specific tool and actual field lengths before adding the permitted short scroll hint. Earlier widget screenshots do not document this compact layout.

November 12 compactness follow-up: workbook identity is a label plus full-width monospace value, with no Setup jargon. Range inputs are full-width; redundant worksheet editors are removed. Append table identities share one summary row. All six forms retain visible fixed targets and Cancel/Confirm; only matrix values use multiline inputs. Native textarea dimensions and host scrolling are not integration-configurable. Focused UI checks: 23 passed.

## Consistent editable targets (November 12)
All six native confirmations now place editable action targets in full-width labeled fields. Workbook context remains read-only; results remain read-only. Chart grouping is editable. Append displays both name and ID and blocks conflicting targets rather than ignoring an edited name. Native host layout and cancellation still require manual QA; longer forms may scroll.

## Compact paired editors
Related editable fields now share horizontal rows in rename, update, append and chart confirmations; each label stays above its input. Create/delete keep their short single-field layout. JSON fields retain native multiline editing because the supported native schema has no textarea rows/height control. No invented CSS/height property or forced scrollbar is used. Manual native-host fit verification remains required.

## Native height and dropdown correction
Update/append JSON inputs now use compact single-line textField controls; array arguments still serialize as JSON and the existing parser preserves types. Append rows use the full card width, with worksheet and read-only workbook context sharing the final row. Series By uses a labeled text input (Auto, Columns, Rows) to avoid the host dropdown white-on-white options bug. No native host CSS is modified. Large JSON may require horizontal caret navigation; arbitrary content cannot be guaranteed visible at once. Manual host fit verification remains pending.

## Local visual validation
See docs/local-ui-audit/README.md and native-confirmations.png for the 36-case native-component browser audit and its explicit host/live-execution limits. The final offline suite reports 179 passing tests.

## November 13: append footer clipping in real host
User screenshots invalidated the previous 350 px normal-case budget. Append now has two paired editor rows (table name/ID, rows/worksheet) plus standalone workbook context. The local native-component normal-case limit is tightened to 280 px for Append and 300 px for the other cards. This reduces the previous append form by one input row, without dropping editable targets or moving the workbook beside a field. Outer host sizing remains outside the component harness.
