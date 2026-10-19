// Paste this entire file into the BROWSER developer console on your BBGM league.
// Uses the live game's proposal generator. It only refreshes proposal suggestions;
// it never proposes/accepts trades, edits rosters, or advances the league.
(async () => {
  const TARGET = 20;
  const MAX_BATCHES = 40;
  if (typeof globalThis.bbgm?.toWorker !== 'function') throw new Error('Open your BBGM league in a browser, then run this in its developer console.');
  const call = (name, args) => globalThis.bbgm.toWorker('main',name,args);
  const snapshotCode = `
    const {g,idb,LEAGUE_DATABASE_VERSION}=bbgm;
    const gameAttributes={};
    for(const key of Object.keys(g)) {
      if(typeof g[key] !== 'function' && key !== 'lid') gameAttributes[key]=g.getRaw(key);
    }
    console.log(JSON.stringify({
      context:{lid:g.get('lid'),userTid:g.get('userTid'),season:g.get('season'),phase:g.get('phase')},
      league:{version:LEAGUE_DATABASE_VERSION,gameAttributes,
        players:(await idb.cache.players.getAll()).filter(p=>p.tid>=-1),
        teams:await idb.cache.teams.getAll(),
        releasedPlayers:await idb.cache.releasedPlayers.getAll(),
        draftPicks:await idb.cache.draftPicks.getAll()}
    }));
  `;
  const initial = JSON.parse(await call('evalOnWorker',snapshotCode));
  if ([2,3].includes(initial.context.phase)) throw new Error('Trades are unavailable after the deadline and during playoffs.');
  if (initial.league.gameAttributes.challengeNoTrades) throw new Error('This league has the no-trades challenge enabled.');
  const offers=[], rejected=[], keys=new Set();
  let batches=0;
  while(offers.length<TARGET && batches<MAX_BATCHES) {
    if(batches>0) await call('incrementTradeProposalsSeed');
    const result=await call('runBefore',{
      viewId:'tradeProposals',params:{},ctxBBGM:{},
      updateEvents:new Set(['firstRun']),prevOutput:{},prevInputs:undefined,
    });
    if(!Array.isArray(result?.data?.offers)) throw new Error('Game proposal API differs from the inspected version; no proposals were downloaded.');
    batches++;
    for(const offer of result.data.offers) {
      if(offer.summary?.warning || offer.summary?.enablePropose!==true) {
        rejected.push({seed:result.data.seed,tid:offer.tid,reason:offer.summary?.warning ?? 'Proposal disabled'});continue;
      }
      const side=(tid,pids,dpids,picks)=>{
        if(!Array.isArray(pids)||!Array.isArray(dpids)||!Array.isArray(picks)) throw new Error('Unexpected proposal asset format');
        if(dpids.some(id=>!picks.some(p=>p.dpid===id))) throw new Error('Missing pick description in game proposal');
        return {tid,send:pids,picks:dpids.map(id=>picks.find(p=>p.dpid===id))};
      };
      const teams=[side(initial.context.userTid,offer.pidsUser,offer.dpidsUser,offer.picksUser),
        side(offer.tid,offer.pids,offer.dpids,offer.picks)];
      const key=JSON.stringify(teams.map(t=>({tid:t.tid,send:[...t.send].sort((a,b)=>a-b),
        picks:t.picks.map(p=>p.dpid).sort((a,b)=>a-b)})).sort((a,b)=>a.tid-b.tid));
      if(keys.has(key)) continue;
      keys.add(key);
      offers.push({id:`proposal-${offers.length+1}`,seed:result.data.seed,teams,warning:null,enablePropose:true});
      if(offers.length===TARGET) break;
    }
    console.log(`Collected ${offers.length}/${TARGET} distinct proposals (${batches} batches).`);
  }
  // Detect game advancement or roster changes while suggestions were collected.
  const final = JSON.parse(await call('evalOnWorker',snapshotCode));
  const stable = snapshot => {
    const copy=structuredClone(snapshot);
    delete copy.league.gameAttributes.tradeProposalsSeed;
    return JSON.stringify(copy);
  };
  if(stable(initial)!==stable(final)) throw new Error('League state changed during collection. Stop simulating or editing the league and run again.');
  if(!offers.length) throw new Error('No distinct proposals without game warnings were found.');
  const bundle={format:'bbgm-proposals-v1',gameVersion:globalThis.bbgmVersion ?? null,
    collectedAt:new Date().toISOString(),requested:TARGET,batches,rejected,
    ...initial,offers};
  const blob=new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`bbgm-proposals-${initial.context.season}-tid${initial.context.userTid}.json`;
  link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  console.log(`Downloaded ${offers.length} proposals with their matching league snapshot. Proposal refreshes changed only the suggestion seed.`);
})().catch(error=>console.error(error));
