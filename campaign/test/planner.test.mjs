import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { diverse, actionKey } from '../generate.mjs';
import { planTrades } from '../planner.mjs';
import { smallLeague } from './fixture.mjs';
let built=true;try{await access(new URL('../../.campaign-build/manifest.json',import.meta.url));}catch{built=false;}

test('screening preserves different objectives including an immediately weaker move',()=>{
  const candidates=[
    {key:'win',screen:{current:90,youth:1,assets:1,flexibility:1}},
    {key:'young',screen:{current:30,youth:90,assets:1,flexibility:1}},
    {key:'assets',screen:{current:50,youth:1,assets:90,flexibility:1}},
    {key:'cap',screen:{current:40,youth:1,assets:1,flexibility:90}},
  ];
  assert.deepEqual(diverse(candidates,4).map(c=>c.key),['win','young','assets','cap']);
  assert.equal(candidates.length,4);
  const action=pids=>[{teams:[{tid:0,pids,dpids:[4]},{tid:1,pids:[7],dpids:[]}]}];
  assert.equal(actionKey(action([1,2])),actionKey(action([2,1])));
});

test('planner generates reproducible native-accepted multi-asset sequences and compares eight seasons', {skip:!built,timeout:180000},async()=>{
  const raw=smallLeague(), before=structuredClone(raw);
  const settings={raw,teamId:0,attempts:8,branches:2,shortlist:2,trials:1,deep:true};
  let saved;
  const a=await planTrades({...settings,onCheckpoint:r=>{saved=r;}});
  assert.equal(a.status,'complete',a.error);
  assert.equal(a.plans.length,2);
  assert.ok(a.plans.some(p=>p.actions.length===2));
  assert.ok(a.plans.some(p=>p.actions.some(t=>t.teams.some(s=>s.pids.length+s.dpids.length>1))));
  assert.equal(a.comparison.completedTrials,1);
  assert.equal(a.comparison.plans[0].id,'baseline');
  for(const result of Object.values(a.comparison.trials[0].results))assert.equal(result.years.length,8);
  assert.equal(saved.status,'complete');
  assert.deepEqual(raw,before);
  const b=await planTrades({...settings,generateOnly:true});
  assert.equal(b.status,'generated');
  assert.deepEqual(a.plans,b.plans);
});

test('planner reports unavailable trading and cancellation without starting comparisons', {skip:!built,timeout:30000},async()=>{
  const raw=smallLeague();raw.gameAttributes.challengeNoTrades=true;
  const failed=await planTrades({raw,teamId:0,generateOnly:true});
  assert.equal(failed.status,'error');assert.match(failed.error,/unavailable/);
  assert.equal(failed.comparison,undefined);
  const controller=new AbortController();controller.abort(new Error('Stopped'));
  const cancelled=await planTrades({raw:smallLeague(),teamId:0,signal:controller.signal});
  assert.equal(cancelled.status,'cancelled');
  assert.equal(cancelled.comparison,undefined);
});
