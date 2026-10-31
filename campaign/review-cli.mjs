import { parseArgs } from 'node:util';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { reviewPlanner } from './review.mjs';
async function main(){
  const {values:v}=parseArgs({options:Object.fromEntries(['report','comparison','out','help'].map(k=>[k,{type:k==='help'?'boolean':'string'}]))});
  if(v.help){console.log('npm run campaign:review -- --report PLANNER.json [--comparison CAMPAIGN.json] [--out REVIEW.json]\nRead saved trade impacts, uncertainty, and the incremental effect of a second trade. No simulations run.');return;}
  if(!v.report)throw new Error('--report is required');
  if(v.out && [v.report,v.comparison].filter(Boolean).some(p=>resolve(p)===resolve(v.out)))throw new Error('Output must not overwrite an input report.');
  const planner=JSON.parse(await readFile(v.report,'utf8'));
  const comparison=v.comparison?JSON.parse(await readFile(v.comparison,'utf8')):undefined;
  const review=reviewPlanner(planner,comparison);
  if(v.out){await mkdir(dirname(resolve(v.out)),{recursive:true});await writeFile(v.out,JSON.stringify(review,null,2)+'\n');}
  console.log(`${review.team}: ${review.completePairedTrials} complete paired trials; ${review.generatedCandidates} candidates, ${review.shortlistedPlans} shortlisted.`);
  if(review.seasons<8)console.log(`PRELIMINARY ${review.seasons}-season comparison; not eight-year championship estimates.`);
  if(review.budget)console.log(`Campaign budget: ${review.budget.used}/${review.budget.limit}; stage: ${review.stage}`);
  const n=x=>x==null?'—':x.toFixed(3);
  for(const r of review.reviews){
    console.log(`\n${r.id}: ${r.name}\n${r.verdict}; expected titles ${n(r.expectedTitles)}; Δ ${n(r.deltaFromBaseline.mean)}; adjusted interval [${r.deltaFromBaseline.interval95.map(n).join(', ')}]`);
    for(const direction of [-1,1])console.log(`${direction<0?'Send':'Receive'}: ${r.netAssets.filter(p=>Math.sign(p.change)===direction).map(p=>p.name).join(', ')||'nothing'}`);
    console.log(`Screen changes: ${JSON.stringify(r.screenDelta)}`);
    if(review.seasons<8 && r.winPercentage!==null)console.log(`Short-run win rate: ${(100*r.winPercentage).toFixed(1)}%`);
  }
  for(const c of review.combinations)console.log(`\n${c.planId} versus ${c.parentId}: second trade Δ ${n(c.additionalTradeEffect.mean)}; pointwise interval [${c.additionalTradeEffect.interval95.map(n).join(', ')}]`);
  console.log(`\n${review.verdict}\n${review.screeningAudit}`);
  if(review.diversity.warning)console.log(review.diversity.warning);
  for(const error of review.errors)console.error(error);
  if(v.out)console.log(`Review: ${resolve(v.out)}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
