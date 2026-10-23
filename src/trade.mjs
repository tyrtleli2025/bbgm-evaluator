import { teamName } from './team-names.mjs';
import { createHash } from 'node:crypto';
import { evaluate, estimatedPossessions, summarizeStrata } from './evaluator.mjs';

function keysOnly(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`Invalid ${label}`);
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}

// A scenario specifies exactly two teams and the player IDs each sends.
// Draft picks and transaction rules require the future financial/action model.
export function prepareTrade(league, scenario, teamId) {
  keysOnly(scenario, ['teams'], 'trade');
  if (!Array.isArray(scenario.teams) || scenario.teams.length !== 2) throw new Error('trade.teams must contain exactly two teams');
  const seen = new Set();
  for (const side of scenario.teams) {
    keysOnly(side, ['tid', 'send'], 'trade team');
    if (!Number.isInteger(side.tid) || !league.teams.has(side.tid)) throw new Error(`Unknown team ID ${side.tid}`);
    if (!Array.isArray(side.send)) throw new Error('Each trade team needs a send array of player IDs');
    for (const pid of side.send) {
      if (!Number.isInteger(pid) || seen.has(pid)) throw new Error(`Invalid or duplicate traded player ID ${pid}`);
      if (!league.teams.get(side.tid).some(p => p.pid === pid)) throw new Error(`Player ${pid} does not belong to team ${side.tid}`);
      seen.add(pid);
    }
  }
  const tids = scenario.teams.map(s => s.tid);
  if (tids[0] === tids[1]) throw new Error('Trade requires two different teams');
  if (!tids.includes(teamId)) throw new Error('--team-id must be one of the trade teams');
  if (!seen.size) throw new Error('Trade must move at least one player');
  const baseline = structuredClone(league), candidate = structuredClone(league);
  const transfers = [];
  // Remove all outgoing players before adding incoming players.
  for (const side of scenario.teams) candidate.teams.set(side.tid, candidate.teams.get(side.tid).filter(p => !seen.has(p.pid)));
  for (const side of scenario.teams) {
    const destination = tids.find(tid => tid !== side.tid);
    for (const pid of side.send) {
      const p = structuredClone(league.teams.get(side.tid).find(p => p.pid === pid));
      transfers.push({ pid, name: `${p.firstName} ${p.lastName}`, fromTid: side.tid, toTid: destination });
      p.tid = destination;
      candidate.teams.get(destination).push(p);
    }
  }
  const warnings = [];
  for (const tid of tids) {
    const roster = candidate.teams.get(tid);
    if (roster.length < league.settings.numPlayersOnCourt) throw new Error(`Trade leaves team ${tid} with too few players to simulate`);
    if (roster.length < league.settings.minRosterSize || roster.length > league.settings.maxRosterSize) {
      warnings.push(`${teamName(league,tid)}: post-trade roster size ${roster.length} is outside exported roster limits.`);
    }
    // Same explicit rotation policy on BOTH sides of the comparison. This is a
    // simple value-based policy, not an optimal lineup search or BBGM auto-sort.
    for (const state of [baseline, candidate]) {
      state.teams.get(tid).sort((a,b) => b.valueNoPot-a.valueNoPot || a.pid-b.pid);
      state.teams.get(tid).forEach((p,i) => { p.rosterOrder = i; p.ptModifier = 1; });
    }
  }
  return { baseline, candidate, transfers, tids, warnings };
}

export function collectTrial(target, rows) {
  return ({home, away, index, game}) => {
    const ours = game.team.find(t => t.id === target), theirs = game.team.find(t => t.id !== target);
    const possessions = estimatedPossessions(ours.stat, theirs.stat);
    rows.push({ key: `${home}:${away}:${index}`, opponent: theirs.id, venue: home === target ? 'home' : 'away',
      net: 100*(ours.stat.pts-theirs.stat.pts)/possessions,
      offense: 100*ours.stat.pts/possessions, defense: 100*theirs.stat.pts/possessions,
      win: ours.stat.pts > theirs.stat.pts ? 1 : ours.stat.pts === theirs.stat.pts ? 0.5 : 0 });
  };
}

