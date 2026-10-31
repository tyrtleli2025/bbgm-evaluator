import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { normalizePlans, validateLeague } from '../input.mjs';
import { estimate, summarize } from '../report.mjs';
import { runIsolated, compareCampaigns, trialSeed } from '../compare.mjs';
import { smallLeague } from './fixture.mjs';

test('validation rejects missing state, unavailable teams, incomplete schedules, and malformed plans', () => {
  const raw = smallLeague();
  assert.equal(validateLeague(raw, 0).firstSeason, 2006);
  assert.throws(() => validateLeague(raw, 29), /not an active team/);
  const missing = structuredClone(raw); delete missing.draftPicks;
  assert.throws(() => validateLeague(missing, 0), /draftPicks/);
  raw.gameAttributes.phase = 1;
  assert.throws(() => validateLeague(raw, 0), /schedule/);
  raw.gameAttributes.phase = 3;
  assert.throws(() => validateLeague(raw, 0), /bracket/);
  raw.gameAttributes.phase = 5;
  assert.equal(validateLeague(raw, 0).firstSeason, 2007);
  assert.throws(() => normalizePlans([{ id: 'baseline', actions: [] }], 0), /reserved/);
  assert.throws(() => normalizePlans([{ id: 'bad', actions: [{ type: 'trade', teams: [
    { tid: 0, pids: [1, 1] }, { tid: 1, pids: [2] },
  ] }] }], 0), /duplicate/);
  assert.throws(() => normalizePlans([{ id: 'bad', actions: [{ type: 'trade', teams: [
    { tid: 0, pids: [1] }, { tid: 1, pids: [1] },
  ] }] }], 0), /both sides/);
});

test('paired reporting excludes failures and keeps uncertainty at zero observed titles', () => {
  const plans = normalizePlans([{ id: 'trade', actions: [] }], 0);
  const run = (titles, season = 2006) => ({ titles, years: Array.from({ length: 8 }, (_, i) => ({ season: season + i, title: i < titles, won: 40 })) });
  const trials = [
    { results: { baseline: run(2), trade: run(4) } },
    { results: { baseline: run(0), trade: run(2) } },
    { results: { baseline: run(8) }, failures: { trade: 'timeout' } },
  ];
  const result = summarize(plans, trials);
  assert.equal(result[0].id, 'trade');
  assert.equal(result[0].expectedTitles.mean, 3);
  assert.equal(result[0].deltaFromBaseline.mean, 2);
  assert.equal(result[0].expectedTitles.n, 2);
  assert.equal(result[0].years.reduce((sum, y) => sum + y.titleProbability.mean, 0), 3);
  assert.ok(estimate(Array(100).fill(0), 0, 8).interval95[1] > 0);
  assert.deepEqual(estimate([], 0, 8).interval95, [0, 8]);
  assert.equal(trialSeed(123, 0), trialSeed(123, 0));
  assert.notEqual(trialSeed(123, 0), trialSeed(123, 1));
});

let built = true;
try { await access(new URL('../../.campaign-build/manifest.json', import.meta.url)); } catch { built = false; }

test('eight actual engine seasons reproduce across isolated workers, with evolving rosters', { skip: !built, timeout: 180000 }, async () => {
  const raw = smallLeague();
  const before = structuredClone(raw);
  const plan = { id: 'baseline', actions: [] };
  const data = { raw, teamId: 0, plan, seed: 71 };
  const [a, b] = await Promise.all([runIsolated(data), runIsolated(data)]);
  assert.deepEqual(a, b);
  assert.deepEqual(raw, before);
  assert.deepEqual(a.years.map(y => y.season), [2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013]);
  assert.equal(a.titles, a.years.filter(y => y.championTid === 0).length);
  for (const year of a.years) {
    assert.ok(year.championTid >= 0 && year.championTid < 4);
    assert.equal(year.won + year.lost, 6);
  }
  assert.ok(a.years.at(-1).league.developedPlayers > 0);
  assert.ok(a.years.at(-1).league.movedPlayers > 0);
  assert.ok(a.years.some(y => (y.league.transactions.draft ?? 0) > 0));
});

