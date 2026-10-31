import { recommendTrades } from './advisor.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { evaluate } from './evaluator.mjs';
import { optimizeRotation } from './rotation.mjs';
import { rankProposals } from './proposals.mjs';
import { searchTrades } from './search.mjs';
import { previewTrade } from './trade-preview.mjs';
import { makeTradeWork } from './negotiation.mjs';
import { evaluateSeries } from './series.mjs';

import { evaluateDraft } from './draft.mjs';

const { league, bundle, type, options, baselineCache } = workerData;
const started = performance.now();
const onProgress = progress => parentPort.postMessage({ type: 'progress', progress });
try {
  let result;
  if (type === 'evaluate') {
    const total = (league.teams.size - 1) * options.gamesPerOpponent;
    result = evaluate(league, { ...options, onProgress: p => onProgress({
      ...p, stage: 'Simulating current team', completed: p.simulatedGames, total,
    }) });
  } else if (type === 'rotation') {
    result = optimizeRotation(league,{...options,onProgress});
  } else if (type === 'advisor') {
    result = await recommendTrades(league,{...options,onProgress});
  } else if (type === 'draft') {
    result = evaluateDraft(league,{...options,onProgress});
  } else if (type === 'series') {
    result = evaluateSeries(league, { ...options, onProgress: p => onProgress({
      ...p, stage: 'Simulating playoff series', completed: p.completedSeries, total: options.series,
    }) });
  } else if (type === 'trade') {
    result = previewTrade(league, options.scenario, { ...options, baselineCache, onProgress,
      onBaseline: cache => parentPort.postMessage({type:'baseline',cache}) });
  } else if (type === 'make-work') {
    result = await makeTradeWork(league, options.scenario, { ...options, onProgress });
  } else if (type === 'search') {
    result = searchTrades(league, { ...options, onProgress });
  } else if (type === 'proposals') {
    result = rankProposals(league, bundle, { ...options,
      onProgress: p => onProgress({ stage: 'Simulating proposals', message: `${p.simulatedGames} games in this comparison` }),
      onProposal: p => onProgress({ ...p, stage: 'Ranking proposals', message: `${p.completed} of ${p.total} proposals simulated` }),
    });
  } else throw new Error('Unknown job type');
  result.elapsedSeconds = (performance.now() - started) / 1000;
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
}
