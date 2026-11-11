import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
const dir=fileURLToPath(new URL('./portable/',import.meta.url));
await mkdir(dir,{recursive:true});
const setupHtml=await readFile(new URL('./setup.html',import.meta.url),'utf8');
await build({entryPoints:[fileURLToPath(new URL('./server.ts',import.meta.url))],outfile:dir+'/server.ts',bundle:true,packages:'external',platform:'node',target:'es2022',format:'esm',charset:'utf8',define:{VOICEOS_SETUP_HTML:JSON.stringify(setupHtml)},banner:{js:'// VoiceOS portable server: MCP tools and OAuth setup UI are bundled. Copy this entire file into Studio.'}});
