import type {Tool} from './catalog.ts';
import {safeSharedUrl} from './link-controls.ts';
export function responseGuidance(tool:Tool){
 if(tool.name==='create_shared_link'||tool.name==='list_shared_links')return ' Shared links are already available through the card Open/Copy controls. Use the returned summary for a brief reply; do not rebuild the URL or print it in a second formatted response. Reuse the exact returned URL for revocation. Never repeat a completed write because narration formatting failed.';
 if(tool.name==='list_revisions')return ' The card shows exact revision IDs. If the user asks for a revision ID, quote the exact rev value from the returned entry, identify it by its timestamp, and do not infer an ID from a date.';
 if('collection' in tool)return ' The card already shows the returned items. Keep default narration brief and do not repeat the entire list unless the user explicitly asks for those details.';
 return '';
}
function compactLink(item:any){
 const out:Record<string,any>={};for(const key of ['name','id','path_lower','path_display','rev','server_modified','client_modified','size'])if(['string','number'].includes(typeof item?.[key]))out[key]=item[key];
 const url=safeSharedUrl(item?.url);if(url)out.url=url;out.link_available=!!url;
 for(const key of ['resolved_visibility','link_access_level']){const value=item?.link_permissions?.[key];if(typeof value==='string')out[key]=value;else if(typeof value?.['.tag']==='string')out[key]=value['.tag'];}
 return out;
}
export function presentResult(tool:Tool,data:any){
 if(tool.name==='create_shared_link'){
  const normalized=compactLink(data);return {data:normalized,summary:normalized.link_available?'Shared link created. Use Open shared link or Copy link in the card.':'Dropbox completed the action but returned no usable link. Inspect Dropbox before repeating the action.',provider_data:data};
 }
 if(tool.name==='list_shared_links'){
  const links=data.links.map(compactLink),unavailable=links.filter((l:any)=>!l.link_available).length;
  return {data:{links,has_more:data.has_more===true,...(typeof data.cursor==='string'?{cursor:data.cursor}:{})},summary:links.length?`${links.length} shared link${links.length===1?'':'s'} returned. Use the Open/Copy controls in the card.${unavailable?' Some returned links could not be displayed safely.':''}${data.has_more===true?' More pages are available.':''}`:'No shared links found.',provider_data:data};
 }
 if('collection' in tool)return {data,summary:`${data[tool.collection].length} ${tool.name==='list_revisions'?'revisions':'items'} returned. See the scrollable card for details.${data.has_more===true||data.more===true?' More pages are available.':''}`};
 return {data};
}
