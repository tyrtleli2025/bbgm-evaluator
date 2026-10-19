import { createHash } from 'node:crypto';
import { makeSeededRandom } from '../.engine/common/random.js';
import { evaluate } from './evaluator.mjs';
import { collectTrial, pairedChanges } from './trade.mjs';
import { assessTrade } from './trade-rules.mjs';

const DEFAULTS = { phase: 'regular', health: 'current', seed: 12345, iterations: 300,
  maxDepth: 2, beamWidth: 6, finalists: 3, gamesPerOpponent: 4, feasibility: 'explore' };
const LIMITS = { iterations: [1, 5000], maxDepth: [1, 5], beamWidth: [1, 24], finalists: [1, 10], gamesPerOpponent: [4, 100] };
const name = p => `${p.firstName} ${p.lastName}`;
const ovr = p => Number.isFinite(p.rating.ovr) ? p.rating.ovr : p.valueNoPot;
const sortRotation = roster => roster.slice().sort((a,b) => b.valueNoPot-a.valueNoPot || a.pid-b.pid)
  .map((p,i) => ({ ...p, rosterOrder: i, ptModifier: 1 }));

// This is a screening priority, not an estimated point differential. The exact
// possession engine, including synergy, decides the final ranking.
export function rosterProxy(roster, { phase = 'regular', health = 'current', numPlayersOnCourt = 5 } = {}) {
  const threshold = phase === 'playoffs' ? 4 : 0;
  const available = roster.filter(p => health === 'healthy' || p.injury.gamesRemaining <= threshold);
  if (available.length < numPlayersOnCourt) return -Infinity;
  const weights = phase === 'playoffs' ? [38,36,34,32,30,28,24,18] : [34,32,30,28,26,25,22,18,15,10];
  const ordered = available.slice().sort((a,b) => b.valueNoPot-a.valueNoPot || a.pid-b.pid).slice(0,weights.length);
  const totalWeight = ordered.reduce((sum,_,i) => sum+weights[i],0);
  return ordered.reduce((sum,p,i) => sum + weights[i]*ovr(p)*(health === 'healthy' ? 1 : 1-0.025*p.injury.gamesRemaining),0)/totalWeight;
}

// Structural sharing keeps the search cheap even when the uploaded export has
// years of player history. No arrays or objects owned by the caller are mutated.
function applyTrade(league, scenario) {
  const teams = new Map(league.teams), moved = new Map(), transfers = [];
  for (const [i,side] of scenario.teams.entries()) {
    const destination = scenario.teams[1-i].tid;
    for (const pid of side.send) {
      const player = league.teams.get(side.tid).find(p => p.pid === pid);
      moved.set(pid,destination);
      transfers.push({ pid, name: name(player), fromTid: side.tid, toTid: destination });
    }
  }
  for (const side of scenario.teams) {
    const keep = league.teams.get(side.tid).filter(p => !moved.has(p.pid));
    const incoming = transfers.filter(p => p.toTid === side.tid).map(p =>
      ({ ...league.teams.get(p.fromTid).find(x => x.pid === p.pid), tid: side.tid }));
    teams.set(side.tid,sortRotation([...keep,...incoming]));
  }
  const rawData = league.rawData ? { ...league.rawData,
    ...(league.rawData.players ? { players: league.rawData.players.map(p => moved.has(p.pid) ? { ...p, tid: moved.get(p.pid) } : p) } : {}) } : undefined;
  return { league: { ...league, teams, ...(rawData ? { rawData } : {}) }, transfers };
}

function stateKey(league) {
  // Ownership across every team matters: a route changes both future partners
  // and the opponents in the final simulation. Rotations are canonical here.
  return createHash('sha256').update([...league.teams].sort(([a],[b]) => a-b)
    .map(([tid,roster]) => `${tid}:${roster.map(p => p.pid).sort((a,b) => a-b).join(',')}`).join(';')).digest('hex');
}

function packageSize(length, random) {
  // A uniform component gives every size (including the entire roster) positive
  // probability. The geometric component spends more effort on modest offers.
  if (random() < 0.3) return Math.floor(random()*(length+1));
  let count = 0;
  while (count < length && random() < 0.65) count++;
  return count;
}

