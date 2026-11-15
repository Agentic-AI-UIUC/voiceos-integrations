/** Keep the embedded confirmation formatter aligned with the server's date validator.
 * Run: bun syncConfirmationDates.ts (Studio copies the generated manifest).
 */
import {toIsoOrThrow,validateDate} from './server.ts';
const path=new URL('./voiceos.integration.json',import.meta.url);
const manifest=await Bun.file(path).json();
const formatter=`${validateDate.toString()}\n${toIsoOrThrow.toString()}\nfunction fmt(v){if(!v)return '';try{var d=new Date(toIsoOrThrow(v,'Time'));return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+' · '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZoneName:'short'})}catch(e){return null;}}\n`;
for(const tool of manifest.tools){
 const root=tool.confirmation?.root;
 if(root?.html)root.html=root.html.replace(/(?:function validateDate[\s\S]*?)?function fmt\(v\)[\s\S]*?(?=function hint)/,formatter).replace('Not a valid date — use 2026-11-12T15:30:00-06:00','Use a valid date with Z or UTC offset, e.g. 2026-11-12T15:30:00-06:00');
}
await Bun.write(path,JSON.stringify(manifest,null,2)+'\n');
