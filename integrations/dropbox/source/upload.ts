import {stat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {Tool} from './catalog.ts';
export const MAX_LOCAL_UPLOAD_BYTES=50*1024*1024;
function dereference(root:any,value:any){
 let current=value;
 for(let depth=0;current?.$ref&&depth<8;depth++){
  if(typeof current.$ref!=='string'||!current.$ref.startsWith('#/'))throw new Error('Upload schema has an unsupported file reference. No upload attempted.');
  const resolved=current.$ref.slice(2).split('/').reduce((v:any,key:string)=>v?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],root);
  if(!resolved)throw new Error('Upload schema file reference could not be resolved. No upload attempted.');
  const {$ref,...rest}=current;current={...resolved,...rest};
 }
 return current;
}
export function uploadField(schema:any){
 if(!schema?.properties)throw new Error('Upload input schema is unavailable. No upload attempted.');
 const candidates=Object.entries(schema.properties).filter(([key,value])=>{
  const p=dereference(schema,value);
  return p?.file_uploadable===true||(['content','file','file_to_upload'].includes(key)&&p?.type==='object'&&p.properties?.name&&p.properties?.mimetype&&p.properties?.s3key);
 });
 if(candidates.length!==1)throw new Error(`Upload schema must declare exactly one staged-file input; found ${candidates.length}. No Dropbox upload attempted.`);
 const [field,value]=candidates[0],property=dereference(schema,value);
 if(property.type&&property.type!=='object')throw new Error('Upload file input is not a staged-file descriptor. No Dropbox upload attempted.');
 return field;
}
async function interruptible<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason||new Error('Upload staging cancelled'));
  signal.addEventListener('abort',abort,{once:true});
  operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  if(signal.aborted)abort();
 });
}
export async function stageLocalFile(tool:Tool,source:unknown,c:any,signal:AbortSignal,notify:(message:string)=>Promise<void>){
 signal.throwIfAborted();
 if(typeof source!=='string'||!source||!isAbsolute(source)||/^[\["']|[\]"']$/.test(source))throw new Error('Choose the full local file path without surrounding brackets or quotes. No Dropbox upload attempted.');
 let path:string,info;
 try{path=await realpath(source);info=await stat(path);}catch{throw new Error('The selected local file is unavailable. Check its full path and save it before uploading.');}
 if(!info.isFile())throw new Error('Select a local file, not a folder.');
 if(info.size>MAX_LOCAL_UPLOAD_BYTES)throw new Error('This integration supports local uploads up to 50 MiB. Choose a smaller file.');
 if(typeof c.files?.upload!=='function')throw new Error('The Composio file-staging API is unavailable. Reload the integration.');
 signal.throwIfAborted();await notify('Staging the selected file with Composio');
 const descriptor:any=await interruptible(c.files.upload({file:path,toolSlug:tool.slug,toolkitSlug:'dropbox'}),signal);
 signal.throwIfAborted();
 if(!descriptor||!['name','mimetype','s3key'].every(key=>typeof descriptor[key]==='string'&&descriptor[key].length>0))throw new Error('Composio did not return a complete staged-file descriptor. No Dropbox upload attempted.');
 return {name:descriptor.name,mimetype:descriptor.mimetype,s3key:descriptor.s3key};
}
