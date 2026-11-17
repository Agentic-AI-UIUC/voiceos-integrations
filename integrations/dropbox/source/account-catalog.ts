export const accountTools = [
  {name:'connect_account',title:'Connect Dropbox',description:'Connect Dropbox through Composio OAuth2. Use when the user asks to connect or authorize their Dropbox account. Opens browser consent and verifies the connection; does not change Dropbox files.',write:true},
  {name:'connection_status',title:'Dropbox account status',description:'Check this Dropbox OAuth2 connection. Use when the user asks whether Dropbox is connected or needs reauthorization. Read only; does not start OAuth or change files.',write:false},
  {name:'disconnect_account',title:'Disconnect Dropbox',description:'Disconnect the saved Dropbox account in Composio. Use only when the user explicitly asks to disconnect or unlink Dropbox. Does not delete Dropbox files.',write:true},
] as const;
export function accountConfirmation(name:'connect_account'|'disconnect_account') {
 const connect=name==='connect_account';
 return {schemaVersion:1,root:{type:'card',title:connect?'Connect Dropbox':'Disconnect Dropbox',children:[{type:'stack',direction:'vertical',gap:'md',children:[{type:'text',text:connect?'Open secure Composio OAuth2 authorization in your browser and connect Dropbox.':'Disconnect this Dropbox account in Composio. Your Dropbox files will remain.',color:'muted'}]}],footer:[{type:'actions',items:[{label:'Cancel',role:'cancel'},{label:connect?'Connect Dropbox':'Disconnect Dropbox',role:'confirm',color:'accent'}]}]}};
}
