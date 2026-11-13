import {test,expect} from 'bun:test';
import {readFileSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// Exact issue inputs exercise real registered handlers over stdio MCP.
// Only the external Composio boundary is substituted; no credentials/network/provider writes.
const cyrillic='\u041b\u0438\u0441\u04421';
async function fixture(scenario:string,run:(client:Client,trace:()=>any[])=>Promise<void>,defaultId='fixture_default_workbook'){
 const dir=mkdtempSync(join(tmpdir(),'excel-issue-repro-')),calls=join(dir,'calls.jsonl'),preload=join(dir,'provider.ts');
 writeFileSync(preload,`import {mock} from 'bun:test';import {appendFileSync} from 'node:fs';
 let cell=0;
 const keys={EXCEL_ADD_WORKSHEET:['item_id','name'],EXCEL_LIST_WORKSHEETS:['item_id'],EXCEL_ADD_CHART:['item_id','worksheet','type','sourcedata','seriesby'],EXCEL_UPDATE_RANGE:['item_id','worksheet_id','address','values'],EXCEL_GET_RANGE:['item_id','worksheet_id','address']};
 mock.module(${JSON.stringify(import.meta.resolve('@composio/core'))},()=>({Composio:class{
 client={connectedAccounts:{retrieve:async()=>({id:'ca_fixture',user_id:'fixture_user',status:'ACTIVE',toolkit:{slug:'excel'}})}};
 tools={getRawComposioToolBySlug:async(slug)=>({inputParameters:{properties:Object.fromEntries(keys[slug].map(k=>[k,{type:k==='values'?'array':'string'}])),required:keys[slug]}}),execute:async(slug,options,request)=>{
 appendFileSync(${JSON.stringify(calls)},JSON.stringify({slug,arguments:options.arguments,version:options.version,maxRetries:request?.maxRetries})+'\\n');const a=options.arguments;
 let data;
 if(slug==='EXCEL_ADD_WORKSHEET')data={name:a.name,id:'fixture_sheet'};
 else if(slug==='EXCEL_LIST_WORKSHEETS')data={worksheets:[{id:'fixture_sheet',name:${JSON.stringify(cyrillic)},visibility:'Visible'},{id:'second',name:'Sheet1',visibility:'Visible'}]};
 else if(slug==='EXCEL_ADD_CHART')data={id:'fixture_chart',name:'Chart 1'};
 else if(slug==='EXCEL_UPDATE_RANGE'){cell=a.values[0][0];if(${JSON.stringify(scenario)}==='timeout_after_write')throw Object.assign(new Error('Simulated provider transport timeout after accepting write'),{name:'APIConnectionTimeoutError'});data={address:a.worksheet_id+'!'+a.address,values:[[cell]],rowCount:1,columnCount:1};}
 else if(slug==='EXCEL_GET_RANGE')data={address:a.worksheet_id+'!'+a.address,values:[[cell]],rowCount:1,columnCount:1};
 else throw Error('Unexpected fixture action '+slug);
 return {successful:true,data};}};
 }}));`);
 const client=new Client({name:'exact-issue-repro-offline',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--preload',preload,fileURLToPath(new URL('./server.ts',import.meta.url))],env:{COMPOSIO_API_KEY:'fixture_not_a_key',COMPOSIO_USER_ID:'fixture_user',COMPOSIO_CONNECTED_ACCOUNT_ID:'ca_fixture',DEFAULT_WORKBOOK_ID:defaultId,DEFAULT_DRIVE_ID:'',COMPOSIO_EXCEL_VERSION:'20261029_00'},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 try{await client.connect(transport);await run(client,()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]);}finally{await client.close();await transport.close();}
}
const data=(r:any)=>JSON.parse(r.content.find((c:any)=>c.type==='text').text);
for(const variant of ['omitted','blank','whitespace'])test('#25 Create worksheet QA Mac with '+variant+' workbook_id uses saved default over actual MCP',async()=>{
 await fixture('success',async(client,trace)=>{const args:any={name:'QA Mac'};if(variant!=='omitted')args.workbook_id=variant==='blank'?'':'   ';const result=await client.callTool({name:'excel_create_worksheet',arguments:args});expect(result.isError).not.toBe(true);expect(data(result).name).toBe('QA Mac');const writes=trace().filter(c=>c.slug==='EXCEL_ADD_WORKSHEET');expect(writes).toHaveLength(1);expect(writes[0].arguments).toEqual({item_id:'fixture_default_workbook',name:'QA Mac'});expect(writes[0].maxRetries).toBe(0);});
},15000);
for(const variant of ['omitted','blank','whitespace'])test('#25 chart '+cyrillic+' A1:B3 with '+variant+' workbook_id resolves default and Cyrillic sheet',async()=>{
 await fixture('success',async(client,trace)=>{const args:any={range:cyrillic+'!A1:B3',chart_type:'ColumnClustered'};if(variant!=='omitted')args.workbook_id=variant==='blank'?'':'   ';const result=await client.callTool({name:'excel_create_chart',arguments:args});expect(result.isError).not.toBe(true);expect(data(result).status).toBe('chart_created');const writes=trace().filter(c=>c.slug==='EXCEL_ADD_CHART');expect(writes).toHaveLength(1);expect(writes[0].arguments).toEqual({item_id:'fixture_default_workbook',worksheet:cyrillic,type:'ColumnClustered',sourcedata:"'"+cyrillic+"'!A1:B3",seriesby:'Auto'});expect(trace().every(c=>c.arguments.item_id==='fixture_default_workbook')).toBe(true);});
},15000);
for(const values of [[[123]],'[[123]]'])test('#27 exact Cyrillic B2=123 update and readback using '+typeof values+' values',async()=>{
 await fixture('success',async(client,trace)=>{const range="'"+cyrillic+"'!B2";const write=await client.callTool({name:'excel_update_range',arguments:{range,values}});expect(write.isError).not.toBe(true);expect(data(write).status).toBe('updated');const read=await client.callTool({name:'excel_get_range',arguments:{range}});expect(read.isError).not.toBe(true);expect(data(read).values).toEqual([[123]]);const writes=trace().filter(c=>c.slug==='EXCEL_UPDATE_RANGE');expect(writes).toHaveLength(1);expect(writes[0].arguments).toEqual({item_id:'fixture_default_workbook',worksheet_id:cyrillic,address:'B2',values:[[123]]});});
},15000);
test('#27 timeout after provider accepts B2 write stays unknown, never retries, and offers successful readback',async()=>{
 await fixture('timeout_after_write',async(client,trace)=>{const range="'"+cyrillic+"'!B2";const write=await client.callTool({name:'excel_update_range',arguments:{range,values:[[123]]}});expect(write.isError).toBe(true);const result=data(write);expect(result.outcome).toBe('unknown');expect(result.error).toContain('Check the workbook before retrying');expect(result.verification.tool).toBe('excel_get_range');const read=await client.callTool({name:result.verification.tool,arguments:result.verification.arguments});expect(data(read).values).toEqual([[123]]);expect(trace().filter(c=>c.slug==='EXCEL_UPDATE_RANGE')).toHaveLength(1);});
},15000);
test('#25 no configured default fails clearly before any provider execution',async()=>{
 await fixture('success',async(client,trace)=>{const result=await client.callTool({name:'excel_create_worksheet',arguments:{name:'QA Mac'}});expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('DEFAULT_WORKBOOK_ID');expect(trace()).toHaveLength(0);},'');
},15000);
