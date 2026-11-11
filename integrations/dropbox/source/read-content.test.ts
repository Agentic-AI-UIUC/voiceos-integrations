import {test} from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {documentUrl,downloadDocument,extractDocxText,readDocumentContent,MAX_DOCUMENT_BYTES} from './read-content.ts';
import {execute,client as makeClient} from './provider.ts';
import {tools} from './catalog.ts';
import {successCard} from './cards.ts';
import {createServer} from './server.ts';
const url='https://temp.fixture.r2.cloudflarestorage.com/document?X-Amz-Signature=fixture';
const body='<w:p><w:r><w:t>Résumé &amp; notes &lt;tag&gt;</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Product</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Laptop</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
async function fixture(contents=body){
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+contents+'</w:body></w:document>');
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
test('Word extraction returns paragraphs, table text, Unicode and XML entities as readable text',async()=>{
 const text=await extractDocxText(await fixture(),new AbortController().signal);
 assert.match(text,/Résumé & notes <tag>/);assert.match(text,/Second paragraph/);assert.match(text,/Product/);assert.match(text,/Laptop/);assert.doesNotMatch(text,/<w:p>|<w:t>/);
});
test('downloaded Word text is returned to the agent and shown in the card',async()=>{
 const original={file_name:'Review.docx',content:{s3url:url},metadata:{name:'Review.docx',path_display:'/QA/Review.docx'}};
 const bytes=await fixture();let requests=0;
 const data=await readDocumentContent(original,'/QA/Review.docx',new AbortController().signal,undefined,async(input:any,init:any)=>{requests++;assert.equal(String(input),url);assert.equal(init.redirect,'manual');assert.equal(init.headers,undefined);return new Response(bytes);});
 assert.equal(requests,1);assert.equal(data.extraction.status,'completed');assert.match(data.extracted_text,/Résumé/);assert.equal(data.content,data.extracted_text);assert.deepEqual(data.download,original.content);assert.deepEqual(data.metadata,original.metadata);
 const html=successCard(tools.find(t=>t.name==='read_file')!,data,{path:'/QA/Review.docx'}).blocks[0].html;
 assert.match(html,/Text extracted from Word/);assert.match(html,/Résumé &amp; notes &lt;tag&gt;/);assert.doesNotMatch(html,/Binary content requires|X-Amz-Signature/);
});
test('read-only execution boundary gets file once, then returns extracted text without additional MCP tools',async()=>{
 const bytes=await fixture();let executions=0,downloads=0;
 const c:any={client:{connectedAccounts:{retrieve:async()=>({id:'ca_test',user_id:'qa',toolkit:{slug:'dropbox'},auth_config:{auth_scheme:'OAUTH2'},status:'ACTIVE'})}},tools:{getRawComposioToolBySlug:async()=>({inputParameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}),execute:async()=>{executions++;return {successful:true,data:{file_name:'Review.docx',content:{s3url:url}}};}}};
 const old=globalThis.fetch;globalThis.fetch=async()=>{downloads++;return new Response(bytes);};
 try{const data=await execute(tools.find(t=>t.name==='read_file')!,{path:'/QA/Review.docx'},c,{account:'ca_test',user:'qa'});assert.match(data.extracted_text,/Second paragraph/);assert.equal(executions,1);assert.equal(downloads,1);}finally{globalThis.fetch=old;}
});
test('unknown hosts, local addresses, insecure URLs and credential-bearing URLs are blocked',()=>{
 for(const value of ['http://temp.fixture.r2.cloudflarestorage.com/a','https://127.0.0.1/a','https://example.com/a','https://r2.cloudflarestorage.com.evil.invalid/a','https://user:pass@temp.fixture.r2.cloudflarestorage.com/a'])assert.throws(()=>documentUrl(value));
});
test('download redirect cannot escape to an unapproved host',async()=>{
 let calls=0;await assert.rejects(downloadDocument(url,new AbortController().signal,async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});}),/approved/);assert.equal(calls,1);
});
test('expired download links have a fresh-read hint',async()=>{
 await assert.rejects(downloadDocument(url,new AbortController().signal,async()=>new Response(null,{status:403})),/Read the file again/);
});
test('declared and streaming download sizes are bounded',async()=>{
 await assert.rejects(downloadDocument(url,new AbortController().signal,async()=>new Response('blocked',{headers:{'content-length':String(MAX_DOCUMENT_BYTES+1)}})),/20 MiB/);
 let cancelled=false;
 const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
 await assert.rejects(downloadDocument(url,new AbortController().signal,async()=>new Response(stream)),/20 MiB/);assert.equal(cancelled,true);
});
test('corrupt, empty and oversized expanded archives fail instead of returning binary as text',async()=>{
 await assert.rejects(extractDocxText(Buffer.from('not a Word file'),new AbortController().signal),/invalid|damaged/i);
 await assert.rejects(extractDocxText(Buffer.alloc(0),new AbortController().signal),/empty/);
 const bytes=await fixture();const central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(65*1024*1024,central+24);
 await assert.rejects(extractDocxText(bytes,new AbortController().signal),/limits/);
});
test('XML declarations and external entities are rejected before parsing',async()=>{
 const zip=new JSZip();zip.file('word/document.xml','<!DOCTYPE a [<!ENTITY x SYSTEM "file:///private">]><a>&x;</a>');
 await assert.rejects(extractDocxText(await zip.generateAsync({type:'nodebuffer'}),new AbortController().signal),/unsupported XML/);
});
test('empty Word documents are represented honestly and other binary formats remain retrieval-only',async()=>{
 assert.equal(await extractDocxText(await fixture('<w:p/>'),new AbortController().signal),'');
 const data={file_name:'sheet.xlsx',content:{s3url:url}};assert.equal(await readDocumentContent(data,'/sheet.xlsx',new AbortController().signal),data);
});
test('cancelled downloads cannot return partial text',async()=>{
 const control=new AbortController();control.abort();let requests=0;
 await assert.rejects(downloadDocument(url,control.signal,async()=>{requests++;return new Response('no');}));assert.equal(requests,0);
});
test('Composio constructor disables notices and misleading staging warnings',()=>{
 const c=makeClient('fixture-project-key');assert.equal(c.getConfig().disableVersionCheck,true);assert.equal(c.getConfig().logLevel,'error');
});
test('failed Word extraction is an MCP error, not a green binary-retrieval success',async()=>{
 const server=createServer(async(tool,args,_c,_config,notify,signal)=>readDocumentContent({file_name:'bad.docx',content:{s3url:url}},args.path,signal,notify,async()=>new Response('not a Word document')));
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'word-error-qa',version:'1'});await client.connect(b);
 try{const result:any=await client.callTool({name:'read_file',arguments:{path:'/QA/bad.docx'}});assert.equal(result.isError,true);assert.equal(result.structuredContent.status,'failed');assert.match(result.content[0].text,/Word file is invalid/i);assert.doesNotMatch(JSON.stringify(result.structuredContent._voiceos_glance),/aria-label=\\"Succeeded/);}
 finally{await client.close();await server.close();}
});
