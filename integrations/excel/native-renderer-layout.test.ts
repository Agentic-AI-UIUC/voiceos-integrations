import {test,expect} from 'bun:test';
import {readFileSync,existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';

// Local-only audit of the installed renderer components, not a mock stylesheet.
// The proprietary renderer is read from a local audit extract; it is never committed.
const renderer=process.env.VOICEOS_RENDERER_AUDIT || join(tmpdir(),'voiceos-renderer-review.js');
const chrome=[process.env.CHROME_BIN,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(p=>p&&existsSync(p));
const manifest=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
const esc=(s:any)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const available=existsSync(renderer)&&!!chrome;
const check=available?test:test.skip;
check('installed native renderer: every confirmation fits without vertical scrolling, footer overlap or inaccessible editors',()=>{
 const source=readFileSync(renderer,'utf8');
 const section=(a:string,b:string)=>{const start=source.indexOf(a),end=source.indexOf(b,start);if(start<0||end<0)throw Error('Renderer audit boundaries changed: '+a);return source.slice(start,end);};
 const components=section('const GENERIC_DARK = {','const CUSTOM_INTEGRATION_PREFIX =')+section('const renderChildren = (children)','const Markdown =')+section('const inputBaseStyle = {','const PasswordField =')+section('const Actions = ({ block })','const Placeholder =');
 const dir=mkdtempSync(join(tmpdir(),'excel-native-layout-'));
 const reports:any[]=[];const cases:any[]=[];let gallery='';
 for(const width of [360,480,520])for(const long of [false,true])for(const tool of manifest.tools.filter((t:any)=>t.confirmation)){
  const args:any={name:'VoiceOS Review QA 01',current_name:'VoiceOS Review QA 01',new_name:'VoiceOS Review QA Verified',worksheet_name:'VoiceOS Review QA Verified',range:'A1:B4',values:[['Product','Quantity'],['Laptop',2],['Mouse',5],['Keyboard',3]],rows:[['Review Marker 01',7]],table_name:'VoiceOSReviewTable01',table_id:'',chart_type:'ColumnClustered',series_by:'Columns',workbook_id:'FIXTURE_DRIVE!FIXTURE_WORKBOOK_0123456789abcdef0123456789'};
  if(long){args.name=args.current_name=args.new_name=args.worksheet_name='Worksheet name of 31 characters!';args.table_name='Table_'+ 'long_'.repeat(12);args.workbook_id='WORKBOOK_'+ '0123456789abcdef'.repeat(10);args.values=[['Quoted, text','Unicode \u041b\u0438\u0441\u0442'],[null,true],[0,false]];}
  const edits:any={},responses:boolean[]=[];
  const resolve=(v:string)=>v.replace(/\{\{([a-z_]+)\}\}/g,(_,key)=>typeof args[key]==='object'?JSON.stringify(args[key]):String(args[key]??''));
  const jsx=(tag:any,props:any)=>typeof tag==='function'?tag(props):{tag,props};
  const ctx:any={WIDGET_SURFACE_RADIUS_PX:26,jsxRuntimeExports:{jsx,jsxs:jsx},useDecl:()=>({args,edits,setEdit:(k:string,v:any)=>edits[k]=v,respond:(v:boolean)=>responses.push(v),canConfirm:true}),resolveText$1:resolve,bindWriteKey:(v:string)=>v.replace(/[{}]/g,''),currentInputValue:(v:string)=>resolve(v),stopMouseDown:()=>{},renderIcon:(src:string)=>jsx('img',{src,style:{width:18,height:18}}),CustomMcpIconResolved:()=>null};
  const render=runInNewContext(components+`;const BlockRenderer=({block})=>({card:Card,stack:Stack,text:Text,textField:TextField,actions:Actions}[block.type])({block});BlockRenderer;`,ctx);
  const tree=render({block:tool.confirmation.root});
  const visit=(n:any):any[]=>!n||typeof n!=='object'?[]:[n,...(Array.isArray(n.props?.children)?n.props.children:[n.props?.children]).flatMap(visit)];
  const nodes=visit(tree),inputs=nodes.filter(n=>n.tag==='input');
  expect(inputs.length).toBeGreaterThan(0);
  for(const input of inputs){input.props.onChange({target:{value:'Edited value'}});}
  expect(Object.keys(edits)).toHaveLength(inputs.length);
  const buttons=nodes.filter(n=>n.tag==='button');buttons[0].props.onClick();expect(responses).toEqual([false]);buttons[1].props.onClick();expect(responses).toEqual([false,true]);
  const html=(n:any):string=>{if(n===null||n===undefined||n===false)return '';if(Array.isArray(n))return n.map(html).join('');if(typeof n!=='object')return esc(n);const p=n.props||{};const unitless=new Set(['fontWeight','flex','flexShrink','opacity','lineHeight','WebkitLineClamp']);const styles=Object.entries(p.style||{}).filter(([,v])=>v!=null).map(([k,v])=>k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+':'+v+(typeof v==='number'&&!unitless.has(k)?'px':'')).join(';');return '<'+n.tag+' style="'+esc(styles)+'"'+(p.src?' src="'+esc(p.src)+'"':'')+(n.tag==='input'?' value="'+esc(p.value)+'"':'')+'>'+html(p.children)+'</'+n.tag+'>';};
  const card=html(tree);cases.push({tool:tool.name,width,long,card});
  if(width===480&&!long)gallery+=`<section><h3>${tool.title}</h3><div class="preview">${card}</div></section>`;
 }
 const file=join(dir,'cases.html');
 writeFileSync(file,'<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px "Segoe UI",sans-serif;color:#eee;background:#081b36}.card{background:#18191c;border-radius:26px;overflow:hidden}button{border-radius:16px;background:#303236}</style>'+cases.map((c,i)=>'<div class="card" data-case="'+i+'" style="width:'+c.width+'px">'+c.card+'</div>').join('')+'<script>const bounds=e=>{const r=e.getBoundingClientRect(),p=e.closest(".card").getBoundingClientRect();return {top:r.top-p.top,bottom:r.bottom-p.top,left:r.left-p.left,right:r.right-p.left}};document.body.dataset.report=JSON.stringify([...document.querySelectorAll(".card")].map(card=>({height:card.getBoundingClientRect().height,overflow:card.scrollWidth>card.clientWidth,inputs:[...card.querySelectorAll("input")].map(bounds),buttons:[...card.querySelectorAll("button")].map(bounds),textareas:card.querySelectorAll("textarea").length})));</script>');
 const r=Bun.spawnSync([chrome!,'--headless=new','--no-first-run','--disable-gpu','--disable-background-networking','--user-data-dir='+join(dir,'profile'),'--window-size=800,700','--dump-dom',pathToFileURL(file).href],{stdout:'pipe',stderr:'pipe'});
 expect(r.exitCode).toBe(0);const raw=/data-report="([^"]+)"/.exec(r.stdout.toString())![1];const measurements=JSON.parse(raw.replaceAll('&quot;','"').replaceAll('&amp;','&'));
 for(let i=0;i<cases.length;i++){const {tool,width,long}=cases[i],report=measurements[i];reports.push({tool,width,long,...report});expect(report.overflow).toBe(false);expect(report.textareas).toBe(0);expect(report.height).toBeLessThanOrEqual(long?340:(tool==='excel_add_table_rows'?280:300));for(const input of report.inputs){expect(input.left).toBeGreaterThanOrEqual(0);expect(input.right).toBeLessThanOrEqual(width+1);for(const button of report.buttons)expect(input.bottom).toBeLessThanOrEqual(button.top);}for(const button of report.buttons)expect(button.bottom).toBeLessThanOrEqual(report.height);}
 writeFileSync(join(dir,'report.json'),JSON.stringify(reports,null,2));writeFileSync(join(dir,'gallery.html'),`<!doctype html><meta charset="utf-8"><style>body{background:#081b36;color:#eee;font:13px "Segoe UI",sans-serif;display:grid;grid-template-columns:480px 480px;gap:20px;padding:16px}section{width:480px}.preview{background:#18191c;border-radius:26px;overflow:hidden}button{border-radius:16px;background:#303236}</style>${gallery}`);
 console.error('Native renderer audit artifacts: '+dir);
},120000);
