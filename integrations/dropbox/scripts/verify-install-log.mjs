import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const logPath=process.argv[2];
if(!logPath)throw new Error('Usage: node scripts/verify-install-log.mjs <VoiceOS first-launch log>');
const expected=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const log=await readFile(resolve(logPath),'utf8');
const build=log.match(/\[dropbox\] Loaded ([^;\r\n]+); version ([^;\r\n]+); (\d+) approved tools/);
if(!build)throw new Error('No Dropbox startup marker found in the log');
if(build[2]!==expected.version||Number(build[3])!==14)throw new Error(`Dropbox startup mismatch: version ${build[2]}, ${build[3]} tools; expected ${expected.version}, 14 tools`);
const installed=new Map([...log.matchAll(/^\s*\+\s+(@?[^\s]+?)@([^\s]+)\s*$/gm)].map(([,name,version])=>[name,version]));
if(!installed.size)throw new Error('No first-launch dependency installation found; use a fresh install log');
const mismatches=Object.entries(expected.dependencies).filter(([name,version])=>/^\d/.test(version)&&installed.get(name)!==version);
if(mismatches.length)throw new Error(`Published package differs from reviewed package: ${mismatches.map(([name,version])=>`${name} installed ${installed.get(name)??'missing'}, expected ${version}`).join('; ')}`);
console.log(`Verified Dropbox ${build[2]}: ${build[3]} tools and all exact dependency pins match package.json`);
