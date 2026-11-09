import { test, expect } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = [process.env.CHROME_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const manifest = JSON.parse(readFileSync(new URL('./voiceos.integration.json', import.meta.url), 'utf8'));

(chrome ? test : test.skip)('real browser: every confirmation field stays above the floating footer when scrolled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'excel-confirm-layout-'));
  const cases = manifest.tools.filter((t: any) => t.confirmation).flatMap((t: any) => [320, 480].flatMap(width => [40, 56].map(lift => ({ name: t.name, width, lift, ...t.confirmation.root }))));
  const payload = JSON.stringify(cases).replace(/</g, '\\u003c');
  const html = `<!doctype html><html><body><script>
  (async function(){
    const cases=${payload}; const results=[];
    await Promise.all(cases.map(async c=>{
      const host=document.createElement('div');
      host.style.cssText='position:fixed;top:0;left:0;width:'+c.width+'px;height:'+c.height+'px;margin-bottom:20px';
      const frame=document.createElement('iframe');
      frame.style.cssText='display:block;border:0;width:100%;height:'+c.height+'px';
      const rail=document.createElement('div');
      rail.style.cssText='position:sticky;bottom:0;height:0;display:flex;justify-content:flex-end;pointer-events:none';
      const button=document.createElement('button');button.textContent=c.confirmLabel;
      button.style.cssText='height:36px;transform:translateY(-'+c.lift+'px);margin-right:12px';
      rail.append(button);host.append(frame,rail);document.body.append(host);
      const loaded=new Promise(resolve=>frame.onload=resolve);
      // Mirror the 40px host rail lift and test an additional 16px intrusion.
      frame.srcdoc=c.html+'<style>html{overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior:contain}body{overflow:visible!important;overscroll-behavior:auto}</style>';
      await loaded;
      const doc=frame.contentDocument, form=doc.querySelector('.cf');
      const formBox=form.getBoundingClientRect(), frameBox=frame.getBoundingClientRect(), buttonBox=button.getBoundingClientRect();
      const footerGap=buttonBox.top-(frameBox.top+formBox.bottom);
      const hint=doc.querySelector('.cf-scroll-hint');
      const hintBox=hint?.getBoundingClientRect();
      const hintVisible=!!hint;
      const backdrop=doc.querySelector('.cf-button-backdrop');
      const backdropSafe=()=>{const r=backdrop.getBoundingClientRect(), b=button.getBoundingClientRect(), style=frame.contentWindow.getComputedStyle(backdrop);return r.top<=b.top-frameBox.top && r.bottom>=b.bottom-frameBox.top && style.backgroundColor==='rgb(17, 17, 17)' && style.pointerEvents==='none';};
      const backdropBefore=backdropSafe();
      const hidden=[];
      for(const field of doc.querySelectorAll('[data-voiceos-key]')){
        field.focus();
        field.scrollIntoView({block:'nearest'});
        const r=field.getBoundingClientRect(), f=form.getBoundingClientRect();
        if(r.top<f.top-1||r.bottom>f.bottom+1)hidden.push(field.getAttribute('data-voiceos-key'));
      }
      results.push({name:c.name,width:c.width,lift:c.lift,footerGap,hidden,scrollbarMode:frame.contentWindow.getComputedStyle(form).overflowY,needsScroll:form.scrollHeight>form.clientHeight+1,hintVisible,backdropBefore,backdropAfter:backdropSafe(),outerOverflow:doc.documentElement.scrollHeight-frame.clientHeight,frameHeight:frame.clientHeight,formTop:formBox.top,formBottom:formBox.bottom,rootHeight:doc.querySelector(".k-cwrap").getBoundingClientRect().height,rootPadding:frame.contentWindow.getComputedStyle(doc.querySelector(".k-cwrap")).paddingBottom});
    }));
    document.body.setAttribute('data-layout-report',btoa(JSON.stringify(results)));
  })().catch(error=>document.body.setAttribute('data-layout-error',String(error)));
  </script></body></html>`;
  const file=join(dir,'layout.html');writeFileSync(file,html);
  const result=Bun.spawnSync([chrome!, '--headless=new', '--no-first-run', '--disable-gpu', '--disable-background-networking', '--disable-extensions', '--no-default-browser-check', '--user-data-dir='+join(dir,'profile'), '--allow-file-access-from-files', '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(file).href], {stdout:'pipe',stderr:'pipe'});
  const output=result.stdout.toString();
  expect(result.exitCode).toBe(0);
  const encoded=/data-layout-report="([^"]+)"/.exec(output)?.[1];
  if(!encoded)throw new Error('Browser did not finish layout measurements: '+output.slice(-1500));
  const measured=JSON.parse(Buffer.from(encoded,'base64').toString());
  expect(measured).toHaveLength(24);
  for(const entry of measured){
    expect({name:entry.name,width:entry.width,hidden:entry.hidden}).toEqual({name:entry.name,width:entry.width,hidden:[]});
    expect(entry.footerGap).toBeGreaterThanOrEqual(0);
    expect(entry.hintVisible).toBe(false);
    expect(entry.scrollbarMode).toBe('auto');
    if(entry.name==='excel_create_worksheet'||entry.name==='excel_rename_worksheet')expect(entry.needsScroll).toBe(false);
    expect(entry.backdropBefore).toBe(true);
    expect(entry.backdropAfter).toBe(true);
    expect(entry.outerOverflow).toBeLessThanOrEqual(1);
  }
}, 30000);

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
