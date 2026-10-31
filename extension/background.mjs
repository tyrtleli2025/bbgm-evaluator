import {readRoster} from './bridge.mjs';
import {analyzeLineups} from './lineup.mjs';
import {readTrade} from './trade-bridge.mjs';
import {analyzeTrade} from './trade-math.mjs';
import {readPlayer} from './player-bridge.mjs';
import {analyzePlayer} from './player-math.mjs';
const handlers={'courtside-roster':[readRoster,analyzeLineups],'courtside-trade':[readTrade,analyzeTrade],'courtside-player':[readPlayer,analyzePlayer]};
// Serialize reads across tabs: evalOnWorker temporarily captures console output.
let queue=Promise.resolve();
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(!Object.hasOwn(handlers,message?.type))return;
 if(sender.id!==chrome.runtime.id||sender.frameId!==0||!sender.tab||new URL(sender.url).origin!=='https://play.basketball-gm.com'||typeof message.path!=='string')return;
 queue=queue.catch(()=>{}).then(async()=>{
  try {
   const [read,analyze]=handlers[message.type];
   const [result]=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,frameIds:[0]},world:'MAIN',func:read,args:[message.path]});
   if(!result?.result)throw new Error('BBGM connection unavailable. Reload the roster page.');
   if(result.result.error)throw new Error(result.result.error);
   respond({ok:true,data:analyze(result.result)});
  }catch(error){respond({ok:false,error:error.message});}
 });
 return true;
});
