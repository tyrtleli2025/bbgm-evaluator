import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smallLeague } from './fixture.mjs';
import { prepareTradePilot, reviewTradePilot } from '../trade-pilot.mjs';
import { collectBatch } from '../batch-learning.mjs';
import { featureNames, featureVersion } from '../features.mjs';
import { relativeKind } from '../relative-predictor.mjs';

const gift = dpid => ({ type: 'trade', teams: [{ tid: 0, pids: [], dpids: [dpid] }, { tid: 1, pids: [], dpids: [] }] });
let built = true;
try { await access(new URL('../../.campaign-build/manifest.json', import.meta.url)); } catch { built = false; }

test('pilot prepares distinct selected trades and validates its lineage input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbgm-pilot-prep-'));
  try {
    const league = join(dir, 'league.json'), plansFile = join(dir, 'plans.json');
    await writeFile(league, JSON.stringify(smallLeague()));
    await writeFile(plansFile, JSON.stringify([{ id: 'first', actions: [gift(0)] }, { id: 'second', actions: [gift(4)] }]));
    const manifest = await prepareTradePilot({ league, plansFile, teamId: 0, group: 'lineage1', planIds: ['second'], seeds: [7] });
    assert.deepEqual(manifest.entries[0].plans.map(plan => plan.id), ['second']);
    assert.equal(manifest.entries[0].group, 'lineage1');
    await assert.rejects(prepareTradePilot({ league, plansFile, teamId: 0, group: 'lineage1', planIds: ['missing'] }), /Select one/);
    await assert.rejects(prepareTradePilot({ league, plansFile, teamId: 0, group: 'lineage1', seeds: [7], planIds: ['first', 'first'] }), /distinct/);
    await assert.rejects(prepareTradePilot({ league, plansFile, teamId: 0, group: 'lineage1', seeds: [7, 7] }), /uint32 seeds/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pilot reviews only matched complete baseline/trade campaigns and predictor changes', { skip: !built, timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbgm-pilot-run-'));
  try {
    const league = join(dir, 'league.json'), plansFile = join(dir, 'plans.json'), batchDir = join(dir, 'batch');
    await writeFile(league, JSON.stringify(smallLeague()));
    await writeFile(plansFile, JSON.stringify([{ id: 'give_pick', actions: [gift(0)] }]));
    const manifest = await prepareTradePilot({ league, plansFile, teamId: 0, group: 'lineage1', seeds: [7] });
    const partial = await collectBatch(manifest, { out: batchDir, budget: 1 });
    assert.equal(partial.status, 'budget-limited');
    const firstReview = await reviewTradePilot({ manifest, batchDir });
    assert.equal(firstReview.status, 'incomplete');
    assert.equal(firstReview.comparisons[0].completePairs, 0);
    const finished = await collectBatch(manifest, { out: batchDir, budget: 1 });
    assert.equal(finished.status, 'complete');
    assert.equal(finished.reused, 1);
    const model = { kind: relativeKind, featureVersion, featureNames, indices: Array.from({ length: 13 }, (_, i) => i),
      scales: Array(13).fill(1), weights: Array(13).fill(0),
      engine: `${finished.engine.revision}:${finished.engine.bundleSha256}`, training: { groups: ['lineage1'], heldOutGroups: [] } };
    const reviewed = await reviewTradePilot({ manifest, batchDir, model });
    const pair = reviewed.comparisons[0].pairs[0];
    assert.equal(reviewed.status, 'complete');
    assert.equal(reviewed.model.assessment, 'in-sample development only');
    assert.equal(reviewed.comparisons[0].completePairs, 1);
    assert.equal(pair.observedDelta, pair.tradeTitles - pair.baselineTitles);
    assert.equal(pair.predictedDelta, 0);
    const reused = await prepareTradePilot({ league, plansFile, teamId: 0, group: 'lineage1', seeds: [7], reuseBatch: batchDir });
    assert.equal(reused.reuseReports.length, 2);
    const reusedBatch = join(dir, 'reused-batch');
    assert.equal((await collectBatch(reused, { out: reusedBatch, budget: 0 })).status, 'complete');
    assert.equal((await reviewTradePilot({ manifest: reused, batchDir: reusedBatch })).status, 'complete');
    await writeFile(league, JSON.stringify({ ...smallLeague(), extra: 1 }));
    await assert.rejects(reviewTradePilot({ manifest, batchDir }), /does not match/);
    const saved = JSON.parse(await readFile(join(batchDir, 'batch.json'), 'utf8'));
    assert.equal(saved.completed.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
