import test from 'node:test';
import assert from 'node:assert/strict';
import { actionKey } from '../generate.mjs';
import { reviewPlanner } from '../review.mjs';
function fixture(){
 const action={type:'trade',teams:[{tid:0,pids:[1],dpids:[]},{tid:1,pids:[2],dpids:[]}]};
 const next={type:'trade',teams:[{tid:0,pids:[2],dpids:[]},{tid:2,pids:[3],dpids:[]}]};
 const plans=[{id:'p1',name:'First',actions:[action]},{id:'p2',name:'Both',actions:[action,next]}];
 const details=[[{team:'Ours',players:[{pid:1,name:'A'}],picks:[]},{team:'Other',players:[{pid:2,name:'B'}],picks:[]}],[{team:'Ours',players:[{pid:2,name:'B'}],picks:[]},{team:'Third',players:[{pid:3,name:'C'}],picks:[]}]];
 const input={sha256:'same',teamId:0,teamName:'Test'},engine={revision:'pin',bundleSha256:'bundle'};
 const planner={input,engine,status:'generated',plans,candidates:plans.map((p,i)=>({key:actionKey(p.actions),screen:{current:60+i},details:details.slice(0,i+1)})),baselineScreen:{current:50}};
 const result=titles=>({titles,years:Array.from({length:8},()=>({}))});
 const comparison={input,engine,status:'complete',plans:[{id:'baseline',actions:[]},...plans],trials:[{results:{baseline:result(0),p1:result(1),p2:result(2)}}]};
 return {planner,comparison};
}
test('review reports net assets, paired second-trade effect, and uncertainty with one trial',()=>{
 const {planner,comparison}=fixture();const before=structuredClone(planner);
 const r=reviewPlanner(planner,comparison);
 assert.equal(r.completePairedTrials,1);assert.equal(r.reviews[1].expectedTitles,2);
 assert.equal(r.reviews[1].verdict,'inconclusive');
 assert.deepEqual(r.reviews[1].netAssets.map(p=>p.name),['A','C']);
 assert.equal(r.combinations[0].additionalTradeEffect.mean,1);
 assert.equal(r.reviews[1].screenDelta.current,11);
 assert.equal(r.reviews[0].deltaFromBaseline.confidence,.975);
 assert.deepEqual(planner,before);
 assert.match(r.diversity.warning,/same first trade/);
});
test('review excludes partial pairs, marks incomplete reports, and handles unsimulated plans',()=>{
 const {planner,comparison}=fixture();
 comparison.trials.push({results:{baseline:comparison.trials[0].results.baseline}});
 comparison.status='incomplete';
 const r=reviewPlanner(planner,comparison);
 assert.equal(r.completePairedTrials,1);
 assert.equal(r.reviews[0].verdict,'comparison incomplete');
 assert.equal(reviewPlanner(planner).reviews[0].verdict,'not simulated');
 assert.equal(reviewPlanner(planner).baselineExpectedTitles,null);
});
test('review rejects mismatched inputs, engine builds and reused plan IDs',()=>{
 for(const mutate of [c=>{c.input={...c.input,teamId:9};},c=>{c.input={...c.input,sha256:'wrong'};},c=>{c.engine={...c.engine,bundleSha256:'wrong'};},c=>{c.plans[1].actions=[];}]){
  const {planner,comparison}=fixture();const copy=structuredClone(comparison);mutate(copy);
  assert.throws(()=>reviewPlanner(planner,copy),/different|match/);
 }
});
