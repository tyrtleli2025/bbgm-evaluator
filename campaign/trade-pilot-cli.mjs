import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareTradePilot, reviewTradePilot } from './trade-pilot.mjs';
import { saveJSON } from './batch-learning.mjs';
import { readLeague } from './input.mjs';
import { generatePilotPlans } from './pilot-generation.mjs';

async function main() {
  const { values: v } = parseArgs({ options: Object.fromEntries([
    ...['mode', 'league', 'team-id', 'group', 'plans', 'plan-ids', 'seeds', 'manifest', 'batch', 'model', 'out', 'reuse-batch', 'count', 'attempts'].map(key => [key, { type: 'string' }]),
    ['empty-released-players', { type: 'boolean' }], ['help', { type: 'boolean' }],
  ]) });
  if (v.help) {
    console.log(`npm run campaign:trade-pilot -- --mode prepare --league PATH --team-id ID --group LINEAGE --plans PLANS.json --out MANIFEST.json
npm run campaign:trade-pilot -- --mode generate --league PATH --team-id ID --group LINEAGE --out MANIFEST.json
npm run campaign:batch -- --mode run --manifest MANIFEST.json --out BATCH_DIR --budget 1
npm run campaign:trade-pilot -- --mode review --manifest MANIFEST.json --batch BATCH_DIR --out REVIEW.json
Prepare selects the first two trade plans by default. Use --plan-ids plan_2,plan_4 to choose others.
--seeds 12345,67890 requests two paired seeds; default is one. Every plan and the baseline costs one eight-season campaign per seed.
--reuse-batch OLD_BATCH_DIR imports exact matching completed campaigns into a new seed/plan batch.
Generate searches native trades and verifies complete sequences on every seed; no seasons simulated.
Generate defaults: --count 2 --attempts 32 --seeds 12345,67890. Saves search and plans alongside the manifest.
--model MODEL.json adds experimental predicted title changes to the review.
--empty-released-players requires a standard BBGM export with Players selected; see campaign:batch --help.`);
    return;
  }
  if (v.mode === 'generate') {
    if (!v.league || v['team-id'] === undefined || !v.group || !v.out) throw new Error('Need --league, --team-id, --group and --out');
    const plansFile = v.out.replace(/\.json$/, '') + '.plans.json';
    const searchFile = v.out.replace(/\.json$/, '') + '.search.json';
    if ([v.out, plansFile, searchFile].some(p => resolve(p) === resolve(v.league))) throw new Error('Output must differ from league input');
    const { raw } = await readLeague(v.league);
    if (v['empty-released-players'] && raw.releasedPlayers === undefined) raw.releasedPlayers = [];
    const seeds = (v.seeds ?? '12345,67890').split(',').map(Number);
    const controller = new AbortController(), cancel = () => controller.abort(new Error('Cancelled'));
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const generated = await generatePilotPlans({ raw, teamId: Number(v['team-id']), seeds, count: Number(v.count ?? 2),
        attempts: Number(v.attempts ?? 32), signal: controller.signal,
        onProgress: e => { if (e.kind === 'branch' || e.kind === 'pilotPreflight') console.error(e.text ?? `${e.planId}: check seed ${e.seed}`); } });
      await saveJSON(searchFile, generated);
      if (!generated.plans.length) throw new Error(`No plans passed all seeds. Details: ${searchFile}`);
      await saveJSON(plansFile, generated.plans);
      const manifest = await prepareTradePilot({ league: v.league, teamId: Number(v['team-id']), group: v.group,
        plansFile, planIds: generated.plans.map(p => p.id), seeds, emptyReleasedPlayers: !!v['empty-released-players'], reuseBatch: v['reuse-batch'] });
      manifest.pilot.generationReport = resolve(searchFile);
      await saveJSON(v.out, manifest);
      console.log(`Prepared ${generated.plans.length}/${generated.requestedPlans} plans verified on ${seeds.length} seeds. ${seeds.length * (generated.plans.length + 1)} total campaigns including baseline.`);
      console.log(`Manifest: ${resolve(v.out)}. No campaigns run.`);
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } else if (v.mode === 'prepare') {
    if (!v.out || !v.plans || !v.league || v['team-id'] === undefined || !v.group) throw new Error('Need --out, --plans, --league, --team-id and --group');
    if ([v.league, v.plans].some(path => resolve(path) === resolve(v.out))) throw new Error('Output must differ from inputs');
    const seeds = (v.seeds ?? '12345').split(',').map(Number);
    const manifest = await prepareTradePilot({ league: v.league, teamId: Number(v['team-id']), group: v.group,
      plansFile: v.plans, planIds: v['plan-ids']?.split(',').map(id => id.trim()), seeds, emptyReleasedPlayers: !!v['empty-released-players'], reuseBatch: v['reuse-batch'] });
    await saveJSON(v.out, manifest);
    console.log(`Prepared ${manifest.entries[0].plans.length} trade plans, ${seeds.length} paired seed(s), and automatic baseline.`);
    console.log(`Manifest: ${resolve(v.out)}. Review its lineage group and trades before running.`);
  } else if (v.mode === 'review') {
    if (!v.manifest || !v.batch || !v.out) throw new Error('Need --manifest, --batch and --out');
    if (resolve(v.out) === resolve(v.manifest) || resolve(v.out) === resolve(v.batch) || resolve(v.out).startsWith(resolve(v.batch) + '/')) throw new Error('Review output must not overwrite batch inputs');
    const json = async path => JSON.parse(await readFile(path, 'utf8'));
    const report = await reviewTradePilot({ manifest: await json(v.manifest), batchDir: v.batch, model: v.model ? await json(v.model) : undefined });
    await saveJSON(v.out, report);
    for (const row of report.comparisons) {
      console.log(`${row.id}: ${row.completePairs}/${row.requestedPairs} pairs; observed Δ ${row.meanObservedDelta?.toFixed(3) ?? '—'} titles` +
        (v.model ? `; predicted Δ ${row.meanPredictedDelta?.toFixed(3) ?? '—'} titles` : ''));
    }
    for (const row of report.evaluation.baseline) console.log(`${row.id}: ${row.verdict}; adjusted title Δ interval ${JSON.stringify(row.observed.interval95)}; ${row.nonzeroObservedPairs} nonzero observed pairs`);
    console.log(`${report.status}. Review: ${resolve(v.out)}. Small pilots are descriptive, not a validated trade ranking.`);
    if (report.batchStatus === 'failed') process.exitCode = 1;
  } else throw new Error('Choose --mode generate, prepare or review; see --help');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
