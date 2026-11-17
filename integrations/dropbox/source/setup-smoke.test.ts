import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for(const [file,args] of [['server.ts',['--setup']],['portable/server.ts',['--setup']]] as const) test(`${file}: setup page, loading UI and CSRF protection`,{timeout:15000},async()=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('./'+file,import.meta.url)),...args],{stdio:['ignore','ignore','pipe']});
 try {
  const url=await new Promise<string>((resolve,reject)=>{let output='';child.stderr.on('data',b=>{output+=b;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});child.once('error',reject);child.once('exit',code=>reject(Error('Setup exited '+code+' '+output)));});
  const response=await fetch(url);assert.equal(response.status,200);const html=await response.text();assert.match(html,/Connect Dropbox/);assert.match(html,/aria-live="polite"/);assert.match(html,/<progress hidden/);assert.match(html,/Connected account ID/);assert.doesNotMatch(html,/CSRF_TOKEN/);
  const blocked=await fetch(url+'/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
 } finally {child.kill();}
});
