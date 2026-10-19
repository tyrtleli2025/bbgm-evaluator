// Player-only acceptance and financial rules from the pinned ZenGM source.
// Audit copies and parity tests accompany this port. No pick-value approximation
// is passed off as game acceptance: trades containing picks remain conditional.
export const TRADE_RULES_PROVENANCE = Object.freeze({
  revision: 'e2e6a3c7cd87d456b64ed94b67539dee7da71aa7',
  url: 'https://github.com/zengm-games/zengm/tree/e2e6a3c7cd87d456b64ed94b67539dee7da71aa7/src/worker/core/trade',
  ai: 'Player-only branch of team/ValueChangeCalculator.ts, with player/updateOvrMeanStd.ts; picks are not valued locally.',
  files: {
    'trade-rules-ai.ts': '141b77c63661354d067ff87fd0420e7a9266de877c16f57c16dfe2f5ca605a24',
    'trade-rules-summary.ts': '0a4970aae3c246453f7db3df82b7c8878c6952aa4ebd3e2c08e653d0d713a397',
    'trade-rules-isUntradable.ts': '9bbf64917aaa06f76a93455945e399bd8ef5d431eaafe1aaa54995ba543a923f',
    'trade-rules-ovr.ts': 'd5453469928198e251ab76d88d4e2a6af8f8c85443b1b9d37d527b5c9ce541ba',
  },
});

const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const distributions = new WeakMap();

function distribution(players) {
  if (!Array.isArray(players)) return null;
  if (distributions.has(players)) return distributions.get(players);
  const ratings = players.filter(p => p.tid >= -1).map(p => p.ratings?.at(-1)?.ovr);
  let result = null;
  if (ratings.length && ratings.every(finite)) {
    const mean = ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
    const std = Math.sqrt(ratings.reduce((sum, value) => sum + (value - mean) ** 2, 0) / ratings.length);
    if (std > 0) result = { mean, std, count: ratings.length };
  }
  distributions.set(players, result);
  return result;
}

function contractValue(contract, value, settings) {
  if (contract.exp === settings.season || (settings.phase > 3 && contract.exp === settings.season + 1)) return 0;
  const slope = (settings.maxContract / settings.salaryCap - settings.minContract / settings.salaryCap) / 2.5;
  return Math.min(slope * (value + 0.5) - contract.amount / settings.salaryCap, 0.1);
}

function isJustDrafted(player, phase, season) {
  return !!player.contract.rookie && ((player.draft.year === season && phase >= 5) ||
    (player.draft.year === season - 1 && phase < 1 && phase >= 0));
}

// The exponent and age/contract/injury adjustments deliberately match upstream,
// including the behavior for negative assets and asymmetric injury treatment.
function sumValues(assets, strategy, tid, userTid, includeInjuries) {
  return assets.reduce((sum, asset) => {
    let value = asset.value;
    const age = asset.age;
    if (strategy === 'rebuilding') {
      if (age <= 19) value *= 1.075;
      else if (age === 20) value *= 1.05;
      else if (age === 21) value *= 1.0375;
      else if (age === 22) value *= 1.025;
      else if (age === 23) value *= 1.0125;
      else if (age === 27) value *= 0.975;
      else if (age === 28) value *= 0.95;
      else if (age >= 29) value *= 0.9;
    } else if (strategy === 'contending') {
      if (age <= 19) value *= 0.8;
      else if (age === 20) value *= 0.825;
      else if (age === 21) value *= 0.85;
      else if (age === 22) value *= 0.875;
      else if (age === 23) value *= 0.925;
      else if (age === 24) value *= 0.95;
    }
    if (includeInjuries && tid !== userTid) value -= value * Math.min(asset.injury.gamesRemaining, 75) / 100;
    if (value < 0) value /= 20;
    value += (strategy === 'rebuilding' ? 2 : 0.5) * asset.contractValue;
    if (asset.justDrafted) value = Math.max(0, value);
    return sum + (value > 1 ? value ** 7 : value);
  }, 0);
}

