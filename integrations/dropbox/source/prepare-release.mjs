import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
const root=new URL('./portable/',import.meta.url);
await mkdir(root,{recursive:true});
await copyFile(new URL('../icon.png',import.meta.url),new URL('icon.png',root));
await copyFile(new URL('./widgetKit.ts',import.meta.url),new URL('widgetKit.ts',root));
const manifest=JSON.parse(await readFile(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
await writeFile(new URL('./voiceos.integration.json',root),JSON.stringify(manifest,null,2)+'\n');
const pkg=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
delete pkg.scripts;delete pkg.devDependencies;delete pkg.dependencies['zod-to-json-schema'];
await writeFile(new URL('./package.json',root),JSON.stringify(pkg,null,2)+'\n');
// No demo data, fabricated success cards, or executable dummy file targets.
const preview={utterances:[],toolPreviews:[]};
await writeFile(new URL('./studio-meta.json',root),JSON.stringify({preview,updatedAt:new Date().toISOString()},null,2)+'\n');
