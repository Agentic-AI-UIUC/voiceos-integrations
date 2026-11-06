import { test, expect } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = [process.env.CHROME_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const manifest = JSON.parse(readFileSync(new URL('./voiceos.integration.json', import.meta.url), 'utf8'));

(chrome ? test : test.skip)('real browser: every confirmation field stays above the floating footer when scrolled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'excel-confirm-layout-'));
  const cases = manifest.tools.filter((t: any) => t.confirmation).flatMap((t: any) => [320, 480].flatMap(width => [40, 80].map(lift => ({ name: t.name, width, lift, ...t.confirmation.root }))));
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
      // Mirror the host overflow CSS; also test an extra 40px rail intrusion.
      frame.srcdoc=c.html+'<style>html{overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior:contain}body{overflow:visible!important;overscroll-behavior:auto}</style>';
      await loaded;
      const doc=frame.contentDocument, form=doc.querySelector('.cf');
      const formBox=form.getBoundingClientRect(), frameBox=frame.getBoundingClientRect(), buttonBox=button.getBoundingClientRect();
      const footerGap=buttonBox.top-(frameBox.top+formBox.bottom);
      const hidden=[];
      for(const field of doc.querySelectorAll('[data-voiceos-key]')){
        field.focus();
        field.scrollIntoView({block:'nearest'});
        const r=field.getBoundingClientRect(), f=form.getBoundingClientRect();
        if(r.top<f.top-1||r.bottom>f.bottom+1)hidden.push(field.getAttribute('data-voiceos-key'));
      }
      results.push({name:c.name,width:c.width,lift:c.lift,footerGap,hidden,outerOverflow:doc.documentElement.scrollHeight-frame.clientHeight,frameHeight:frame.clientHeight,formTop:formBox.top,formBottom:formBox.bottom,rootHeight:doc.querySelector(".k-cwrap").getBoundingClientRect().height,rootPadding:frame.contentWindow.getComputedStyle(doc.querySelector(".k-cwrap")).paddingBottom});
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
    expect(entry.footerGap).toBeGreaterThanOrEqual(24);
    expect(entry.outerOverflow).toBeLessThanOrEqual(1);
  }
}, 30000);
