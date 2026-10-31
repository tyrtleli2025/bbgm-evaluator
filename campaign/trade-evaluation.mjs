import { estimate } from './report.mjs';

export function evaluateTradeComparisons(comparisons, complete) {
  const tests = Math.max(1, comparisons.length + comparisons.length * (comparisons.length - 1) / 2);
  const summarize = (pairs, eligible) => {
    const observed = estimate(pairs.map(p => p.observedDelta), -8, 8, .05 / tests);
    const informative = pairs.filter(p => p.observedDelta !== 0);
    const predicted = pairs.filter(p => Number.isFinite(p.predictedDelta));
    return { observed, verdict: !eligible ? 'incomplete' : observed.interval95[0] > 0 ? 'positive effect established' :
      observed.interval95[1] < 0 ? 'negative effect established' : 'inconclusive',
      nonzeroObservedPairs: informative.length,
      predictionMAE: predicted.length ? predicted.reduce((s,p) => s + Math.abs(p.predictedDelta-p.observedDelta),0)/predicted.length : null,
      zeroChangeMAE: predicted.length ? predicted.reduce((s,p) => s + Math.abs(p.observedDelta),0)/predicted.length : null,
      directionalAgreement: informative.length && informative.every(p => Number.isFinite(p.predictedDelta)) ?
        informative.reduce((s,p) => s + (Math.abs(p.predictedDelta)<1e-12 ? .5 : Math.sign(p.predictedDelta)===Math.sign(p.observedDelta) ? 1 : 0),0)/informative.length : null };
  };
  const baseline = comparisons.map(row => ({ id: row.id, ...summarize(row.pairs, complete && row.completePairs === row.requestedPairs) }));
  const betweenPlans = [];
  for (let i=0;i<comparisons.length;i++) for(let j=i+1;j<comparisons.length;j++) {
    const a=comparisons[i],b=comparisons[j],bySeed=new Map(b.pairs.map(p=>[p.seed,p]));
    const pairs=a.pairs.filter(p=>bySeed.has(p.seed)).map(p=>({seed:p.seed,observedDelta:p.tradeTitles-bySeed.get(p.seed).tradeTitles,
      predictedDelta:Number.isFinite(p.predictedTrade)&&Number.isFinite(bySeed.get(p.seed).predictedTrade)?p.predictedTrade-bySeed.get(p.seed).predictedTrade:undefined}));
    betweenPlans.push({first:a.id,second:b.id,completePairs:pairs.length,
      ...summarize(pairs,complete && pairs.length===a.requestedPairs && pairs.length===b.requestedPairs)});
  }
  return {baseline,betweenPlans,confidence:'95% simultaneous conservative Hoeffding intervals within this review, adjusted across baseline and plan comparisons.',
    scope:'Descriptive prediction errors against noisy observed outcomes. Shared seeds and plans are correlated; team rows are not independent trials. Zero observed differences provide no directional ranking evidence. No model validation verdict is inferred.'};
}
