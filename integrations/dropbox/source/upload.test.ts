import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,truncate,mkdir,symlink} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {tools} from './catalog.ts';
import {execute,mapArgs} from './provider.ts';
import {uploadField,MAX_LOCAL_UPLOAD_BYTES,allowedUploadPath} from './upload.ts';
export const fileDescriptorSchema={type:'object',file_uploadable:true,properties:{name:{type:'string'},mimetype:{type:'string'},s3key:{type:'string'}},required:['name','mimetype','s3key'],additionalProperties:false};
export const uploadSchema={type:'object',properties:{path:{type:'string'},content:fileDescriptorSchema,mode:{type:'string',enum:['add','overwrite']},autorename:{type:'boolean'},strict_conflict:{type:'boolean'}},required:['path','content'],additionalProperties:false};
const tool=tools.find(t=>t.name==='upload_file')!,account={id:'ca_test',user_id:'qa',toolkit:{slug:'dropbox'},auth_config:{auth_scheme:'OAUTH2'},status:'ACTIVE'};
const descriptor={name:'review.docx',mimetype:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',s3key:'staging/test-key'};
const downloads=join(homedir(),'Downloads');
async function testDirectory(prefix:string){await mkdir(downloads,{recursive:true});return mkdtemp(join(downloads,prefix));}
test('upload roots work on Mac and Windows and exclude private and escaping paths',()=>{
 for(const platform of ['darwin','linux']){assert.equal(allowedUploadPath('/Users/qa/Downloads/report.docx','/Users/qa',platform),true);assert.equal(allowedUploadPath('/Users/qa/Library/secret','/Users/qa',platform),false);assert.equal(allowedUploadPath('/Users/qa/Downloads/.private/file','/Users/qa',platform),false);assert.equal(allowedUploadPath('/Users/other/Downloads/file','/Users/qa',platform),false);}
 assert.equal(allowedUploadPath('C:\\Users\\qa\\Documents\\report.docx','C:\\Users\\qa','win32'),true);
 assert.equal(allowedUploadPath('C:\\Users\\qa\\AppData\\Local\\secret','C:\\Users\\qa','win32'),false);
 assert.equal(allowedUploadPath('D:\\Downloads\\secret','C:\\Users\\qa','win32'),false);
});
test('a symlink in Downloads cannot stage a file outside the allowed roots',async t=>{
 const dir=await testDirectory('dropbox-symlink-'),target=join(tmpdir(),'dropbox-outside-'+Date.now()),link=join(dir,'outside.docx');await writeFile(target,'private');
 try{try{await symlink(target,link);}catch(e:any){if(process.platform==='win32'&&e.code==='EPERM'){t.skip('Windows symlink privilege unavailable');return;}throw e;}
  const {client,calls,stages}=uploadClient();await assert.rejects(execute(tool,{path:'/QA/outside.docx',file:link,mode:'add'},client,{account:'ca_test',user:'qa'}),/allowed only/);assert.equal(stages.length,0);assert.equal(calls.length,0);
 }finally{await rm(dir,{recursive:true,force:true});await rm(target,{force:true});}
});
export function uploadClient(schema:any=uploadSchema){
 const calls:any[]=[];const stages:any[]=[];
 const client={client:{connectedAccounts:{retrieve:async()=>account}},files:{upload:async(args:any)=>{stages.push(args);return descriptor;}},tools:{getRawComposioToolBySlug:async()=>({inputParameters:schema}),execute:async(...args:any[])=>{calls.push(args);return {successful:true,data:{name:'review.docx'}};}}};return {client,calls,stages};
}
test('catalog-declared content descriptor replaces guessed file aliases',()=>{
 assert.equal(uploadField(uploadSchema),'content');
 assert.throws(()=>uploadField({properties:{file:{type:'string'}}}),/staged-file/);
 assert.throws(()=>uploadField({properties:{content:fileDescriptorSchema,file:fileDescriptorSchema}}),/exactly one/);
 const args=mapArgs(tool,{path:'/QA/review.docx',file:descriptor,mode:'overwrite'},uploadSchema);
 assert.deepEqual(args.content,descriptor);assert.equal(args.strict_conflict,false);assert.equal(args.autorename,false);
});
test('local binary file is staged without text conversion, then uploaded exactly once',async()=>{
 const dir=await testDirectory('dropbox-upload-');const path=join(dir,'VoiceOS Review QA 01.docx');
 const bytes=Buffer.from([0x50,0x4b,3,4,0,255,128,1]);await writeFile(path,bytes);
 const {client,calls,stages}=uploadClient();const phases:string[]=[];
 client.files.upload=async args=>{stages.push(args);assert.deepEqual(await readFile(args.file),bytes);return descriptor;};
 try{
  await execute(tool,{path:'/QA/review.docx',file:path,mode:'add'},client,{account:'ca_test',user:'qa'},async s=>{phases.push(s);});
  assert.equal(stages.length,1);assert.equal(calls.length,1);assert.equal(stages[0].toolSlug,'DROPBOX_UPLOAD_FILE');assert.equal(stages[0].toolkitSlug,'dropbox');
  assert.deepEqual(calls[0][1].arguments.content,descriptor);assert.equal(calls[0][1].arguments.strict_conflict,true);assert.equal(calls[0][2].maxRetries,0);assert.ok(phases.some(s=>s.includes('Staging')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing file, bad mode, incomplete descriptor and failed staging cannot dispatch a Dropbox upload',async()=>{
 const {client,calls,stages}=uploadClient();
 await assert.rejects(execute(tool,{path:'/QA/a.docx',file:join(tmpdir(),'missing-'+Date.now()+'.docx'),mode:'add'},client,{account:'ca_test',user:'qa'}),/local file is unavailable/);assert.equal(stages.length,0);assert.equal(calls.length,0);
 await assert.rejects(execute(tool,{path:'/QA/a.docx',file:'not-used',mode:'invalid'},client,{account:'ca_test',user:'qa'}),/validation/);assert.equal(stages.length,0);
 const dir=await testDirectory('dropbox-staging-');const path=join(dir,'a.docx');await writeFile(path,'binary fixture');
 try{client.files.upload=async()=>({name:'a.docx'} as any);await assert.rejects(execute(tool,{path:'/QA/a.docx',file:path,mode:'add'},client,{account:'ca_test',user:'qa'}),/complete staged-file descriptor/);client.files.upload=async()=>{throw Error('Staging refused');};await assert.rejects(execute(tool,{path:'/QA/a.docx',file:path,mode:'add'},client,{account:'ca_test',user:'qa'}),/Staging refused/);assert.equal(calls.length,0);}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('upload file schema reference is resolved and validated',()=>{
 const schema={...uploadSchema,properties:{...uploadSchema.properties,content:{$ref:'#/$defs/File'}},$defs:{File:fileDescriptorSchema}};
 assert.equal(uploadField(schema),'content');assert.deepEqual(mapArgs(tool,{path:'/QA/a.docx',file:descriptor,mode:'add'},schema).content,descriptor);
});
test('cancellation during staging cannot dispatch a late Dropbox upload',async()=>{
 const dir=await testDirectory('dropbox-cancel-stage-'),path=join(dir,'review.docx');await writeFile(path,'fixture');
 const {client,calls}=uploadClient(),controller=new AbortController();let stages=0;
 client.files.upload=async()=>{stages++;controller.abort();return descriptor;};
 try{await assert.rejects(execute(tool,{path:'/QA/review.docx',file:path,mode:'add'},client,{account:'ca_test',user:'qa'},undefined,controller.signal),/cancelled/);assert.equal(calls.length,0);assert.equal(stages,1);}finally{await rm(dir,{recursive:true,force:true});}
});
test('local size limit is checked before file staging',async()=>{
 const dir=await testDirectory('dropbox-size-'),path=join(dir,'large.docx');await writeFile(path,'');await truncate(path,MAX_LOCAL_UPLOAD_BYTES+1);
 const {client,calls,stages}=uploadClient();
 try{await assert.rejects(execute(tool,{path:'/QA/large.docx',file:path,mode:'add'},client,{account:'ca_test',user:'qa'}),/50 MiB/);assert.equal(stages.length,0);assert.equal(calls.length,0);}finally{await rm(dir,{recursive:true,force:true});}
});
