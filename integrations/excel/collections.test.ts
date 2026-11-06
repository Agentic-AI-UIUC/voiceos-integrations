import {test, expect, beforeEach, afterEach} from "bun:test";
import {readExcelCollection, resolveWriteTarget, executeComposioAction} from "./server.ts";

const sheets = [{id:"sheet_a",name:"Sheet1",visibility:"Visible"},{id:"sheet_b",name:"Review QA",visibility:"Visible"}];
const tables = [{id:"table_42",name:"ReviewTable"}];
const shapes: Record<string,(items:any[],kind:string)=>any> = {
  graph: items=>({value:items}),
  named: (items,kind)=>({[kind]:items}),
  array: items=>items,
  data: (items,kind)=>({data:{[kind]:items}}),
  response: (items,kind)=>({response_data:{[kind]:items}}),
  nested: (items,kind)=>({data:{response_data:{[kind]:items}}}),
};
for(const [shape,wrap] of Object.entries(shapes)) for(const kind of ["worksheets","tables"] as const) {
  test(`${kind}: ${shape} response is accepted`,()=>expect(readExcelCollection(wrap(kind==="worksheets"?sheets:tables,kind),kind)).toEqual(kind==="worksheets"?sheets:tables));
  test(`${kind}: ${shape} empty response is valid`,()=>expect(readExcelCollection(wrap([],kind),kind)).toEqual([]));
}
test("worksheet strings and sheets alias are normalized",()=>expect(readExcelCollection({sheets:["Sheet1"]},"worksheets")).toEqual([{name:"Sheet1"}]));
for(const [label,data] of Object.entries({
  missing:{}, malformed:{worksheets:{}}, nullItem:{worksheets:[null]}, error:{error:"failed",worksheets:[]},
  conflicting:{worksheets:sheets,value:[]}, graphPage:{worksheets:sheets,"@odata.nextLink":"next"},
  namedPage:{worksheets:sheets,odata_next_link:"next"}, hasMore:{worksheets:sheets,has_more:true},
  nestedPage:{data:{worksheets:sheets,odata_next_link:"next"}}, cursor:{worksheets:sheets,next_cursor:"next"},
})) test(`unsafe response blocks writes: ${label}`,async()=>{
  const calls:string[]=[];
  await expect(resolveWriteTarget("EXCEL_ADD_TABLE_ROW",{table_name:"ReviewTable"},async action=>{calls.push(action);return data;})).rejects.toThrow();
  expect(calls).toEqual(["EXCEL_LIST_WORKSHEETS"]);
});

const keys=["COMPOSIO_API_KEY","COMPOSIO_USER_ID","COMPOSIO_CONNECTED_ACCOUNT_ID","DEFAULT_DRIVE_ID","DEFAULT_WORKBOOK_ID"];
const saved = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
beforeEach(()=>{process.env.COMPOSIO_API_KEY="test_not_real";process.env.COMPOSIO_USER_ID="qa_user";process.env.COMPOSIO_CONNECTED_ACCOUNT_ID="ca_test";delete process.env.DEFAULT_DRIVE_ID;delete process.env.DEFAULT_WORKBOOK_ID;});
afterEach(()=>{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});

// Schema fixtures are explicit offline contracts, not evidence of a live call.
const fields:Record<string,string[]>={
  EXCEL_LIST_WORKSHEETS:["item_id"],EXCEL_LIST_TABLES:["item_id","worksheet"],
  EXCEL_ADD_TABLE_ROW:["item_id","table_id","values"],
  EXCEL_ADD_CHART:["item_id","worksheet","type","sourcedata","seriesby"],
  EXCEL_DELETE_WORKSHEET:["item_id","worksheet"],
};
for(const [shape,wrap] of Object.entries(shapes)) for(const action of ["EXCEL_ADD_TABLE_ROW","EXCEL_ADD_CHART","EXCEL_DELETE_WORKSHEET"]) {
  test(`${action}: complete lookup and SDK execution with ${shape} collections`,async()=>{
    const calls:any[]=[];
    const client={client:{connectedAccounts:{retrieve:async()=>({id:"ca_test",user_id:"qa_user",status:"ACTIVE",toolkit:{slug:"excel"}})}},tools:{
      getRawComposioToolBySlug:async(slug:string)=>({inputParameters:{properties:Object.fromEntries(fields[slug].map(key=>[key,{type:key==="values"?"array":"string"}])),required:fields[slug]}}),
      execute:async(slug:string,options:any)=>{calls.push([slug,options]);return {successful:true,data:slug==="EXCEL_LIST_WORKSHEETS"?wrap(sheets,"worksheets"):slug==="EXCEL_LIST_TABLES"?wrap(tables,"tables"):{id:"result"}};},
    }};
    const execute=(slug:string,args:any)=>executeComposioAction(slug,args,client);
    const input={workbook_id:"fixture_wb",worksheet_name:"Review QA",table_name:"ReviewTable",rows:[["Marker",7]],range:"A1:B4",chart_type:"ColumnClustered",series_by:"Columns"};
    const target=await resolveWriteTarget(action,input,execute);
    await execute(action,target);
    const writes=calls.filter(([slug])=>slug===action);
    expect(writes).toHaveLength(1);
    expect(writes[0][1].version).toBe("20261029_00");
    if(action==="EXCEL_ADD_TABLE_ROW") expect(writes[0][1].arguments).toEqual({item_id:"fixture_wb",table_id:"table_42",values:[["Marker",7]]});
    else expect(writes[0][1].arguments.worksheet).toBe("Review QA");
    expect(writes[0][1].arguments.worksheet_id).toBeUndefined();
  });
}
test("delete blocks the last visible worksheet",async()=>{
  await expect(resolveWriteTarget("EXCEL_DELETE_WORKSHEET",{worksheet_name:"Sheet1"},async()=>({worksheets:[sheets[0],{name:"Hidden",visibility:"Hidden"}]}))).rejects.toThrow("last visible worksheet");
});
test("duplicate table matches never pick one arbitrarily",async()=>{
  await expect(resolveWriteTarget("EXCEL_ADD_TABLE_ROW",{table_name:"ReviewTable"},async slug=>slug==="EXCEL_LIST_WORKSHEETS"?{worksheets:sheets}:{tables})).rejects.toThrow("uniquely resolved");
});
test("table pagination blocks writes",async()=>{
  await expect(resolveWriteTarget("EXCEL_ADD_TABLE_ROW",{table_name:"ReviewTable",worksheet_name:"Review QA"},async slug=>slug==="EXCEL_LIST_WORKSHEETS"?{worksheets:sheets}:{tables,odata_next_link:"next"})).rejects.toThrow("additional pages");
});
