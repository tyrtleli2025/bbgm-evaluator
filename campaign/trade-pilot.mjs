import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLeague, validateLeague, normalizePlans, sha256 } from './input.mjs';
import { trialSeed } from './compare.mjs';
import { actionKey } from './generate.mjs';
import { predictLeague, validateRelativeModel, relativeKind } from './relative-predictor.mjs';
import { evaluateTradeComparisons } from './trade-evaluation.mjs';

const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));

export async function prepareTradePilot({ league, teamId, group, plansFile, planIds, seeds = [12345], emptyReleasedPlayers = false, reuseBatch }) {
  if (!league || !plansFile || !group || !Number.isInteger(teamId) || !Array.isArray(seeds) || !seeds.length ||
      seeds.some(seed => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) || new Set(seeds).size !== seeds.length) {
    throw new Error('Need a full league, team ID, lineage group, plan file, and uint32 seeds');
  }
  const { raw } = await readLeague(league);
  const assumedEmpty = emptyReleasedPlayers && raw.releasedPlayers === undefined;
  if (assumedEmpty) raw.releasedPlayers = [];
  validateLeague(raw, teamId);
  const available = normalizePlans(await readJSON(plansFile), teamId).slice(1);
  if (!available.length) throw new Error('Plan file has no trade plans');
  const requested = planIds ?? available.slice(0, 2).map(plan => plan.id);
  if (!requested.length || new Set(requested).size !== requested.length || requested.some(id => !available.some(plan => plan.id === id))) {
    throw new Error('Select one or more distinct plan IDs from the plan file');
  }
  const plans = requested.map(id => available.find(plan => plan.id === id));
  if (plans.some(plan => !plan.actions.length) || new Set(plans.map(plan => actionKey(plan.actions))).size !== plans.length) {
    throw new Error('Trade plans must have distinct, nonempty actions');
  }
  const previous = reuseBatch ? await readJSON(resolve(reuseBatch, 'batch.json')) : null;
  if (previous && !Array.isArray(previous.completed)) throw new Error('Invalid reusable batch');
  return {
    formatVersion: 1,
    entries: [{ league: resolve(league), teamId, group, seeds, emptyReleasedPlayers: assumedEmpty, plans }],
    reuseReports: previous ? previous.completed.map(row => resolve(reuseBatch, 'runs', `${row.key}.json`)) : [],
    pilot: { plansFile: resolve(plansFile), objective: 'Matched-seed eight-season trade comparison',
      note: 'The baseline runs automatically. Related snapshots and plans must retain the same lineage group.' },
  };
}

const titles = (run, tid) => {
  if (!run || run.years?.length !== 8 || !run.trainingFeatures?.length) throw new Error('Saved campaign lacks eight seasons or starting-team features');
  return run.years.filter(year => year.championTid === tid).length;
};

const predict = (model, run, tid) => {
  if (!model) return null;
  const teams = run.trainingFeatures;
  const index = teams.findIndex(team => team.tid === tid);
  if (index < 0 || new Set(teams.map(team => team.tid)).size !== teams.length) throw new Error('Saved campaign has incomplete team features');
  return predictLeague(model, teams.map(team => team.features))[index];
};

