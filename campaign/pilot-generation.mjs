import { planTrades } from './planner.mjs';
import { runIsolated, trialSeed } from './compare.mjs';

// Verify each complete sequence on every requested seed before expensive rollouts.
export async function generatePilotPlans({ raw, teamId, seeds = [12345, 67890], count = 2,
  attempts = 32, signal, onProgress = () => {} }) {
  if (!Number.isInteger(count) || count < 1 || count > 10 || !seeds.length ||
      seeds.some(s => !Number.isInteger(s) || s < 0 || s > 0xffffffff) || new Set(seeds).size !== seeds.length) {
    throw new Error('Use 1–10 plans and distinct uint32 seeds');
  }
  const search = await planTrades({ raw, teamId, seed: trialSeed(seeds[0], 0),
    attempts, branches: 2, shortlist: Math.min(20, count * 3), depth: 2,
    generateOnly: true, signal, onProgress });
  if (search.status !== 'generated') throw new Error(search.error ?? `Search: ${search.status}`);
  const plans = [], checks = [];
  for (const plan of search.plans) {
    if (plans.length >= count) break;
    let valid = true;
    for (const baseSeed of seeds) {
      const seed = trialSeed(baseSeed, 0);
      onProgress({ kind: 'pilotPreflight', planId: plan.id, seed });
      try {
        await runIsolated({ raw, teamId, seed, plan, preflight: true }, { signal });
        checks.push({ planId: plan.id, seed, accepted: true });
      } catch (error) {
        if (signal?.aborted) throw error;
        checks.push({ planId: plan.id, seed, accepted: false, message: error.message });
        valid = false;
        break;
      }
    }
    if (valid) plans.push(plan);
  }
  return { search, plans, checks, requestedPlans: count, seeds,
    scope: 'Selected using roster heuristics and native acceptance only. No campaign outcomes or learned model used in selection.' };
}
