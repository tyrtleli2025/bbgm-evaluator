import { Worker } from 'node:worker_threads';
import { validateLeague, normalizePlans, sha256 } from './input.mjs';
import { verifyBuild } from './provenance.mjs';
import { summarize } from './report.mjs';

export const trialSeed = (seed, trial) => Number.parseInt(sha256(`${seed}:${trial}`).slice(0, 8), 16);

export function runIsolated(data, { signal, timeoutMs = 20 * 60_000, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Cancelled')); return; }
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: data, execArgv: [], stdout: true, stderr: true });
    let settled = false;
    let stderr = '';
    worker.stdout.on('data', () => {});
    worker.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => void finish(signal.reason ?? new Error('Cancelled'));
    const timer = setTimeout(() => void finish(new Error(`Campaign exceeded ${timeoutMs / 60000} minute limit`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', error => void finish(error));
    worker.on('exit', code => { if (!settled) void finish(new Error(`Campaign worker exited (${code}) without a result. ${stderr}`)); });
    worker.on('message', message => {
      if (message.type === 'progress') {
        try { onProgress(message.progress); } catch (error) { void finish(error); }
      } else if (message.type === 'result') void finish(null, message.result);
      else if (message.type === 'failure') void finish(new Error(message.message));
    });
  });
}

export async function compareCampaigns({ raw, inputHash, teamId, plans: inputPlans = [], trials: count = 10, seed = 12345,
  jobs = 1, seasons = 8, stopOnFailure = false, collectTraining = false, timeoutMs = 20 * 60_000, signal, onProgress = () => {}, onCheckpoint = async () => {} }) {
  for (const [name, value, min, max] of [['seasons', seasons, 1, 8], ['trials', count, 1, 10000], ['jobs', jobs, 1, 4], ['seed', seed, 0, 0xffffffff], ['timeoutMs', timeoutMs, 1, 86400000]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected integer ${min}–${max}`);
  }
  const input = validateLeague(raw, teamId);
  const plans = normalizePlans(inputPlans, teamId);
  const engine = await verifyBuild();
  const started = Date.now();
  const trials = Array.from({ length: count }, (_, index) => ({ index, seed: trialSeed(seed, index), results: {}, failures: {} }));
  const report = { formatVersion: 1, objective: seasons === 8 ? 'Expected championships over the next eight seasons' : `Preliminary ${seasons}-season comparison; not an eight-year estimate`, seasons,
    policy: 'Native BBGM auto-play AI for all teams after opening actions', engine, input: { ...input, sha256: inputHash ?? sha256(JSON.stringify(raw)) },
    seed, requestedTrials: count, plans, trials, status: 'running', completedTrials: 0, failedTrials: 0, summary: [],
    uncertainty: '95% pointwise conservative Hoeffding bounds over independent seeded campaigns; not engine/model uncertainty or simultaneous bounds across all plans.',
    seedPolicy: 'Each plan uses the same seed for a given trial. Changed states/actions can consume different random draws.',
  };
  const progress = (plan, trial) => detail => onProgress({ planId: plan.id, trial, ...detail });
  const refresh = () => {
    report.completedTrials = trials.filter(t => plans.every(p => t.results[p.id])).length;
    report.failedTrials = trials.filter(t => Object.keys(t.failures).length).length;
    report.summary = summarize(plans, trials, seasons);
    report.elapsedSeconds = (Date.now() - started) / 1000;
  };
  // Import and validate every opening sequence before spending time on full campaigns.
  report.preflight = [];
  for (const plan of plans) {
    onProgress({ kind: 'preflight', planId: plan.id });
    try {
      report.preflight.push(await runIsolated({ raw, teamId, plan, seed: trials[0].seed, preflight: true },
        { signal, timeoutMs, onProgress: progress(plan, null) }));
    } catch (error) {
      report.status = signal?.aborted ? 'cancelled' : 'invalid-plan';
      report.error = { planId: plan.id, message: error.message };
      refresh(); await onCheckpoint(report); return report;
    }
  }
  // Parallelize entire trials, keeping each plan in its own fresh JS/IndexedDB realm.
  let next = 0;
  let checkpointQueue = Promise.resolve();
  const internalAbort = new AbortController();
  const poolSignal = signal ? AbortSignal.any([signal, internalAbort.signal]) : internalAbort.signal;
  const tasks = Array.from({ length: Math.min(jobs, count) }, async () => {
    while (next < count && !poolSignal.aborted) {
      const trial = trials[next++];
      for (const plan of plans) {
        if (poolSignal.aborted) break;
        try {
          onProgress({ kind: 'campaign', planId: plan.id, trial: trial.index });
          trial.results[plan.id] = await runIsolated({ raw, teamId, plan, seed: trial.seed, seasons, collectTraining },
            { signal: poolSignal, timeoutMs, onProgress: progress(plan, trial.index) });
        } catch (error) {
          trial.failures[plan.id] = error.message;
          onProgress({ kind: 'failure', planId: plan.id, trial: trial.index, message: error.message });
          if (stopOnFailure) internalAbort.abort(error);
          break;
        }
        refresh();
        const snapshot = structuredClone(report);
        checkpointQueue = checkpointQueue.then(() => onCheckpoint(snapshot));
        await checkpointQueue;
      }
    }
  }).map(task => task.catch(error => { internalAbort.abort(error); throw error; }));
  const completed = await Promise.allSettled(tasks);
  const failure = completed.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  refresh();
  report.status = signal?.aborted ? 'cancelled' : report.failedTrials ? 'incomplete' : 'complete';
  if (report.failedTrials) report.warning = 'Some trials failed. Estimates use complete pairs only and may be biased if failures depend on outcomes. Resolve failures before choosing a plan.';
  await onCheckpoint(report);
  return report;
}
