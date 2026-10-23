import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readLeague } from '../src/importer.mjs';
import { evaluateSeries, wilsonInterval, prepareSeriesTeams, normalizeSeriesInjuries } from '../src/series.mjs';

test('series injury scenarios honor both teams, reduced ratings, and explicit health overrides without mutation', () => {
  const snapshot = structuredClone(league);
  const [a,b] = [league.teams.get(0)[0], league.teams.get(1)[0]];
  const options = {teamId:0, opponentId:1, health:'healthy'};
  const healthy = prepareSeriesTeams(league, options);
  const injured = prepareSeriesTeams(league, {...options, injuries:[{pid:a.pid,gamesRemaining:3},{pid:b.pid,gamesRemaining:30}]});
  assert.equal(injured.get(0).player[0].injury.playingThrough,true);
  assert.equal(injured.get(0).player[0].injured,false);
  assert.ok(Math.abs(injured.get(0).player[0].compositeRating.passing / healthy.get(0).player[0].compositeRating.passing - .925) < 1e-10);
  assert.equal(injured.get(1).player[0].injured,true);
  const current = structuredClone(league);
  current.teams.get(0)[0].injury.gamesRemaining=30;
  assert.equal(prepareSeriesTeams(current,{...options,health:'current',injuries:[{pid:a.pid,gamesRemaining:0}]}).get(0).player[0].injured,false);
  assert.deepEqual(league,snapshot);
  for (const injuries of [null, {}, [{pid:league.teams.get(2)[0].pid,gamesRemaining:30}],
    [{pid:a.pid,gamesRemaining:-1}], [{pid:a.pid,gamesRemaining:1.5}], [{pid:a.pid,gamesRemaining:Infinity}],
    [{pid:a.pid,gamesRemaining:0},{pid:a.pid,gamesRemaining:30}]]) {
    assert.throws(()=>normalizeSeriesInjuries(league,0,1,injuries));
  }
  assert.throws(()=>prepareSeriesTeams(league,{...options,injuries:league.teams.get(0).map(p=>({pid:p.pid,gamesRemaining:30}))}),/available players/);
});

test('removing the best players changes series odds and resetting injuries restores the original result', () => {
  const matched = structuredClone(league);
  // Matched rosters avoid a baseline already near 0% or 100%.
  matched.teams.set(1,matched.teams.get(0).map(p=>({...structuredClone(p),pid:p.pid+100000,tid:1})));
  const stars = matched.teams.get(0).toSorted((a,b)=>b.valueNoPot-a.valueNoPot).slice(0,3);
  const options = {teamId:0,opponentId:1,series:100,health:'healthy',seed:71};
  const baseline = evaluateSeries(matched,options);
  const injured = evaluateSeries(matched,{...options,injuries:stars.map(p=>({pid:p.pid,gamesRemaining:30}))});
  assert.ok(baseline.teams[0].seriesWinProbability-injured.teams[0].seriesWinProbability > .25);
  assert.equal(injured.teams[0].availability.filter(p=>p.status==='out').length,3);
  assert.deepEqual(evaluateSeries(matched,{...options,injuries:[]}),baseline);
});

const league = readLeague(new URL('./fixtures/league.json.gz', import.meta.url));

test('in-progress series resume at the correct venue and only produce reachable outcomes', () => {
  for (const currentScore of [[3,1],[1,3],[3,3],[0,2]]) {
    const r=evaluateSeries(league,{teamId:0,opponentId:1,series:20,currentScore,seed:71});
    const played=currentScore[0]+currentScore[1];
    assert.equal(r.sampleSeries[0].game,played+1);
    assert.equal(r.sampleSeries[0].home,r.homeSchedule[played]);
    assert.equal(r.simulatedGames,r.outcomes.reduce((s,o)=>s+o.count*(4+o.loserWins-played),0));
    assert.equal(r.meanSeriesLength,played+r.meanRemainingGames);
    assert.equal(r.outcomes.reduce((s,o)=>s+o.count,0),20);
    for(const o of r.outcomes.filter(o=>o.count)) assert.ok(o.loserWins>=currentScore[o.loser===0?0:1]);
    if(played===6) assert.equal(r.simulatedGames,20);
    const reversed=evaluateSeries(league,{teamId:1,opponentId:0,homeCourt:0,series:20,currentScore:[...currentScore].reverse(),seed:71});
    assert.deepEqual(reversed.teams.toReversed(),r.teams);
  }
});

