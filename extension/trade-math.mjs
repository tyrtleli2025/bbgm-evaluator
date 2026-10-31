import {analyzeRoster} from './math.mjs';
import {analyzeLineups} from './lineup.mjs';

export function analyzeTrade(snapshot) {
 const {trade,players,picks,tid}=snapshot;
 if(!Array.isArray(trade)||trade.length!==2||trade[0].tid!==tid||trade[1].tid===tid)throw new Error('Unsupported trade data.');
 // Validate ratings before sorting or constructing hypothetical rosters.
 analyzeRoster(snapshot);
 const assets=trade.map(side=>{
  const select=(ids,rows,key)=>{
   if(!Array.isArray(ids)||new Set(ids).size!==ids.length)throw new Error('Invalid trade selection.');
   return ids.map(id=>{
    const item=rows.find(p=>p[key]===id&&p.tid===side.tid);
    if(!item)throw new Error('Trade assets changed. Updating…');
    return item;
   });
  };
  return {players:select(side.pids,players,'pid'),picks:select(side.dpids,picks,'dpid')};
 });
 const original=players.filter(p=>p.tid===tid);
 const removed=new Set(trade[0].pids);
 const hypothetical=[...original.filter(p=>!removed.has(p.pid)),...assets[1].players];
 const evaluate=roster=>{
  if(!roster.length)return {teamOVR:null,score:null,synergy:null,lineup:[],enoughPlayers:false};
  const analysis=analyzeLineups({...snapshot,players:roster});
  return {...analysis,...(analysis.best??{}),search:analysis.search};
 };
 const before=evaluate(original),after=evaluate(hypothetical);
 const beforeIds=new Set(before.lineup.map(p=>p.pid)),afterIds=new Set(after.lineup.map(p=>p.pid));
 return {kind:'trade',name:snapshot.name,otherName:snapshot.otherName,season:snapshot.season,playoffs:snapshot.phase===3,
  before,after,outgoing:assets[0],incoming:assets[1],
  entering:after.lineup.filter(p=>!beforeIds.has(p.pid)),leaving:before.lineup.filter(p=>!afterIds.has(p.pid)),
  selected:trade.some(t=>t.pids.length||t.dpids.length),revision:before.revision??after.revision,gameVersion:snapshot.gameVersion};
}
