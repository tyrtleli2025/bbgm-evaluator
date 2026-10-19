import { createHash } from 'node:crypto';
import { evaluate } from './evaluator.mjs';
import { prepareTrade, collectTrial, pairedChanges, playerChanges } from './trade.mjs';

export function proposalKey(teams) {
  return JSON.stringify(teams.map(t => ({tid:t.tid, send:[...t.send].sort((a,b)=>a-b),
    picks:t.picks.map(p=>p.dpid).sort((a,b)=>a-b)})).sort((a,b)=>a.tid-b.tid));
}

export function rankProposals(league, bundle, options = {}) {
  if (bundle.format !== 'bbgm-proposals-v1' || !Array.isArray(bundle.offers)) throw new Error('Expected a bbgm-proposals-v1 bundle from the browser collector');
  const teamId = options.teamId ?? bundle.context?.userTid;
  if (teamId !== bundle.context?.userTid || !league.teams.has(teamId)) throw new Error('Selected team must match the proposal bundle userTid');
  if (bundle.context?.season !== league.settings.season) throw new Error('Proposal season does not match snapshot');
  if (!Number.isInteger(bundle.context?.phase)) throw new Error('Proposal bundle is missing its league phase');
  if ([2,3].includes(bundle.context.phase)) throw new Error('These proposals were collected after the trade deadline or during playoffs');
  if (league.settings.challengeNoTrades) throw new Error('League has the no-trades challenge enabled');
  const limit = options.proposalLimit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('proposal-limit must be a positive integer');

  // All candidates share one reference state and rotation policy. Sorting only
  // the current partner would otherwise give each candidate a different baseline.
  const baseline = structuredClone(league);
  for (const roster of baseline.teams.values()) {
    roster.sort((a,b) => b.valueNoPot-a.valueNoPot || a.pid-b.pid);
    roster.forEach((p,i) => {p.rosterOrder=i; p.ptModifier=1;});
  }
  const valid = [], skipped = [], seen = new Set();
  for (let index=0; index<bundle.offers.length; index++) {
    const offer = bundle.offers[index];
    try {
      if (!offer || !Array.isArray(offer.teams) || offer.teams.length !== 2) throw new Error('Expected two offer teams');
      if (offer.warning !== null) throw new Error(offer.warning || 'Missing game salary-warning status');
      if (offer.enablePropose !== true) throw new Error('Game did not enable proposing this offer');
      for (const side of offer.teams) {
        if (!Array.isArray(side.send) || !Array.isArray(side.picks)) throw new Error('Each side needs send and picks arrays');
        const pickIds = side.picks.map(p=>p?.dpid);
        if (pickIds.some(id=>!Number.isInteger(id)) || new Set(pickIds).size !== pickIds.length) throw new Error('Invalid or duplicate pick IDs');
        for (const dpid of pickIds) {
          if (!bundle.league?.draftPicks?.some(p=>p.dpid===dpid && p.tid===side.tid)) throw new Error(`Pick ${dpid} does not belong to team ${side.tid} in the bundled snapshot`);
        }
      }
      const allPickIds = offer.teams.flatMap(t=>t.picks.map(p=>p.dpid));
      if (new Set(allPickIds).size !== allPickIds.length) throw new Error('A pick appears on both sides');
      const key = proposalKey(offer.teams);
      if (seen.has(key)) throw new Error('Duplicate proposal');
      const scenario = {teams:offer.teams.map(({tid,send})=>({tid,send}))};
      prepareTrade(baseline,scenario,teamId); // Ownership and playable-roster checks.
      seen.add(key);
      valid.push({offer,scenario,index});
    } catch(error) { skipped.push({index, id:offer?.id, reason:error.message}); }
  }
  const selected = valid.slice(0,limit);
  if (!selected.length) throw new Error(`No evaluable proposals. ${skipped.map(s=>s.reason).join('; ')}`);
  const beforeRows = [];
  const before = evaluate(baseline,{...options,teamId,onGame:collectTrial(teamId,beforeRows)});
  let simulatedGames = before.simulatedGames;
  const ranked = [];
  for (const {offer,scenario,index} of selected) {
    const {candidate,transfers,warnings} = prepareTrade(baseline,scenario,teamId);
    const afterRows = [];
    const after = evaluate(candidate,{...options,teamId,onGame:collectTrial(teamId,afterRows)});
    simulatedGames += after.simulatedGames;
    const delta = pairedChanges(beforeRows,afterRows);
    const a=before.teams[0],b=after.teams[0];
    ranked.push({id:offer.id ?? `offer-${index+1}`, sourceIndex:index, scenario, transfers,
      picks: offer.teams.map(t=>({tid:t.tid,send:t.picks})),
      gameChecks:{warning:offer.warning,enablePropose:offer.enablePropose,checkedAt:bundle.collectedAt},
      delta, after:b, playerChanges:playerChanges(a,b),
      synergyChange:Object.fromEntries(['off','def','reb'].map(k=>[k,b.synergy.scale100[k]-a.synergy.scale100[k]])),
      verdict:delta.net.confidence95[0]>0?'Estimated improvement':delta.net.confidence95[1]<0?'Estimated decline':'No clear change',
      warnings});
    options.onProposal?.({completed:ranked.length,total:selected.length,simulatedGames});
  }
  ranked.sort((a,b)=>b.delta.net.estimate-a.delta.net.estimate || a.sourceIndex-b.sourceIndex);
  return {...Object.fromEntries(Object.entries(before).filter(([k])=>k!=='teams')),
    model:'pinned-engine-proposal-ranking-v1',teamId,simulatedGames,
    source:'Actual game proposals collected through the live tradeProposals view; no local offer generation.',
    sourceGameVersion:bundle.gameVersion,collectionContext:bundle.context,
    proposalBundleSha256:createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
    proposed:bundle.offers.length,evaluated:ranked.length,skipped,unevaluatedValid:valid.length-selected.length,
    rotationPolicy:'All teams use valueNoPot descending, PID tie-break, and normal playing-time modifiers in the shared baseline and all candidates.',
    baseline:before.teams[0],ranked,
    warnings:[...before.warnings.filter(w=>!w.startsWith('Exported playing-time modifiers')),
      'Ranking measures current basketball impact only; draft picks are retained in offers but their future value is not scored.',
      'Game warning/enablePropose checks are captured at collection time, not a guarantee of later acceptance.',
      'The top estimate among many proposals can be inflated by selection noise; intervals are per proposal and are not simultaneous ranking guarantees.',
      'All candidates are compared with a shared baseline using automatic rotations for every team.',
      ...(selected.length<limit?[`Only ${selected.length} distinct evaluable proposals were available (requested ${limit}).`]:[])],
  };
}
