import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prepareTeam, simulate } from './adapter.mjs';

const manifest = JSON.parse(readFileSync(new URL('../vendor/zengm/manifest.json', import.meta.url)));
const mean = xs => xs.reduce((s,x) => s+x, 0) / xs.length;
const variance = xs => {
  if (xs.length < 2) return 0;
  const average = mean(xs);
  return xs.reduce((s,x) => s+(x-average)**2, 0)/(xs.length-1);
};
const safeRatio = (a,b) => b > 0 ? a/b : null;
const playerKeys = 'min pts fg fga tp tpa ft fta ast tov orb drb stl blk pf'.split(' ');

export function scheduleSeed(seed, first, second, game) {
  return createHash('sha256').update(`${seed}:${first}:${second}:${game}`).digest().readUInt32LE();
}

export function estimatedPossessions(a, b) {
  // Shared denominator keeps each game's offensive and defensive ratings
  // comparable. Includes overtime, FT trips approximately, and second chances.
  return ((a.fga + 0.44*a.fta - a.orb + a.tov) + (b.fga + 0.44*b.fta - b.orb + b.tov))/2;
}

export function validateGame(game, settings, phase) {
  const otLength = phase === 'playoffs' ? (settings.overtimeLengthPlayoffs ?? settings.overtimeLength) : settings.overtimeLength;
  const minutes = settings.numPlayersOnCourt * (settings.numPeriods*settings.quarterLength + game.overtimes*otLength);
  for (const t of game.team) {
    for (const [key, val] of Object.entries(t.stat)) {
      if (typeof val === 'number' && !Number.isFinite(val)) throw new Error(`Nonfinite team stat ${key}`);
    }
    if (t.stat.pts !== 2*t.stat.fg + t.stat.tp + t.stat.ft) throw new Error('Team points identity failed');
    if (Math.abs(t.player.reduce((s,p) => s+p.stat.min,0)-minutes) > 0.001) throw new Error('Player minutes identity failed');
    for (const key of playerKeys) {
      if (Math.abs(t.player.reduce((s,p) => s+p.stat[key],0)-t.stat[key]) > 0.001) throw new Error(`Player/team ${key} totals differ`);
    }
    for (const p of t.player) {
      if (p.stat.pts !== 2*p.stat.fg + p.stat.tp + p.stat.ft) throw new Error('Player points identity failed');
    }
  }
  if (!(estimatedPossessions(...game.team.map(t => t.stat)) > 0)) throw new Error('Invalid possession estimate');
}

function observation(team, opp, venue) {
  const a = team.stat, b = opp.stat;
  const poss = estimatedPossessions(a,b);
  return { opponent: opp.id, venue, offense: 100*a.pts/poss, defense: 100*b.pts/poss,
    net: 100*(a.pts-b.pts)/poss, margin: a.pts-b.pts,
    win: a.pts > b.pts ? 1 : a.pts === b.pts ? 0.5 : 0,
    synergy: team.synergyAverage, opponentSynergy: opp.synergyAverage,
    poss, stat: a, opponentStat: b, players: team.player };
}

// Equal opponent and venue weights, even if budgets become unequal later.
// Normal-approximation CI; variance is estimated within each opponent/venue.
export function summarizeStrata(strata, key) {
  const values = strata.map(rows => rows.map(r => r[key]));
  const estimate = mean(values.map(mean));
  const standardError = Math.sqrt(values.reduce((s,xs) => s+variance(xs)/xs.length,0))/strata.length;
  return { estimate, standardError, confidence95: [estimate-1.96*standardError, estimate+1.96*standardError] };
}

