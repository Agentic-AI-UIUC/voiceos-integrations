import {approved} from './catalog.ts';

// Composio derives OAuth scopes from these tools. Its API rejects an auth
// config that also supplies explicit scopes or user_scopes.
export function dropboxManagedAuthConfig(){
 const tools=[...approved];
 return {
  type:'use_composio_managed_auth' as const,
  name:'VoiceOS Dropbox',
  toolAccessConfig:{
   toolsForConnectedAccountCreation:tools,
   toolsAvailableForExecution:tools,
  },
 };
}