test('finished series have exact probabilities and invalid scores are rejected', () => {
  for(const currentScore of [[4,0],[4,3],[2,4]]) {
    const r=evaluateSeries(league,{teamId:0,opponentId:1,series:2,currentScore});
    assert.equal(r.simulatedGames,0);assert.equal(r.finished,true);assert.equal(r.nextGame,null);
    assert.equal(r.teams[currentScore.indexOf(4)].seriesWinProbability,1);
    assert.deepEqual(r.teams[currentScore.indexOf(4)].seriesWinConfidence95,[1,1]);
    assert.deepEqual(r.teams[1-currentScore.indexOf(4)].seriesWinConfidence95,[0,0]);
    assert.equal(r.outcomes.find(o=>o.count).count,2);
  }
  for(const currentScore of [[4,4],[-1,0],[5,0],[1.5,0],[0],null,{}]) {
    assert.throws(()=>evaluateSeries(league,{teamId:0,opponentId:1,series:1,currentScore}),/Series score/);
  }
});

test('series stop at four wins, account for every outcome, and reproduce by seed', () => {
  const options = { teamId: 29, opponentId: 8, series: 30, seed: 71 };
  const before = structuredClone(league);
  const result = evaluateSeries(league, options);
  assert.deepEqual(result, evaluateSeries(league, options));
  assert.deepEqual(league, before);
  assert.equal(result.teams.reduce((s,t) => s+t.seriesWins, 0), 30);
  assert.equal(result.outcomes.reduce((s,o) => s+o.count, 0), 30);
  assert.equal(result.simulatedGames, result.outcomes.reduce((s,o) => s+o.count*(4+o.loserWins), 0));
  assert.equal(result.simulatedGames, result.teams.reduce((s,t) => s+t.gameWins, 0));
  assert.deepEqual(result.homeSchedule, [29,29,8,8,29,8,29]);
  const score = { 29: 0, 8: 0 };
  for (const game of result.sampleSeries) {
    assert.ok(score[29] < 4 && score[8] < 4);
    assert.equal(game.home, result.homeSchedule[game.game-1]);
    score[game.winner]++;
  }
  assert.equal(Math.max(...Object.values(score)), 4);
  const reversed = evaluateSeries(league, { ...options, teamId: 8, opponentId: 29, homeCourt: 29 });
  assert.deepEqual(reversed.teams.toReversed(), result.teams);
  assert.deepEqual(reversed.sampleSeries, result.sampleSeries);
});

test('series reject invalid selections and budgets; home court and neutral venues are explicit', () => {
  const options = { teamId: 0, opponentId: 1, series: 1 };
  assert.throws(() => evaluateSeries(league, { ...options, opponentId: 0 }), /different/);
  assert.throws(() => evaluateSeries(league, { ...options, opponentId: 999 }), /Unknown/);
  assert.throws(() => evaluateSeries(league, { ...options, homeCourt: 2 }), /home-court/);
  assert.throws(() => evaluateSeries(league, { ...options, series: 0 }), /positive integer/);
  const neutral = { ...league, settings: { ...league.settings, neutralSite: 'playoffs' } };
  const r = evaluateSeries(neutral, { ...options, homeCourt: 1 });
  assert.equal(r.neutralSite, true);
  assert.deepEqual(r.homeSchedule, [1,1,0,0,1,0,1]);
  const finiteOT = { ...league, settings: { ...league.settings, maxOvertimesPlayoffs: 0 } };
  assert.throws(() => evaluateSeries(finiteOT, options), /unlimited/);
});

test('series probability intervals remain informative at zero and all wins', () => {
  const zero = wilsonInterval(0, 100), all = wilsonInterval(100, 100);
  assert.ok(zero[0] < 1e-10 && zero[1] > 0.03);
  assert.ok(all[0] < 0.97 && all[1] > 1-1e-10);
});

test('CLI exposes series mode, league selection and home court without changing normal evaluation', () => {
  const cwd = new URL('../', import.meta.url);
  const r = JSON.parse(execFileSync(process.execPath, ['src/cli.mjs', '--league', 'test/fixtures/league.json.gz', '--team-id', '29', '--opponent-id', '8', '--home-court', '8', '--series', '2', '--json'], { cwd, encoding: 'utf8' }));
  assert.equal(r.phase, 'playoffs');
  assert.equal(r.homeCourt, 8);
  assert.equal(r.series, 2);
  assert.equal(r.teams.length, 2);
  const bad = spawnSync(process.execPath, ['src/cli.mjs', '--league', 'test/fixtures/league.json.gz', '--team-id', '29', '--opponent-id', '8', '--games-per-opponent', '20'], { cwd, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Use --series/);
  const normal = JSON.parse(execFileSync(process.execPath, ['src/cli.mjs', '--league', 'test/fixtures/league.json.gz', '--team-id', '29', '--games-per-opponent', '4', '--json'], { cwd, encoding: 'utf8' }));
  assert.equal(normal.phase, 'regular');
  assert.equal(normal.teams[0].games, 116);
});
