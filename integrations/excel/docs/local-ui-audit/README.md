# Local confirmation audit - November 12, 2026

179 offline tests pass across 8 files, including 36 native-component layout cases (six cards, widths 360/480/520, normal and long identifiers). 1251 assertions passed.

The layout test reads components from a local extract of the installed VoiceOS renderer, executes their JSX with fixture arguments, and measures the resulting DOM in headless Chrome. It checks input boundaries, footer visibility, no vertical height overflow within the test budget, edit callbacks and distinct Cancel/Confirm callbacks. Native code is not redistributed. The renderer audit skips explicitly when its local extract or Chrome is absent.

The gallery was visually inspected. Append was improved after that inspection: worksheet and workbook each get their own full-width line. Results and workbook context remain read-only. All action targets remain editable.

| Card | Height at 480 px |
| --- | --- |
| excel_create_worksheet | 197 px |
| excel_rename_worksheet | 197 px |
| excel_delete_worksheet | 225 px |
| excel_update_range | 258 px |
| excel_add_table_rows | 319 px |
| excel_create_chart | 258 px |

## Scope and limits

This is local component evidence, not a screenshot from a running VoiceOS window. The full overlay, zoom, surrounding narration, app styles and host scrolling behavior are outside this harness. Global button styling is approximated; component geometry and field styles come from the installed renderer. No live Excel/Composio calls or real workbook mutations were made. Callback tests prove native component dispatch, not the complete host cancellation lifecycle. Do not claim perfect UX or production acceptance from these checks alone.

Single-line JSON keeps cards compact, but long content requires horizontal caret navigation. Series By is text (Auto, Columns, Rows) to avoid unreadable native select options.

## November 13 correction
The earlier 319 px append card still clipped in the real host. That previous fit assessment was insufficient. Append now pairs Rows and Worksheet on the same row; workbook remains standalone. The latest suite passes 180 tests and 1257 assertions, with an append normal-case height cap of 280 px across tested widths. The image and JSON measurements are refreshed. Full overlay behavior remains outside this harness.
