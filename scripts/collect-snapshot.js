// Paste into the browser developer console of your open Basketball GM league.
// Read-only: no trades, proposal refreshes, or simulation advancement.
(async () => {
  if (typeof globalThis.bbgm?.toWorker !== 'function') throw new Error('Open your Basketball GM league, then run this in its browser developer console.');
  const code = `
    const {g,idb,LEAGUE_DATABASE_VERSION}=bbgm;
    const gameAttributes={};
    for(const key of Object.keys(g)) {
      if(typeof g[key] !== 'function' && key !== 'lid') gameAttributes[key]=g.getRaw(key);
    }
    console.log(JSON.stringify({version:LEAGUE_DATABASE_VERSION,
      meta:{name:'League '+g.get('lid')},gameAttributes,
      players:(await idb.cache.players.getAll()).filter(p=>p.tid>=-1),
      teams:await idb.cache.teams.getAll(),
      releasedPlayers:await idb.cache.releasedPlayers.getAll(),
      draftPicks:await idb.cache.draftPicks.getAll()
    }));
  `;
  const first=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  const second=await globalThis.bbgm.toWorker('main','evalOnWorker',code);
  if (first!==second) throw new Error('League state changed while collecting. Stop simulating or editing and try again.');
  const snapshot=JSON.parse(first);
  if (!Array.isArray(snapshot.players) || !snapshot.gameAttributes) throw new Error('The game returned an unsupported snapshot format.');
  const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`bbgm-snapshot-${snapshot.gameAttributes.season}-tid${snapshot.gameAttributes.userTid}.json`;
  link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  console.log('Downloaded a read-only league snapshot. Import it into Courtside for player negotiation and trade impact.');
})().catch(error=>console.error(error));
