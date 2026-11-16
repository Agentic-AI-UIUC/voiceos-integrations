import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const manifest=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
test('actual stdio MCP advertises matching version and Create/Chart honor Setup with empty confirmed IDs',async()=>{
 const client=new Client({name:'offline-excel-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.ts',import.meta.url))],env:{COMPOSIO_API_KEY:'',COMPOSIO_USER_ID:'',COMPOSIO_CONNECTED_ACCOUNT_ID:'',DEFAULT_WORKBOOK_ID:'qa_fixture_default',DEFAULT_DRIVE_ID:'',COMPOSIO_EXCEL_VERSION:'20261029_00'},stderr:'pipe'});
 try{
 await client.connect(transport);expect(client.getServerVersion()?.version).toBe(manifest.version);
 const list=await client.listTools();expect(list.tools.map(t=>t.name).sort()).toEqual(manifest.tools.map((t:any)=>t.name).sort());
 for(const [name,args] of [['excel_create_worksheet',{name:'QA Mac',workbook_id:''}],['excel_create_chart',{range:"'Sheet QA'!A1:B3",chart_type:'ColumnClustered',workbook_id:''}]] as const){
  const result=await client.callTool({name,arguments:args});const text=JSON.stringify(result);
  expect(result.isError).toBe(true);expect(text).toContain('Missing Composio API key');expect(text).not.toContain('No workbook ID');
 }
 }finally{await client.close();await transport.close();}
},15000);
