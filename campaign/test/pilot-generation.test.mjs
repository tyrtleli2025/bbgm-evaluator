import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { generatePilotPlans } from '../pilot-generation.mjs';
import { compareCampaigns } from '../compare.mjs';
import { smallLeague } from './fixture.mjs';
let built = true;
try { await access(new URL('../../.campaign-build/manifest.json', import.meta.url)); } catch { built = false; }

test('generated pilot checks each seed and collects paired native trade outcomes', { skip: !built, timeout: 120000 }, async () => {
  const raw = smallLeague(), before = structuredClone(raw);
  const result = await generatePilotPlans({ raw, teamId: 0, count: 2, attempts: 8, seeds: [71, 72] });
  assert.ok(result.plans.length > 0);
  for (const plan of result.plans) assert.equal(result.checks.filter(c => c.planId === plan.id && c.accepted).length, 2);
  const campaign = await compareCampaigns({ raw, teamId: 0, plans: result.plans.slice(0, 1), seed: 71,
    trials: 1, collectTraining: true, stopOnFailure: true });
  assert.equal(campaign.status, 'complete');
  const runs = Object.values(campaign.trials[0].results);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].seed, runs[1].seed);
  assert.ok(runs.every(run => run.years.length === 8 && run.trainingFeatures.length === 4));
  assert.deepEqual(raw, before);
});

test('invalid seed sets and counts fail before searching', async () => {
  await assert.rejects(generatePilotPlans({ raw: {}, teamId: 0, seeds: [1, 1] }), /distinct/);
  await assert.rejects(generatePilotPlans({ raw: {}, teamId: 0, count: 0 }), /1–10/);
});
