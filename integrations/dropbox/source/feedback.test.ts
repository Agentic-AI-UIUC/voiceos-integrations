import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from './server.ts';
async function call(run:any,name:string,args:any){
 const server=createServer(run);const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);
 const client=new Client({name:'feedback-qa',version:'1'});await client.connect(b);
 try {const result:any=await client.callTool({name,arguments:args});return {result,payload:result.structuredContent||JSON.parse(result.content[0].text)};}
 finally {await client.close();await server.close();}
}
test('real result gets green success icon and escaped filename',async()=>{
 const data={entries:[{name:'<img src=x onerror=alert(1)>.xlsx'}],has_more:false};
 const {result,payload}=await call(async()=>data,'list_files',{path:''});
 assert.notEqual(result.isError,true);assert.deepEqual(payload.data,data);
 const html=payload._voiceos_glance.blocks[0].html;
 assert.match(html,/data-status="completed"/);assert.match(html,/aria-label="Succeeded"/);assert.match(html,/fill="#30d158"/);
 assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);assert.doesNotMatch(html,/Illustration only|Example|\/Documents\/example/);
});
test('empty live search is successful and says no matches',async()=>{
 const {payload}=await call(async()=>({matches:[],more:false}),'search_files',{query:'unknown'});
 assert.match(payload._voiceos_glance.blocks[0].html,/No matches found/);
 assert.match(payload._voiceos_glance.blocks[0].html,/aria-label="Succeeded"/);
});
test('failed action never gets success card',async()=>{
 const {result,payload}=await call(async()=>{throw Error('Unavailable');},'get_metadata',{path:'/missing'});
 assert.equal(result.isError,true);assert.equal(payload.status,'failed');assert.doesNotMatch(JSON.stringify(payload._voiceos_glance),/Succeeded|Completed/);assert.match(result.content[0].text,/unavailable/i);assert.doesNotMatch(result.content[0].text,/\{|_voiceos_glance/);
});
test('release previews contain no dummy cards or executable sample targets',()=>{
 const meta=JSON.parse(readFileSync(new URL('./portable/studio-meta.json',import.meta.url),'utf8'));
 assert.deepEqual(meta.preview,{utterances:[],toolPreviews:[]});
 const manifest=JSON.parse(readFileSync(new URL('./portable/voiceos.integration.json',import.meta.url),'utf8'));
 assert.doesNotMatch(JSON.stringify(manifest),/\/Documents\/example|select-a-real-revision|Illustration only/);
});
test('write outcome unknown stays unknown rather than falsely completed or failed',async()=>{
 const {result,payload}=await call(async()=>{throw Error('Dropbox write outcome is unknown. Inspect Dropbox before retrying.');},'delete_item',{path:'/a'});
 assert.equal(result.isError,true);assert.equal(payload.status,'unknown');assert.match(result.content[0].text,/unknown/);assert.doesNotMatch(JSON.stringify(payload._voiceos_glance),/Succeeded/);
});
test('a renderer failure after a completed write cannot turn success into a failed write',async()=>{
 const data={metadata:{path_display:{toString:null,valueOf:null}}};let writes=0;
 const {payload}=await call(async()=>{writes++;return data;},'create_folder',{path:'/a'});
 assert.equal(writes,1);assert.equal(payload.status,'completed');assert.deepEqual(payload.data,data);assert.equal(payload._voiceos_glance.blocks[0].type,'header');
});