function summarize(tid, rows, roster) {
  const opponents = [...new Set(rows.map(r => r.opponent))].sort((a,b) => a-b);
  const strata = opponents.flatMap(id => ['home','away'].map(v => rows.filter(r => r.opponent===id && r.venue===v)));
  const net = summarizeStrata(strata, 'net');
  const win = summarizeStrata(strata, 'win');
  win.confidence95 = win.confidence95.map(x => Math.max(0, Math.min(1,x)));
  const average = key => summarizeStrata(strata, key).estimate;
  const avgSynergy = (field, group, key) => mean(strata.map(s => mean(s.map(r => r[field][group][key]))));
  const synergyRaw = Object.fromEntries(['off','def','reb'].map(k => [k,avgSynergy('synergy','raw',k)]));
  const upperBounds = { off: 1, def: 5/6, reb: 1/2 };
  const synergy = {
    raw: synergyRaw,
    scale100: Object.fromEntries(Object.entries(synergyRaw).map(([k,v]) => [k,100*v/upperBounds[k]])),
    opponentAverageScale100: Object.fromEntries(Object.entries(upperBounds).map(([k,v]) => [k,100*avgSynergy('opponentSynergy','raw',k)/v])),
    fractionalSkills: Object.fromEntries(['3','A','B','Di','Dp','Po','Ps','R'].map(k => [k,avgSynergy('synergy','fractionalSkills',k)])),
  };
  const totals = (field, key) => rows.reduce((s,r) => s+r[field][key],0);
  const factors = field => {
    const oppField = field === 'stat' ? 'opponentStat' : 'stat';
    return {
      effectiveFgPct: safeRatio(totals(field,'fg')+0.5*totals(field,'tp'), totals(field,'fga')),
      turnoversPer100: 100*totals(field,'tov')/rows.reduce((s,r)=>s+r.poss,0),
      offensiveReboundPct: safeRatio(totals(field,'orb'),totals(field,'orb')+totals(oppField,'drb')),
      freeThrowAttemptRate: safeRatio(totals(field,'fta'),totals(field,'fga')),
      threePointAttemptRate: safeRatio(totals(field,'tpa'),totals(field,'fga')),
      rimAttemptRate: safeRatio(totals(field,'fgaAtRim'),totals(field,'fga')),
      postAttemptRate: safeRatio(totals(field,'fgaLowPost'),totals(field,'fga')),
      midrangeAttemptRate: safeRatio(totals(field,'fgaMidRange'),totals(field,'fga')),
    };
  };
  const players = roster.map(p => {
    const games = rows.map(r=>r.players.find(x=>x.id===p.pid));
    const perGame = Object.fromEntries(playerKeys.map(k=>[k,mean(games.map(x=>x.stat[k]))]));
    return { pid:p.pid, name:`${p.firstName} ${p.lastName}`, ...perGame,
      shotAttemptShare: safeRatio(perGame.fga, totals('stat','fga')/rows.length),
      trueShootingPct: safeRatio(perGame.pts, 2*(perGame.fga+0.44*perGame.fta)) };
  }).sort((a,b)=>b.min-a.min);
  return { tid, leaders: players.slice(0,3).map(p=>p.name), games: rows.length,
    strength: net.estimate, strengthStandardError: net.standardError, strengthConfidence95: net.confidence95,
    offensiveRating: average('offense'), defensiveRating: average('defense'),
    winRate: win.estimate, winRateConfidence95: win.confidence95, meanMargin: average('margin'),
    marginStdDev: Math.sqrt(variance(rows.map(r=>r.margin))),
    offenseFactors: factors('stat'), defenseFactors: factors('opponentStat'), synergy, players,
    matchups: opponents.map(id=>({ opponent:id, games:rows.filter(r=>r.opponent===id).length,
      ...summarizeStrata(strata.filter(s=>s[0].opponent===id),'net') })) };
}

export function evaluate(league, { teamId, phase = 'regular', health = 'current', gamesPerOpponent = 20, seed = 12345, onProgress, onGame } = {}) {
  if (!['regular','playoffs'].includes(phase)) throw new Error('phase must be regular or playoffs');
  if (!['current','healthy'].includes(health)) throw new Error('health must be current or healthy');
  if (!Number.isInteger(gamesPerOpponent) || gamesPerOpponent < 4 || gamesPerOpponent % 2) throw new Error('games-per-opponent must be an even integer >= 4');
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  if (teamId !== undefined && !league.teams.has(teamId)) throw new Error(`Unknown team ID ${teamId}`);
  const tids = [...league.teams.keys()];
  const targets = teamId === undefined ? tids : [teamId];
  const observations = new Map(targets.map(tid=>[tid,[]]));
  const templates = new Map(tids.map(tid=>[tid,prepareTeam(tid,league.teams.get(tid),league.settings,{phase,health})]));
  // This is a generic playoff matchup, not specifically the finals.
  const neutral = phase === 'playoffs' && league.settings.neutralSite === 'playoffs';
  let simulatedGames = 0;
  for (let i=0;i<tids.length;i++) for(let j=i+1;j<tids.length;j++) {
    const a=tids[i], b=tids[j];
    if (teamId !== undefined && teamId !== a && teamId !== b) continue;
    for(let n=0;n<gamesPerOpponent;n++) {
      const [home,away] = n%2 === 0 ? [a,b] : [b,a];
      const game = simulate(templates.get(home),templates.get(away),league.settings,
        {seed:scheduleSeed(seed,a,b,n),phase,neutral});
      validateGame(game,league.settings,phase);
      onGame?.({ home, away, index: n, game });
      const [h,v] = game.team;
      if (observations.has(home)) observations.get(home).push(observation(h,v,'home'));
      if (observations.has(away)) observations.get(away).push(observation(v,h,'away'));
      simulatedGames++;
    }
    onProgress?.({simulatedGames,first:a,second:b});
  }
  return {
    model: 'pinned-engine-frozen-roster-v1', engineRevision: manifest.revision,
    engineSourceHashes: manifest.files, nodeVersion:process.version,
    inputSha256:league.inputHash, exportSchemaVersion:league.schemaVersion,
    phase, health, seed, gamesPerOpponent, simulatedGames,
    scoreDefinition:'Equal-opponent, equal-venue mean of per-game estimated net points per 100 possessions. Higher is better; zero is parity.',
    possessionDefinition:'0.5 * sum over both teams of (FGA + 0.44*FTA - ORB + TOV), including overtime',
    synergyDefinition:'Time-weighted engine lineup synergy within each game, then equal game/opponent/venue weights. Scale100 is percent of mathematical upper bound: off=1, def=5/6, reb=1/2; not a percentile or predicted efficiency.',
    settings:league.settings, engineOverrides:{phase:phase==='playoffs'?3:1,injuryRate:0,homeCourtFactor:1,neutralSite:neutral},
    warnings:[...league.warnings, 'Game win rate is not playoff-series or championship probability.',
      ...(league.settings.neutralSite === 'finals' ? ['Generic matchups are not finals; finals-only neutral venues are not applied.'] : []),
      ...(gamesPerOpponent < 20 ? ['Small simulation budget: use more games before comparing close scores.'] : [])],
    teams:targets.map(tid=>summarize(tid,observations.get(tid),league.teams.get(tid))).sort((a,b)=>b.strength-a.strength),
  };
}
