import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTradeComparisons } from '../trade-evaluation.mjs';
const row=(id,delta)=>({id,completePairs:2,requestedPairs:2,pairs:[1,2].map(seed=>({seed,baselineTitles:0,tradeTitles:delta,observedDelta:delta,predictedDelta:1,predictedTrade:1}))});
test('zero-title ties never become ranking evidence or zero-width intervals',()=>{
 const e=evaluateTradeComparisons([row('a',0),row('b',0)],true);
 assert.equal(e.baseline[0].directionalAgreement,null);
 assert.equal(e.baseline[0].verdict,'inconclusive');
 assert.deepEqual(e.baseline[0].observed.interval95,[-8,8]);
 assert.equal(e.betweenPlans[0].nonzeroObservedPairs,0);
 assert.equal(e.baseline[0].zeroChangeMAE,0);
});
test('plan comparisons pair by seed, and incomplete runs cannot establish effects',()=>{
 const a=row('a',2),b=row('b',1);b.pairs=b.pairs.slice(1);b.completePairs=1;
 const e=evaluateTradeComparisons([a,b],false);
 assert.equal(e.betweenPlans[0].completePairs,1);
 assert.equal(e.betweenPlans[0].observed.mean,1);
 assert.equal(e.baseline[0].verdict,'incomplete');
});