function assessAcceptance(league, sides, settings, options, missing, assumptions) {
  if (sides.some(s => s.picks.length)) {
    missing.push('AI draft-pick valuation is not implemented; verify this package in the game.');
    return null;
  }
  const requestedUser = options.userTid ?? options.teamId ?? sides[0].tid;
  if (!sides.some(s => s.tid === requestedUser)) {
    missing.push('The controlled team must participate in the trade.');
    return null;
  }
  const userTid = requestedUser;
  if (settings.userTid !== userTid) assumptions.push(`Controlled team is assumed to be ${userTid}; the export ${settings.userTid === undefined ? 'omits userTid' : `specifies ${settings.userTid}`}.`);
  const ours = sides.find(s => s.tid === userTid), theirs = sides.find(s => s.tid !== userTid);
  const metadata = league.rawData?.teams?.find(t => t.tid === theirs.tid);
  let strategy = metadata?.strategy;
  const override = options.strategies?.[theirs.tid];
  if (override !== undefined && override !== strategy) {
    assumptions.push(`Team ${theirs.tid} strategy is assumed to be ${override}.`);
    strategy = override;
  }
  const errors = [];
  if (!['contending', 'rebuilding'].includes(strategy)) errors.push(`Missing team ${theirs.tid} strategy for AI acceptance.`);
  for (const key of ['phase', 'difficulty', 'season', 'salaryCap', 'minContract', 'maxContract']) {
    if (!finite(settings[key]) || (key === 'salaryCap' && settings[key] <= 0)) errors.push(`Missing or invalid ${key} for AI acceptance.`);
  }
  const stats = distribution(league.rawData?.players);
  if (!stats) errors.push('AI acceptance needs exported active players and free agents with valid OVR ratings and nonzero OVR spread.');
  for (const p of [...ours.players, ...theirs.players]) {
    if (!finite(p.value) || !nonnegative(p.contract?.amount) || !Number.isInteger(p.contract?.exp) ||
        !Number.isInteger(p.born?.year) || !nonnegative(p.injury?.gamesRemaining) ||
        (p.contract?.rookie && !Number.isInteger(p.draft?.year))) errors.push(`Player ${p.pid} is missing AI trade-value inputs.`);
  }
  if (errors.length) { missing.push(...errors); return null; }
  const fudge = Math.max(1 + 0.1 * settings.difficulty, 0);
  const asset = (p, outgoing) => {
    const value = (p.value - stats.mean) / stats.std;
    return { value: outgoing && value > 0 ? value * fudge : value,
      contractValue: contractValue(p.contract, value, settings), injury: p.injury,
      age: settings.season - p.born.year, justDrafted: isJustDrafted(p, settings.phase, settings.season) };
  };
  const incomingValue = sumValues(ours.players.map(p => asset(p, false)), strategy, theirs.tid, userTid, true);
  const outgoingValue = sumValues(theirs.players.map(p => asset(p, true)), strategy, theirs.tid, userTid, false);
  const valueChange = incomingValue - outgoingValue;
  return { accepted: valueChange > 0, valueChange, incomingValue, outgoingValue, strategy,
    controlledTid: userTid, partnerTid: theirs.tid, ovrDistribution: stats,
    model: 'Pinned BBGM player-only AI valuation; acceptance requires valueChange > 0.' };
}

/** Assess a two-team package; never mutate the league. Monetary values are in
 * exported $1,000 units. `verified` means verified against the pinned model and
 * supplied snapshot, not a promise that another game version will accept it. */
