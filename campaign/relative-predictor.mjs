import { featureNames,featureVersion } from './features.mjs';
import { validateRows } from './predictor.mjs';
export const relativeKind='league-relative-softmax-v1';
// Deliberately omit absolute opponent strength and league-wide settings. They
// cannot distinguish teams within one league and caused the previous shift.
const indices=Array.from({length:13},(_,i)=>i);
export const relativeProfiles={full:indices,top5:[2],talentAge:[0,2,3,5,7,8]};
const mean=(a)=>a.reduce((s,x)=>s+x,0)/a.length;
export function validateRelativeModel(m){
 if(m.outsideTitles!==undefined&&(!Number.isFinite(m.outsideTitles)||m.outsideTitles<0||m.outsideTitles>8))throw new Error('Invalid outside title allocation');
 if(m.kind!==relativeKind||m.featureVersion!==featureVersion||JSON.stringify(m.featureNames)!==JSON.stringify(featureNames)||JSON.stringify(m.indices)!==JSON.stringify(indices)||!Array.isArray(m.weights)||!Array.isArray(m.scales)||m.weights.length!==indices.length||m.scales.length!==indices.length||m.weights.some(x=>!Number.isFinite(x))||m.scales.some(x=>!Number.isFinite(x)||x<=0))throw new Error('Incompatible league-relative model');
}
function centered(context){
 if(!Array.isArray(context)||context.length<2||context.some(f=>f.length!==featureNames.length||f.some(x=>!Number.isFinite(x))))throw new Error('Full finite league feature context is required');
 return context.map(f=>indices.map(i=>f[i]-mean(context.map(row=>row[i]))));
}
function shares(scores){const max=Math.max(...scores),exps=scores.map(x=>Math.exp(x-max)),sum=exps.reduce((s,x)=>s+x,0);return exps.map(x=>x/sum);}
export function predictLeague(model,context){
 validateRelativeModel(model);
 const x=centered(context).map(f=>f.map((v,i)=>v/model.scales[i]));
 return shares(x.map(f=>f.reduce((s,v,i)=>s+v*model.weights[i],0))).map(p=>(8-(model.outsideTitles??0))*p);
}
function rollouts(rows){
 const groups=new Map();
 for(const r of rows){const key=r.rollout??r.source;const group=groups.get(key)??[];group.push(r);groups.set(key,group);}
 const sizeIndex=featureNames.indexOf('leagueSize');
 for(const group of groups.values()){
  if(group.some(r=>r.group!==group[0].group||r.source!==group[0].source||r.features[sizeIndex]!==group.length))throw new Error('Relative training requires complete league rollouts; re-ingest saved reports for explicit rollout IDs');
  const total=group.reduce((s,r)=>s+r.titles,0),outside=group[0].outsideTitles??0;
  if(!Number.isInteger(outside)||outside<0||outside>8||total+outside!==8||group.some(r=>(r.outsideTitles??0)!==outside))throw new Error('Relative training requires eight allocated titles, including explicit outsideTitles for future teams; re-ingest saved reports');
 }
 return [...groups.values()];
}
function evaluate(model,groups){
 let n=0,abs=0,sq=0,zeroAbs=0,zeroSq=0,uniformAbs=0,uniformSq=0,pairs=0,credit=0,outsideSq=0;
 const leagues=[];
 for(const rows of groups){const p=predictLeague(model,rows.map(r=>r.features));
  const outside=rows[0].outsideTitles??0;outsideSq+=((model.outsideTitles??0)-outside)**2;
  leagues.push({source:rows[0].source,group:rows[0].group,teams:rows.length,predictedTotal:p.reduce((s,x)=>s+x,0),observedTotal:8-outside,predictedOutsideTitles:model.outsideTitles??0,observedOutsideTitles:outside,predictionRange:[Math.min(...p),Math.max(...p)]});
  rows.forEach((r,i)=>{const d=p[i]-r.titles,u=8/rows.length-r.titles;n++;abs+=Math.abs(d);sq+=d*d;zeroAbs+=r.titles;zeroSq+=r.titles**2;uniformAbs+=Math.abs(u);uniformSq+=u*u;});
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(rows[i].titles!==rows[j].titles){pairs++;const d=p[i]-p[j];credit+=Math.abs(d)<1e-12?.5:Math.sign(d)===Math.sign(rows[i].titles-rows[j].titles)?1:0;}
 }
 return {rows:n,rollouts:groups.length,mae:abs/n,rmse:Math.sqrt(sq/n),outsideRMSE:Math.sqrt(outsideSq/groups.length),zeroMAE:zeroAbs/n,zeroRMSE:Math.sqrt(zeroSq/n),uniformMAE:uniformAbs/n,uniformRMSE:Math.sqrt(uniformSq/n),ranking:{value:pairs?credit/pairs:null,pairs,tieCredit:.5},leagues,scope:'Descriptive metrics from correlated team outcomes. This is not a trade-ranking or independent-trial accuracy estimate.'};
}
export function diagnoseRelative(model,rows){
 validateRows(rows);validateRelativeModel(model);
 if(model.engine!==rows[0].engine)throw new Error('Model and data engine mismatch');
 const test=rows.filter(r=>model.training.heldOutGroups.includes(r.group));
 if(!test.length)throw new Error('Held-out league data missing');
 const evaluation=evaluate(model,rollouts(test));
 const warnings=['Experimental evaluation: use new independent league groups for validation after model design.'];
 if(evaluation.rmse>=Math.min(evaluation.zeroRMSE,evaluation.uniformRMSE))warnings.push('RMSE does not beat both trivial baselines.');
 if(evaluation.ranking.value===null||evaluation.ranking.value<=.5)warnings.push('Ranking does not beat tied scores on this sample.');
 if(model.training.groups.length<2)warnings.push('Only one training league; generalization remains unestablished.');
 return {evaluation,warnings};
}
export function trainRelative(rows,{holdoutGroups,lambda=.1,iterations=1000,profile='full'}={}){
 validateRows(rows);
 if(!Object.hasOwn(relativeProfiles,profile))throw new Error('Unknown relative feature profile');
 if(!Number.isFinite(lambda)||lambda<=0||!Number.isInteger(iterations)||iterations<1)throw new Error('Positive lambda and iteration count required');
 const all=[...new Set(rows.map(r=>r.group))].sort(),heldOutGroups=holdoutGroups??[all.at(-1)];
 if(all.length<2||!heldOutGroups.length||heldOutGroups.some(g=>!all.includes(g)))throw new Error('Need independent training and held-out league groups');
 const train=rows.filter(r=>!heldOutGroups.includes(r.group));
 if(!train.length)throw new Error('No training groups remain');
 const groups=rollouts(train),raw=groups.map(g=>centered(g.map(r=>r.features)));
 const flat=raw.flat(),scales=indices.map((_,i)=>{const v=Math.sqrt(mean(flat.map(f=>f[i]**2)));return v>1e-12?v:1;});
 const x=raw.map(g=>g.map(f=>f.map((v,i)=>relativeProfiles[profile].includes(i)?v/scales[i]:0)));
 let w=indices.map(()=>0);
 const objective=weights=>{
  let loss=lambda*weights.reduce((s,v)=>s+v*v,0)/2,grad=weights.map(v=>lambda*v);
  groups.forEach((g,k)=>{const logits=x[k].map(f=>f.reduce((s,v,i)=>s+v*weights[i],0)),p=shares(logits),max=Math.max(...logits),logZ=max+Math.log(logits.reduce((s,z)=>s+Math.exp(z-max),0));
   const mass=g.reduce((sum,r)=>sum+r.titles,0)/8;
   g.forEach((r,j)=>{loss+=(r.titles/8)*(logZ-logits[j])/groups.length;for(let i=0;i<w.length;i++)grad[i]+=(mass*p[j]-r.titles/8)*x[k][j][i]/groups.length;});
  });return {loss,grad};
 };
 let completed=0;
 for(;completed<iterations;completed++){
  const {loss,grad}=objective(w),norm=grad.reduce((s,v)=>s+v*v,0);if(norm<1e-14)break;
  let step=1,next;while(step>1e-10){next=w.map((v,i)=>v-step*grad[i]);if(objective(next).loss<=loss-1e-4*step*norm)break;step/=2;}
  if(step<=1e-10)break;w=next;
 }
 const model={kind:relativeKind,profile,allocationVersion:2,outsideTitles:mean(groups.map(g=>g[0].outsideTitles??0)),featureVersion,featureNames,indices,scales,weights:w,lambda,iterations:completed,engine:rows[0].engine,experimental:true,
  training:{rows:train.length,groups:all.filter(g=>!heldOutGroups.includes(g)),heldOutGroups,rollouts:groups.length},
  limitations:'Future-team title allocation is a global mean learned from training rollouts only; it does not predict expansion schedules or trade-dependent expansion strength. Current teams share the remaining titles. Native AI future policy. Development model, not validated trade advice.'};
 model.diagnostics=diagnoseRelative(model,rows);model.evaluation=model.diagnostics.evaluation;return model;
}
