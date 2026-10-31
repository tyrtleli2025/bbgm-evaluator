import { predictLeague,relativeKind } from './relative-predictor.mjs';
import { teamFeatures,featureSettings } from './features.mjs';
import { predict } from './predictor.mjs';
// Runs inside the imported native engine worker. Candidate construction does not
// execute trades; each retained sequence is replayed through native propose().
export function diverse(candidates, limit) {
  const remaining = [...candidates];
  const selected = [];
  const metrics = ['current', 'youth', 'assets', 'flexibility'];
  while (remaining.length && selected.length < limit) {
    const metric = metrics[selected.length % metrics.length];
    remaining.sort((a, b) => b.screen[metric] - a.screen[metric] || a.key.localeCompare(b.key));
    selected.push(remaining.shift());
  }
  return selected;
}
export const actionKey = actions => JSON.stringify(actions.map(a => a.teams.map(t => ({ tid: t.tid, pids: [...t.pids].sort((a,b)=>a-b), dpids: [...t.dpids].sort((a,b)=>a-b) }))));

export async function generateTrades(engine, teamId, { attempts = 24, offset = 0, model }, onProgress) {
  const { idb, g, trade, team, ValueChangeCalculator } = engine;
  if (g.get('challengeNoTrades') || (g.get('phase') >= 2 && g.get('phase') <= 3)) throw new Error('Trading is unavailable in this league phase or challenge.');
  const players = await idb.cache.players.getAll();
  const picks = await idb.cache.draftPicks.getAll();
  const teams = (await idb.cache.teams.getAll()).filter(t => !t.disabled);
  const ours = players.filter(p => p.tid === teamId);
  const eligible = players.filter(p => p.tid >= 0 && !trade.isUntradable(p).untradable);
  const score = (roster, ownedPicks) => ({
    current: team.ovr(roster.map(p => ({ ratings: p.ratings.at(-1) })), { playoffs: true }),
    youth: roster.reduce((sum,p) => sum + Math.max(0, 28 - (g.get('season') - p.born.year)) * Math.max(0, p.ratings.at(-1).ovr - 35), 0),
    assets: roster.reduce((sum,p) => sum + (p.value ?? p.ratings.at(-1).ovr), 0) + ownedPicks.reduce((sum,p) => sum + (p.round === 1 ? 30 : 10), 0),
    flexibility: -roster.reduce((sum,p) => sum + p.contract.amount * Math.max(1, p.contract.exp - g.get('season') + 1), 0),
  });
  const baseline = score(ours, picks.filter(p => p.tid === teamId));
  const byId = new Map(players.map(p => [p.pid,p]));
  const byPick = new Map(picks.map(p => [p.dpid,p]));
  const partners = teams.filter(t => t.tid !== teamId);
  // Round-robin teams, alternating current talent, youth, packages and selling.
  const seeds = [];
  for (let round = 0; round < 8; round++) for (const partner of partners) {
    const targets = eligible.filter(p => p.tid === partner.tid).sort((a,b) => round % 2 ? (b.value ?? 0) - (a.value ?? 0) : b.ratings.at(-1).ovr - a.ratings.at(-1).ovr);
    const outgoing = eligible.filter(p => p.tid === teamId).sort((a,b) => b.contract.amount - a.contract.amount);
    const sell = round % 4 === 3;
    const target = targets[Math.floor(round / 4) % Math.max(1, targets.length)];
    if (!target || sell && !outgoing.length) continue;
    const incoming = [target.pid];
    if (round % 4 === 2 && targets[1] && targets[1].pid !== target.pid) incoming.push(targets[1].pid);
    const side = (tid,pids) => ({ tid,pids,dpids:[],pidsExcluded:[],dpidsExcluded:[] });
    seeds.push([side(teamId,sell ? [outgoing[Math.floor(round/4) % outgoing.length].pid] : []),side(partner.tid,sell ? [] : incoming)]);
  }
  const candidates = []; const seen = new Set();
  let attempted = 0;
  for (let i = 0; i < Math.min(attempts,seeds.length); i++) {
    const seed = seeds[(offset + i) % seeds.length]; attempted++;
    onProgress({ kind:'candidate', text:`Trade package ${attempted}/${Math.min(attempts,seeds.length)}` });
    const proposal = await trade.makeItWork(seed, { holdUserConstant:false, valueChangeCalculator:new ValueChangeCalculator() });
    if (!proposal || (await trade.summary(proposal)).warning) continue;
    const action = { type:'trade', teams:proposal.map(t => ({ tid:t.tid,pids:t.pids,dpids:t.dpids })) };
    const key = actionKey([action]); if (seen.has(key)) continue; seen.add(key);
    const [send,receive] = action.teams;
    if (!send.pids.length && !send.dpids.length && !receive.pids.length && !receive.dpids.length) continue;
    const roster = [...ours.filter(p => !send.pids.includes(p.pid)),...receive.pids.map(pid=>byId.get(pid))];
    const ownedPicks = [...picks.filter(p => p.tid === teamId && !send.dpids.includes(p.dpid)),...receive.dpids.map(id=>byPick.get(id))];
    const updatedPlayers=[...players.filter(p=>!send.pids.includes(p.pid)&&!receive.pids.includes(p.pid)),...send.pids.map(pid=>({...byId.get(pid),tid:receive.tid})),...receive.pids.map(pid=>({...byId.get(pid),tid:teamId}))];
    const updatedPicks=picks.map(p=>send.dpids.includes(p.dpid)?{...p,tid:receive.tid}:receive.dpids.includes(p.dpid)?{...p,tid:teamId}:p);
    const features=teamFeatures(updatedPlayers,updatedPicks,teamId,featureSettings(g),teams);
    let predictedTitles;
    if(model?.kind===relativeKind){
      const context=teams.map(t=>teamFeatures(updatedPlayers,updatedPicks,t.tid,featureSettings(g),teams));
      predictedTitles=predictLeague(model,context)[teams.findIndex(t=>t.tid===teamId)];
    }else if(model)predictedTitles=predict(model,features);
    candidates.push({ key, action, features, ...(model?{predictedTitles}:{}), screen:score(roster,ownedPicks), details:action.teams.map(side=>({
      team: teams.find(t=>t.tid===side.tid)?.region + ' ' + teams.find(t=>t.tid===side.tid)?.name,
      players:side.pids.map(pid=>({ pid,name:`${byId.get(pid).firstName} ${byId.get(pid).lastName}` })),
      picks:side.dpids.map(dpid=>byPick.get(dpid)),
    })) });
  }
  return { baseline, candidates, attempted };
}
