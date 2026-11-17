import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {tools} from './catalog.ts';
import {successCard} from './cards.ts';
const chrome=[process.env.CHROME_BIN,'C:/Program Files/Google/Chrome/Application/chrome.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&existsSync(p));
test('browser: result lists scroll to the last item without clipping their brand and status',{skip:!chrome,timeout:45000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'dropbox-cards-'));
 const results=successCard(tools[0],{entries:Array.from({length:30},(_,i)=>({name:'file-'+i})),has_more:false},{path:''}).blocks[0];
 const html=`<!doctype html><html><body><script>(async()=>{
 const iframe=document.createElement('iframe');iframe.style.cssText='width:320px;height:380px;border:0';document.body.append(iframe);const loaded=new Promise(r=>iframe.onload=r);iframe.srcdoc=${JSON.stringify(results.html).replace(/</g,'\\u003c')};await loaded;
 const doc=iframe.contentDocument,scroll=doc.querySelector('.db-scroll');scroll.scrollTop=scroll.scrollHeight;
 const logo=doc.querySelector('.db-brand').getBoundingClientRect(),title=doc.querySelector('.db-card strong').getBoundingClientRect(),status=doc.querySelector('.db-state').getBoundingClientRect();
 document.body.dataset.report=btoa(JSON.stringify({results:{rows:doc.querySelectorAll('.db-item').length,last:doc.querySelector('.db-item:last-child').textContent,scrolls:scroll.scrollTop>0,logoClear:logo.right<=title.left&&title.right<=status.left,markBars:doc.querySelectorAll('.k-mkbar').length}}));
 })().catch(e=>document.body.dataset.failure=String(e));</script></body></html>`;
 const file=join(dir,'cards.html');writeFileSync(file,html);
 const output=execFileSync(chrome!,['--headless=new','--no-first-run','--disable-gpu','--disable-background-networking','--disable-extensions','--user-data-dir='+join(dir,'profile'),'--allow-file-access-from-files','--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',maxBuffer:32*1024*1024,timeout:35000,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const encoded=/data-report="([^"]+)"/.exec(output)?.[1];assert.ok(encoded,'Browser report missing: '+output.slice(-1000));
 const measured=JSON.parse(Buffer.from(encoded,'base64').toString()); assert.deepEqual(measured.results,{rows:30,last:'file-29',scrolls:true,logoClear:true,markBars:0});
});
