import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {accountError,accountRequestOptions,connectAccount,connectionStatus,disconnectAccount,loadState} from './account.ts';
import {accountTools,accountConfirmation} from './account-catalog.ts';
import {approved} from './catalog.ts';
import {dropboxManagedAuthConfig} from './account-config.ts';

test('managed OAuth config uses one permission strategy and limits execution to approved tools',()=>{
 const config=dropboxManagedAuthConfig();
 assert.equal(approved.size,14);
 assert.equal('credentials' in config,false);
 assert.deepEqual(config.toolAccessConfig.toolsForConnectedAccountCreation,[...approved]);
 assert.deepEqual(config.toolAccessConfig.toolsAvailableForExecution,[...approved]);
});

test('account requests get a fresh timeout after the server has been idle',()=>{
 const first=accountRequestOptions();
 const second=accountRequestOptions();
 assert.notEqual(first.signal,second.signal);
 assert.equal(first.signal.aborted,false);
 assert.equal(second.signal.aborted,false);
 assert.equal(first.maxRetries,0);
});

test('account permission failures identify Composio key scope without claiming Dropbox rejected file access',()=>{
 assert.match(accountError(Object.assign(new Error('Forbidden'),{status:403})),/Connected accounts Read and write/);
 assert.match(accountError(Object.assign(new Error('Invalid API key'),{status:401})),/project API key/);
 assert.doesNotMatch(accountError(Object.assign(new Error('Forbidden'),{status:403})),/Dropbox denied permission/);
});

test('three account tools are separate from fourteen approved Dropbox actions and only mutations confirm',()=>{
 assert.equal(approved.size,14);assert.deepEqual(accountTools.map(t=>t.name),['connect_account','connection_status','disconnect_account']);
 for(const name of ['connect_account','disconnect_account'] as const){const card=accountConfirmation(name);assert.equal(card.root.type,'card');assert.deepEqual(card.root.footer[0].items.map(a=>a.role),['cancel','confirm']);assert.doesNotMatch(JSON.stringify(card),/voiceos:invokeTool/);}
});
test('connect opens HTTPS OAuth, verifies ownership, persists account, and status stays read only',async()=>{
 const original=process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;delete process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
 const dir=await mkdtemp(join(tmpdir(),'dropbox-account-')),file=pathToFileURL(join(dir,'connection.json'));
 const raw=(id:string,status='ACTIVE')=>({id,user_id:'voiceos-qa',toolkit:{slug:'dropbox'},auth_config:{auth_scheme:'OAUTH2'},status});
 const calls:string[]=[];
 const c:any={authConfigs:{create:async(_toolkit:string,input:any)=>{calls.push('create');assert.deepEqual(input,dropboxManagedAuthConfig());return {id:'ac_qa',toolkit:'dropbox',authScheme:'OAUTH2'};},get:async()=>({toolkit:{slug:'dropbox'},authScheme:'OAUTH2'})},connectedAccounts:{link:async(user:string)=>{calls.push('link');assert.equal(user,'voiceos-qa');return {id:'ca_qa',redirectUrl:'https://backend.composio.dev/oauth/qa'};},waitForConnection:async()=>{calls.push('wait');return raw('ca_qa');},delete:async()=>({success:true})},client:{connectedAccounts:{retrieve:async(id:string)=>{calls.push('retrieve');return raw(id);}}}};
 try{
  await import('node:fs/promises').then(fs=>fs.writeFile(file,JSON.stringify({user:'voiceos-qa'})));
  const connected=await connectAccount(c,file,async url=>{calls.push('browser');assert.match(url,/^https:/);});
  assert.equal(connected.status,'connected');assert.equal((await loadState(file)).account,'ca_qa');assert.deepEqual(calls,['create','link','browser','wait','retrieve']);
  calls.length=0;const status=await connectionStatus(c,file);assert.equal(status.status,'connected');assert.deepEqual(calls,['retrieve']);assert.doesNotMatch(JSON.stringify(status._voiceos_glance),/invokeTool|button/);
  const disconnected=await disconnectAccount(c,file);assert.equal(disconnected.status,'disconnected');assert.equal((await loadState(file)).disconnectedAccountId,'ca_qa');
  process.env.COMPOSIO_CONNECTED_ACCOUNT_ID='ca_qa';assert.equal((await connectionStatus(c,file)).status,'disconnected');
 }finally{if(original===undefined)delete process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;else process.env.COMPOSIO_CONNECTED_ACCOUNT_ID=original;await rm(dir,{recursive:true,force:true});}
});
test('pending authorization remains recoverable and cannot falsely report connected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dropbox-pending-')),file=pathToFileURL(join(dir,'connection.json'));
 const c:any={authConfigs:{create:async()=>({id:'ac_qa',toolkit:'dropbox',authScheme:'OAUTH2'}),get:async()=>({toolkit:{slug:'dropbox'},authScheme:'OAUTH2'})},connectedAccounts:{link:async()=>({id:'ca_pending',redirectUrl:'https://backend.composio.dev/oauth/qa'}),waitForConnection:async()=>{throw Error('timed out');}},client:{connectedAccounts:{retrieve:async()=>({id:'ca_pending',status:'PENDING'})}}};
 try{await import('node:fs/promises').then(fs=>fs.writeFile(file,JSON.stringify({user:'qa'})));const result=await connectAccount(c,file,async()=>{});assert.equal(result.status,'pending');assert.equal((await loadState(file)).pending?.id,'ca_pending');const status=await connectionStatus(c,file);assert.equal(status.status,'pending');assert.ok((await readFile(file,'utf8')).includes('ca_pending'));let deleted='';c.connectedAccounts.delete=async(id:string)=>{deleted=id;return {success:true};};const disconnected=await disconnectAccount(c,file);assert.equal(disconnected.status,'disconnected');assert.equal(deleted,'ca_pending');assert.equal((await loadState(file)).pending,undefined);}finally{await rm(dir,{recursive:true,force:true});}
});
