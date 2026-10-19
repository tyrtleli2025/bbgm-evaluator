import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readLeague } from '../src/importer.mjs';
import { evaluateSeries, wilsonInterval } from '../src/series.mjs';

const league = readLeague(new URL('./fixtures/league.json.gz', import.meta.url));

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
