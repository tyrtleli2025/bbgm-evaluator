import { mergeRows } from './learning.mjs';
import { validateRows } from './predictor.mjs';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareBatch,collectBatch,saveJSON } from './batch-learning.mjs';
async function main(){
 const {values:v}=parseArgs({options:Object.fromEntries([...['mode','directory','manifest','out','budget','seeds','timeout-minutes'].map(k=>[k,{type:'string'}]),['reuse',{type:'string',multiple:true}],['data',{type:'string',multiple:true}],...['help','empty-released-players'].map(k=>[k,{type:'boolean'}])])});
 if(v.help){console.log(`npm run campaign:batch -- --mode prepare --directory "League json files" --out results/training-manifest.json
npm run campaign:batch -- --mode run --manifest results/training-manifest.json --out results/training-batch --budget 1
npm run campaign:batch -- --mode merge --data OLD.json --data NEW.json --out MERGED.json
Prepare scans files and writes a reviewable manifest; no simulation runs.
--seeds 12345,67890 sets base seeds (each uses campaign trialSeed(base,0)).
--reuse REPORT may be repeated; only exact engine/adapter/source/seed/plan matches are reused.
--empty-released-players asserts Players was selected in standard BBGM exports with omitted empty stores.
--timeout-minutes N limits each campaign (default 20; elapsed wall time).
Run is sequential, capped by NEW campaigns per invocation; rerun the SAME command to resume.
Edit manifest entries to correct lineage groups or add multi-asset plans. Baseline is automatic.
A failure stops the batch. Ctrl+C saves finished campaigns. No model is trained automatically.`);return;}
 if(v.mode==='prepare'){
  if(!v.directory||!v.out)throw new Error('--directory and --out required');
  if(resolve(v.out).startsWith(resolve(v.directory)+'/'))throw new Error('Put the manifest outside the league directory');
  const seeds=(v.seeds??'12345,67890').split(',').map(Number);if(!seeds.length||seeds.some(s=>!Number.isInteger(s)||s<0||s>0xffffffff))throw new Error('Use uint32 seeds');
  const manifest=await prepareBatch(v.directory,{seeds,emptyReleasedPlayers:!!v['empty-released-players'],reuseReports:v.reuse??[]});await saveJSON(v.out,manifest);
  console.log(`${manifest.entries.length} sources prepared; ${manifest.skipped.length} skipped. Review groups in ${v.out}. No campaigns run.`);
  for(const row of manifest.skipped)console.log(`Skipped ${row.league}: ${row.reason}`);
 }else if(v.mode==='merge'){
  if(!v.out||!v.data?.length||v.data.some(p=>resolve(p)===resolve(v.out)))throw new Error('Use --data inputs and a distinct --out');
  let rows=[];for(const path of v.data)rows=mergeRows(rows,JSON.parse(await readFile(path,'utf8')));validateRows(rows);await saveJSON(v.out,rows);console.log(`${rows.length} unique training rows in ${v.out}`);
 }else if(v.mode==='run'){
  if(!v.manifest||!v.out)throw new Error('--manifest and --out required');
  if(resolve(v.manifest).startsWith(resolve(v.out)+'/'))throw new Error('Manifest must be outside the batch output directory');
  const manifest=JSON.parse(await readFile(v.manifest,'utf8'));
  const controller=new AbortController(),cancel=()=>controller.abort(new Error('Cancelled by user'));
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
   const report=await collectBatch(manifest,{out:v.out,budget:Number(v.budget??1),timeoutMs:Number(v['timeout-minutes']??20)*60000,signal:controller.signal,onProgress:e=>{if(e.kind==='batchCampaign')console.error(`${e.group}: ${e.league}, ${e.planId}`);else if(e.kind==='seasonComplete')console.error(`${e.season}: ${e.won}–${e.lost}`);}});
   console.log(`${report.status}: ${report.rows} rows, ${report.reused} reused campaigns, ${report.budget.used}/${report.budget.limit} new attempts, ${report.remaining} pending.`);
   console.log(`Dataset: ${report.dataset}\nCoverage: ${JSON.stringify(report.coverage)}`);
   if(report.failures.length)console.error(JSON.stringify(report.failures));
   if(!['complete','budget-limited'].includes(report.status))process.exitCode=report.status==='cancelled'?130:1;
  }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
 }else throw new Error('Choose --mode prepare, run, or merge; see --help');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