function pickPlayers(roster, count, random, incoming) {
  const remaining = roster.slice(), chosen = [];
  while (chosen.length < count && remaining.length) {
    // Every player remains selectable; incoming stars and outgoing depth get
    // more samples without ruling out star-for-star or large package trades.
    const weights = remaining.map(p => incoming ? 1+Math.max(0,ovr(p))**2/100 : 1+Math.max(0,100-ovr(p))**2/100);
    let draw = random()*weights.reduce((sum,x) => sum+x,0), index = 0;
    while (index < weights.length-1 && (draw -= weights[index]) > 0) index++;
    chosen.push(remaining.splice(index,1)[0].pid);
  }
  return chosen.sort((a,b) => a-b);
}

function proposal(league, teamId, opponents, random, parentOffers) {
  if (parentOffers.length && random() < 0.4) {
    const source = parentOffers[Math.floor(random()*parentOffers.length)];
    const scenario = structuredClone(source.scenario);
    const mutations = 1+Math.floor(random()*4);
    for (let n=0;n<mutations;n++) {
      const side = scenario.teams[Math.floor(random()*2)];
      const roster = league.teams.get(side.tid);
      const pid = roster[Math.floor(random()*roster.length)].pid;
      const index = side.send.indexOf(pid);
      if (index < 0) side.send.push(pid); else side.send.splice(index,1);
      side.send.sort((a,b) => a-b);
    }
    if (scenario.teams.some(side => side.send.length)) return scenario;
  }
  const opponent = opponents[Math.floor(random()*opponents.length)];
  const ours = league.teams.get(teamId), theirs = league.teams.get(opponent);
  const incoming = packageSize(theirs.length,random);
  let outgoing = packageSize(ours.length,random);
  if (!incoming && !outgoing) outgoing = 1;
  return { teams: [
    { tid: teamId, send: pickPlayers(ours,outgoing,random,false) },
    { tid: opponent, send: pickPlayers(theirs,incoming,random,true) },
  ] };
}

function validateOptions(league, options) {
  if (!league.teams.has(options.teamId)) throw new Error(`Unknown team ID ${options.teamId}`);
  if (league.teams.size < 2) throw new Error('Trade search requires at least two teams');
  for (const [key,[min,max]] of Object.entries(LIMITS)) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  if (options.gamesPerOpponent % 2) throw new Error('gamesPerOpponent must be even');
  if (!Number.isSafeInteger(options.seed)) throw new Error('seed must be a safe integer');
  if (!['regular','playoffs'].includes(options.phase)) throw new Error('phase must be regular or playoffs');
  if (!['current','healthy'].includes(options.health)) throw new Error('health must be current or healthy');
  if (!['explore','verified'].includes(options.feasibility)) throw new Error('feasibility must be explore or verified');
}

