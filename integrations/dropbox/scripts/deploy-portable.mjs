import {readFile,writeFile,copyFile,mkdir,access} from 'node:fs/promises';
import {join,resolve,basename,dirname} from 'node:path';
const release=new URL('../source/portable/',import.meta.url);
for(const arg of process.argv.slice(2)){
 const target=resolve(arg);
 if(basename(dirname(target))!=='custom-mcps'||!/^dropbox-[a-z0-9]+$/.test(basename(target)))throw Error('Not an explicitly named Dropbox integration folder');
 await access(join(target,'AGENTS.md'));
 const backup=join(target,'backup-portable-'+new Date().toISOString().replace(/[:.]/g,'-'));
 await mkdir(backup);
 for(const name of ['server.ts','voiceos.integration.json','package.json','package-lock.json','studio-meta.json','bun.lock','icon.png','widgetKit.ts']){try{await copyFile(join(target,name),join(backup,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
 const current=JSON.parse((await readFile(join(target,'voiceos.integration.json'),'utf8')).replace(/^\uFEFF/,''));
 const updated=JSON.parse(await readFile(new URL('./voiceos.integration.json',release),'utf8'));
 for(const field of ['version','summary','tools','preferences','permissions','setupGuide']) current[field]=updated[field];
 await writeFile(join(target,'voiceos.integration.json'),JSON.stringify(current,null,2)+'\n');
 for(const name of ['server.ts','icon.png','widgetKit.ts'])await copyFile(new URL(name,release),join(target,name));
 await copyFile(new URL('../package.json',import.meta.url),join(target,'package.json'));
 for(const name of ['package-lock.json','bun.lock'])await copyFile(new URL('../'+name,import.meta.url),join(target,name));
 let meta={};try{meta=JSON.parse((await readFile(join(target,'studio-meta.json'),'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code!=='ENOENT')throw e;}
 Object.assign(meta,JSON.parse(await readFile(new URL('./studio-meta.json',release),'utf8')));
 await writeFile(join(target,'studio-meta.json'),JSON.stringify(meta,null,2)+'\n');
 await copyFile(new URL('../REPAIR-NOTES.md',import.meta.url),join(target,'REPAIR-NOTES.md'));
 console.log(`Installed portable ${updated.version} in ${basename(target)}; backup ${basename(backup)}`);
}
