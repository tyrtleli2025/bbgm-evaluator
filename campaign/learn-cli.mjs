import { parseArgs } from 'node:util';
import { readFile,writeFile,mkdir,rename } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { sha256 } from './input.mjs';
import { readLeague } from './input.mjs';
import { compareCampaigns } from './compare.mjs';
import { trainingRows,mergeRows } from './learning.mjs';
import { trainRelative,diagnoseRelative,relativeKind } from './relative-predictor.mjs';
import { trainPredictor,diagnosePredictor } from './predictor.mjs';
async function main(){
 const {values:v}=parseArgs({options:Object.fromEntries([...['mode','league','team-id','group','report','data','out','trials','seed','holdout','lambda','model','kind','profile'].map(k=>[k,{type:'string'}]),...['help','empty-released-players'].map(k=>[k,{type:'boolean'}])])});
 if(v.help){console.log(`npm run campaign:learn -- --mode collect --league PATH --team-id ID --group LINEAGE --out REPORT.json
npm run campaign:learn -- --mode ingest --report REPORT.json --group LINEAGE --data DATASET.json
npm run campaign:learn -- --mode train --data DATASET.json --holdout LINEAGE --out MODEL.json
npm run campaign:learn -- --mode diagnose --data DATASET.json --model MODEL.json --out DIAGNOSTICS.json
--kind relative selects the experimental league-relative model; default remains ridge.
--profile full|top5|talentAge selects relative features; default full. --lambda controls regularization.
Collect runs full eight-season campaigns (default one trial), with features for all initial teams.
--empty-released-players treats an omitted releasedPlayers section as empty; use only when Players was selected in a BBGM export.
Use the SAME group for related snapshots/seasons of one league. Train requires at least two independent groups.
Existing reports without training features cannot be ingested. No simulation is run by ingest or train.`);return;}
 const json=async p=>JSON.parse(await readFile(p,'utf8'));
 const save=async(p,r)=>{await mkdir(dirname(resolve(p)),{recursive:true});await writeFile(p+'.tmp',JSON.stringify(r,null,2)+'\n');await rename(p+'.tmp',p);};
 const protect=(out,inputs)=>{if(!out||inputs.filter(Boolean).some(p=>resolve(p)===resolve(out)))throw new Error('Output required and must differ from inputs');};
 if(v.mode==='collect'){
  if(!v.league||v['team-id']===undefined||!v.group)throw new Error('--league, --team-id and --group required');
  protect(v.out,[v.league,v.data]);
  const {raw}=await readLeague(v.league);
  const assumedEmptyReleasedPlayers=!!v['empty-released-players'] && raw.releasedPlayers===undefined;
  if(assumedEmptyReleasedPlayers){
   raw.releasedPlayers=[];
   console.error('Treating omitted releasedPlayers as empty, based on your export selection.');
  }
  const controller=new AbortController();const cancel=()=>controller.abort(new Error('Cancelled'));
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
   const report=await compareCampaigns({raw,teamId:Number(v['team-id']),trials:Number(v.trials??1),seed:Number(v.seed??12345),collectTraining:true,stopOnFailure:true,signal:controller.signal,
    onProgress:e=>{if(['campaign','seasonComplete','failure'].includes(e.kind))console.error(`${e.planId}: ${e.season??e.message??e.kind}`);},onCheckpoint:r=>save(v.out,{...r,trainingGroup:v.group,assumedEmptyReleasedPlayers})});
   console.log(`${report.status}. Saved ${v.out}. Ingest the report to add training rows.`);
   if(report.status!=='complete')process.exitCode=1;
  }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
 }else if(v.mode==='ingest'){
  if(!v.report||!v.data)throw new Error('--report and --data required');protect(v.data,[v.report]);
  const report=await json(v.report);if(v.group&&report.trainingGroup&&v.group!==report.trainingGroup)throw new Error('Cannot reassign the collected league group');let old=[];try{old=await json(v.data);}catch(e){if(e.code!=='ENOENT')throw e;}
  const rows=mergeRows(old,trainingRows(report,v.group??report.trainingGroup));await save(v.data,rows);console.log(`${rows.length} rows in ${v.data}`);
 }else if(v.mode==='diagnose'){
  protect(v.out,[v.data,v.model]);if(!v.data||!v.model)throw new Error('--data and --model required');
  const model=await json(v.model);const diagnostics=model.kind===relativeKind?diagnoseRelative(model,await json(v.data)):diagnosePredictor(model,await json(v.data));await save(v.out,diagnostics);console.log(JSON.stringify(diagnostics,null,2));
 }else if(v.mode==='train'){
  protect(v.out,[v.data]);if(!v.data)throw new Error('--data required');
  const data=await json(v.data);
  if(v.kind&&!['ridge','relative'].includes(v.kind))throw new Error('Choose --kind ridge or relative');
  if(v.profile&&v.kind!=='relative')throw new Error('--profile requires --kind relative');
  const model=(v.kind==='relative'?trainRelative:trainPredictor)(data,{holdoutGroups:v.holdout?v.holdout.split(','):undefined,lambda:Number(v.lambda??(v.kind==='relative'?.1:10)),profile:v.profile??'full'});
  model.datasetSha256=sha256(JSON.stringify(data));
  await save(v.out,model);console.log(JSON.stringify({experimental:true,training:model.training,evaluation:model.evaluation,warnings:model.diagnostics.warnings},null,2));
 }else throw new Error('Choose --mode collect, ingest, train, or diagnose; see --help');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
