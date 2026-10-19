import { createHash } from 'node:crypto';
import { evaluate } from './evaluator.mjs';
import { collectTrial, pairedChanges, playerChanges } from './trade.mjs';
import { assessTrade } from './trade-rules.mjs';

export function normalizeTradeScenario(league, scenario, teamId) {
  if (!scenario || !Array.isArray(scenario.teams) || scenario.teams.length !== 2) throw new Error('Choose exactly two trade teams');
  if (scenario.teams[0]?.tid === scenario.teams[1]?.tid) throw new Error('Choose a different trading partner');
  const pids = new Set(), dpids = new Set();
  const teams = scenario.teams.map(side => {
    const roster = league.teams.get(side?.tid);
    if (!Number.isInteger(side?.tid) || !roster || !Array.isArray(side.send)) throw new Error('Invalid team or player list');
    if (side.picks !== undefined && !Array.isArray(side.picks)) throw new Error('Invalid draft pick list');
    for (const pid of side.send) {
      if (!Number.isInteger(pid) || pids.has(pid) || !roster.some(p=>p.pid===pid)) throw new Error(`Invalid, duplicate, or incorrectly owned player ${pid}`);
      pids.add(pid);
    }
    for (const dpid of side.picks ?? []) {
      if (!Number.isInteger(dpid) || dpids.has(dpid) || !league.rawData?.draftPicks?.some(p=>p.dpid===dpid && p.tid===side.tid)) throw new Error(`Invalid, duplicate, or incorrectly owned draft pick ${dpid}`);
      dpids.add(dpid);
    }
    return {tid:side.tid,send:[...side.send].sort((a,b)=>a-b),picks:[...(side.picks??[])].sort((a,b)=>a-b)};
  });
  if (!teams.some(t=>t.tid===teamId)) throw new Error('Your team must participate in the trade');
  teams.sort((a,b) => (a.tid === teamId ? -1 : b.tid === teamId ? 1 : a.tid-b.tid));
  return {teams};
}

export function tradeAssessment(league, scenario, options) {
  return assessTrade(league, scenario, {teamId:options.teamId,phase:options.tradePhase,
    difficulty:options.difficulty,strategies:options.strategies});
}

export function previewBaselineKey(league, options) {
  return createHash('sha256').update(JSON.stringify([league.inputHash,options.teamId,
    options.phase??'regular',options.health??'current',options.gamesPerOpponent??4,options.seed??12345,'all-auto-v1'])).digest('hex');
}
const autoRotation = roster => roster.slice().sort((a,b)=>b.valueNoPot-a.valueNoPot || a.pid-b.pid)
  .map((p,i)=>({...p,ptModifier:1,rosterOrder:i}));

export function previewTrade(league, inputScenario, options = {}) {
  const scenario = normalizeTradeScenario(league,inputScenario,options.teamId);
  const assessment = tradeAssessment(league,scenario,options);
  const baseline = {...league,teams:new Map([...league.teams].map(([tid,roster])=>[tid,autoRotation(roster)]))};
  const candidate = {...baseline,teams:new Map(baseline.teams)};
  const transfers = [];
  for (const [i,side] of scenario.teams.entries()) {
    const other = scenario.teams[1-i];
    const outgoing = new Set(side.send);
    const incoming = baseline.teams.get(other.tid).filter(p=>other.send.includes(p.pid)).map(p=>{
      transfers.push({pid:p.pid,name:`${p.firstName} ${p.lastName}`,fromTid:other.tid,toTid:side.tid});
      return {...p,tid:side.tid};
    });
    const roster = autoRotation([...baseline.teams.get(side.tid).filter(p=>!outgoing.has(p.pid)),...incoming]);
    if (roster.length < league.settings.numPlayersOnCourt) throw new Error(`This trade leaves team ${side.tid} with too few players to simulate`);
    candidate.teams.set(side.tid,roster);
  }
  const evaluationOptions = {teamId:options.teamId,phase:options.phase??'regular',health:options.health??'current',
    seed:options.seed??12345,gamesPerOpponent:options.gamesPerOpponent??4};
  const total = (league.teams.size-1)*evaluationOptions.gamesPerOpponent;
  const key = previewBaselineKey(league,evaluationOptions);
  let cached = options.baselineCache?.key === key ? options.baselineCache : null;
  let simulatedGames = 0;
  const baselineReused = !!cached;
  if (!cached) {
    const rows = [];
    const report = evaluate(baseline,{...evaluationOptions,onGame:collectTrial(options.teamId,rows),
      onProgress:p=>options.onProgress?.({stage:'baseline',completed:p.simulatedGames,total,message:'Simulating the comparison baseline'})});
    cached = {key,report,rows};
    simulatedGames += report.simulatedGames;
    options.onBaseline?.(cached);
  }
  const afterRows = [], hasPlayers = scenario.teams.some(t=>t.send.length);
  const afterReport = hasPlayers ? evaluate(candidate,{...evaluationOptions,onGame:collectTrial(options.teamId,afterRows),
    onProgress:p=>options.onProgress?.({stage:'trade',completed:p.simulatedGames,total,message:'Simulating your selected trade'})}) : cached.report;
  if (hasPlayers) simulatedGames += afterReport.simulatedGames;
  else afterRows.push(...cached.rows);
  const before = cached.report.teams[0], after = afterReport.teams[0];
  const delta = pairedChanges(cached.rows,afterRows);
  const hasPicks = scenario.teams.some(t=>t.picks.length);
  return {...Object.fromEntries(Object.entries(cached.report).filter(([k])=>k!=='teams')),
    model:'interactive-trade-impact-v1',teamId:options.teamId,scenario,assessment,before,after,delta,transfers,
    baselineReused,simulatedGames,comparisonGames:total,playerChanges:playerChanges(before,after),
    synergyChange:Object.fromEntries(['off','def','reb'].map(k=>[k,after.synergy.scale100[k]-before.synergy.scale100[k]])),
    verdict:delta.net.confidence95[0]>0?'Estimated improvement':delta.net.confidence95[1]<0?'Estimated decline':'No clear change',
    rotationPolicy:'Both sides of this comparison use valueNoPot descending, PID tie-break, and normal playing-time modifiers for every team. The engine controls substitutions. This baseline can differ from the exported-rotation team overview.',
    comparisonDefinition:'Paired simulations with identical opponent IDs, venue weights, seed schedules, and budgets; the post-trade partner roster is included. Synergy changes are on the 0–100 ceiling scale.',
    warnings:[...cached.report.warnings.filter(w=>!w.startsWith('Exported playing-time modifiers')),
      'Hypothetical current basketball impact is evaluated even when the trade fails salary rules or AI acceptance.',
      'Comparison uses automatic rotations for all teams; the before score can differ from the team overview.',
      'Confidence intervals measure simulation noise, not certainty about game-version compatibility or transaction feasibility.',
      ...assessment.details.rosterWarnings,
      ...(hasPicks?['Draft picks change neither current players nor simulated basketball strength. Their future cost/value is not scored, and AI pick valuation is not available locally.']:[])],
  };
}
