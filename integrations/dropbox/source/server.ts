import {responseGuidance,presentResult} from './presentation.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools,parseArgs,BUILD,INTEGRATION_VERSION } from './catalog.ts';
import { execute,errorMessage } from './provider.ts';
import {startSetup} from './setup.ts';
import { successCard,failureCard } from './cards.ts';
import { pathToFileURL } from 'node:url';
import {accountTools} from './account-catalog.ts';
import {connectAccount,connectionStatus,disconnectAccount,accountError} from './account.ts';
export function createServer(run=execute) {
  const server=new McpServer({name:'dropbox',version:INTEGRATION_VERSION});
  let accountMutation:Promise<any>|undefined;
  for(const tool of tools) server.registerTool(tool.name,{
    title:tool.title,description:`${tool.title} via Composio OAuth2. Use when the user asks to ${tool.use}. Returns provider data including pagination; never infer all pages were read.${responseGuidance(tool)}`,
    inputSchema:tool.schema,
    annotations:{readOnlyHint:!tool.write,destructiveHint:tool.write,idempotentHint:!tool.write,openWorldHint:true},
  },async(args:any,extra:any)=>{
    let progress=0;
    const notify=async(message:string)=>{
      const token=extra?._meta?.progressToken;
      if(token!==undefined) await extra.sendNotification({method:'notifications/progress',params:{progressToken:token,progress:++progress,message}}).catch(()=>{});
    };
    try {
      const data=await run(tool,parseArgs(tool,args),undefined,undefined,notify,extra?.signal);
      let glance:any;
      try {glance=successCard(tool,data,args);}catch{glance={blocks:[{type:'header',title:tool.title,trailing:'Completed'},{type:'badges',items:[{text:'Succeeded',tone:'good'}]}]};}
      let presented:any={data};
      try {presented=presentResult(tool,data);}catch{ /* Presentation must not turn a completed write into a failure. */ }
      const payload={data:presented.data,status:'completed',...(presented.summary?{summary:presented.summary}:{}),_voiceos_glance:glance};
      return {...(presented.provider_data?{structuredContent:{status:'completed',provider_data:presented.provider_data,summary:presented.summary}}:{}),content:[{type:'text',text:JSON.stringify(payload)}]};
    } catch(e:any) {
      const message=errorMessage(e,tool.write,false,tool.name);
      const status=/outcome is unknown/i.test(message)?'unknown':/request was cancelled/i.test(message)?'cancelled':'failed';
      const payload={status,error:message,_voiceos_glance:failureCard(tool,message,status)};
      return {isError:true,structuredContent:payload,content:[{type:'text',text:`${tool.title}: ${message}`}]};
    }
  });
  for(const accountTool of accountTools)server.registerTool(accountTool.name,{
    title:accountTool.title,description:accountTool.description,inputSchema:{},
    annotations:{readOnlyHint:!accountTool.write,destructiveHint:accountTool.name==='disconnect_account',idempotentHint:accountTool.name==='connection_status',openWorldHint:true},
  },async()=>{
    try{let result:any;
      if(accountTool.write){if(accountMutation)throw new Error('Another Dropbox account operation is still running. Wait for it to finish.');const task=accountTool.name==='connect_account'?connectAccount():disconnectAccount();accountMutation=task;try{result=await task;}finally{accountMutation=undefined;}}
      else result=await connectionStatus();
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    }catch(e){const message=accountError(e);return {isError:true,content:[{type:'text',text:JSON.stringify({status:'failed',error:message,_voiceos_glance:{blocks:[{type:'header',title:accountTool.title,trailing:'Failed'},{type:'badges',items:[{text:message.slice(0,100),tone:'bad'}]}]}})}]};}
  });
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.includes('--setup'))await startSetup();
  else {
    console.error(`[dropbox] Loaded ${BUILD}; version ${INTEGRATION_VERSION}; 14 approved tools`);
    await createServer().connect(new StdioServerTransport());
  }
}