export function searchTrades(league, inputOptions = {}) {
  const options = { ...DEFAULTS, ...inputOptions };
  validateOptions(league,options);
  const { teamId, seed, iterations, maxDepth, beamWidth, finalists, onProgress } = options;
  const random = makeSeededRandom(seed);
  const initial = { ...league, teams: new Map([...league.teams].map(([tid,roster]) => [tid,sortRotation(roster)])) };
  const proxyOptions = { ...options, numPlayersOnCourt: league.settings.numPlayersOnCourt };
  const baselineProxy = rosterProxy(initial.teams.get(teamId),proxyOptions);
  if (!Number.isFinite(baselineProxy)) throw new Error('Selected team has too few available players to simulate');
  const first = { league: initial, key: stateKey(initial), steps: [], proxyScore: baselineProxy, offers: [] };
  const visited = new Map([[first.key,0]]), candidates = [], opponents = [...league.teams.keys()].filter(tid => tid !== teamId);
  const stats = { iterations, candidatesEvaluated: 0, legalCandidates: 0, conditionalCandidates: 0,
    rejectedCandidates: 0, duplicateStates: 0, statesVisited: 1, maxDepth, depthReached: 0, beamWidth, finalists,
    largestOutgoingPackage: 0, largestIncomingPackage: 0, rejectedReasons: {}, simulatedGames: 0 };
  let frontier = [first];
  const reject = reason => { stats.rejectedCandidates++; stats.rejectedReasons[reason] = (stats.rejectedReasons[reason] ?? 0)+1; };
  onProgress?.({stage:'search',completed:0,total:iterations,message:'Screening variable-size player packages'});
  for (let depth=1;depth<=maxDepth && frontier.length;depth++) {
    const next = [];
    const attempts = Math.floor(iterations/maxDepth)+(depth <= iterations%maxDepth ? 1 : 0);
    for (let index=0;index<attempts;index++) {
      const parent = frontier[index%frontier.length];
      const scenario = proposal(parent.league,teamId,opponents,random,parent.offers);
      stats.candidatesEvaluated++;
      stats.largestOutgoingPackage = Math.max(stats.largestOutgoingPackage,scenario.teams[0].send.length);
      stats.largestIncomingPackage = Math.max(stats.largestIncomingPackage,scenario.teams[1].send.length);
      const assessment = assessTrade(parent.league,scenario,{phase:options.tradePhase,teamId});
      if (assessment.status === 'illegal' || assessment.legal === false || assessment.aiAcceptance === false) {
        reject(assessment.reasons[0] ?? 'Trade rejected');
      } else if (options.feasibility === 'verified' && assessment.status !== 'verified') {
        reject('Trade feasibility is not fully verified');
      } else {
        const applied = applyTrade(parent.league,scenario);
        // Salary rules alone allow temporary roster undersizes. This frozen
        // roster search cannot add free agents, so every node must be playable.
        const scores = scenario.teams.map(side => rosterProxy(applied.league.teams.get(side.tid),proxyOptions));
        if (!scores.every(Number.isFinite)) {
          reject('Trade leaves a team with too few available players to simulate');
        } else {
          stats.legalCandidates++;
          if (assessment.status !== 'verified') stats.conditionalCandidates++;
          const score = scores[0], key = stateKey(applied.league);
          parent.offers.push({scenario,score});
          parent.offers.sort((a,b) => b.score-a.score);
          if (parent.offers.length > beamWidth) parent.offers.length = beamWidth;
          if ((visited.get(key) ?? Infinity) <= depth) stats.duplicateStates++;
          else {
            visited.set(key,depth);
            const node = { league: applied.league, key, proxyScore: score, offers: [],
              steps: [...parent.steps,{scenario,transfers:applied.transfers,assessment}] };
            next.push(node);
            candidates.push(node);
          }
        }
      }
      if (stats.candidatesEvaluated%10 === 0) onProgress?.({stage:'search',completed:stats.candidatesEvaluated,total:iterations,
        message:`Depth ${depth}: ${visited.size} distinct roster states`});
    }
    stats.depthReached = depth;
    // Keep one slot for a randomly sampled state when possible. This permits a
    // temporarily weaker intermediate roster to survive a greedy beam cut.
    next.sort((a,b) => b.proxyScore-a.proxyScore || a.key.localeCompare(b.key));
    frontier = next.slice(0,beamWidth);
    if (next.length > beamWidth && beamWidth > 1) frontier[beamWidth-1] = next[beamWidth+Math.floor(random()*(next.length-beamWidth))];
  }
  stats.statesVisited = visited.size;
  onProgress?.({stage:'search',completed:stats.candidatesEvaluated,total:iterations,message:`Screened ${stats.candidatesEvaluated} packages; ${visited.size} distinct states`});
  // Trading may temporarily exceed roster limits in BBGM, but an end state
  // advertised as ready to play must fit them without unplanned signings/cuts.
  const ready = candidates.filter(node => {
    const count = node.league.teams.get(teamId).length;
    return count >= (league.settings.minRosterSize ?? league.settings.numPlayersOnCourt)
      && count <= (league.settings.maxRosterSize ?? Infinity);
  });
  stats.finalStatesOutsideRosterLimits = candidates.length-ready.length;
  const ordered = ready.sort((a,b) => b.proxyScore-a.proxyScore || a.steps.length-b.steps.length || a.key.localeCompare(b.key));
  const selected = ordered.slice(0,finalists);
  const beforeRows = [];
  const evaluationOptions = { teamId,phase:options.phase,health:options.health,gamesPerOpponent:options.gamesPerOpponent,seed };
  const perEvaluation = (league.teams.size-1)*options.gamesPerOpponent;
  onProgress?.({stage:'baseline',completed:0,total:perEvaluation,message:'Simulating the baseline with the same automatic rotation policy'});
  const baseline = evaluate(initial,{ ...evaluationOptions,onGame:collectTrial(teamId,beforeRows),
    onProgress:p => onProgress?.({stage:'baseline',completed:p.simulatedGames,total:perEvaluation,message:'Simulating baseline'}) });
  stats.simulatedGames += baseline.simulatedGames;
  const routes = selected.map((node,index) => {
    const afterRows = [];
    const evaluated = evaluate(node.league,{ ...evaluationOptions,onGame:collectTrial(teamId,afterRows),
      onProgress:p => onProgress?.({stage:'verify',completed:index*perEvaluation+p.simulatedGames,total:selected.length*perEvaluation,
        message:`Simulating finalist ${index+1} of ${selected.length}`}) });
    stats.simulatedGames += evaluated.simulatedGames;
    const after = evaluated.teams[0], delta = pairedChanges(beforeRows,afterRows);
    return { depth:node.steps.length,proxyScore:node.proxyScore,score:after.strength,gain:delta.net.estimate,delta,after,
      steps:node.steps,feasibility:node.steps.every(step => step.assessment.status === 'verified') ? 'verified' : 'conditional',
      roster:node.league.teams.get(teamId).map(p => ({pid:p.pid,name:name(p),ovr:ovr(p),pos:p.rating.pos,contract:p.contract})) };
  }).sort((a,b) => b.gain-a.gain || a.depth-b.depth).map((route,i) => ({rank:i+1,...route}));
  const bestRouteIndex = routes.length && routes[0].gain > 0 ? 0 : null;
  return { model:'bounded-player-trade-search-v1',teamId,seed,baseline,routes,bestRouteIndex,
    recommendation:bestRouteIndex === null ? 'Keep the current roster: no simulated finalist improved its estimated strength.'
      : routes[0].delta.net.confidence95[0] <= 0 ? 'The leading route has a positive estimate, but its improvement is inconclusive. Increase the simulation budget before choosing it.'
      : routes[0].feasibility === 'verified' ? 'Best route accepted by the pinned model found within this search budget.'
        : 'Best conditional route found; unresolved trade conditions must be checked in the game.',
    search:stats,proxy:{baseline:baselineProxy,definition:'Injury-adjusted OVR averaged over a fixed top-rotation minutes template, ordered by valueNoPot. Missing OVR falls back to valueNoPot.',
      status:'Uncalibrated screening heuristic; not a prediction of net rating. Finalists are reranked using the possession simulator.',
      observations:routes.map(r => ({rank:r.rank,proxyScore:r.proxyScore,simulatedStrength:r.score}))},
    rotationPolicy:'All teams use valueNoPot descending, pid tie-break, with playing-time modifiers reset to 1 in baseline and every searched state.',
    definitions:{scope:'Two-team player-only trades involving the selected team. Any package size can be sampled, including empty one-way packages; picks, cash, signings, development and time advancement are outside this search.',
      search:'Seeded stochastic package generation and mutation, with a bounded beam across trade depths. Ownership for the entire league defines a node. Repeated states retain the shortest discovered path.',
      guarantees:'Returns the strongest simulated finalist found. Neither the global optimum nor its globally shortest path is guaranteed.',
      comparison:'Baseline and finalist use identical opponent IDs, venue weights and simulation seeds. Post-trade opponent rosters are included. Paired confidence intervals describe Monte Carlo error, not model or search error.'},
    warnings:[...baseline.warnings,'Search can miss stronger rosters because package sampling and the OVR screen are approximate.',
      'Each route is a sequence in one frozen league phase. No games, injuries, salary changes, draft picks or free-agent signings occur between steps.',
      'Final user rosters must fit the exported roster limits. Temporary or opponent roster-limit violations are recorded in each trade assessment.',
      'The current roster remains an available zero-trade option. A positive estimate with a confidence interval crossing zero is inconclusive.',
      'Finalist confidence intervals are approximate Monte Carlo intervals and do not correct for selection of the highest observed score.',
      ...(stats.conditionalCandidates ? ['Conditional routes are not confirmed achievable: missing phase, rules or AI inputs must be supplied or checked in the game.'] : []),
      ...(routes.length === 0 ? ['No eligible simulated trade routes were found within this search budget. This does not prove that no useful trade exists.'] : [])] };
}
