import { createServer } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { client,checkAccount,errorMessage } from './provider.ts';
import { approved,VERSION } from './catalog.ts';
import {dropboxManagedAuthConfig} from './account-config.ts';
declare const VOICEOS_SETUP_HTML:string;
export async function startSetup(){
const csrf=randomBytes(32).toString('hex');
const configUrl=new URL('./connection.json',import.meta.url);
let selected:{user:string,account:string,authConfig:string}|undefined;
let pending:any;
let busy=false;
try { const saved=JSON.parse(await readFile(configUrl,'utf8'));if(saved?.account)selected=saved; } catch(e:any) {if(e.code!=='ENOENT') throw e;}
const html=typeof VOICEOS_SETUP_HTML==='string'?VOICEOS_SETUP_HTML:await readFile(new URL('./setup.html',import.meta.url),'utf8');
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403).end();return;}
  if(req.method==='GET'&&req.url==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html.replace('CSRF_TOKEN',csrf));return;}
  if(req.method!=='POST'||req.headers['x-setup-token']!==csrf||req.headers.origin!==`http://127.0.0.1:${port}`){res.writeHead(403).end();return;}
  if(busy){res.setHeader('Content-Type','application/json');res.writeHead(409).end(JSON.stringify({error:'A setup operation is still running. Please wait.'}));return;}
  busy=true;
  res.setHeader('Content-Type','application/json');
  try {
    let body=''; for await(const chunk of req){body+=chunk;if(body.length>8192) throw new Error('Request too large');}
    const args=JSON.parse(body), c=client(args.key||process.env.COMPOSIO_API_KEY);
    const options={signal:AbortSignal.timeout(25000),maxRetries:0};
    if(req.url==='/connect') {
      const user=typeof args.user==='string'&&args.user.trim()?args.user.trim():selected?.user||`voiceos-${randomUUID()}`;
      let authConfig=args.authConfig?.trim()||selected?.authConfig;
      if(!authConfig) {
        const config=await c.authConfigs.create('dropbox',dropboxManagedAuthConfig(),options);
        if(config.toolkit!=='dropbox'||config.authScheme!=='OAUTH2') throw new Error('Created config was not Dropbox OAuth2.');
        authConfig=config.id;
      }
      const config=await c.authConfigs.get(authConfig,options);
      if(config.toolkit.slug!=='dropbox'||config.authScheme!=='OAUTH2') throw new Error('Auth config must be Dropbox OAuth2.');
      const request=await c.connectedAccounts.link(user,authConfig,{},options);
      const url=new URL(request.redirectUrl!);
      if(url.protocol!=='https:') throw new Error('Composio returned an insecure authorization URL.');
      pending={user,authConfig,request};
      res.end(JSON.stringify({url:url.href,message:'Authorize Dropbox in the opened tab, then select Check connection.'}));
    } else if(req.url==='/check') {
      if(pending){
        // A Connect Link session ID is not an active connected account ID.
        const account=await pending.request.waitForConnection(15000);
        const raw=await c.client.connectedAccounts.retrieve(account.id,options);
        checkAccount(raw,account.id,pending.user);
        selected={user:pending.user,account:account.id,authConfig:pending.authConfig};
        await writeFile(configUrl,JSON.stringify(selected,null,2),{mode:0o600});
        pending=undefined;
      } else if(selected){
        const raw=await c.client.connectedAccounts.retrieve(selected.account,options);
        checkAccount(raw,selected.account,selected.user);
      } else throw new Error('Start Connect first.');
      res.end(JSON.stringify({message:'Dropbox is connected. Copy the account ID below into VoiceOS Setup, save the API key there, then Reload.',account:selected.account}));
    } else if(req.url==='/disconnect') {
      if(!selected) throw new Error('No saved Dropbox connection.');
      const raw=await c.client.connectedAccounts.retrieve(selected.account,options);
      checkAccount(raw,selected.account,selected.user,false);
      const result=await c.connectedAccounts.delete(selected.account,options);
      if(result.success===false) throw new Error('Composio did not delete the connection.');
      await writeFile(configUrl,JSON.stringify({disconnectedAccountId:selected.account,user:selected.user,authConfig:selected.authConfig},null,2),{mode:0o600});
      selected=undefined;pending=undefined;
      res.end(JSON.stringify({message:'Disconnected from Composio. You can also revoke app access in Dropbox settings. Clear any account ID override in VoiceOS Setup.'}));
    } else if(req.url==='/audit') {
      const schemas:Record<string,unknown>={};
      for(const slug of approved) schemas[slug]=await c.tools.getRawComposioToolBySlug(slug,{version:VERSION},options);
      await writeFile(new URL('./catalog-snapshot.json',import.meta.url),JSON.stringify(schemas,null,2));
      res.end(JSON.stringify({message:'Saved all 14 pinned catalog schemas for review. No Dropbox files were changed.'}));
    } else {res.writeHead(404).end('{}');}
  } catch(e:any) {res.writeHead(400).end(JSON.stringify({error:errorMessage(e)}));}
  finally {busy=false;}
});
let port=0;
server.listen(0,'127.0.0.1',()=>{port=(server.address() as any).port;console.error(`Dropbox setup: http://127.0.0.1:${port}\nPress Ctrl+C when finished.`);});
}
