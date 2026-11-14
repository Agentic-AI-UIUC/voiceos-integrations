import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {client,checkAccount,errorMessage} from './provider.ts';
import {dropboxManagedAuthConfig} from './account-config.ts';
import {connectionStateUrl,legacyConnectionStateUrl} from './connection-state.ts';

type State={user?:string;account?:string;authConfig?:string;pending?:{id:string;url:string;user:string;authConfig:string};disconnectedAccountId?:string};
// Abort signals have a fixed deadline. Create one for each request so an
// account action still works after the MCP server has been idle.
export const accountRequestOptions=()=>({signal:AbortSignal.timeout(25000),maxRetries:0});
export async function loadState(file:URL=connectionStateUrl()):Promise<State>{try{return JSON.parse(await readFile(file,'utf8'))||{};}catch(e:any){if(e.code==='ENOENT'){if(file.href!==connectionStateUrl().href)return {};try{return JSON.parse(await readFile(legacyConnectionStateUrl(),'utf8'))||{};}catch(legacy:any){if(legacy.code==='ENOENT')return {};}}throw new Error('Saved Dropbox connection is unreadable. Reconnect using Setup.');}}
export async function saveState(state:State,file:URL=connectionStateUrl()){await mkdir(dirname(fileURLToPath(file)),{recursive:true,mode:0o700});await writeFile(file,JSON.stringify(state,null,2),{mode:0o600});}
export function openAuthorization(url:string):Promise<void>{
 const target=new URL(url);if(target.protocol!=='https:')throw new Error('Composio returned an insecure authorization URL.');
 const command=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'/usr/bin/open':'xdg-open';
 const args=process.platform==='win32'?['url.dll,FileProtocolHandler',target.href]:[target.href];
 return new Promise((resolve,reject)=>execFile(command,args,{timeout:8000,windowsHide:true},e=>e?reject(new Error('Could not open the authorization browser. Use the saved authorization link or local setup page.')):resolve()));
}
function accountResult(status:string,message:string,extra:Record<string,unknown>={}){
 const tone=status==='connected'?'good':status==='error'?'bad':'neutral';
 return {status,message,...extra,_voiceos_glance:{blocks:[{type:'header',title:'Dropbox account',trailing:status==='connected'?'Connected':status==='pending'?'Authorization pending':status==='disconnected'?'Disconnected':'Needs attention'},{type:'badges',items:[{text:message.slice(0,100),tone}]}]}};
}
async function verified(c:any,id:string,user?:string,active=true){const raw=await c.client.connectedAccounts.retrieve(id,accountRequestOptions());const owner=user||raw?.user_id;checkAccount(raw,id,owner,active);return raw;}
function selected(state:State){const manual=process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim()||'';return {account:state.account||(manual&&manual!==state.disconnectedAccountId?manual:''),user:state.account?state.user:process.env.COMPOSIO_USER_ID?.trim()||undefined};}
export async function connectionStatus(c:any=client(),file:URL=connectionStateUrl()){
 const state=await loadState(file),config=selected(state);
 if(state.pending){
  try{const raw=await c.client.connectedAccounts.retrieve(state.pending.id,accountRequestOptions());if(raw?.status==='ACTIVE'){
   checkAccount(raw,raw.id,state.pending.user);
   state.account=raw.id;state.user=state.pending.user;state.authConfig=state.pending.authConfig;delete state.pending;delete state.disconnectedAccountId;await saveState(state,file);
   return accountResult('connected','Dropbox is connected and ready to use.');
  }}catch(e:any){if(e.status!==404&&e.cause?.status!==404)throw e;}
  return accountResult('pending','Finish Dropbox authorization in your browser, then check status again.',{authorization_url:state.pending.url});
 }
 if(!config.account)return accountResult('disconnected','Dropbox is not connected. Ask to connect Dropbox or use Setup.');
 try{const raw=await verified(c,config.account,config.user,false);
  if(raw.status==='ACTIVE'&&!raw.isDisabled)return accountResult('connected','Dropbox is connected and ready to use.');
  return accountResult('error','Dropbox authorization expired or was revoked. Ask to connect Dropbox again.');
 }catch(e:any){if(e.status===404||e.cause?.status===404)return accountResult('error','Dropbox connection was removed. Ask to connect Dropbox again.');throw e;}
}
export async function connectAccount(c:any=client(),file:URL=connectionStateUrl(),open=openAuthorization){
 const state=await loadState(file),config=selected(state);
 if(config.account){try{const raw=await verified(c,config.account,config.user);if(raw.status==='ACTIVE')return accountResult('connected','Dropbox is already connected and ready to use.');}catch{/* Continue with fresh authorization. */}}
 if(!state.pending){
  const user=state.user||`voiceos-${randomUUID()}`;
  let authConfig=state.authConfig;
  if(!authConfig){const created=await c.authConfigs.create('dropbox',dropboxManagedAuthConfig(),accountRequestOptions());
   if(created.toolkit!=='dropbox'||created.authScheme!=='OAUTH2')throw new Error('Created config was not Dropbox OAuth2.');authConfig=created.id;
  }
  const checked=await c.authConfigs.get(authConfig,accountRequestOptions());if(checked.toolkit?.slug!=='dropbox'||checked.authScheme!=='OAUTH2')throw new Error('Auth config must be Dropbox OAuth2.');
  const request=await c.connectedAccounts.link(user,authConfig,{},accountRequestOptions());
  if(!request.id||!request.redirectUrl||new URL(request.redirectUrl).protocol!=='https:')throw new Error('Composio did not return a secure authorization link.');
  state.pending={id:request.id,url:request.redirectUrl,user,authConfig};state.authConfig=authConfig;state.user=user;await saveState(state,file);
 }
 const pending=state.pending;
 await open(pending.url);
 try{
  const account=await c.connectedAccounts.waitForConnection(pending.id,90000);
  await verified(c,account.id,pending.user);
  state.account=account.id;delete state.pending;delete state.disconnectedAccountId;await saveState(state,file);
  return accountResult('connected','Dropbox authorization verified. Your account is ready to use.');
 }catch(e:any){if(/timed?\s*out|pending/i.test(String(e?.message)))return accountResult('pending','Finish Dropbox authorization in your browser, then ask for connection status.',{authorization_url:pending.url});throw e;}
}
export async function disconnectAccount(c:any=client(),file:URL=connectionStateUrl()){
 const state=await loadState(file),config=selected(state),id=state.account||config.account;
 if(state.pending&&state.pending.id!==id){
  try{const pending=await c.client.connectedAccounts.retrieve(state.pending.id,accountRequestOptions());if(pending?.toolkit?.slug&&pending.toolkit.slug!=='dropbox')throw new Error('Refusing to disconnect a non-Dropbox connection.');await c.connectedAccounts.delete(state.pending.id,accountRequestOptions());}
  catch(e:any){if(e.status!==404&&e.cause?.status!==404)throw e;}
 }
 if(!id){delete state.pending;await saveState(state,file);return accountResult('disconnected','Dropbox is disconnected. Your files were not deleted.');}
 const raw=await verified(c,id,state.user||config.user,false);
 const result=await c.connectedAccounts.delete(raw.id,accountRequestOptions());
 if(result?.success===false)throw new Error('Composio did not disconnect Dropbox.');
 state.disconnectedAccountId=id;delete state.account;delete state.pending;await saveState(state,file);
 return accountResult('disconnected','Dropbox was disconnected in Composio. Your files were not deleted.');
}
export function accountError(error:unknown){
 const e=error as {status?:number;cause?:{status?:number};message?:string};
 const status=e?.status??e?.cause?.status;
 const message=String(e?.message||error);
 if(status===403||/\b403\b|forbidden|permission denied/i.test(message))return 'Composio denied account management (HTTP 403). Use a project API key with Connected accounts Read and write access; connecting also needs Auth configs Read and write access. Update the key in VoiceOS Setup and reload. The Dropbox connection was not changed.';
 if(status===401||/APIKey_InvalidAPIKey/i.test(message))return 'Composio rejected the project API key. Update it in VoiceOS Setup and reload. The Dropbox connection was not changed.';
 return errorMessage(error,false,false);
}
