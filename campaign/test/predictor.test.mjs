import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { featureNames,featureVersion,teamFeatures } from '../features.mjs';
import { predict,trainPredictor,diagnosePredictor } from '../predictor.mjs';
import { trainingRows,mergeRows } from '../learning.mjs';
import { compareCampaigns } from '../compare.mjs';
import { planTrades } from '../planner.mjs';
import { smallLeague } from './fixture.mjs';
const rows=()=>Array.from({length:60},(_,i)=>({id:String(i),source:String(i),group:`group${i%3}`,engine:'test',featureVersion,features:featureNames.map((_,j)=>j===0?(i%9)*10:0),titles:i%9}));
test('ridge predicts a known relationship on unseen groups and serializes without changes',()=>{
 const r=rows(),m=trainPredictor(r,{holdoutGroups:['group2'],lambda:.1});
 assert.ok(m.evaluation.mae<m.evaluation.constantMAE);
 assert.deepEqual(m.training.groups,['group0','group1']);
 assert.equal(m.training.rows,40);assert.equal(m.evaluation.rows,20);
 assert.equal(predict(m,r[0].features),predict(JSON.parse(JSON.stringify(m)),r[0].features));
 assert.ok(r.every(r=>predict(m,r.features)>=0&&predict(m,r.features)<=8));
 assert.throws(()=>predict(m,[NaN]),/features/);
});
test('training rejects duplicate data, mixed builds, and invalid grouped splits',()=>{
 assert.throws(()=>trainPredictor([...rows(),rows()[0]]),/Duplicate/);
 const r=rows();r[0].engine='other';assert.throws(()=>trainPredictor(r),/engine/);
 assert.throws(()=>trainPredictor(rows().map(r=>({...r,group:'same'}))),/two independent/);
 const leak=rows();leak[0].source=leak[1].source;assert.throws(()=>trainPredictor(leak),/holdout groups/);
});
test('features ignore identity and future histories but respond to roster changes',()=>{
 const raw=smallLeague(),ga=raw.gameAttributes;
 const x=teamFeatures(raw.players,raw.draftPicks,0,ga,raw.teams);
 const copy=structuredClone(raw);copy.players.forEach(p=>{p.firstName='unused';p.pid+=999;p.stats=[{pts:10000}];p.ratings[0].pot=100;});
 assert.deepEqual(x,teamFeatures(copy.players,copy.draftPicks,0,ga,copy.teams));
 copy.players.find(p=>p.tid===0).tid=1;
 assert.notDeepEqual(x,teamFeatures(copy.players,copy.draftPicks,0,ga,copy.teams));
});
let built=true;try{await access(new URL('../../.campaign-build/manifest.json',import.meta.url));}catch{built=false;}
test('native eight-year collection yields all-team labels and learned screening integrates', {skip:!built,timeout:120000},async()=>{
 const report=await compareCampaigns({raw:smallLeague(),teamId:0,trials:1,collectTraining:true});
 assert.equal(report.status,'complete');
 const data=trainingRows(report,'fixture');assert.equal(data.length,4);
 assert.equal(data.reduce((s,r)=>s+r.titles,0),8);
 assert.equal(mergeRows(data,data).length,4);
 assert.throws(()=>trainingRows({...report,seasons:1},'fixture'),/eight-season/);
 const model=trainPredictor(rows(),{holdoutGroups:['group2']});
 model.engine=data[0].engine;
 const planned=await planTrades({raw:smallLeague(),teamId:0,attempts:4,branches:1,shortlist:2,generateOnly:true,model});
 assert.equal(planned.status,'generated',planned.error);
 assert.ok(planned.candidates.every(c=>Number.isFinite(c.predictedTitles)));
 assert.equal(planned.predictor.experimental,true);
 assert.throws(()=>mergeRows(data,[{...data[0],titles:9}]),/Conflicting/);
});

test('constant fractional features cannot create extrapolation from rounding noise',()=>{
 const data=rows();
 const i=featureNames.indexOf('threePointFactor');
 for(const r of data)r.features[i]=r.group==='group2'?.31:.435;
 const m=trainPredictor(data,{holdoutGroups:['group2']});
 assert.equal(m.active[i],false);assert.equal(m.scales[i],1);assert.equal(m.weights[i],0);
 const a=[...data[2].features],b=[...a];b[i]=999;
 assert.equal(predict(m,a),predict(m,b));
 const changed=data.map(r=>r.group==='group2'?{...r,titles:8-r.titles}:r);
 const other=trainPredictor(changed,{holdoutGroups:['group2']});
 assert.deepEqual(m.weights,other.weights);
 assert.deepEqual(m.means,other.means);
});

test('diagnostics expose clipped constant predictions and compare zero/ranking baselines',()=>{
 const data=rows().map(r=>({...r,source:r.group}));
 const model=trainPredictor(data,{holdoutGroups:['group2']});
 model.weights=model.weights.map(()=>0);model.intercept=-2;
 const {evaluation,warnings}=diagnosePredictor(model,data);
 assert.deepEqual(evaluation.predictionRange,[0,0]);
 assert.equal(evaluation.clippedLow,evaluation.rows);
 assert.equal(evaluation.mae,evaluation.zeroMAE);
 assert.equal(evaluation.ranking.value,.5);
 assert.ok(warnings.some(w=>w.includes('cannot rank')));
});
