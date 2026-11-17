import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeSharedUrl,linkControls} from './link-controls.ts';
import {presentResult} from './presentation.ts';
import {tools} from './catalog.ts';
import {createServer} from './server.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const url='https://www.dropbox.com/scl/fi/test/review.docx?rlkey=qa%2Ftest+value&dl=0';
test('shared URLs preserve exact query bytes and reject unsafe destinations',()=>{
 assert.equal(safeSharedUrl(url),url);
 for(const bad of ['javascript:alert(1)','http://dropbox.com/a','https://dropbox.com.evil/a','https://a@dropbox.com/a','https://dropbox.com:444/a','https://dropbox.com/a\n','https://dropbox.com/<script>','https://dropbox.com/'+ 'x'.repeat(4096)])assert.equal(safeSharedUrl(bad),undefined,bad);
 assert.match(linkControls(url,0),/rlkey=qa%2Ftest\+value&amp;dl=0/);
 assert.doesNotMatch(linkControls('javascript:alert(1)',0),/<a /);
});
test('shared-link summaries retain original provider details separately and pagination honestly',()=>{
 const tool=tools.find(t=>t.name==='list_shared_links')!;
 const raw={links:[{name:'review.docx',url,link_permissions:{resolved_visibility:{'.tag':'public'},can_revoke:true}}],has_more:true,cursor:'next'};
 const result=presentResult(tool,raw);
 assert.equal(result.data.links[0].url,url);assert.equal(result.provider_data,raw);assert.equal(result.data.cursor,'next');assert.match(result.summary!,/More pages/);assert.ok(!result.summary!.includes(url));
 assert.match(presentResult(tool,{links:[],has_more:false}).summary!,/No shared links/);
 assert.match(presentResult(tool,{links:[{url:'https://evil.test'}]}).summary!,/could not be displayed safely/);
});
test('MCP shared-link completion executes once, supplies compact content, and retains raw provider metadata',async()=>{
 const raw={url,name:'review.docx',link_permissions:{resolved_visibility:{'.tag':'public'},options:[{nested:'policy'}]}};let calls=0;
 const server=createServer((async()=>{calls++;return raw;}) as any);
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'links-qa',version:'1'});await client.connect(b);
 try{const result:any=await client.callTool({name:'create_shared_link',arguments:{path:'/qa/review.docx'}});const payload=JSON.parse(result.content[0].text);
 assert.equal(calls,1);assert.notEqual(result.isError,true);assert.equal(payload.status,'completed');assert.equal(payload.data.url,url);assert.equal(payload.data.resolved_visibility,'public');assert.deepEqual(result.structuredContent.provider_data,raw);assert.match(payload._voiceos_glance.blocks[0].html,/Copy link/);
 }finally{await client.close();await server.close();}
});
