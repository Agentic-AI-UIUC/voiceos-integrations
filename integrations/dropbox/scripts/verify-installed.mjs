import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {BUILD,INTEGRATION_VERSION} from '../source/catalog.ts';
for(const targetArg of process.argv.slice(2)){
 const target=resolve(targetArg);
 const manifest=JSON.parse(await readFile(join(target,'voiceos.integration.json'),'utf8'));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>!key.startsWith('COMPOSIO_')&&typeof value==='string'));
 const transport=new StdioClientTransport({command:process.env.DROPBOX_QA_RUNTIME||process.execPath,args:[join(target,'server.ts')],env,cwd:target,stderr:'pipe'});
 let marker='';transport.stderr.on('data',b=>marker+=String(b));
 const client=new Client({name:'installed-qa',version:'1'});
 try{
  await client.connect(transport);const {tools}=await client.listTools();
  assert.equal(tools.length,14);assert.deepEqual(tools.map(t=>t.name).sort(),manifest.tools.map(t=>t.name).sort());
  assert.ok(marker.includes(BUILD));
  const pkg=JSON.parse(await readFile(join(target,'package.json'),'utf8'));
  for(const name of ['@composio/core','mammoth','yauzl']){
   const installed=JSON.parse(await readFile(join(target,'node_modules',name,'package.json'),'utf8'));
   assert.equal(installed.version,pkg.dependencies[name],`${name}: installed dependency differs from the package pin`);
  }
  assert.equal(manifest.version,INTEGRATION_VERSION);assert.equal(pkg.version,manifest.version);assert.equal(client.getServerVersion()?.version,manifest.version);
  assert.deepEqual(manifest.preferences.map(p=>p.name),['COMPOSIO_API_KEY','COMPOSIO_CONNECTED_ACCOUNT_ID']);
  const result=await client.callTool({name:'list_files',arguments:{path:''}});assert.equal(result.isError,true);assert.match(result.content[0].text,/COMPOSIO_API_KEY/);
  console.log(`${target}: version ${manifest.version} matches manifest/package/MCP; pinned SDK/parsers, portable startup, 14-tool parity, 2-field setup and missing-key handling passed`);
 }catch(e){throw new Error(`${e.message}\nServer stderr: ${marker}`,{cause:e});}finally{await client.close();}
}