export function pairedChanges(before, after) {
  if (before.length !== after.length || !before.length) throw new Error('Mismatched comparison trials');
  const strata = new Map();
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    if (a.key !== b.key || a.opponent !== b.opponent || a.venue !== b.venue) throw new Error('Mismatched comparison schedule');
    const key = `${a.opponent}:${a.venue}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(Object.fromEntries(['net','offense','defense','win'].map(k => [k,b[k]-a[k]])));
  }
  return Object.fromEntries(['net','offense','defense','win'].map(k => [k,summarizeStrata([...strata.values()],k)]));
}

export function playerChanges(before, after) {
  const ids = new Set([...before.players, ...after.players].map(p => p.pid));
  return [...ids].map(pid => {
    const a = before.players.find(p => p.pid === pid), b = after.players.find(p => p.pid === pid);
    return { pid, name: (a ?? b).name, status: !a ? 'incoming' : !b ? 'outgoing' : 'retained',
      beforeMinutes: a?.min ?? 0, afterMinutes: b?.min ?? 0,
      pointsChange: (b?.pts ?? 0)-(a?.pts ?? 0),
      minutesChange: (b?.min ?? 0)-(a?.min ?? 0),
      shotAttemptsChange: (b?.fga ?? 0)-(a?.fga ?? 0) };
  }).sort((a,b) => Math.abs(b.minutesChange)-Math.abs(a.minutesChange));
}

export function evaluateTrade(league, scenario, options = {}) {
  const { baseline, candidate, transfers, tids, warnings } = prepareTrade(league, scenario, options.teamId);
  const comparisons = [];
  let simulatedGames = 0;
  for (const tid of [options.teamId, ...tids.filter(id => id !== options.teamId)]) {
    const beforeRows = [], afterRows = [];
    const before = evaluate(baseline, { ...options, teamId: tid, onGame: collectTrial(tid, beforeRows) });
    const after = evaluate(candidate, { ...options, teamId: tid, onGame: collectTrial(tid, afterRows) });
    simulatedGames += before.simulatedGames + after.simulatedGames;
    const delta = pairedChanges(beforeRows, afterRows);
    const a = before.teams[0], b = after.teams[0];
    comparisons.push({ tid, before: a, after: b, delta,
      verdict: delta.net.confidence95[0] > 0 ? 'Estimated improvement' : delta.net.confidence95[1] < 0 ? 'Estimated decline' : 'No clear change',
      playerChanges: playerChanges(a,b) });
    if (comparisons.length === 1) {
      // Preserve evaluator provenance and assumptions without duplicating four reports.
      comparisons[0].provenance = Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'teams'));
    }
  }
  const { provenance } = comparisons[0];
  delete comparisons[0].provenance;
  return { ...provenance, model: 'pinned-engine-trade-comparison-v1', simulatedGames,
    teamId: options.teamId, scenario: structuredClone(scenario),
    scenarioSha256: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'), transfers,
    rotationPolicy: 'Both trade teams sorted by valueNoPot descending, pid tie-break; all their ptModifiers set to 1 in both baseline and candidate. Other teams retain exported rotations.',
    transactionAssessment: 'Hypothetical basketball impact only. Salary matching, trade restrictions, AI acceptance, contract/pick value, and future development are not evaluated.',
    comparisonDefinition: 'Same opponent IDs and equal weights, with post-trade partner roster included in candidate. Confidence intervals use paired game differences within opponent/venue strata.',
    warnings: [...provenance.warnings.filter(w => !w.startsWith('Exported playing-time modifiers')), ...warnings,
      'Trade baseline uses the stated automatic rotation policy and may differ from a standalone evaluation of exported rotations.',
      'Shared seeds do not guarantee identical possession-level random events after a roster changes.',
      'An improved basketball score does not establish that the trade is legal, acceptable to the AI, or beneficial over eight years.'], comparisons };
}
