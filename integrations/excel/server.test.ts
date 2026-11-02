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

// These injected-client tests exercise the execution boundary without network calls.
import { resolveConnectedAccountId, executeComposioAction, mapPinnedAction, timeoutMessage, WRITE_ACTIONS } from "./server.ts";
import { afterEach, beforeEach } from "bun:test";
const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.COMPOSIO_API_KEY = "test_key_not_real";
  process.env.COMPOSIO_USER_ID = "qa_user";
  process.env.COMPOSIO_CONNECTED_ACCOUNT_ID = "ca_test";
});
afterEach(() => {
  for (const key of ["COMPOSIO_API_KEY", "COMPOSIO_USER_ID", "COMPOSIO_CONNECTED_ACCOUNT_ID"]) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});
const validAccount = {id: "ca_test", user_id: "qa_user", status: "ACTIVE", toolkit: {slug: "excel"}};
const accountClient = (account: any) => ({client: {connectedAccounts: {retrieve: async () => account}}});
test("raw account owner verifies before execution", async () => {
  expect(await resolveConnectedAccountId(accountClient(validAccount), "unused", "qa_user")).toBe("ca_test");
});
for (const [label, change] of Object.entries({
  "unknown owner": {user_id: undefined}, "foreign owner": {user_id: "other_user"},
  "wrong toolkit": {toolkit: {slug: "asana"}}, "expired account": {status: "EXPIRED"},
  "wrong account": {id: "ca_other"},
})) {
  test("rejects " + label, async () => {
    await expect(resolveConnectedAccountId(accountClient({...validAccount,...change}), "unused", "qa_user")).rejects.toThrow();
  });
}
test("account retrieval failure does not fall through", async () => {
  const client = {client: {connectedAccounts: {retrieve: async () => {throw Error("lookup unavailable");}}}};
  await expect(resolveConnectedAccountId(client, "unused", "qa_user")).rejects.toThrow("lookup unavailable");
});
for (const action of WRITE_ACTIONS) test(action + ": timeout warns outcome is unknown", () => {
  expect(timeoutMessage(action)).toContain("Outcome unknown");
  expect(timeoutMessage(action)).toContain("Check the workbook before retrying");
  expect(timeoutMessage(action)).not.toContain("Please try again");
});
test("fixed rename mapping does not send aliases or overwrite the target", () => {
  expect(mapPinnedAction("EXCEL_UPDATE_WORKSHEET", {workbook_id: "qa_wb", current_name: "Before", new_name: "After"})).toEqual({item_id: "qa_wb", worksheet: "Before", name: "After"});
});
test("schema drift stops a write instead of choosing another field", async () => {
  let calls = 0;
  const client = {...accountClient(validAccount), tools: {
    getRawComposioToolBySlug: async () => ({inputParameters: {properties: {file_id: {type: "string"}, title: {type: "string"}},required: ["file_id","title"]}}),
    execute: async () => {calls++;return {data:{}};},
  }};
  await expect(executeComposioAction("EXCEL_ADD_WORKSHEET", {workbook_id:"qa_wb",name:"Approved"},client)).rejects.toThrow("pinned mapping field");
  expect(calls).toBe(0);
});
test("SDK write is called once with approved mapped values and retries disabled", async () => {
  const calls:any[]=[];
  const client={...accountClient(validAccount),tools:{
    getRawComposioToolBySlug: async () => ({inputParameters:{properties:{item_id:{type:"string"},name:{type:"string"}},required:["item_id","name"]}}),
    execute:async (...args:any[]) => {calls.push(args);return {successful:true,data:{id:"fixture_sheet"}};},
  }};
  expect(await executeComposioAction("EXCEL_ADD_WORKSHEET",{workbook_id:"qa_wb",name:"Approved"},client)).toEqual({id:"fixture_sheet"});
  expect(calls).toHaveLength(1);
  expect(calls[0][1].arguments).toEqual({item_id:"qa_wb",name:"Approved"});
  expect(calls[0][2].maxRetries).toBe(0);
});
test("no deprecated API or startup regression invocation remains", () => {
  expect(source).not.toContain("/api/v1/");
  expect(source).not.toContain("const regTest = runRegressionTests()");
  expect(source).not.toContain("candidateName");
});

test("interactive previews use configured workbook and drive defaults", () => {
  const meta = JSON.parse(readFileSync(new URL("./studio-meta.json", import.meta.url), "utf8"));
  for (const preview of meta.preview.toolPreviews) {
    expect(preview.sampleArgs?.workbook_id).toBeUndefined();
    expect(preview.sampleArgs?.drive_id).toBeUndefined();
  }
});

