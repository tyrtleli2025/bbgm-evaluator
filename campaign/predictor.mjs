import { featureNames,featureVersion } from './features.mjs';
// Standardized ridge regression: transparent small-data baseline. Fits expected
// title counts directly, with bounded predictions. No neural-network dependency.
export function predictRaw(model,features){
  if(model.featureVersion!==featureVersion || JSON.stringify(model.featureNames)!==JSON.stringify(featureNames) || features.length!==featureNames.length || features.some(x=>!Number.isFinite(x)))throw new Error('Incompatible predictor features');
  const value=model.intercept+features.reduce((s,x,i)=>s+model.weights[i]*(x-model.means[i])/model.scales[i],0);
  if(!Number.isFinite(value))throw new Error('Invalid predictor coefficients');
  return value;
}
export function predict(model,features){return Math.max(0,Math.min(8,predictRaw(model,features)));}
function fit(rows,lambda){
 const n=featureNames.length, means=Array.from({length:n},(_,i)=>rows.reduce((s,r)=>s+r.features[i],0)/rows.length);
 // Constant or numerically constant features cannot teach a coefficient.
 // max-min avoids interpreting mean-rounding noise as training variation.
 const active=means.map((m,i)=>Math.max(...rows.map(r=>r.features[i]))-Math.min(...rows.map(r=>r.features[i]))>1e-12*Math.max(1,Math.abs(m)));
 const scales=means.map((m,i)=>active[i]?Math.sqrt(rows.reduce((s,r)=>s+(r.features[i]-m)**2,0)/rows.length):1);
 const intercept=rows.reduce((s,r)=>s+r.titles,0)/rows.length;
 const a=Array.from({length:n},(_,i)=>Array.from({length:n+1},(_,j)=>j===i?lambda:0));
 for(const r of rows){const x=r.features.map((v,i)=>active[i]?(v-means[i])/scales[i]:0);for(let i=0;i<n;i++){for(let j=0;j<n;j++)a[i][j]+=x[i]*x[j];a[i][n]+=x[i]*(r.titles-intercept);}}
 for(let i=0;i<n;i++){let pivot=i;for(let k=i+1;k<n;k++)if(Math.abs(a[k][i])>Math.abs(a[pivot][i]))pivot=k;[a[i],a[pivot]]=[a[pivot],a[i]];const d=a[i][i];for(let j=i;j<=n;j++)a[i][j]/=d;for(let k=0;k<n;k++)if(k!==i){const v=a[k][i];for(let j=i;j<=n;j++)a[k][j]-=v*a[i][j];}}
 return {featureVersion,featureNames,means,scales,intercept,weights:a.map((r,i)=>active[i]?r[n]:0),active,lambda};
}
export function validateRows(rows){
 const ids=new Set(),sources=new Map();
 for(const r of rows){
  if(!r.id||ids.has(r.id))throw new Error('Duplicate or missing training row ID');ids.add(r.id);
  if(!r.group||!r.source||r.features?.length!==featureNames.length||r.features.some(x=>!Number.isFinite(x))||!Number.isInteger(r.titles)||r.titles<0||r.titles>8||r.featureVersion!==featureVersion)throw new Error('Invalid training row');
  if(sources.has(r.source)&&sources.get(r.source)!==r.group)throw new Error('Same source assigned to different holdout groups');sources.set(r.source,r.group);
 }
 const builds=new Set(rows.map(r=>r.engine));if(builds.size!==1||!rows[0]?.engine)throw new Error('Training rows must share one engine build');
}
function concordance(rows,score){
 let pairs=0,credit=0;
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
  if(rows[i].source!==rows[j].source||rows[i].titles===rows[j].titles)continue;
  const diff=score(rows[i])-score(rows[j]);pairs++;
  credit+=Math.abs(diff)<1e-12?.5:Math.sign(diff)===Math.sign(rows[i].titles-rows[j].titles)?1:0;
 }
 return {value:pairs?credit/pairs:null,pairs,tieCredit:.5};
}
function metrics(model,rows,constant){
 const predictions=rows.map(r=>predict(model,r.features));
 const raw=rows.map(r=>predictRaw(model,r.features));
 const errors=predictions.map((v,i)=>v-rows[i].titles);
 const mse=f=>rows.reduce((s,r)=>s+(f(r)-r.titles)**2,0)/rows.length;
 return {rows:rows.length,mae:errors.reduce((s,e)=>s+Math.abs(e),0)/rows.length,rmse:Math.sqrt(mse(r=>predict(model,r.features))),constantMAE:rows.reduce((s,r)=>s+Math.abs(constant-r.titles),0)/rows.length,
 zeroMAE:rows.reduce((s,r)=>s+r.titles,0)/rows.length,zeroRMSE:Math.sqrt(mse(()=>0)),constantRMSE:Math.sqrt(mse(()=>constant)),
 predictionRange:[Math.min(...predictions),Math.max(...predictions)],rawPredictionRange:[Math.min(...raw),Math.max(...raw)],clippedLow:raw.filter(x=>x<0).length,clippedHigh:raw.filter(x=>x>8).length,
 ranking:concordance(rows,r=>predict(model,r.features)),top5RatingRanking:concordance(rows,r=>r.features[featureNames.indexOf('top5')]),
 rankingScope:'Descriptive concordance on unequal title-count pairs within an export; repeated trials and teams are correlated. Constant scores receive 0.5. This does not validate trade ranking.'};
}
export function diagnosePredictor(model,rows){
 validateRows(rows);
 if(model.engine!==rows[0].engine)throw new Error('Model and data engine mismatch');
 const training=rows.filter(r=>model.training.groups.includes(r.group));
 const test=rows.filter(r=>model.training.heldOutGroups.includes(r.group));
 if(!training.length||!test.length)throw new Error('Model training and held-out groups must be present');
 const warnings=[];
 const features=featureNames.map((name,i)=>{
  const values=training.map(r=>r.features[i]),lo=Math.min(...values),hi=Math.max(...values);
  const avg=test.reduce((s,r)=>s+r.features[i],0)/test.length;
  const constant=hi-lo<=1e-12*Math.max(1,Math.abs(model.means[i]));
  const contribution=model.weights[i]*(avg-model.means[i])/model.scales[i];
  if(constant&&model.scales[i]<1e-12&&model.weights[i]!==0)warnings.push(`Numerically unstable constant feature: ${name}`);
  return {name,trainingRange:[lo,hi],heldOutMean:avg,scale:model.scales[i],weight:model.weights[i],constantInTraining:constant,meanShiftContribution:contribution,
   outsideTrainingRange:test.filter(r=>r.features[i]<lo-1e-12||r.features[i]>hi+1e-12).length};
 }).sort((a,b)=>Math.abs(b.meanShiftContribution)-Math.abs(a.meanShiftContribution));
 const evaluation=metrics(model,test,model.intercept);
 if(evaluation.predictionRange[1]-evaluation.predictionRange[0]<1e-12)warnings.push('Held-out predictions are constant; the model cannot rank these teams.');
 if(evaluation.rmse>=Math.min(evaluation.zeroRMSE,evaluation.constantRMSE))warnings.push('Held-out RMSE does not beat both trivial baselines.');
 if(new Set(training.map(r=>r.group)).size<2)warnings.push('Only one training league group; between-league effects cannot be learned reliably.');
 return {evaluation,features,warnings,heldOutGroups:model.training.heldOutGroups};
}
export function trainPredictor(rows,{holdoutGroups,lambda=10}={}){
 validateRows(rows);
 if(!Number.isFinite(lambda)||lambda<=0)throw new Error('lambda must be positive');
 const groups=[...new Set(rows.map(r=>r.group))].sort();
 const holdout=holdoutGroups??[groups.at(-1)];
 if(groups.length<2||holdout.some(g=>!groups.includes(g)))throw new Error('Need at least two independent league groups, with a valid held-out group');
 const test=rows.filter(r=>holdout.includes(r.group)),train=rows.filter(r=>!holdout.includes(r.group));
 if(!train.length||!test.length)throw new Error('Training and holdout sets must both be nonempty');
 const model=fit(train,lambda), evaluation=metrics(model,test,model.intercept);
 const result = {...model,engine:rows[0].engine,experimental:true,training:{rows:train.length,groups:groups.filter(g=>!holdout.includes(g)),heldOutGroups:holdout},evaluation,
  limitations:'Experimental ridge baseline under native BBGM AI. Held-out groups must be independent league lineages; correlated teams/trials do not provide independent validation. Accuracy and trade rankings are not established by fitting this model.'};
 result.diagnostics=diagnosePredictor(result,rows);
 return result;
}
