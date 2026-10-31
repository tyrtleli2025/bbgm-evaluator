import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { benchmarkPredictors, evaluateFrozenPredictor } from './benchmark.mjs';
import { saveJSON } from './batch-learning.mjs';

const {values:v}=parseArgs({options:{data:{type:'string'},out:{type:'string'},model:{type:'string'},help:{type:'boolean'}}});
async function main(){
  if(v.help){console.log('npm run campaign:benchmark -- --data DATASET.json --out REPORT.json\nCompares fixed feature/regularization candidates with whole-lineage holdouts. Saves each fold model beside the report. No simulations.\nAdd --model MODEL.json to evaluate a frozen model on fresh lineage data without training. Previously used lineages are rejected.');return;}
  if(!v.data||!v.out||resolve(v.data)===resolve(v.out))throw new Error('Use --data and a distinct --out');
  if(v.model){
    if(resolve(v.model)===resolve(v.out))throw new Error('Output must differ from model');
    const report=evaluateFrozenPredictor(JSON.parse(await readFile(v.model,'utf8')),JSON.parse(await readFile(v.data,'utf8')));
    await saveJSON(v.out,report);console.log(JSON.stringify(report,null,2));return;
  }
  const dir=resolve(v.out.replace(/\.json$/,'')+'.models');
  if(resolve(v.data).startsWith(dir+'/'))throw new Error('Model output directory must not contain the input data');
  const {report,models}=benchmarkPredictors(JSON.parse(await readFile(v.data,'utf8')));
  for(const {file,model} of models)await saveJSON(resolve(dir,file),model);
  await saveJSON(v.out,{...report,modelDirectory:dir});
  for(const c of report.candidates)console.log(`${c.id}: mean lineage RMSE ${c.macroRMSE.toFixed(3)}; beats uniform in every lineage: ${c.beatsUniformEveryFold}`);
  console.log(`Uniform: ${report.baselines.uniformMacroRMSE.toFixed(3)}; zero: ${report.baselines.zeroMacroRMSE.toFixed(3)}. Development leader: ${report.developmentLeader}.`);
  console.log(`Report: ${resolve(v.out)}\nDevelopment comparison only; recommendations remain experimental.`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