test('trade sequence uses native acceptance, moves picks, and rejects stale ownership and cooldowns', { skip: !built, timeout: 60000 }, async () => {
  const raw = smallLeague();
  const gift = dpid => ({ type: 'trade', teams: [{ tid: 0, pids: [], dpids: [dpid] }, { tid: 1, pids: [], dpids: [] }] });
  const plan = { id: 'two_moves', actions: [gift(0), gift(4)] };
  const data = { raw, teamId: 0, plan, seed: 1, preflight: true };
  const result = await runIsolated(data);
  assert.equal(result.actions.length, 2);
  await assert.rejects(runIsolated({ ...data, plan: { ...plan, actions: [gift(0), gift(0)] } }), /not owned/);
  const refused = { id: 'steal', actions: [{ type: 'trade', teams: [{ tid: 0, pids: [], dpids: [] }, { tid: 1, pids: [10], dpids: [1] }] }] };
  await assert.rejects(runIsolated({ ...data, plan: refused }), /rejected/i);
  raw.players[0].gamesUntilTradable = 10;
  const cooldown = { id: 'cooldown', actions: [{ type: 'trade', teams: [{ tid: 0, pids: [0], dpids: [] }, { tid: 1, pids: [], dpids: [] }] }] };
  await assert.rejects(runIsolated({ ...data, plan: cooldown }), /recently-acquired/);
});

test('timeouts and cancellation terminate workers instead of leaving database timers running', { skip: !built, timeout: 15000 }, async () => {
  const data = { raw: smallLeague(), teamId: 0, plan: { id: 'baseline', actions: [] }, seed: 1 };
  await assert.rejects(runIsolated(data, { timeoutMs: 1 }), /limit/);
  const controller = new AbortController();
  const pending = runIsolated(data, { signal: controller.signal });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(pending, /test cancellation/);
});

test('comparison rejects an illegal opening plan before simulating and preserves a reviewable report', { skip: !built, timeout: 30000 }, async () => {
  const raw = smallLeague();
  const report = await compareCampaigns({ raw, teamId: 0, trials: 1,
    plans: [{ id: 'invalid', actions: [{ type: 'trade', teams: [{ tid: 0, pids: [999999] }, { tid: 1 }] }] }] });
  assert.equal(report.status, 'invalid-plan');
  assert.equal(report.completedTrials, 0);
  assert.match(report.error.message, /not owned/);
});

test('parallel comparisons pair seeds, preserve no-op controls, and complete multi-asset trade campaigns', { skip: !built, timeout: 180000 }, async () => {
  const raw = smallLeague();
  const before = structuredClone(raw);
  const plans = [
    { id: 'control', actions: [] },
    { id: 'package', actions: [{ type: 'trade', teams: [
      { tid: 0, pids: [0, 1, 2], dpids: [0, 4] }, { tid: 1 },
    ] }] },
  ];
  let checkpoint;
  const report = await compareCampaigns({ raw, teamId: 0, trials: 2, seed: 91, jobs: 2, plans,
    onCheckpoint: async r => { checkpoint = JSON.parse(JSON.stringify(r)); } });
  assert.deepEqual(raw, before);
  assert.equal(report.status, 'complete');
  assert.equal(report.completedTrials, 2);
  assert.equal(report.failedTrials, 0);
  assert.equal(checkpoint.status, 'complete');
  for (const trial of report.trials) {
    assert.equal(trial.results.baseline.seed, trial.results.package.seed);
    assert.deepEqual(trial.results.baseline.years, trial.results.control.years);
    assert.equal(trial.results.package.actions.length, 1);
    assert.equal(trial.results.package.years.length, 8);
  }
  assert.equal(report.summary.find(r => r.id === 'control').deltaFromBaseline.mean, 0);
});

test('failed campaigns are marked incomplete, and mid-run cancellation saves a cancelled report', { skip: !built, timeout: 30000 }, async () => {
  const raw = smallLeague();
  const report = await compareCampaigns({ raw, teamId: 0, trials: 1, onProgress(event) {
    if (event.kind === 'seasonComplete') throw new Error('Injected observer failure');
  } });
  assert.equal(report.status, 'incomplete');
  assert.equal(report.failedTrials, 1);
  assert.equal(report.completedTrials, 0);
  assert.equal(report.summary[0].expectedTitles.mean, null);
  const controller = new AbortController();
  const cancelled = await compareCampaigns({ raw, teamId: 0, trials: 1, signal: controller.signal, onProgress(event) {
    if (event.kind === 'campaign') controller.abort(new Error('Cancel campaign'));
  } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.completedTrials, 0);
});