test("chart execution uses worksheet instead of range-action worksheet_id", async () => {
  const calls:any[] = [];
  const client = {...accountClient(validAccount), tools: {
    getRawComposioToolBySlug: async () => ({inputParameters: {
      properties: {item_id:{type:"string"}, worksheet:{type:"string"}, type:{type:"string"}, sourcedata:{type:"string"}, seriesby:{type:"string"}},
      required: ["item_id","worksheet","type","sourcedata","seriesby"],
    }}),
    execute: async (...args:any[]) => {calls.push(args);return {successful:true,data:{id:"fixture_chart"}};},
  }};
  await executeComposioAction("EXCEL_ADD_CHART", {
    workbook_id:"qa_wb", worksheet_name:"VoiceOS Review QA Verified",range:"A1:B4",chart_type:"ColumnClustered",series_by:"Columns",
  },client);
  expect(calls).toHaveLength(1);
  expect(calls[0][1].arguments).toEqual({item_id:"qa_wb",worksheet:"VoiceOS Review QA Verified",type:"ColumnClustered",sourcedata:"'VoiceOS Review QA Verified'!A1:B4",seriesby:"Columns"});
  expect(calls[0][1].arguments.worksheet_id).toBeUndefined();
});

import { resolveWriteTarget } from "./server.ts";
test("chart missing worksheet reports actual names and performs no write", async () => {
  const calls:string[]=[];
  await expect(resolveWriteTarget("EXCEL_ADD_CHART", {range:"A1:B4",worksheet_name:"Renamed but absent"}, async action => {
    calls.push(action);return {value:[{id:"sheet_1",name:"VoiceOS Review QA 01"}]};
  })).rejects.toThrow("Available worksheets: VoiceOS Review QA 01");
  expect(calls).toEqual(["EXCEL_LIST_WORKSHEETS"]);
});
test("table name resolves to the returned stable ID in its actual worksheet", async () => {
  const calls:any[]=[];
  const result=await resolveWriteTarget("EXCEL_ADD_TABLE_ROW",{workbook_id:"wb_fixture",table_name:"ReviewTable",rows:[["marker",7]]},async(action,args)=>{
    calls.push([action,args]);
    return action==="EXCEL_LIST_WORKSHEETS"?{value:[{name:"Real sheet"}]}:{value:[{id:"table_fixture_42",name:"ReviewTable"}]};
  });
  expect(result.table_id).toBe("table_fixture_42");
  expect(result.worksheet_name).toBe("Real sheet");
  expect(result.rows).toEqual([["marker",7]]);
  expect(calls[1][1].worksheet_name).toBe("Real sheet");
});
test("missing table is not fabricated or replaced with another table",async()=>{
  await expect(resolveWriteTarget("EXCEL_ADD_TABLE_ROW",{table_name:"Missing"},async action=>action==="EXCEL_LIST_WORKSHEETS"?{value:[{name:"Sheet1"}]}:{value:[{id:"other",name:"ActualTable"}]})).rejects.toThrow("Available tables: ActualTable");
});
test("table lookup failure is not swallowed",async()=>{
  await expect(resolveWriteTarget("EXCEL_ADD_TABLE_ROW",{table_name:"T"},async action=>{
    if(action==="EXCEL_LIST_WORKSHEETS")return {value:[{name:"Sheet1"}]};
    throw Error("read failed");
  })).rejects.toThrow("read failed");
});
test("incomplete worksheet enumeration blocks target resolution",async()=>{
  await expect(resolveWriteTarget("EXCEL_ADD_CHART",{range:"Sheet1!A1:B4"},async()=>({value:[],"@odata.nextLink":"next"}))).rejects.toThrow("complete worksheet list");
});
test("chart uses a verified existing worksheet without changing approved range",async()=>{
  const result=await resolveWriteTarget("EXCEL_ADD_CHART",{range:"'Actual Sheet'!A1:B4"},async()=>({value:[{name:"Actual Sheet",id:"sheet_fixture"}]}));
  expect(result.worksheet_name).toBe("Actual Sheet");
  expect(result.range).toBe("'Actual Sheet'!A1:B4");
});

test("Composio SDK remains pinned after Studio regeneration", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  expect(pkg.dependencies["@composio/core"]).toBe("0.27.0");
});

test("Studio fixtures contain no personal OneDrive IDs or truncated prefixes", () => {
  const meta = readFileSync(new URL("./studio-meta.json", import.meta.url), "utf8");
  expect(meta).not.toMatch(/\b[0-9A-F]{14,16}(?:!|[.\u2026])/i);
});
