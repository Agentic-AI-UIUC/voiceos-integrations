import type {Tool} from './catalog.ts';
import {uploadModeControl} from './upload-mode-control.ts';
const labels:Record<string,string>={path:'File or folder path',from_path:'Source path',to_path:'Destination path',file:'Local source file',mode:'Upload behavior (add or overwrite)',rev:'Revision ID',url:'Shared link'};
export function confirmationCard(tool:Tool){
 if(!tool.write)throw Error('Read-only tools must not have confirmations');
 const note=tool.name==='upload_file'?'Add stops if the destination exists. Overwrite replaces its contents.':tool.name==='delete_item'?'Deletes this item and everything inside it. Recovery depends on your Dropbox plan.':tool.name==='restore_revision'?'Replaces the current file with the exact revision below.':tool.name==='create_shared_link'?'Creates a link using the default access settings for your Dropbox account.':tool.name==='revoke_shared_link'?'People using this link will lose access through it.':tool.name==='create_folder'?'Review the destination path, then create this folder.':'Review the exact source and destination before continuing.';
 const fields=Object.keys(tool.schema).map(key=>key==='mode'?uploadModeControl:{type:'textField',bind:'{{'+key+'}}',label:key==='file'?'Local file':key==='path'&&(tool.name==='upload_file'||tool.name==='create_folder')?'Destination path':labels[key]||key,required:true});
 return {schemaVersion:1,root:{type:'card',title:tool.title,children:[{type:'stack',direction:'vertical',gap:tool.name==='upload_file'?'sm':'md',children:[...(tool.name==='upload_file'?[]:[{type:'text',text:note,color:'muted'}]),...fields]}],footer:[{type:'actions',items:[{label:'Cancel',role:'cancel'},{label:tool.title,role:'confirm',color:'accent'}]}]}};
}
