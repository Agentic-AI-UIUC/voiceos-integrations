import {responseGuidance} from './presentation.ts';
import { readFileSync,writeFileSync } from 'node:fs';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { tools,INTEGRATION_VERSION } from './catalog.ts';
import { confirmationCard } from './confirmation.ts';
const m=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
m.version=INTEGRATION_VERSION;
m.summary='Find, read, upload, organize, version and share Dropbox files through Composio OAuth2.';
m.permissions=[{kind:'network',domains:['backend.composio.dev','*.r2.cloudflarestorage.com']},{kind:'background'}];
m.preferences=[{name:'COMPOSIO_API_KEY',title:'Composio API key',description:'Your Composio project API key. Save it here; never paste Dropbox tokens. Reload after saving.',type:'password',required:true},{name:'COMPOSIO_CONNECTED_ACCOUNT_ID',title:'Dropbox connected account ID',description:'Required: the actual active Dropbox OAuth2 connection ID from Composio (normally ca_...). This is not a project ID, playground test ID, or user ID. The owner is retrieved automatically.',type:'text',required:true}];
m.setupGuide={title:'Connect Dropbox with Composio OAuth2',collapsedByDefault:false,blocks:[{type:'text',text:'From this integration folder, run npm run setup to open the local Composio OAuth2 Connect/Disconnect page. After authorizing Dropbox, select Check connection and copy the active connected account ID (normally ca_...) into the field below with your Composio API key. Save both fields, then Reload. No separate User ID is required. You can also connect in the Composio dashboard. A pg-test-... playground identifier is not a connected account ID. To disconnect, use the setup page or remove the connection in Composio, then clear these preferences.'}]};
m.tools=tools.map(t=>{
 const inputSchema=zodToJsonSchema(z.object(t.schema).strict(),{$refStrategy:'none'});delete inputSchema.$schema;
 const card=t.write?confirmationCard(t):undefined;
 // Native footer actions and input bindings are rendered and executed by VoiceOS.
 return {name:t.name,title:t.title,description:`${t.title} via Composio OAuth2. Use when the user asks to ${t.use}. Returns provider data including pagination; never infer all pages were read.${responseGuidance(t)}`,inputSchema,execution:{mode:'background'},...(card?{confirmation:card}: {})};
});
writeFileSync(new URL('./voiceos.integration.json',import.meta.url),JSON.stringify(m,null,2)+'\n');
const pkg=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));
pkg.dependencies.mammoth='1.13.0';pkg.dependencies.yauzl='3.4.0';pkg.devDependencies={...pkg.devDependencies,jszip:'3.10.1'};
pkg.version=INTEGRATION_VERSION;pkg.dependencies['@composio/core']='0.28.0';pkg.dependencies.ajv='8.17.1';pkg.dependencies['zod-to-json-schema']='3.25.0';pkg.scripts={setup:'tsx server.ts --setup',test:'tsx --test integration.test.ts setup-smoke.test.ts portable.test.ts feedback.test.ts review.test.ts layout.test.ts upload.test.ts brand.test.ts read-content.test.ts links.test.ts links-browser.test.ts','build:manifest':'tsx build-manifest.ts','build:portable':'node build-portable.mjs'};
writeFileSync(new URL('./package.json',import.meta.url),JSON.stringify(pkg,null,2)+'\n');
