import { readFileSync } from 'node:fs';

const reference = JSON.parse(readFileSync(new URL('./data/historical-teams.json',import.meta.url)));
const events = reference.events.slice().sort((a,b)=>a.season-b.season || a.phase-b.phase);
const occursBy = (event,season,phase) => event.season < season || event.season === season && event.phase <= phase;

// Historical BBGM IDs are compacted when the league is created, then remain
// stable through relocations and later expansions. They are not NBA API IDs.
export function historicalTeamNames(startingSeason,season,phase=0) {
  if (!Number.isInteger(startingSeason) || startingSeason < 1947 || startingSeason > reference.throughSeason || season < startingSeason) return new Map();
  const initial = new Map();
  const apply = (state,event,removeContracted) => {
    if (event.type === 'expansionDraft') for (const team of event.info.teams) state.set(team.tid,{...team});
    else if (event.type === 'teamInfo' && state.has(event.info.tid)) state.set(event.info.tid,{...state.get(event.info.tid),...event.info});
    else if (event.type === 'contraction' && removeContracted) state.delete(event.info.tid);
  };
  for (const event of events) if (occursBy(event,startingSeason,0)) apply(initial,event,true);
  const ids = new Map([...initial.keys()].map((oldTid,tid)=>[oldTid,tid]));
  const current = new Map(initial);
  for (const event of events) {
    if (occursBy(event,startingSeason,0) || !occursBy(event,season,phase)) continue;
    if (event.type === 'expansionDraft') for (const team of event.info.teams) {
      if (!ids.has(team.tid)) ids.set(team.tid,ids.size);
    }
    apply(current,event,false);
  }
  return new Map([...current].map(([oldTid,team])=>{
    const identity = reference.names[team.srID];
    return [ids.get(oldTid),{tid:ids.get(oldTid),region:identity.region,
      name:`${identity.region} ${identity.name}`,abbrev:team.srID,source:'historical-reference'}];
  }));
}

export function resolveTeamNames(data,settings,tids) {
  const exported = new Map((data.teams??[]).map(t=>[t.tid,t]));
  const cached = Array.isArray(settings.teamInfoCache) ? settings.teamInfoCache : [];
  const realLeague = data.players.some(p=>p.tid>=0 && p.real===true && typeof p.srID==='string');
  const historical = realLeague ? historicalTeamNames(settings.startingSeason,settings.season,settings.phase??8) : new Map();
  return new Map([...tids].map(tid=>{
    const team = exported.get(tid), fromCache = cached[tid];
    const fullName = record => [record?.region,record?.name].filter(v=>typeof v==='string' && v.trim()).join(' ');
    const record = fullName(team) ? team : fullName(fromCache) ? fromCache : null;
    const identity = record ? {tid,name:fullName(record),region:record.region??'',abbrev:record.abbrev??String(tid),source:'export'}
      : historical.get(tid) ?? {tid,name:`Team ${tid}`,region:'',abbrev:String(tid),source:'id'};
    return [tid,identity];
  }));
}

export function teamName(league,tid) {
  return league.teamNames?.get(tid)?.name ?? `Team ${tid}`;
}
