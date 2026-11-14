import {responseGuidance} from './presentation.ts';
import { readFileSync,writeFileSync } from 'node:fs';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { tools,INTEGRATION_VERSION } from './catalog.ts';
import { confirmationCard } from './confirmation.ts';
import {accountTools,accountConfirmation} from './account-catalog.ts';
const m=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
m.version=INTEGRATION_VERSION;
m.summary='Find, read, upload, organize, version and share Dropbox files through Composio OAuth2.';
m.permissions=[{kind:'network',domains:['backend.composio.dev','*.r2.cloudflarestorage.com']},{kind:'background'}];
m.preferences=[{name:'COMPOSIO_API_KEY',title:'Composio API key',description:'Your Composio project API key. Save it here; never paste Dropbox tokens. Reload after saving.',type:'password',required:true},{name:'COMPOSIO_CONNECTED_ACCOUNT_ID',title:'Dropbox connected account ID (manual fallback)',description:'Optional: an active Dropbox OAuth2 connection ID from Composio (normally ca_...). Leave blank when using the Connect Dropbox voice tool. This is not a project, playground, or user ID.',type:'text',required:false}];
m.setupGuide={title:'Connect Dropbox with Composio OAuth2',collapsedByDefault:false,blocks:[{type:'text',text:'Save your Composio project API key, then ask VoiceOS to connect Dropbox. Voice Connect/Disconnect requires Connected accounts Read and write access; creating an OAuth config also requires Auth configs Read and write access. Approve the confirmation card and authorize Dropbox in your browser. Ask for Dropbox connection status to verify. You can ask VoiceOS to disconnect Dropbox. Fallback: run npm run setup in this integration folder to use the local Connect/Disconnect page, then copy its active connected account ID (normally ca_...) into Setup and Reload. A pg-test-... identifier is not a connected account ID.'}]};
m.tools=tools.map(t=>{
 const inputSchema=zodToJsonSchema(z.object(t.schema).strict(),{$refStrategy:'none'});delete inputSchema.$schema;
 const card=t.write?confirmationCard(t):undefined;
 // Native footer actions and input bindings are rendered and executed by VoiceOS.
 return {name:t.name,title:t.title,description:`${t.title} via Composio OAuth2. Use when the user asks to ${t.use}. Returns provider data including pagination; never infer all pages were read.${responseGuidance(t)}`,inputSchema,execution:{mode:'background'},...(card?{confirmation:card}: {})};
});
m.tools.push(...accountTools.map(t=>({name:t.name,title:t.title,description:t.description,inputSchema:{type:'object',properties:{},additionalProperties:false},execution:{mode:'background'},...(t.write?{confirmation:accountConfirmation(t.name as 'connect_account'|'disconnect_account')}: {})})));
writeFileSync(new URL('./voiceos.integration.json',import.meta.url),JSON.stringify(m,null,2)+'\n');
const pkg=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));
pkg.dependencies.mammoth='1.13.0';pkg.dependencies.yauzl='3.4.0';pkg.devDependencies={...pkg.devDependencies,jszip:'3.10.1'};
pkg.version=INTEGRATION_VERSION;pkg.dependencies['@composio/core']='0.28.0';pkg.dependencies.ajv='8.17.1';pkg.dependencies['zod-to-json-schema']='3.25.0';pkg.scripts={setup:'tsx server.ts --setup',test:'tsx --test account.test.ts integration.test.ts setup-smoke.test.ts portable.test.ts feedback.test.ts review.test.ts layout.test.ts upload.test.ts brand.test.ts read-content.test.ts links.test.ts links-browser.test.ts','build:manifest':'tsx build-manifest.ts','build:portable':'node build-portable.mjs'};
writeFileSync(new URL('./package.json',import.meta.url),JSON.stringify(pkg,null,2)+'\n');
