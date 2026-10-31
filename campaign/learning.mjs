import { sha256 } from './input.mjs';
import { actionKey } from './generate.mjs';
import { featureVersion } from './features.mjs';
export function trainingRows(report,group){
 if(!group||report.status!=='complete'||report.seasons!==8)throw new Error('Use a complete eight-season comparison and an explicit independent league group');
 const rows=[],engine=`${report.engine.revision}:${report.engine.bundleSha256}`;
 for(const trial of report.trials)for(const plan of report.plans){
  const run=trial.results[plan.id];
  if(run.years?.length!==8||!run.trainingFeatures?.length)throw new Error('Report lacks eight-season training features; collect a new run');
  const tids=new Set(run.trainingFeatures.map(entry=>entry.tid));
  if(tids.size!==run.trainingFeatures.length||run.years.some(y=>!Number.isInteger(y.championTid)||y.championTid<0))throw new Error('Missing champion or duplicate starting team');
  const outsideTitles=run.years.filter(y=>!tids.has(y.championTid)).length;
  const source=report.input.sha256;
  for(const entry of run.trainingFeatures){
   const titles=run.years.filter(y=>y.championTid===entry.tid).length;
   rows.push({id:sha256(JSON.stringify([engine,source,run.seed,actionKey(plan.actions),entry.tid])),source,group,rollout:sha256(JSON.stringify([engine,source,run.seed,actionKey(plan.actions)])),engine,featureVersion,features:entry.features,titles,outsideTitles});
  }
 }
 return rows;
}
export function mergeRows(existing,added){
 const rows=new Map(existing.map(r=>[r.id,r]));
 for(const r of added){
  const prev=rows.get(r.id);
  if(prev&&JSON.stringify(prev)!==JSON.stringify(r)){
   const {rollout:a,outsideTitles:c,...oldCore}=prev,{rollout:b,outsideTitles:d,...newCore}=r;
   if(JSON.stringify(oldCore)!==JSON.stringify(newCore)||(a&&b&&a!==b)||(c!==undefined&&d!==undefined&&c!==d))throw new Error('Conflicting duplicate training row');
   rows.set(r.id,{...prev,rollout:a??b,...(c!==undefined||d!==undefined?{outsideTitles:c??d}:{})});
  }else rows.set(r.id,r);
 }
 return [...rows.values()];
}
