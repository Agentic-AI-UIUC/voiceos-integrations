import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tools,parseArgs} from './catalog.ts';
import {execute,unwrap,readCollection,mapArgs,errorMessage} from './provider.ts';
import {successCard} from './cards.ts';
import {confirmationCard} from './confirmation.ts';
test('all eight native confirmations bind every editable argument and have one Cancel and Confirm',()=>{
 const writes=tools.filter(t=>t.write);assert.equal(writes.length,8);
 for(const tool of writes){const card=confirmationCard(tool);assert.equal(card.root.type,'card');const fields=card.root.children[0].children.filter(c=>c.type==='textField'||c.type==='select');assert.deepEqual(fields.map(f=>f.bind),Object.keys(tool.schema).map(k=>'{{'+k+'}}'));const actions=card.root.footer.flatMap(f=>f.items);assert.deepEqual(actions.map(a=>a.role),['cancel','confirm']);assert.doesNotMatch(JSON.stringify(card),/voiceos:invokeTool|<script|confirmLabel/);if(tool.name==='upload_file'){const mode=fields.find(f=>f.bind==='{{mode}}') as any;assert.equal(mode.type,'select');assert.deepEqual(mode.options,[{label:'Add',value:'add'},{label:'Overwrite',value:'overwrite'}]);assert.equal(card.root.children[0].gap,'sm');assert.doesNotMatch(JSON.stringify(card),/Selected source/);}else assert.ok(fields.every(f=>f.type==='textField'));}
 for(const tool of tools.filter(t=>!t.write))assert.throws(()=>confirmationCard(tool),/Read-only/);
});

test('result cards retain 30 returned rows without exposing raw revision identifiers',()=>{
 const entries=Array.from({length:30},(_,i)=>({name:`file-${i}`,rev:`rev-${i}`,path_display:`/file-${i}`,size:100}));
 const {html}=successCard(tools[0],{entries,has_more:false},{path:''}).blocks[0];
 assert.equal((html.match(/class="db-item"/g)||[]).length,30);assert.match(html,/file-29/);assert.doesNotMatch(html,/rev-29/);assert.match(html,/overflow:auto/);assert.match(html,/30 of 30 returned items/);
});
test('revision and metadata cards show readable dates while model data keeps exact values',()=>{
 const row={name:'review.docx',rev:'0165secret',server_modified:'2026-11-10T21:16:14Z',path_display:'/review.docx',size:13313};
 const revision=successCard(tools.find(t=>t.name==='list_revisions')!,{entries:[row]},{path:'/review.docx'}).blocks[0].html;
 const metadata=successCard(tools.find(t=>t.name==='get_metadata')!,row,{path:'/review.docx'}).blocks[0].html;
 for(const html of [revision,metadata]){assert.doesNotMatch(html,/0165secret|2026-11-10T21:16:14Z/);assert.match(html,/Nov 10/);}
 assert.equal(row.rev,'0165secret');
});
test('shared links are usable but unsafe URLs and binary signed URLs are not rendered as links',()=>{
 const tool=tools.find(t=>t.name==='create_shared_link')!;
 assert.match(successCard(tool,{url:'https://www.dropbox.com/s/a/file'},{path:'/a'}).blocks[0].html,/href="https:\/\/www.dropbox.com\/s\/a\/file"/);
 assert.doesNotMatch(successCard(tool,{url:'javascript:alert(1)'},{path:'/a'}).blocks[0].html,/href="javascript/);
 const read=tools.find(t=>t.name==='read_file')!;
 const html=successCard(read,{content:{s3url:'https://host.invalid/file?X-Amz-Signature=private'}},{path:'/a'}).blocks[0].html;
 assert.doesNotMatch(html,/private/);assert.match(html,/Binary content requires/);
});
test('provider errors and conflicting or malformed envelopes fail closed',()=>{
 assert.throws(()=>unwrap({data:{entries:[]},response_data:{entries:[{}]}}),/Conflicting/);
 assert.throws(()=>readCollection({entries:[null]},'entries'),/Malformed/);
 const cycle:any={};cycle.data=cycle;assert.throws(()=>unwrap(cycle),/nesting/);
 assert.throws(()=>parseArgs(tools[0],{path:'/../a'}));assert.throws(()=>parseArgs(tools[0],{path:'/a\nb'}));
 assert.throws(()=>mapArgs(tools.find(t=>t.name==='copy_item')!,{from_path:'/Source',to_path:'/SOURCE/child'},{type:'object',properties:{from_path:{},to_path:{}}}),/Destination/);
});
test('errors redact credentials and signed URL query strings',()=>{
 const message=errorMessage(Error('Failure https://user:password@example.com/file?X-Amz-Signature=secret api_key=private'));
 for(const secret of ['password','secret','private'])assert.ok(!message.includes(secret));
 assert.match(errorMessage(Error('401 APIKey_InvalidAPIKey')),/Composio API key/);
 assert.match(errorMessage(Error('Set COMPOSIO_API_KEY in VoiceOS Setup.')),/COMPOSIO_API_KEY/);
});
test('large cards disclose display limits while preserving all returned data',()=>{
 const data={entries:Array.from({length:1000},()=>({name:'&'.repeat(150),path_display:'/'+ 'a'.repeat(200)}))};
 const html=successCard(tools[0],data,{path:''}).blocks[0].html;
 assert.ok(html.length<300000);assert.match(html,/full data is returned to the agent/);assert.equal(data.entries.length,1000);
});
test('cancellation before dispatch blocks writes; cancellation after dispatch is unknown and never retried',async()=>{
 const tool=tools.find(t=>t.name==='delete_item')!,abort=new AbortController();let writes=0;
 const c={client:{connectedAccounts:{retrieve:async()=>({id:'ca_test',user_id:'qa',toolkit:{slug:'dropbox'},auth_config:{auth_scheme:'OAUTH2'},status:'ACTIVE'})}},tools:{getRawComposioToolBySlug:async()=>({inputParameters:{type:'object',properties:{path:{type:'string'}}}}),execute:async()=>{writes++;abort.abort();throw Error('cancelled');}}};
 await assert.rejects(execute(tool,{path:'/a'},c,{account:'ca_test',user:'qa'},undefined,abort.signal),/outcome is unknown/);assert.equal(writes,1);
 await assert.rejects(execute(tool,{path:'/a'},c,{account:'ca_test',user:'qa'},undefined,abort.signal),/cancelled/);assert.equal(writes,1);
});
