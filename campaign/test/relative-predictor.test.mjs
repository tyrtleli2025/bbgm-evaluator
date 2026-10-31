import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { featureNames,featureVersion } from '../features.mjs';
import { trainRelative,predictLeague } from '../relative-predictor.mjs';
import { planTrades } from '../planner.mjs';
import { smallLeague } from './fixture.mjs';
import { verifyBuild } from '../provenance.mjs';
import { mergeRows } from '../learning.mjs';
const data=()=>['a','b','c'].flatMap((group,g)=>Array.from({length:4},(_,i)=>({id:`${group}${i}`,source:group,group,engine:'engine',featureVersion,titles:i===3?8:0,features:featureNames.map((_,j)=>j===0?40+i*10+g*20:j===15?4:0)})));
test('relative predictions conserve eight titles and ignore uniform league shifts',()=>{
 const rows=data(),m=trainRelative(rows,{holdoutGroups:['c']});
 const x=rows.filter(r=>r.group==='c').map(r=>r.features),p=predictLeague(m,x);
 assert.ok(Math.abs(p.reduce((s,x)=>s+x,0)-8)<1e-12);
 assert.ok(p.every(v=>v>=0&&v<=8));assert.ok(p[3]>p[0]);
 const shifted=x.map(f=>f.map((v,i)=>v+([0,14,18].includes(i)?100:0)));
 assert.deepEqual(p,predictLeague(m,shifted));
 assert.deepEqual(predictLeague(m,[x[0],x[0],x[0],x[0]]),[2,2,2,2]);
 assert.throws(()=>predictLeague(m,[x[0]]),/context/);
});
test('holdout labels cannot change learned weights or scaling',()=>{
 const a=data(),b=data().map(r=>r.group==='c'?{...r,titles:2}:r);
 const m=trainRelative(a,{holdoutGroups:['c']}),n=trainRelative(b,{holdoutGroups:['c']});
 assert.deepEqual(m.weights,n.weights);assert.deepEqual(m.scales,n.scales);
 assert.notEqual(m.evaluation.mae,n.evaluation.mae);
});
test('expansion allocation uses training rollouts only and preserves legacy prediction behavior',()=>{
 const rows=data().map(r=>({...r,outsideTitles:r.group==='a'?2:0,titles:r.group==='a'&&r.titles===8?6:r.titles}));
 const model=trainRelative(rows,{holdoutGroups:['c']});
 assert.equal(model.outsideTitles,1);
 const context=rows.filter(r=>r.group==='c').map(r=>r.features);
 assert.ok(Math.abs(predictLeague(model,context).reduce((s,x)=>s+x,0)+model.outsideTitles-8)<1e-12);
 const changed=rows.map(r=>r.group==='c'?{...r,outsideTitles:8,titles:0}:r);
 const second=trainRelative(changed,{holdoutGroups:['c']});
 assert.equal(second.outsideTitles,model.outsideTitles);assert.deepEqual(second.weights,model.weights);
 const legacy={...model};delete legacy.outsideTitles;
 assert.ok(Math.abs(predictLeague(legacy,context).reduce((s,x)=>s+x,0)-8)<1e-12);
 assert.throws(()=>trainRelative(rows.map(r=>({...r,outsideTitles:0})),{holdoutGroups:['c']}),/eight allocated/);
});
test('reject incomplete contexts, ambiguous repeated legacy trials and missing titles',()=>{
 assert.throws(()=>trainRelative(data().slice(1),{holdoutGroups:['c']}),/complete league/);
 const repeated=[...data(),...data().filter(r=>r.group==='a').map(r=>({...r,id:r.id+'repeat'}))];
 assert.throws(()=>trainRelative(repeated,{holdoutGroups:['c']}),/complete league/);
 assert.throws(()=>trainRelative(data().map(r=>({...r,titles:0})),{holdoutGroups:['c']}),/eight allocated/);
});
test('re-ingestion enriches legacy rows without accepting conflicting rollouts',()=>{
 const old=data()[0],updated={...old,rollout:'run1'};
 assert.deepEqual(mergeRows([old],[updated]),[updated]);
 assert.throws(()=>mergeRows([updated],[{...updated,rollout:'run2'}]),/Conflicting/);
});
let built=true;try{await access(new URL('../../.campaign-build/manifest.json',import.meta.url));}catch{built=false;}
test('relative model screens native trades with changed opponent rosters', {skip:!built,timeout:60000},async()=>{
 const m=trainRelative(data(),{holdoutGroups:['c']});const e=await verifyBuild();m.engine=`${e.revision}:${e.bundleSha256}`;
 const r=await planTrades({raw:smallLeague(),teamId:0,attempts:4,branches:1,shortlist:2,generateOnly:true,model:m});
 assert.equal(r.status,'generated',r.error);
 assert.ok(r.candidates.every(c=>c.predictedTitles>=0&&c.predictedTitles<=8));
});
