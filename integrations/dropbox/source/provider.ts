import { Composio } from '@composio/core';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { approved, VERSION, type Tool } from './catalog.ts';
import {uploadField,stageLocalFile} from './upload.ts';
import {readDocumentContent} from './read-content.ts';
export const client = (key = process.env.COMPOSIO_API_KEY) => {
  if (!key?.trim()) throw new Error('Set COMPOSIO_API_KEY in VoiceOS Setup.');
  return new Composio({apiKey:key.trim(),baseUrl:'https://backend.composio.dev',disableVersionCheck:true,logLevel:'error'});
};
export function connection() {
  let saved:any={};
  try {saved=JSON.parse(readFileSync(new URL('./connection.json',import.meta.url),'utf8'))||{};}
  catch(e:any) {if(e.code!=='ENOENT') throw new Error('Saved Dropbox connection is unreadable. Reconnect using Setup.');}
  return {user:process.env.COMPOSIO_USER_ID?.trim()||saved.user||'',account:process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim()||saved.account||''};
}
export function checkAccount(a:any,id:string,user:string,active=true) {
  if (!user || a?.id!==id || a?.user_id!==user) throw new Error('Cannot verify account ownership. Check COMPOSIO_USER_ID and connected account ID.');
  if(a.toolkit?.slug!=='dropbox') throw new Error('Selected account is not Dropbox.');
  if(a.auth_config?.auth_scheme!=='OAUTH2' && a.authScheme!=='OAUTH2') throw new Error('Selected Dropbox account must use OAuth2.');
  if(active && a.status!=='ACTIVE') throw new Error('Dropbox OAuth connection is inactive, expired, or revoked. Reconnect using Setup.');
}
export function unwrap(value:any,depth=0):any {
  if(depth>8) throw new Error('Malformed Composio result: excessive wrapper nesting.');
  if(value==null) throw new Error('Composio returned no result.');
  if(typeof value==='object') {
    if(value.successful===false || value.success===false || value.error) throw new Error(typeof value.error==='string'?value.error:JSON.stringify(value.error||'Provider reported failure'));
    if(value.data!==undefined&&value.response_data!==undefined&&!isDeepStrictEqual(value.data,value.response_data))throw new Error('Conflicting Composio result envelopes.');
    if(value.data!==undefined) return unwrap(value.data,depth+1);
    if(value.response_data!==undefined) return unwrap(value.response_data,depth+1);
  }
  return value;
}
export function readCollection(data:any,key:string,allowMoreWithoutCursor=false) {
  if(!data || typeof data!=='object' || !Array.isArray(data[key])) throw new Error(`Malformed Dropbox response: missing ${key} array. No empty result inferred.`);
  if(data.has_more===true && typeof data.cursor!=='string' && !allowMoreWithoutCursor) throw new Error('Incomplete Dropbox page: continuation cursor missing.');
  if(data[key].some((row:any)=>{if(!row||typeof row!=='object'||Array.isArray(row))return true;const item=row.metadata?.metadata||row.metadata||row;return ![item?.name,item?.url,item?.rev,item?.id,item?.path_display].some(v=>typeof v==='string'&&v.length>0);}))throw new Error('Malformed Dropbox collection item.');
  return data[key];
}
// Explicit compatibility mappings, selected only when the pinned schema declares the exact field.
// Unrecognized or newly required fields fail closed; no speculative execution or retries.
export function mapArgs(tool:Tool,input:Record<string,any>,schema:any) {
  if(!schema?.properties || schema.type!=='object') throw new Error('Pinned Composio input schema unavailable. No execution attempted.');
  const p=schema.properties, args:Record<string,any>={};
  for(const [key,value] of Object.entries(input)) {
    if(value===undefined) continue;
    if(key==='file' && tool.name==='upload_file') {
      args[uploadField(schema)]=value;
    } else if(tool.name==='search_files' && (key==='path'||key==='max_results') && !(key in p) && 'options' in p) {
      args.options={...args.options,[key]:value};
    } else {
      if(!(key in p)) throw new Error(`Pinned ${tool.slug} schema does not accept ${key}; no execution attempted.`);
      args[key]=value;
    }
  }
  for(const key of ['autorename','allow_ownership_transfer','allow_shared_folder']) if(key in p) args[key]=false;
  // Dropbox add mode must conflict instead of silently renaming/overwriting.
  if(tool.name==='upload_file' && 'strict_conflict' in p) args.strict_conflict=input.mode!=='overwrite';
  if(input.from_path && input.to_path){const from=input.from_path.toLowerCase(),to=input.to_path.toLowerCase();if(from===to||to.startsWith(from+'/'))throw new Error('Destination must differ from the source and cannot be inside it.');}
  const validate=new Ajv({strict:false,allErrors:true,validateFormats:false}).compile(schema);
  if(!validate(args)) throw new Error(`Pinned ${tool.slug} input validation failed: ${JSON.stringify(validate.errors)}. No execution attempted.`);
  return args;
}
export function errorMessage(error:any,write=false,started=false,action?:Tool['name']) {
  const m=String(error?.message||error);
  if(/^The selected local file is unavailable|^The Composio file-staging API is unavailable/.test(m))return m;
  if(/cancelled|canceled/i.test(m))return write&&started?'Dropbox write outcome is unknown after cancellation. Inspect Dropbox before retrying.':'Dropbox request was cancelled before completion.';
  if(/abort|timeout|timed out|ECONNRESET|fetch failed/i.test(m)) return write&&started?'Dropbox write outcome is unknown. Inspect the destination before retrying; no automatic retry was made.':'Dropbox request timed out. Try again after checking the connection.';
  if(/invalid.*api.?key|APIKey_Invalid|missing.*api.?key/i.test(m))return 'Composio API key is missing or invalid. Update it in VoiceOS Setup and reload.';
  if(/401|invalid_access_token|expired.*token|revoked|reauth/i.test(m)) return 'Dropbox OAuth token expired or was revoked. Reconnect using Setup.';
  if(/403|permission|insufficient_scope|no_permission/i.test(m)) return 'Dropbox denied permission. Check file access and reconnect with the required scopes.';
  if(/too_large|file.size|payload.*large|413/i.test(m)) return 'File exceeds the supported transfer size. Choose a smaller file; this integration does not start multipart upload sessions.';
  if(/conflict|already_exists|409/i.test(m)) return action==='upload_file'?'Dropbox destination conflicts with an existing item. Choose another destination, or explicitly approve Overwrite to replace an existing file. Overwrite cannot replace a folder.':'Dropbox destination already exists or conflicts with another item. Choose another destination.';
  if(/not_found|404|not_file|unavailable/i.test(m)) return 'Dropbox file or folder is unavailable. Check the exact path and account.';
  // Avoid reflecting request headers, credentials, signed URLs, or provider payloads into the UI.
  return m.replace(/https?:\/\/[^\s"'<>]+/gi,(raw)=>{try{const u=new URL(raw);u.username='';u.password='';if(/signature|credential|token|key|code/i.test(u.search))u.search='?[redacted]';return u.href;}catch{return '[URL redacted]';}}).replace(/Bearer\s+[^\s",}]+|(?:api[_-]?key|access_token|refresh_token)["']?\s*[:=]\s*["']?[^\s"',}]+/gi,'[redacted]').slice(0,500);
}
export async function execute(tool:Tool,input:Record<string,any>,c:any=client(),config=connection(),notify: (message:string)=>Promise<void>=async()=>{},externalSignal?:AbortSignal) {
  if(!approved.has(tool.slug)) throw new Error('Unapproved Dropbox action.');
  if(!config.account) throw new Error('Save the active Dropbox connected account ID in VoiceOS Setup, then Reload.');
  if(config.account.startsWith('pg-test-')) throw new Error('This is a Composio playground test ID, not a Dropbox connected account ID. Use the active Dropbox connection ID (normally ca_...) from Composio.');
  let started=false;
  const deadline=AbortSignal.timeout(45000);
  const signal=externalSignal?AbortSignal.any([deadline,externalSignal]):deadline;
  try {
    signal.throwIfAborted();
    await notify('Checking Dropbox account');
    const account=await c.client.connectedAccounts.retrieve(config.account,{signal,maxRetries:0});
    // A manually selected account is authorized by the user's project API key.
    // Resolve its raw owner instead of guessing "default" or forcing a second ID.
    const userId=config.user || account?.user_id;
    if(typeof userId!=='string'||!userId.trim()) throw new Error('Composio did not return an account owner. Set COMPOSIO_USER_ID to the exact owner shown in Composio.');
    checkAccount(account,config.account,userId);
    const raw=await c.tools.getRawComposioToolBySlug(tool.slug,{version:VERSION},{signal,maxRetries:0});
    let prepared=input;
    if(tool.name==='upload_file'){
      const field=uploadField(raw.inputParameters);
      const {file,...other}=input;
      const preflight={...raw.inputParameters,required:(raw.inputParameters.required||[]).filter((key:string)=>key!==field)};
      mapArgs(tool,other,preflight);
      prepared={...input,file:await stageLocalFile(tool,file,c,signal,notify)};
    }
    const args=mapArgs(tool,prepared,raw.inputParameters);
    await notify(tool.name==='upload_file'?'Uploading the staged file to Dropbox':'Running Dropbox action');
    signal.throwIfAborted();started=true;
    const result=await c.tools.execute(tool.slug,{userId,connectedAccountId:config.account,arguments:args,version:VERSION},{signal,maxRetries:0});
    const data=unwrap(result);
    // Dropbox revisions reports has_more at a small limit, but does not
    // provide a continuation cursor. Return the valid partial page so the
    // agent can request a larger limit instead of reporting a false error.
    if('collection' in tool) readCollection(data,tool.collection,tool.name==='list_revisions');
    return tool.name==='read_file'?await readDocumentContent(data,input.path,signal,notify):data;
  } catch(e) {
    if(externalSignal?.aborted)throw new Error(errorMessage(new Error('Request cancelled'),tool.write,started,tool.name));
    if(signal.aborted)throw new Error(errorMessage(new Error('Request timed out'),tool.write,started));
    throw new Error(errorMessage(e,tool.write,started));
  }
}
