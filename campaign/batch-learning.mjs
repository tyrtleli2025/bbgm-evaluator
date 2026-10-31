import { readdir,readFile,mkdir,writeFile,rename } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { readLeague,validateLeague,normalizePlans,sha256 } from './input.mjs';
import { verifyBuild } from './provenance.mjs';
import { runIsolated,trialSeed } from './compare.mjs';
import { actionKey } from './generate.mjs';
import { trainingRows,mergeRows } from './learning.mjs';
export async function saveJSON(path,value){await mkdir(dirname(resolve(path)),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n');await rename(path+'.tmp',path);}
const readJSON=async p=>JSON.parse(await readFile(p,'utf8'));
export async function prepareBatch(directory,{seeds=[12345,67890],emptyReleasedPlayers=false,reuseReports=[]}={}){
 const entries=[],skipped=[],seen=new Set();
 for(const name of (await readdir(directory)).filter(n=>/\.json(\.gz)?$/.test(n)).sort()){
  const league=resolve(directory,name),match=name.match(/League_(\d+)_/);
  if(!match){skipped.push({league,reason:'Cannot infer lineage; add this file with an explicit group in the manifest.'});continue;}
  try{
   const {raw}=await readLeague(league);const assumed=emptyReleasedPlayers&&raw.releasedPlayers===undefined;if(assumed)raw.releasedPlayers=[];
   const teamId=raw.teams?.find(t=>!t.disabled)?.tid??0;validateLeague(raw,teamId);
   const hash=sha256(JSON.stringify(raw));if(seen.has(hash))continue;seen.add(hash);
   entries.push({league,teamId,group:`league${match[1]}`,seeds,emptyReleasedPlayers:!!assumed,plans:[]});
  }catch(error){skipped.push({league,reason:error.message});}
 }
 return {formatVersion:1,entries,reuseReports,skipped,note:'Review inferred lineage groups. Related saves must share a group. Each seed/plan is one eight-season campaign; baseline is always included.'};
}
const keyFor=(engine,source,seed,plan,teamId)=>sha256(JSON.stringify([engine.revision,engine.bundleSha256,engine.adapterSha256,source,teamId,seed,actionKey(plan.actions)]));
export async function collectBatch(manifest,{out,budget=1,signal,onProgress=()=>{},timeoutMs=20*60000}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>86400000)throw new Error('Invalid campaign timeout');
 if(!out||!Number.isInteger(budget)||budget<0||budget>10000||manifest.formatVersion!==1||!Array.isArray(manifest.entries)||!manifest.entries.length)throw new Error('Need a nonempty batch manifest, output directory and integer campaign budget 0–10000');
 const engine=await verifyBuild(),tasks=[],sources=new Map(),cache=new Map();
 const report={status:'preparing',engine,budget:{limit:budget,used:0},completed:[],failures:[],reused:0,rows:0,coverage:[],dataset:resolve(out,'dataset.json')};
 // Validate every source and output path before writing any files or launching workers.
 for(const entry of manifest.entries){
  if(!entry.group||!Array.isArray(entry.seeds)||!entry.seeds.length||entry.seeds.some(s=>!Number.isInteger(s)||s<0||s>0xffffffff))throw new Error('Each entry needs a group and uint32 seeds');
  const {raw}=await readLeague(entry.league);if(entry.emptyReleasedPlayers&&raw.releasedPlayers===undefined)raw.releasedPlayers=[];
  validateLeague(raw,entry.teamId);const source=sha256(JSON.stringify(raw));
  if(sources.has(source)&&sources.get(source)!==entry.group)throw new Error('One league source assigned to different lineage groups');sources.set(source,entry.group);
  const inputPaths=[resolve(entry.league),...(manifest.reuseReports??[]).map(p=>resolve(p))];
  if(inputPaths.some(p=>p===resolve(out)||p.startsWith(resolve(out)+'/')))throw new Error('Batch output directory must not contain input leagues or reusable reports');
  const plans=normalizePlans(entry.plans??[],entry.teamId);
  for(const [seedIndex,baseSeed] of entry.seeds.entries())for(const plan of plans){const seed=trialSeed(baseSeed,0),key=keyFor(engine,source,seed,plan,entry.teamId);if(tasks.some(t=>t.key===key))continue;tasks.push({key,entry,source,seed,plan,seedIndex});}
 }
 tasks.sort((a,b)=>a.seedIndex-b.seedIndex);
 report.taskSetHash=sha256(JSON.stringify(tasks.map(t=>[t.key,t.entry.group]).sort()));
 try{const previous=await readJSON(resolve(out,'batch.json'));if(previous.taskSetHash!==report.taskSetHash)throw new Error('Batch inputs, groups or build changed; use a new output directory');}catch(e){if(e.code!=='ENOENT')throw e;}
 // Reuse only exact source/seed/actions/engine+adapter matches from complete reports.
 for(const path of manifest.reuseReports??[]){
  const r=await readJSON(path);
  if(r.status!=='complete'||r.seasons!==8||r.engine?.revision!==engine.revision||r.engine?.bundleSha256!==engine.bundleSha256||r.engine?.adapterSha256!==engine.adapterSha256)continue;
  for(const t of r.trials)for(const plan of r.plans){const run=t.results[plan.id];if(run?.trainingFeatures?.length&&run.years?.length===8)cache.set(keyFor(engine,r.input.sha256,run.seed,plan,r.input.teamId),run);}
 }
 let rows=[];
 const checkpoint=async()=>{report.rows=rows.length;await saveJSON(report.dataset,rows);await saveJSON(resolve(out,'batch.json'),report);};
 // Cache hits for all jobs are ingested before spending this invocation's budget.
 const pending=[];
 for(const task of tasks){
  const path=resolve(out,'runs',task.key+'.json');let run;
  try{run=await readJSON(path);if(run.batchKey!==task.key||run.status!=='complete')run=undefined;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!run&&cache.has(task.key)){
   const result=cache.get(task.key);
   run={status:'complete',seasons:8,engine,input:{sha256:task.source,teamId:task.entry.teamId},plans:[task.plan],trials:[{index:0,seed:task.seed,results:{[task.plan.id]:result}}],batchKey:task.key,trainingGroup:task.entry.group};
   await saveJSON(path,run);
  }
  if(run){rows=mergeRows(rows,trainingRows(run,task.entry.group));report.completed.push({key:task.key,group:task.entry.group,league:task.entry.league,plan:task.plan.id,reused:true});report.reused++;}
  else pending.push({...task,path});
 }
 report.status='running';await checkpoint();
 for(const task of pending){
  if(signal?.aborted){report.status='cancelled';break;}
  if(report.budget.used>=budget){report.status='budget-limited';break;}
  const {raw}=await readLeague(task.entry.league);if(task.entry.emptyReleasedPlayers&&raw.releasedPlayers===undefined)raw.releasedPlayers=[];
  if(sha256(JSON.stringify(raw))!==task.source)throw new Error('League changed during batch preparation');
  report.budget.used++;onProgress({kind:'batchCampaign',key:task.key,group:task.entry.group,league:task.entry.league,planId:task.plan.id});
  try{
   const run=await runIsolated({raw,teamId:task.entry.teamId,plan:task.plan,seed:task.seed,collectTraining:true,seasons:8},{signal,timeoutMs,onProgress});
   const saved={status:'complete',seasons:8,engine,input:{sha256:task.source,teamId:task.entry.teamId},plans:[task.plan],trials:[{index:0,seed:task.seed,results:{[task.plan.id]:run}}],batchKey:task.key,trainingGroup:task.entry.group};
   await saveJSON(task.path,saved);rows=mergeRows(rows,trainingRows(saved,task.entry.group));report.completed.push({key:task.key,group:task.entry.group,league:task.entry.league,plan:task.plan.id,reused:false});
  }catch(error){report.status=signal?.aborted?'cancelled':'failed';report.failures.push({key:task.key,message:error.message});await checkpoint();break;}
  await checkpoint();
 }
 if(report.status==='running')report.status='complete';
 report.remaining=tasks.length-report.completed.length;
 report.coverage=[...new Set(rows.map(r=>r.group))].map(group=>({group,rows:rows.filter(r=>r.group===group).length,sources:new Set(rows.filter(r=>r.group===group).map(r=>r.source)).size,rollouts:new Set(rows.filter(r=>r.group===group).map(r=>r.rollout)).size}));
 await checkpoint();return report;
}
