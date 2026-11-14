import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Studio can replace an integration directory on reload. Keep OAuth state in
// the current OS user's application data, scoped to the Composio project key.
export function connectionStateUrl(platform=process.platform,home=homedir(),appData=process.env.APPDATA,key=process.env.COMPOSIO_API_KEY){
 const base=platform==='win32'?(appData||join(home,'AppData','Roaming')):platform==='darwin'?join(home,'Library','Application Support'):process.env.XDG_STATE_HOME||join(home,'.local','state');
 const project=createHash('sha256').update((key||'').trim()).digest('hex').slice(0,24);
 return pathToFileURL(join(base,'VoiceOS','dropbox-composio',`connection-${project}.json`));
}
export const legacyConnectionStateUrl=()=>new URL('./connection.json',import.meta.url);
