// Executed in the page's MAIN world. Only this fixed read operation is exposed.
export async function readRoster(path) {
 try {
  if(location.pathname!==path)throw new Error('Roster page changed. Updating…');
  const match=path.match(/^\/l\/(\d+)\/roster(?:\/([^/]+))?(?:\/(\d+))?\/?$/);
  if(!match)throw new Error('Open a current roster page.');
  if(typeof globalThis.bbgm?.toWorker!=='function')throw new Error('Waiting for BBGM to load its worker connection…');
  const request={lid:Number(match[1]),team:match[2]??null,season:match[3]?Number(match[3]):null};
  const code=`
    const request=${JSON.stringify(request)};
    const {g,idb}=bbgm;
    if(g.get('lid')!==request.lid)throw new Error('Waiting for the selected league…');
    const season=g.get('season'),phase=g.get('phase');
    if(request.season!==null&&request.season!==season)throw new Error('Live analysis is available for the current season roster.');
    const teams=await idb.cache.teams.getAll();
    let tid=g.get('userTid');
    if(request.team) {
      const tidMatch=request.team.match(/_(\\d+)$/);
      const team=tidMatch?teams.find(t=>t.tid===Number(tidMatch[1])):teams.find(t=>t.abbrev===request.team);
      if(!team)throw new Error('Could not identify the displayed team.');
      tid=team.tid;
    }
    const team=teams.find(t=>t.tid===tid);
    if(!team)throw new Error('Team is unavailable.');
    const players=(await idb.cache.players.getAll()).filter(p=>p.tid===tid).map(p=>({
      pid:p.pid,name:p.firstName+' '+p.lastName,rosterOrder:p.rosterOrder,
      ptModifier:p.ptModifier,rating:p.ratings.at(-1),injury:p.injury
    }));
    const userTids=g.get('userTids')??[g.get('userTid')];
    const policy=!g.get('spectator')&&userTids.includes(tid)?team.playThroughInjuries??[0,4]:[0,4];
    if(g.get('lid')!==request.lid||g.get('season')!==season||g.get('phase')!==phase)throw new Error('League is advancing. Updating…');
    console.log(JSON.stringify({lid:request.lid,tid,season,phase,name:team.region+' '+team.name,
      numPlayersOnCourt:g.get('numPlayersOnCourt'),threshold:policy[phase===3?1:0],players}));
  `;
  // Two agreeing reads avoid publishing a roster assembled across an edit.
  const first=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  const second=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  if(first!==second||location.pathname!==path)throw new Error('Roster is changing. Updating…');
  return {...JSON.parse(second),gameVersion:globalThis.bbgmVersion??'unknown'};
 } catch(error) { return {error:error.message}; }
}
