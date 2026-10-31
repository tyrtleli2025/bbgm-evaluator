import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { openingOrder, pickFinalists } from '../stages.mjs';
import { actionKey } from '../generate.mjs';
import { planTrades } from '../planner.mjs';
import { compareCampaigns } from '../compare.mjs';
import { reviewPlanner } from '../review.mjs';
import { smallLeague } from './fixture.mjs';
let built=true;try{await access(new URL('../../.campaign-build/manifest.json',import.meta.url));}catch{built=false;}
const action=id=>({teams:[{tid:0,pids:[id],dpids:[]},{tid:1,pids:[],dpids:[]}]});
test('opening diversity covers different first trades and preserves a combination',()=>{
 const c=(ids,current)=>({key:String(ids),actions:ids.map(action),screen:{current,youth:current,assets:current,flexibility:current}});
 const ordered=openingOrder([c([1],90),c([1,2],99),c([3],20)]);
 assert.deepEqual(ordered.slice(0,2).map(c=>c.actions.map(a=>a.teams[0].pids[0])),[[1,2],[3]]);
});
test('finalists reserve a long-term option even with poor short performance',()=>{
 const plans=[1,2,3].map(id=>({id:String(id),actions:[action(id)]}));
 const candidates=plans.map((p,i)=>({key:actionKey(p.actions),screen:{youth:i*10,assets:0}}));
 assert.deepEqual(pickFinalists(plans,candidates,[{id:'1'},{id:'2'},{id:'3'}],2).map(p=>p.id),['1','3']);
});
test('default staged run stops after short seasons and respects a tight campaign budget', {skip:!built,timeout:90000},async()=>{
 const report=await planTrades({raw:smallLeague(),teamId:0,attempts:6,branches:2,shortlist:3,budget:2,deep:true,trials:1});
 assert.equal(report.status,'budget-limited',report.error);
 assert.equal(report.budget.used,2);
 assert.equal(report.shortComparison.seasons,1);
 assert.equal(report.shortComparison.plans.length,2);
 for(const t of report.shortComparison.trials)for(const r of Object.values(t.results))assert.equal(r.years.length,1);
 assert.equal(report.deepComparison,undefined);
 const review=reviewPlanner(report);assert.equal(review.seasons,1);assert.match(review.verdict,/Preliminary/);
});
test('two-season comparison labels the horizon and failures stop the staged pool', {skip:!built,timeout:90000},async()=>{
 const raw=smallLeague();
 const report=await compareCampaigns({raw,teamId:0,seasons:2,trials:1});
 assert.equal(report.status,'complete');assert.equal(report.summary[0].years.length,2);
 assert.match(report.objective,/Preliminary/);
 let campaigns=0;
 const failed=await compareCampaigns({raw,teamId:0,seasons:1,trials:5,stopOnFailure:true,onProgress:e=>{
   if(e.kind==='campaign')campaigns++;
   if(e.kind==='seasonComplete')throw new Error('Injected failure');
 }});
 assert.equal(failed.status,'incomplete');assert.equal(campaigns,1);
});
