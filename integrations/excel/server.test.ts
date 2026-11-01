import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  APPROVED_COMPOSIO_ACTIONS, runRegressionTests,
  prepareRangeActionArgs, prepareChartActionArgs,
} from "./server.ts";

// Offline regression tests: no Composio execution or Microsoft account required.
const regression = runRegressionTests();
describe("existing offline regression checks", () => {
  for (const [name, passed] of Object.entries(regression.results)) {
    test(name, () => expect(passed).toBe(true));
  }
  test("all 32 checks execute", () => {
    expect(Object.keys(regression.results)).toHaveLength(32);
    expect(regression.passed).toBe(true);
  });
});

const manifest = JSON.parse(readFileSync(new URL("./voiceos.integration.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
test("manifest and actual MCP registrations expose exactly the approved ten tools", () => {
  const registered = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map(match => match[1]);
  const approved = Object.keys(APPROVED_COMPOSIO_ACTIONS).sort();
  expect(registered.sort()).toEqual(approved);
  expect(manifest.tools.map((tool: any) => tool.name).sort()).toEqual(approved);
});
const writes = new Set(["excel_create_worksheet", "excel_rename_worksheet", "excel_delete_worksheet", "excel_update_range", "excel_add_table_rows", "excel_create_chart"]);
for (const tool of manifest.tools) {
  test(`${tool.name}: confirmation matches read/write behavior`, () => {
    if (writes.has(tool.name)) {
      expect(tool.confirmation).toBeDefined();
      expect(tool.confirmation.schemaVersion).toBe(1);
      expect(tool.confirmation.root.type).toBe("widget");
      expect(tool.confirmation.root.html).toContain("data-k-key");
      expect(tool.confirmation.root.confirmLabel.length).toBeGreaterThan(0);
    } else expect(tool.confirmation).toBeUndefined();
  });
}
test("manual account ID is required in QA setup", () => {
  expect(manifest.preferences.find((field: any) => field.name === "COMPOSIO_CONNECTED_ACCOUNT_ID").required).toBe(true);
});
for (const action of ["EXCEL_GET_RANGE", "EXCEL_UPDATE_RANGE"]) {
  test(`${action}: quoted sheet address maps to worksheet_id and address`, () => {
    const mapped = prepareRangeActionArgs(action, {workbook_id: "qa_workbook", range: "'Sales Data'!A1:B2", values: [[1, 2], [3, 4]]});
    expect(mapped.worksheet_id).toBe("Sales Data");
    expect(mapped.address).toBe("A1:B2");
    expect(mapped.item_id).toBe("qa_workbook");
  });
}
test("chart maps source, chart type and explicit column grouping", () => {
  const args = prepareChartActionArgs({workbook_id: "qa_workbook", range: "'Sales Data'!A1:B4", chart_type: "ColumnClustered", series_by: "Columns"});
  expect(args.sourcedata).toBe("'Sales Data'!A1:B4");
  expect(args.type).toBe("ColumnClustered");
  expect(args.seriesby).toBe("Columns");
});
test("chart rejects unsupported grouping before execution", () => {
  expect(() => prepareChartActionArgs({workbook_id: "qa_workbook", series_by: "Invalid"})).toThrow("Unsupported series_by");
});