import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {BUILD,INTEGRATION_VERSION} from './catalog.ts';

test('release packages and lockfiles pin the same Composio SDK',async()=>{
 const root=new URL('../',import.meta.url);
 for(const relative of ['package.json','source/package.json','source/portable/package.json']){
  const pkg=JSON.parse(await readFile(new URL(relative,root),'utf8'));
  assert.equal(pkg.version,INTEGRATION_VERSION,relative);
  assert.equal(pkg.dependencies['@composio/core'],'0.28.0',relative);
 }
 for(const relative of ['package-lock.json','source/package-lock.json']){
  const lock=JSON.parse(await readFile(new URL(relative,root),'utf8'));
  assert.equal(lock.version,INTEGRATION_VERSION,relative);
  assert.equal(lock.packages[''].dependencies['@composio/core'],'0.28.0',relative);
  assert.equal(lock.packages['node_modules/@composio/core'].version,'0.28.0',relative);
 }
 const bun=await readFile(new URL('bun.lock',root),'utf8');
 assert.match(bun,/"@composio\/core": "0\.28\.0"/);
 assert.match(bun,/"@composio\/core": \["@composio\/core@0\.28\.0"/);
});
test('Studio-style clean folder starts and discovers exactly 14 tools without local helpers',{timeout:20000},async()=>{
 const dir=await mkdtemp(fileURLToPath(new URL('./portable-check-',import.meta.url)));
 let client:Client|undefined;
 try {
  const bundle=new URL('./portable/server.ts',import.meta.url);
  const source=await readFile(bundle,'utf8');
  assert.doesNotMatch(source,/(?:from\s*|import\s*\()\s*['"]\.\//);
  await copyFile(bundle,dir+'/server.ts');await writeFile(dir+'/package.json','{"type":"module"}');
  assert.deepEqual((await readdir(dir)).sort(),['package.json','server.ts']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>!key.startsWith('COMPOSIO_')&&typeof value==='string')) as Record<string,string>;
  const transport=new StdioClientTransport({command:process.execPath,args:[dir+'/server.ts'],env,cwd:dir,stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',b=>stderr+=String(b));
  client=new Client({name:'portable-qa',version:'1'});await client.connect(transport);
  const list=await client.listTools();assert.equal(list.tools.length,14);assert.ok(stderr.includes(BUILD));assert.doesNotMatch(stderr,/Dropbox setup:/);assert.equal(client.getServerVersion()?.version,INTEGRATION_VERSION);
  const result:any=await client.callTool({name:'list_files',arguments:{path:''}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/COMPOSIO_API_KEY/);
 } finally {await client?.close();await rm(dir,{recursive:true,force:true});}
});