export async function reviewTradePilot({ manifest, batchDir, model }) {
  if (manifest?.formatVersion !== 1 || manifest.entries?.length !== 1 || !manifest.pilot || !batchDir) {
    throw new Error('Review requires one prepared trade-pilot manifest and its batch output directory');
  }
  const entry = manifest.entries[0];
  const plans = normalizePlans(entry.plans, entry.teamId);
  const batch = await readJSON(resolve(batchDir, 'batch.json'));
  if (!batch.engine || !Array.isArray(batch.completed)) throw new Error('Invalid batch report');
  if (model) {
    if (model.kind !== relativeKind) throw new Error('Trade-pilot prediction requires a league-relative model');
    validateRelativeModel(model);
    if (model.engine !== `${batch.engine.revision}:${batch.engine.bundleSha256}`) throw new Error('Model and batch engine differ');
  }
  const { raw } = await readLeague(entry.league);
  if (entry.emptyReleasedPlayers && raw.releasedPlayers === undefined) raw.releasedPlayers = [];
  validateLeague(raw, entry.teamId);
  const source = sha256(JSON.stringify(raw));
  const seeds = entry.seeds.map(seed => trialSeed(seed, 0));
  const expected = new Map(plans.map(plan => [plan.id, actionKey(plan.actions)]));
  const runs = new Map();
  for (const completed of batch.completed) {
    const saved = await readJSON(resolve(batchDir, 'runs', `${completed.key}.json`));
    const plan = saved.plans?.[0], trial = saved.trials?.[0], run = trial?.results?.[plan?.id];
    if (saved.status !== 'complete' || saved.seasons !== 8 || saved.batchKey !== completed.key ||
        saved.engine?.revision !== batch.engine.revision || saved.engine?.bundleSha256 !== batch.engine.bundleSha256 ||
        saved.engine?.adapterSha256 !== batch.engine.adapterSha256 || saved.input?.sha256 !== source ||
        saved.input?.teamId !== entry.teamId || saved.trainingGroup !== entry.group ||
        !expected.has(plan?.id) || actionKey(plan.actions) !== expected.get(plan.id) ||
        !seeds.includes(trial?.seed) || run?.seed !== trial.seed) {
      throw new Error(`Saved campaign does not match this pilot: ${completed.key}`);
    }
    titles(run, entry.teamId);
    const key = `${trial.seed}:${plan.id}`;
    if (runs.has(key)) throw new Error(`Duplicate saved campaign: ${key}`);
    runs.set(key, run);
  }
  const comparisons = plans.slice(1).map(plan => {
    const pairs = [];
    for (const seed of seeds) {
      const baseline = runs.get(`${seed}:baseline`), trade = runs.get(`${seed}:${plan.id}`);
      if (!baseline || !trade) continue;
      const baselineTitles = titles(baseline, entry.teamId), tradeTitles = titles(trade, entry.teamId);
      const predictedBaseline = predict(model, baseline, entry.teamId), predictedTrade = predict(model, trade, entry.teamId);
      pairs.push({ seed, baselineTitles, tradeTitles, observedDelta: tradeTitles - baselineTitles,
        ...(model ? { predictedBaseline, predictedTrade, predictedDelta: predictedTrade - predictedBaseline } : {}) });
    }
    const mean = key => pairs.length ? pairs.reduce((sum, pair) => sum + pair[key], 0) / pairs.length : null;
    return { id: plan.id, name: plan.name, completePairs: pairs.length, requestedPairs: seeds.length,
      meanObservedDelta: mean('observedDelta'), ...(model ? { meanPredictedDelta: mean('predictedDelta') } : {}), pairs };
  });
  const incomplete = batch.status === 'failed' || batch.status === 'cancelled' || comparisons.some(row => row.completePairs < row.requestedPairs);
  return {
    status: incomplete ? 'incomplete' : 'complete', objective: 'Titles for the selected team over the next eight seasons',
    teamId: entry.teamId, group: entry.group, source, engine: batch.engine,
    batchStatus: batch.status, batchFailures: batch.failures, model: model ? {
      kind: model.kind, trainingGroups: model.training?.groups ?? [], heldOutGroups: model.training?.heldOutGroups ?? [],
      assessment: model.training?.groups?.includes(entry.group) ? 'in-sample development only' :
        model.training?.heldOutGroups?.includes(entry.group) ? 'held-out lineage, previously inspected if used during model design' : 'new lineage, outside recorded training groups',
    } : null,
    comparisons,
    evaluation: evaluateTradeComparisons(comparisons, !incomplete),
    note: 'Only complete baseline/trade pairs are compared. Each pair shares a seed, but changed actions consume random draws differently. Small pilots do not establish the best trade or validate the predictor.',
  };
}
