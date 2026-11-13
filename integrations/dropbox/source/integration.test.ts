import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,writeFileSync,rmSync,mkdirSync } from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tools,parseArgs,VERSION } from './catalog.ts';
import { checkAccount,execute,mapArgs,unwrap,readCollection,errorMessage } from './provider.ts';
import { createServer } from './server.ts';
const config={user:'qa',account:'ca_qa'};
const account={id:'ca_qa',user_id:'qa',toolkit:{slug:'dropbox'},auth_config:{auth_scheme:'OAUTH2'},status:'ACTIVE'};
const downloads=join(homedir(),'Downloads');mkdirSync(downloads,{recursive:true});
const directory=mkdtempSync(join(downloads,'dropbox-boundary-')),localFile=join(directory,'source.docx');writeFileSync(localFile,Buffer.from([80,75,3,4,0,255]));after(()=>rmSync(directory,{recursive:true,force:true}));
const descriptor={name:'source.docx',mimetype:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',s3key:'staged/test-file'};
const fileProperty={type:'object',file_uploadable:true,properties:{name:{type:'string'},mimetype:{type:'string'},s3key:{type:'string'}},required:['name','mimetype','s3key']};
const samples:any={list_files:{path:''},search_files:{query:'report'},get_metadata:{path:'/a'},read_file:{path:'/a'},upload_file:{path:'/a',file:'/tmp/source.txt',mode:'add'},create_folder:{path:'/a'},copy_item:{from_path:'/a',to_path:'/b'},move_item:{from_path:'/a',to_path:'/b'},delete_item:{path:'/a'},list_revisions:{path:'/a'},restore_revision:{path:'/a',rev:'abc'},create_shared_link:{path:'/a'},list_shared_links:{},revoke_shared_link:{url:'https://www.dropbox.com/s/abc/a'}};
samples.upload_file.file=localFile;
function fake(tool:any,data:any,opts:any={}) {
 const calls:any[]=[];
 const schema=tool.name==='upload_file'?{type:'object',properties:{path:{type:'string'},mode:{type:'string'},content:fileProperty},required:['path','content']}:{type:'object',properties:Object.fromEntries(Object.keys(samples[tool.name]).map(k=>[k,{type:'string'}])),required:Object.keys(samples[tool.name]),additionalProperties:false};
 const c={client:{connectedAccounts:{retrieve:async()=>opts.account||account}},files:{upload:async()=>descriptor},tools:{getRawComposioToolBySlug:async()=>({inputParameters:opts.schema||schema}),execute:async(...args:any[])=>{calls.push(args);if(opts.error)throw opts.error;return {successful:true,data};}}};return {c,calls};
}
for(const tool of tools) test(`${tool.name}: account → pinned schema → execute once`,async()=>{
 const data='collection' in tool?{[tool.collection]:[],has_more:false}:{name:'a'};
 const {c,calls}=fake(tool,data);
 assert.deepEqual(await execute(tool,parseArgs(tool,samples[tool.name]),c,config),data);
 assert.equal(calls.length,1);assert.equal(calls[0][0],tool.slug);assert.equal(calls[0][1].version,VERSION);assert.equal(calls[0][2].maxRetries,0);
});
for(const change of [{user_id:'other'},{toolkit:{slug:'excel'}},{status:'EXPIRED'},{auth_config:{auth_scheme:'API_KEY'}},{user_id:undefined}])test(`account rejected ${JSON.stringify(change)}`,async()=>{
 const tool=tools.find(t=>t.name==='delete_item')!;const {c,calls}=fake(tool,{}, {account:{...account,...change}});
 await assert.rejects(execute(tool,{path:'/a'},c,config));assert.equal(calls.length,0);
});
for(const status of ['EXPIRED','REVOKED'])test(`${status} OAuth account requests reconnection before any tool call`,async()=>{
 const tool=tools.find(t=>t.name==='list_files')!;const {c,calls}=fake(tool,{entries:[]},{account:{...account,status}});
 await assert.rejects(execute(tool,{path:''},c,config),/connect Dropbox again/);
 assert.equal(calls.length,0);
});
test('provider token revocation requests reconnection without retrying',async()=>{
 const tool=tools.find(t=>t.name==='list_files')!;const {c,calls}=fake(tool,{}, {error:Error('invalid_access_token')});
 await assert.rejects(execute(tool,{path:''},c,config),/connect Dropbox again/);
 assert.equal(calls.length,1);
});
for(const envelope of [{data:{entries:[]}},{response_data:{entries:[]}},{data:{response_data:{entries:[]}}}])test(`unwrap ${JSON.stringify(envelope)}`,()=>assert.deepEqual(unwrap(envelope),{entries:[]}));
for(const bad of [{successful:false},{data:{error:'failure'}},{response_data:{success:false}},null])test(`reject provider failure ${JSON.stringify(bad)}`,()=>assert.throws(()=>unwrap(bad)));
for(const bad of [{},{files:[]},{entries:null},{entries:[],has_more:true}])test(`collection fails closed ${JSON.stringify(bad)}`,()=>assert.throws(()=>readCollection(bad,'entries')));
test('pagination retained',async()=>{const {c}=fake(tools[0],{entries:[],has_more:true,cursor:'next'});assert.equal((await execute(tools[0],{path:''},c,config)).cursor,'next');});
test('revisions keep a valid partial page when Dropbox omits its cursor',async()=>{
 const tool=tools.find(t=>t.name==='list_revisions')!;
 const data={entries:[{name:'review.docx',rev:'rev-1'}],has_more:true};
 const {c,calls}=fake(tool,data,{schema:{type:'object',properties:{path:{type:'string'},limit:{type:'integer'}},required:['path']}});
 assert.deepEqual(await execute(tool,{path:'/review.docx',limit:10},c,config),data);
 assert.equal(calls.length,1);
});
test('other paginated collections still require a continuation cursor',async()=>{
 const tool=tools.find(t=>t.name==='list_files')!;
 const {c}=fake(tool,{entries:[{name:'review.docx'}],has_more:true});
 await assert.rejects(execute(tool,{path:''},c,config),/continuation cursor missing/);
});
test('schema mismatch blocks write',async()=>{const t=tools.find(t=>t.name==='delete_item')!;const {c,calls}=fake(t,{}, {schema:{type:'object',properties:{wrong:{type:'string'}}}});await assert.rejects(execute(t,{path:'/a'},c,config),/no execution/i);assert.equal(calls.length,0);});
test('timeout write is unknown and not retried',async()=>{const t=tools.find(t=>t.name==='delete_item')!;const {c,calls}=fake(t,{}, {error:Error('timeout')});await assert.rejects(execute(t,{path:'/a'},c,config),/outcome is unknown/);assert.equal(calls.length,1);});
test('root and unexpected arguments rejected',()=>{for(const path of ['', '/', 'relative','/a/','/a//b'])assert.throws(()=>parseArgs(tools.find(t=>t.name==='delete_item')!,{path}));assert.throws(()=>parseArgs(tools[0],{path:'',team_id:'x'}));});
test('copy into source rejected',()=>{const t=tools.find(t=>t.name==='copy_item')!;assert.throws(()=>mapArgs(t,{from_path:'/a',to_path:'/a/b'},{type:'object',properties:{from_path:{},to_path:{}}}));});
test('upload conflict settings explicit',()=>{const t=tools.find(t=>t.name==='upload_file')!;const args=mapArgs(t,{...samples.upload_file,file:descriptor},{type:'object',properties:{path:{},file_to_upload:fileProperty,mode:{},autorename:{},strict_conflict:{}}});assert.deepEqual(args.file_to_upload,descriptor);assert.equal(args.autorename,false);assert.equal(args.strict_conflict,true);});
test('clear error categories',()=>{for(const [input,match] of [['invalid_access_token',/connect Dropbox again/],['403',/permission/],['413',/size/],['409',/conflict/],['404',/unavailable/]])assert.match(errorMessage(Error(input as string)),match as RegExp);});
test('manual account ID resolves non-default owner without user preference',async()=>{const {c,calls}=fake(tools[0],{entries:[]},{account:{...account,user_id:'custom-owner'}});await execute(tools[0],{path:''},c,{user:'',account:config.account});assert.equal(calls[0][1].userId,'custom-owner');});
test('missing raw owner blocks execution',async()=>{const {c,calls}=fake(tools[0],{entries:[]},{account:{...account,user_id:undefined}});await assert.rejects(execute(tools[0],{path:''},c,{user:'',account:config.account}),/owner/);assert.equal(calls.length,0);});
test('playground test ID is rejected before provider call',async()=>{const {c,calls}=fake(tools[0],{});c.client.connectedAccounts.retrieve=async()=>{throw Error('Must not call');};await assert.rejects(execute(tools[0],{path:''},c,{user:'',account:'pg-test-example'}),/playground/);assert.equal(calls.length,0);});
test('MCP discovery, manifest parity, confirmations, real error flag',async()=>{
 const manifest=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
 const server=createServer(async()=>{throw Error('Provider failed');});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);const c=new Client({name:'qa',version:'1'});await c.connect(b);
 try {const listed=await c.listTools();assert.equal(listed.tools.length,17);assert.equal(tools.length,14);assert.deepEqual(listed.tools.map(t=>t.name).sort(),manifest.tools.map((t:any)=>t.name).sort());
 for(const t of tools){const m=manifest.tools.find((x:any)=>x.name===t.name);assert.equal(!!m.confirmation,t.write);assert.match(m.description,/Use when/);}
 const result=await c.callTool({name:'delete_item',arguments:{path:'/a'}});assert.equal(result.isError,true);
 }finally{await c.close();await server.close();}
});

for(const name of ['create_folder','copy_item','move_item','upload_file'] as const)test(name+': conflicting destination stays failed, executes once, and gives action-specific advice through MCP',async()=>{
 const selected=tools.find(t=>t.name===name)!;const {c,calls}=fake(selected,{}, {error:Error('409 path/conflict')});
 const server=createServer(((tool:any,args:any)=>execute(tool,args,c,config)) as any),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'conflict-qa',version:'1'});await client.connect(b);
 try{const result:any=await client.callTool({name,arguments:samples[name]});assert.equal(result.isError,true);assert.equal(result.structuredContent.status,'failed');assert.equal(calls.length,1);const message=result.content[0].text;assert.match(message,/Choose another destination/);if(name==='upload_file'){assert.match(message,/explicitly approve Overwrite/);assert.match(message,/cannot replace a folder/);}else assert.doesNotMatch(message,/overwrite/i);assert.doesNotMatch(JSON.stringify(result.structuredContent._voiceos_glance),/Succeeded/);}
 finally{await client.close();await server.close();}
});
