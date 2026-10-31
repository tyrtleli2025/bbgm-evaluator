// Fixed, read-only reader executed in the game's MAIN world.
export async function readTrade(path) {
 try {
  const match=path.match(/^\/l\/(\d+)\/trade\/?$/);
  if(!match||location.pathname!==path)throw new Error('Open the current trade page.');
  if(typeof globalThis.bbgm?.toWorker!=='function')throw new Error('Waiting for BBGM…');
  const code=`
   const {g,idb}=bbgm;
   if(g.get('lid')!==${Number(match[1])})throw new Error('Waiting for the selected league…');
   const season=g.get('season'),phase=g.get('phase'),tid=g.get('userTid');
   const trade=await idb.cache.trade.get(0);
   if(!trade||trade.teams[0].tid!==tid)throw new Error('Waiting for the current trade…');
   const teams=await idb.cache.teams.getAll();
   const team=teams.find(t=>t.tid===tid),other=teams.find(t=>t.tid===trade.teams[1].tid);
   if(!team||!other)throw new Error('Trading partner unavailable.');
   const players=(await idb.cache.players.getAll()).filter(p=>p.tid===tid||p.tid===other.tid).map(p=>({
    pid:p.pid,tid:p.tid,name:p.firstName+' '+p.lastName,rosterOrder:p.rosterOrder,
    ptModifier:p.ptModifier,rating:p.ratings.at(-1),injury:p.injury,contract:p.contract,age:season-p.born.year
   }));
   const picks=(await idb.cache.draftPicks.getAll()).filter(p=>trade.teams.some(t=>t.dpids.includes(p.dpid))).map(p=>({
    dpid:p.dpid,tid:p.tid,name:p.season+' round '+p.round+' ('+(teams.find(t=>t.tid===p.originalTid)?.abbrev??p.originalTid)+')'
   }));
   const policy=g.get('spectator')?[0,4]:team.playThroughInjuries??[0,4];
   if(g.get('lid')!==${Number(match[1])}||g.get('season')!==season||g.get('phase')!==phase||g.get('userTid')!==tid)throw new Error('League is changing. Updating…');
   console.log(JSON.stringify({tid,season,phase,name:team.region+' '+team.name,otherName:other.region+' '+other.name,
    numPlayersOnCourt:g.get('numPlayersOnCourt'),threshold:policy[phase===3?1:0],players,picks,
    trade:trade.teams.map(t=>({tid:t.tid,pids:t.pids,dpids:t.dpids}))}));
  `;
  const first=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  const second=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  if(first!==second||location.pathname!==path)throw new Error('Trade is changing. Updating…');
  return {...JSON.parse(second),gameVersion:globalThis.bbgmVersion??'unknown'};
 }catch(error){return {error:error.message};}
}
