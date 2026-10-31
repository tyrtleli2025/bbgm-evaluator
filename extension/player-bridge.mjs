// Fixed read-only profile reader, serialized into BBGM's MAIN world.
export async function readPlayer(path) {
 try {
  const match=path.match(/^\/l\/(\d+)\/player\/(\d+)\/?$/);
  if(!match||location.pathname!==path)throw new Error('Open a player profile.');
  if(typeof globalThis.bbgm?.toWorker!=='function')throw new Error('Waiting for BBGM…');
  const lid=Number(match[1]),pid=Number(match[2]);
  if(!Number.isSafeInteger(lid)||!Number.isSafeInteger(pid))throw new Error('Invalid player profile.');
  const code=`
   const {g,idb}=bbgm;
   if(g.get('lid')!==${lid})throw new Error('Waiting for the selected league…');
   const season=g.get('season'),phase=g.get('phase'),userTid=g.get('userTid');
   const p=idb.merged?.players?.get?await idb.merged.players.get(${pid}):await idb.getCopy.players({pid:${pid}},'noCopyCache');
   if(!p)throw new Error('Player unavailable.');
   const team=p.tid>=0?await idb.cache.teams.get(p.tid):null;
   const userTids=g.get('userTids')??[userTid];
   const policy=!g.get('spectator')&&userTids.includes(p.tid)?team?.playThroughInjuries??[0,4]:[0,4];
   if(g.get('lid')!==${lid}||g.get('season')!==season||g.get('phase')!==phase||g.get('userTid')!==userTid)throw new Error('League is changing. Updating…');
   console.log(JSON.stringify({season,phase,threshold:policy[phase===3?1:0],player:{pid:p.pid,tid:p.tid,
    name:p.firstName+' '+p.lastName,rating:p.ratings.at(-1),injury:p.injury}}));
  `;
  const first=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  const second=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  if(first!==second||location.pathname!==path)throw new Error('Player is changing. Updating…');
  return {...JSON.parse(second),gameVersion:globalThis.bbgmVersion??'unknown'};
 }catch(error){return {error:error.message};}
}
