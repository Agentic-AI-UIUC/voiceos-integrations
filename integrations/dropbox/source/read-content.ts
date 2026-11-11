import mammoth from 'mammoth';
import yauzl from 'yauzl';
export const MAX_DOCUMENT_BYTES=20*1024*1024;
const MAX_EXPANDED_BYTES=64*1024*1024,MAX_ENTRY_BYTES=32*1024*1024,MAX_TEXT_CHARS=1000000;
export function documentUrl(value:unknown){
 let u:URL;try{u=new URL(String(value));}catch{throw new Error('The Word document has no valid download reference. Read it again.');}
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!/^[-a-z0-9.]+\.r2\.cloudflarestorage\.com$/i.test(u.hostname))throw new Error('The document download host is not an approved Composio storage host.');
 return u;
}
export async function downloadDocument(reference:unknown,signal:AbortSignal,fetcher:typeof fetch=fetch){
 let url=documentUrl(reference);
 for(let redirects=0;redirects<4;redirects++){
  signal.throwIfAborted();
  const response=await fetcher(url.href,{method:'GET',redirect:'manual',signal,cache:'no-store'});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');await response.body?.cancel();
   if(!location)throw new Error('The document download redirect has no destination.');
   url=documentUrl(new URL(location,url).href);continue;
  }
  if(response.status===401||response.status===403){await response.body?.cancel();throw new Error('The document download link expired or was denied. Read the file again to request a fresh link.');}
  if(!response.ok){await response.body?.cancel();throw new Error('The Word document could not be downloaded. Read it again after checking Dropbox.');}
  const declared=Number(response.headers.get('content-length'));
  if(declared>MAX_DOCUMENT_BYTES){await response.body?.cancel();throw new Error('Word text extraction supports documents up to 20 MiB.');}
  if(!response.body)throw new Error('The Word document download was empty.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
   while(true){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_DOCUMENT_BYTES){await reader.cancel();throw new Error('Word text extraction supports documents up to 20 MiB.');}chunks.push(value);}
  }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
  signal.throwIfAborted();
  return Buffer.concat(chunks,total);
 }
 throw new Error('Too many redirects while downloading the Word document.');
}
export async function validateDocxArchive(buffer:Buffer,signal:AbortSignal){
 signal.throwIfAborted();
 if(buffer.length>MAX_DOCUMENT_BYTES)throw new Error('Word text extraction supports documents up to 20 MiB.');
 if(buffer.length<4||buffer.readUInt32LE(0)!==0x04034b50)throw new Error('The Word file is invalid, encrypted, or not a supported .docx document.');
 let zip:any;try{zip=await yauzl.fromBufferPromise(buffer,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true});}catch{throw new Error('The Word file is damaged or is not a valid DOCX archive.');}
 let count=0,total=0,actual=0,main=false;
 try{
  for await(const entry of zip.eachEntry()){
   signal.throwIfAborted();count++;total+=entry.uncompressedSize;
   if(count>2048||!Number.isSafeInteger(total)||total>MAX_EXPANDED_BYTES||entry.uncompressedSize>MAX_ENTRY_BYTES)throw new Error('The Word document exceeds safe extraction limits.');
   if(entry.generalPurposeBitFlag&1)throw new Error('Password-protected Word documents cannot be read. Save an unencrypted .docx copy.');
   if(entry.fileName==='word/document.xml')main=true;
   if(entry.fileName.endsWith('/'))continue;
   const stream=await zip.openReadStreamPromise(entry);
   const abort=()=>stream.destroy(new Error('Document read cancelled'));
   signal.addEventListener('abort',abort,{once:true});
   let tail='';
   try{for await(const chunk of stream){signal.throwIfAborted();actual+=chunk.length;if(actual>MAX_EXPANDED_BYTES)throw new Error('The Word document exceeds safe extraction limits.');if(/\.(?:xml|rels)$/i.test(entry.fileName)){const xml=tail+chunk.toString('utf8');if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('The Word document uses unsupported XML declarations.');tail=xml.slice(-40);}}}
   finally{signal.removeEventListener('abort',abort);stream.destroy();}
  }
  if(!main)throw new Error('This archive does not contain a Word document.');
 }finally{zip.close();}
}
export async function extractDocxText(buffer:Buffer,signal:AbortSignal){
 if(buffer.length<4)throw new Error('The Word document is empty or damaged.');
 await validateDocxArchive(buffer,signal);signal.throwIfAborted();
 let result:any;try{result=await mammoth.extractRawText({buffer});}catch{throw new Error('The Word document was retrieved but its text could not be extracted. It may be damaged or unsupported.');}
 signal.throwIfAborted();
 const text=String(result.value||'').replace(/\r\n?/g,'\n').trim();
 if(text.length>MAX_TEXT_CHARS)throw new Error('The Word document has too much text for one read. Split it into smaller documents.');
 return text;
}
export async function readDocumentContent(data:any,path:string,signal:AbortSignal,notify:(message:string)=>Promise<void>=async()=>{},fetcher:typeof fetch=fetch){
 const name=data?.file_name||data?.metadata?.name||path;
 const docx=/\.docx$/i.test(name)||data?.content?.mimetype==='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 if(!docx)return data;
 const reference=data?.content?.s3url||data?.content?.s3Url;
 if(!reference)throw new Error('The Word document was retrieved without a downloadable file reference. Read it again.');
 await notify('Downloading Word document for text extraction');
 const buffer=await downloadDocument(reference,signal,fetcher);
 await notify('Extracting text from Word document');
 const text=await extractDocxText(buffer,signal);
 return {...data,download:data.content,content:text,extracted_text:text,extraction:{format:'docx',status:'completed',character_count:text.length,empty:text.length===0}};
}