export function assessTrade(league, scenario, options = {}) {
  const reasons = [], missing = [], assumptions = [], teams = [], rosterWarnings = [];
  const details = { provenance: TRADE_RULES_PROVENANCE, assumptions, missing, teams, rosterWarnings, ai: null };
  let legal = true;
  const reject = reason => { legal = false; reasons.push(reason); };
  const unknown = reason => { if (legal !== false) legal = null; missing.push(reason); };
  const finish = (aiAcceptance = null) => ({
    status: legal === false || aiAcceptance === false ? 'illegal' : legal === true && aiAcceptance === true && !assumptions.length ? 'verified' : 'conditional',
    legal, aiAcceptance, reasons: [...new Set([...reasons, ...missing, ...assumptions])], details,
  });
  if (!Array.isArray(scenario?.teams) || scenario.teams.length !== 2 || scenario.teams[0]?.tid === scenario.teams[1]?.tid) {
    reject('A trade must contain two different teams.'); return finish();
  }
  const settings = { ...league.settings };
  for (const key of ['phase', 'difficulty']) if (options[key] !== undefined && options[key] !== null && options[key] !== settings[key]) {
    assumptions.push(`${key} is assumed to be ${options[key]}; the export ${settings[key] === undefined ? 'omits it' : `specifies ${settings[key]}`}.`);
    settings[key] = options[key];
  }
  if (settings.challengeNoTrades === true) reject('The No Trades challenge is enabled.');
  if (settings.spectator === true) reject('Spectator mode does not permit user trades.');
  if (!Number.isInteger(settings.phase)) unknown('The export does not specify the transaction phase.');
  else if (settings.phase >= 2 && settings.phase <= 3) reject('Trades are disabled after the trade deadline and during playoffs.');
  else if ([-2,-1].includes(settings.phase)) reject('Trades are disabled during fantasy and expansion drafts.');
  const seenPlayers = new Set(), seenPicks = new Set(), sides = [];
  for (const side of scenario.teams) {
    const roster = league.teams.get(side?.tid);
    if (!Number.isInteger(side?.tid) || !roster || !Array.isArray(side.send) || (side.picks !== undefined && !Array.isArray(side.picks))) {
      reject('Each trade side needs a valid team ID and player/pick ID arrays.'); return finish();
    }
    if (league.rawData?.teams?.find(t => t.tid === side.tid)?.disabled) reject(`Team ${side.tid} is disabled.`);
    const players = [];
    for (const pid of side.send) {
      const p = roster.find(p => p.pid === pid);
      if (!Number.isInteger(pid) || !p || seenPlayers.has(pid)) {
        reject(`Invalid, duplicated, or incorrectly owned player ID ${pid}.`); return finish();
      }
      seenPlayers.add(pid); players.push(p);
      if (!settings.godMode) {
        if (!Number.isInteger(p.contract?.exp)) unknown(`Missing contract expiry for player ${pid}.`);
        else if (p.contract.exp <= settings.season && settings.phase > 3 && settings.phase < 8) reject(`Player ${pid} has an expired contract and cannot be traded in this phase.`);
        if (!nonnegative(p.gamesUntilTradable)) unknown(`Missing gamesUntilTradable for player ${pid}.`);
        else if (p.gamesUntilTradable > 0) reject(`Player ${pid} cannot be traded for ${p.gamesUntilTradable} more games.`);
      }
    }
    for (const dpid of side.picks ?? []) {
      if (!Number.isInteger(dpid) || seenPicks.has(dpid)) { reject(`Invalid or duplicated draft pick ID ${dpid}.`); return finish(); }
      seenPicks.add(dpid);
      if (!Array.isArray(league.rawData?.draftPicks)) unknown('Draft-pick ownership is absent from this export.');
      else if (!league.rawData.draftPicks.some(p => p.dpid === dpid && p.tid === side.tid)) reject(`Draft pick ${dpid} does not belong to team ${side.tid}.`);
    }
    sides.push({ ...side, players, picks: side.picks ?? [] });
  }
  if (!seenPlayers.size && !seenPicks.size) reject('A trade must move at least one asset.');
  if (!['soft', 'hard', 'none'].includes(settings.salaryCapType)) unknown('Missing or unsupported salaryCapType.');
  const capped = ['soft', 'hard'].includes(settings.salaryCapType);
  if (capped && !nonnegative(settings.salaryCap)) unknown('Missing or invalid salaryCap.');
  if (settings.salaryCapType === 'soft' && !nonnegative(settings.softCapTradeSalaryMatch)) unknown('Missing or invalid softCapTradeSalaryMatch.');
  if (capped && !Array.isArray(league.rawData?.releasedPlayers)) unknown('Released-player liabilities were not exported; payroll cannot be verified.');
  for (let i = 0; i < 2; i++) {
    const side = sides[i], other = sides[1 - i], roster = league.teams.get(side.tid);
    const releases = league.rawData?.releasedPlayers?.filter(p => p.tid === side.tid) ?? [];
    const payrollRecords = [...roster, ...releases];
    const salaryKnown = [...payrollRecords, ...other.players].every(p => nonnegative(p.contract?.amount));
    if (capped && !salaryKnown) unknown(`Team ${side.tid} has missing contract amounts.`);
    const sumSalary = players => players.reduce((sum, p) => sum + p.contract.amount, 0);
    const row = { tid: side.tid, rosterBefore: roster.length, rosterAfter: roster.length - side.players.length + other.players.length };
    if (row.rosterAfter < settings.minRosterSize || row.rosterAfter > settings.maxRosterSize) rosterWarnings.push(`Team ${side.tid} would have ${row.rosterAfter} players, outside the roster limit; BBGM's trade check does not reject this, but roster moves may be needed before playing.`);
    if (salaryKnown) {
      row.payrollBefore = sumSalary(payrollRecords);
      row.outgoingSalary = sumSalary(side.players); row.incomingSalary = sumSalary(other.players);
      row.payrollAfter = row.payrollBefore - row.outgoingSalary + row.incomingSalary;
      row.salaryRatio = row.outgoingSalary > 0 ? Math.floor(100 * row.incomingSalary / row.outgoingSalary) : row.incomingSalary > 0 ? null : 100;
      row.ratioInfinite = row.outgoingSalary === 0 && row.incomingSalary > 0;
      const overCap = row.payrollAfter > settings.salaryCap;
      if (settings.salaryCapType === 'soft' && overCap && (row.ratioInfinite || row.salaryRatio > settings.softCapTradeSalaryMatch)) reject(`Team ${side.tid} fails the soft-cap salary match (${row.ratioInfinite ? 'infinite' : row.salaryRatio}% incoming/outgoing).`);
      if (settings.salaryCapType === 'hard' && overCap && row.payrollAfter > row.payrollBefore) reject(`Team ${side.tid} increases payroll above the hard cap.`);
    }
    teams.push(row);
  }
  // Financial legality and AI valuation are independent. Counteroffers must
  // still be valued while salary matching is being repaired.
  details.ai = assessAcceptance(league, sides, settings, options, missing, assumptions);
  if (details.ai?.accepted === false) reasons.push(`The pinned AI valuation rejects this package (value change ${details.ai.valueChange.toFixed(3)}).`);
  return finish(details.ai?.accepted ?? null);
}
