import { test, expect } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = [process.env.CHROME_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const manifest = JSON.parse(readFileSync(new URL('./voiceos.integration.json', import.meta.url), 'utf8'));

(chrome ? test : test.skip)('real browser: range grid scrolls to the last returned row and column', async () => {
 const {renderRangeGrid,renderCustom}=await import('./server.ts');
 const source=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
 const css=/const CSS = `([\s\S]*?)`;/.exec(source)![1];
 const values=Array.from({length:30},(_,r)=>Array.from({length:8},(_,c)=>'Cell '+r+':'+c));
 const dir=mkdtempSync(join(tmpdir(),'excel-range-scroll-')),file=join(dir,'range.html');
 writeFileSync(file,renderCustom({css,body:'<div class="xl">'+renderRangeGrid(values,0,0,8)+'</div>',height:380}).html.replace('</body>','<script>setTimeout(function(){const e=document.querySelector(".xr-wrap");e.scrollTop=e.scrollHeight;e.scrollLeft=e.scrollWidth;document.body.dataset.scrollReport=JSON.stringify({vertical:e.scrollTop>0,horizontal:e.scrollLeft>0,rows:document.querySelectorAll(".xr-rw").length,last:document.querySelector("tbody tr:last-child td:last-child").textContent,scrollbar:getComputedStyle(document.querySelector(".xl")).overflowY});},250);</script></body>'));
 const r=Bun.spawnSync([chrome!,'--headless=new','--no-first-run','--disable-gpu','--disable-background-networking','--user-data-dir='+join(dir,'profile'),'--window-size=320,600','--virtual-time-budget=1000','--dump-dom',pathToFileURL(file).href],{stdout:'pipe',stderr:'pipe'});
 expect(r.exitCode).toBe(0);
 const encoded=/data-scroll-report="([^"]+)"/.exec(r.stdout.toString())![1];
 expect(JSON.parse(encoded.replaceAll('&quot;','"'))).toEqual({vertical:true,horizontal:true,rows:30,last:'Cell 29:7',scrollbar:'auto'});
},30000);
