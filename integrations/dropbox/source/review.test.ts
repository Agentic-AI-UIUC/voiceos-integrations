import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tools,parseArgs} from './catalog.ts';
import {execute,unwrap,readCollection,mapArgs,errorMessage} from './provider.ts';
import {successCard} from './cards.ts';
import {confirmationCard} from './confirmation.ts';
import {uploadModeControl} from './upload-mode-control.ts';
import {existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
test('all eight native confirmations bind every editable argument and have one Cancel and Confirm',()=>{
 const writes=tools.filter(t=>t.write);assert.equal(writes.length,8);
 for(const tool of writes){const card=confirmationCard(tool);assert.equal(card.root.type,'card');const fields=card.root.children[0].children.filter(c=>c.type==='textField'||c.type==='select'||c.type==='widget');assert.doesNotMatch(JSON.stringify(card),/voiceos:invokeTool|"type":"select"/);if(tool.name==='upload_file'){assert.deepEqual(fields.map(f=>f.type),['textField','textField','widget']);assert.deepEqual(fields.slice(0,2).map(f=>f.bind),['{{path}}','{{file}}']);const mode=fields[2] as any;assert.equal(mode.height,60);assert.equal(mode.confirmLabel,'Upload File');assert.match(mode.html,/<select/);assert.match(mode.html,/<option value="add">/);assert.match(mode.html,/<option value="overwrite">/);assert.match(mode.html,/voiceos:updateInput/);assert.match(mode.html,/key:'mode'/);assert.equal(card.root.children[0].gap,'sm');assert.equal(card.root.children[0].children.length,4);assert.equal(card.root.children[0].children[3].children[0].role,'cancel');assert.equal(card.root.footer,undefined);assert.doesNotMatch(JSON.stringify(card),/Selected source/);}else {assert.deepEqual(card.root.footer.flatMap(f=>f.items).map(a=>a.role),['cancel','confirm']);assert.deepEqual(fields.map(f=>f.bind),Object.keys(tool.schema).map(k=>'{{'+k+'}}'));assert.ok(fields.every(f=>f.type==='textField'));}}
 for(const tool of tools.filter(t=>!t.write))assert.throws(()=>confirmationCard(tool),/Read-only/);
});

const chrome=[process.env.CHROME_BIN,'C:/Program Files/Google/Chrome/Application/chrome.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&existsSync(p));
test('upload choices remain readable and send the exact staged mode',{skip:!chrome,timeout:30000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'dropbox-upload-mode-'));
 try{
  const html=`<!doctype html><body><script>window.messages=[];window.addEventListener('message',e=>{if(e.data?.type==='voiceos:updateInput')window.messages.push(e.data)});(async()=>{const frame=document.createElement('iframe');frame.style.cssText='width:300px;height:60px;border:0';frame.srcdoc=${JSON.stringify(uploadModeControl.html).replace(/</g,'\\u003c')};document.body.append(frame);await new Promise(r=>frame.onload=r);const d=frame.contentDocument,w=frame.contentWindow,s=d.querySelector('select');w.postMessage({type:'voiceos:init',args:{mode:'overwrite'}},'*');await new Promise(r=>setTimeout(r,50));const initial=s.value==='overwrite';s.value='add';s.dispatchEvent(new Event('change'));s.value='overwrite';s.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,50));const style=w.getComputedStyle(s.options[1]);const result={initial,labels:[...s.options].map(o=>o.textContent),values:window.messages.map(m=>m.value),keys:window.messages.map(m=>m.key),visible:s.getBoundingClientRect().width>0&&s.getBoundingClientRect().height>0,fits:d.documentElement.scrollHeight<=60&&d.documentElement.scrollWidth<=300,color:style.color,background:style.backgroundColor};document.body.dataset.report=btoa(JSON.stringify(result));})().catch(e=>document.body.dataset.failure=String(e));</script>`;
  const file=join(dir,'test.html');writeFileSync(file,html);
  const output=execFileSync(chrome!,['--headless=new','--no-first-run','--disable-gpu','--disable-background-networking','--disable-extensions','--user-data-dir='+join(dir,'profile'),'--allow-file-access-from-files','--virtual-time-budget=3000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',maxBuffer:2*1024*1024,timeout:20000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const encoded=/data-report="([^"]+)"/.exec(output)?.[1];assert.ok(encoded,output.slice(-700));const result=JSON.parse(Buffer.from(encoded,'base64').toString());assert.equal(result.initial,true);assert.deepEqual(result.labels,['Add (no replace)','Overwrite']);assert.deepEqual(result.values,['add','overwrite']);assert.deepEqual(result.keys,['mode','mode']);assert.equal(result.visible,true);assert.equal(result.fits,true);assert.notEqual(result.color,result.background);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('result cards retain 30 returned rows without exposing raw revision identifiers',()=>{
 const entries=Array.from({length:30},(_,i)=>({name:`file-${i}`,rev:`rev-${i}`,path_display:`/file-${i}`,size:100}));
 const {html}=successCard(tools[0],{entries,has_more:false},{path:''}).blocks[0];
 assert.equal((html.match(/class="db-item"/g)||[]).length,30);assert.match(html,/file-29/);assert.doesNotMatch(html,/rev-29/);assert.match(html,/overflow:auto/);assert.match(html,/30 of 30 returned items/);
});
test('revision card shows exact selectable ID and readable date',()=>{
 const row={name:'review.docx',rev:'0165secret',server_modified:'2026-11-10T21:16:14Z',path_display:'/review.docx',size:13313};
 const revision=successCard(tools.find(t=>t.name==='list_revisions')!,{entries:[row]},{path:'/review.docx'}).blocks[0].html;
 const metadata=successCard(tools.find(t=>t.name==='get_metadata')!,row,{path:'/review.docx'}).blocks[0].html;
 assert.match(revision,/Revision ID: <code>0165secret<\/code>/);
 assert.doesNotMatch(metadata,/0165secret/);
 for(const html of [revision,metadata]){assert.doesNotMatch(html,/2026-11-10T21:16:14Z/);assert.match(html,/Nov 10/);}
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
