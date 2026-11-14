import {linkControls,LINK_CSS,LINK_JS} from './link-controls.ts';
import {scrollControls,SCROLL_CSS,SCROLL_JS} from './scroll-controls.ts';
import {renderCustom,esc} from './widgetKit.ts';
import type {Tool} from './catalog.ts';
import {brandMark,BRAND_CSS} from './brand.ts';
const CSS=BRAND_CSS+LINK_CSS+SCROLL_CSS+`.db-card{padding:14px 16px;font:13px/1.4 system-ui;color:var(--ink-1)}.db-card header{display:flex;align-items:center;gap:9px;margin-bottom:10px}.db-card header svg{flex:none}.db-card strong{font-size:13px;flex:1;min-width:0;overflow-wrap:anywhere}.db-state{display:inline-flex;align-items:center;gap:5px;font-size:11px;flex:none;color:#30d158}.db-scroll{max-height:258px;overflow:auto;overscroll-behavior:contain;scrollbar-width:auto!important;scrollbar-color:#999 transparent}.db-scroll::-webkit-scrollbar{display:block!important;width:7px}.db-scroll::-webkit-scrollbar-thumb{background:#999;border-radius:5px}.db-item{padding:7px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.db-item:first-child{border-top:0}.db-detail{margin:5px 0;color:var(--ink-2);font-size:11px;overflow-wrap:anywhere}.db-meta{color:var(--ink-3);font-size:11px;display:block}.db-card a{color:var(--accent);overflow-wrap:anywhere}.db-card pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.4 ui-monospace,monospace;margin:0}.db-error{color:var(--bad,#ff453a)}`;
function icon(ok:boolean){return `<svg role="img" aria-label="${ok?'Succeeded':'Failed'}" width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="${ok?'#30d158':'#ff453a'}"/><path d="${ok?'m6.5 12 3.5 3.5 7.5-7.5':'m8 8 8 8m0-8-8 8'}" fill="none" stroke="#071b0d" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;}
function size(n:unknown){if(typeof n!=='number'||!Number.isFinite(n)||n<0)return '';return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;}
export function readableDate(value:unknown){if(typeof value!=='string')return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date);}
export function successCard(tool:Tool,data:any,args:Record<string,any>){
 const entries='collection' in tool?data[tool.collection]:undefined;
 let content='',shown=0,budget=0,textLength=0;
 if(entries){
  const empty=tool.name==='search_files'?'No matches found':tool.name==='list_files'?'Folder is empty':tool.name==='list_revisions'?'No revisions found':'No shared links found';
  if(!entries.length)content=`<p class="db-detail">${empty}</p>`;
  for(const row of entries){
   const item=row.metadata?.metadata||row.metadata||row;
   const name=item.name||item.path_display||(item.rev?'File revision':undefined)||item.id;
   const details=[item['.tag']==='folder'?'Folder':size(item.size),readableDate(item.server_modified)].filter(Boolean).join(' · ');
   const link=tool.name==='list_shared_links'?linkControls(item.url,shown):'';
   const fragment=`<div class="db-item"><span>${esc(String(name||'Unlabelled returned item').slice(0,180))}</span>${item.path_display?`<span class="db-meta">${esc(item.path_display.slice(0,220))}</span>`:''}${details?`<span class="db-meta">${esc(details)}</span>`:''}${link}</div>`;
   if(budget+fragment.length>140000)break;
   content+=fragment;budget+=fragment.length;shown++;
  }
 }else{
  const item=data?.metadata||data;
  const detail=item?.path_display||data?.file_name||item?.name||args.to_path||args.path;
  if(detail)content+=`<div class="db-item">${esc(String(detail).slice(0,300))}</div>`;
  const pairs=[['Size',size(item?.size)],['Modified',readableDate(item?.server_modified)]].filter(([,v])=>v);
  for(const [label,value]of pairs)content+=`<p class="db-detail">${label}: ${esc(String(value))}</p>`;
  if(tool.name==='create_shared_link')content+=linkControls(data?.url,0);
  const text=typeof data?.extracted_text==='string'?data.extracted_text:typeof data?.content==='string'?data.content:typeof data==='string'?data:undefined;
  if(data?.extraction?.status==='completed')content+=`<p class="db-detail">${text?'Text extracted from Word document':'No extractable text found in the Word document.'}</p>`;
  if(text!==undefined){textLength=text.length;content+=`<pre>${esc(text.slice(0,20000))}</pre>`;if(text.length>20000)content+='<p class="db-detail">Text preview shortened; full content is returned to the agent.</p>';}
  if(tool.name==='read_file'&&data?.content?.s3url&&data?.extraction?.status!=='completed')content+='<p class="db-detail">File retrieved. Binary content requires a compatible file reader.</p>';
 }
 const count=entries?`<p class="db-detail">${shown} of ${entries.length} returned items${shown<entries.length?' shown; full data is returned to the agent':''}${data.has_more===true||data.more===true?' · More pages available':''}</p>`:'';
 const card=renderCustom({accent:'#0061ff',label:`${tool.title}: completed`,height:entries?.length?Math.min(380,116+shown*(tool.name==='list_shared_links'?160:55)):textLength?Math.min(380,190+Math.ceil(textLength/70)*18):tool.name==='create_shared_link'?280:180,css:CSS,body:`<section class="db-card" data-status="completed"><header>${brandMark()}<strong>${esc(tool.title)}</strong><span class="db-state">${icon(true)}Completed</span></header>${count}${scrollControls(content)}</section><script>${SCROLL_JS}${LINK_JS}</script>`});
 return {blocks:[{type:'widget',html:card.html,height:card.height}]};
}
export function failureCard(tool:Tool,message:string,status='failed'){const label=status==='unknown'?'Outcome unknown':status==='cancelled'?'Cancelled':'Failed';const card=renderCustom({accent:'#0061ff',height:200,css:CSS,body:`<section class="db-card" data-status="${esc(status)}"><header>${brandMark()}<strong>${esc(tool.title)}</strong><span class="db-state db-error">${icon(false)}${label}</span></header><p>${esc(message)}</p></section>`});return {blocks:[{type:'widget',html:card.html,height:card.height}]};}
