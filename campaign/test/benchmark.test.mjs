import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkPredictors, evaluateFrozenPredictor } from '../benchmark.mjs';
import { trainRelative, predictLeague, relativeProfiles } from '../relative-predictor.mjs';
import { featureNames,featureVersion } from '../features.mjs';

const data=()=>['a','b','c'].flatMap(group=>Array.from({length:4},(_,i)=>({
  id:group+i,source:group,rollout:group,group,engine:'engine',featureVersion,outsideTitles:0,
  titles:i===3?8:0,features:featureNames.map((_,j)=>j===2?40+i*10:j===15?4:0),
})));
test('compact profiles fit only declared features and retain usable title predictions',()=>{
  const rows=data(),model=trainRelative(rows,{profile:'top5',holdoutGroups:['c']});
  assert.ok(model.weights[2]>0);
  assert.ok(model.weights.every((w,i)=>relativeProfiles.top5.includes(i)||w===0));
  const x=rows.filter(r=>r.group==='c').map(r=>r.features);
  const changed=x.map((f,j)=>f.map((v,i)=>i===2?v:v+100*j));
  assert.deepEqual(predictLeague(model,x),predictLeague(model,changed));
  assert.throws(()=>trainRelative(rows,{profile:'typo'}),/profile/);
});
test('frozen evaluation rejects development lineages and leaves the model unchanged',()=>{
 const rows=data(),{models}=benchmarkPredictors(rows),model=models[0].model,before=structuredClone(model);
 assert.throws(()=>evaluateFrozenPredictor(model,rows.filter(r=>r.group==='c')),/absent from training and development/);
 const fresh=rows.filter(r=>r.group==='c').map(r=>({...r,id:'new'+r.id,group:'fresh',source:'fresh',rollout:'fresh'}));
 const result=evaluateFrozenPredictor(model,fresh);
 assert.equal(result.mode,'frozen-evaluation');assert.equal(result.diagnostics.evaluation.rows,4);
 assert.deepEqual(model,before);
});
test('benchmark holds out entire lineages and does not train on their labels',()=>{
  const rows=data(),first=benchmarkPredictors(rows);
  const changed=rows.map(r=>r.group==='a'?{...r,titles:2}:r);
  const second=benchmarkPredictors(changed);
  for(const {file,model} of first.models.filter(x=>x.model.training.heldOutGroups.includes('a'))){
    const updated=second.models.find(x=>x.file===file).model;
    assert.deepEqual(model.weights,updated.weights);
    assert.deepEqual(model.scales,updated.scales);
    assert.equal(model.outsideTitles,updated.outsideTitles);
    assert.ok(!model.training.groups.includes('a'));
  }
  assert.equal(first.report.candidates.length,8);
  assert.equal(first.report.readyForRecommendations,false);
  for(const row of first.report.candidates)assert.equal(row.macroRMSE,row.folds.reduce((s,f)=>s+f.rmse,0)/3);
  assert.throws(()=>benchmarkPredictors(rows.filter(r=>r.group==='a')),/two independent/);
});
