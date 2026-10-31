import { parseArgs } from 'node:util';
import { resolve,dirname } from 'node:path';
import { mkdir,writeFile,rename,readFile } from 'node:fs/promises';
import { readLeague } from './input.mjs';
import { planTrades } from './planner.mjs';
import { actionKey } from './generate.mjs';

async function main() {
  const {values:v}=parseArgs({options:Object.fromEntries([
    ...['league','team-id','attempts','branches','shortlist','depth','trials','jobs','seed','short-seasons','short-trials','finalists','budget','model','out'].map(k=>[k,{type:'string'}]),
    ...['help','generate-only','deep'].map(k=>[k,{type:'boolean'}]),
  ])});
  if(v.help){console.log(`npm run campaign:plan -- --league PATH --team-id ID
  --attempts 32     Package searches per state (1–500)
  --branches 4      First trades explored for follow-ups (1–20)
  --shortlist 4     Plans compared with baseline (1–20)
  --depth 2         Maximum opening trades (1 or 2)
  --short-seasons 1 Short horizon, 1 or 2 seasons (preliminary)
  --short-trials 1  Short trials per plan
  --budget 12       Maximum simulated campaigns across stages
  --model PATH      Experimental learned screening model
  --deep            Also run eight-season comparisons of finalists
  --finalists 2     Finalists, including a reserved long-term candidate
  --trials 2        Deep trials per finalist plus baseline
  --jobs 1          Concurrent trials (1–4)
  --seed 12345      Reproducible seed
  --generate-only   Save verified plans without running campaigns
  --out PATH       Report path (default results/trade-planner-TIMESTAMP.json)`);return;}
  if(!v.league || v['team-id']===undefined)throw new Error('--league and --team-id are required');
  const out=resolve(v.out??`results/trade-planner-${Date.now()}.json`);
  const plansOut=out.replace(/\.json$/,'')+'.plans.json';
  if([out,plansOut].includes(resolve(v.league)))throw new Error('Output must not overwrite input');
  const {raw}=await readLeague(v.league);
  await mkdir(dirname(out),{recursive:true});
  const controller=new AbortController();
  const cancel=()=>controller.abort(new Error('Cancelled by user'));
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  let last=0;
  try {
    const report=await planTrades({raw,teamId:Number(v['team-id']),...Object.fromEntries(['attempts','branches','shortlist','depth','trials','jobs','seed'].filter(k=>v[k]!==undefined).map(k=>[k,Number(v[k])])),
      model:v.model?JSON.parse(await readFile(v.model,'utf8')):undefined,deep:!!v.deep,shortSeasons:Number(v['short-seasons']??1),shortTrials:Number(v['short-trials']??1),finalists:Number(v.finalists??2),budget:Number(v.budget??12),generateOnly:!!v['generate-only'],signal:controller.signal,
      onProgress:e=>{if(Date.now()-last>3000 || ['branch','campaign','seasonComplete'].includes(e.kind)){console.error(`${e.planId??'search'}: ${e.text??(e.season?`${e.season}: ${e.won}–${e.lost}`:e.kind)}`);last=Date.now();}},
      onCheckpoint:async r=>{await writeFile(out+'.tmp',JSON.stringify(r,null,2)+'\n');await rename(out+'.tmp',out);await writeFile(plansOut,JSON.stringify(r.plans,null,2)+'\n');},
    });
    console.log(`${report.status}: ${report.candidates.length} candidate sequences; ${report.plans.length} verified plans.`);
    for(const p of report.plans){
      console.log(`${p.id}: ${p.name}`);
      const candidate=report.candidates.find(c=>c.key===actionKey(p.actions));
      for(const trade of candidate?.details??[]) for(const side of trade) {
        const assets=[...side.players.map(p=>`${p.name} (pid ${p.pid})`),...side.picks.map(p=>`${p.season} round ${p.round} pick (dpid ${p.dpid})`)];
        console.log(`  ${side.team} sends: ${assets.join(', ')||'nothing'}`);
      }
    }
    if(report.comparison?.seasons<8)console.log(`PRELIMINARY: ${report.comparison.seasons}-season results, not eight-year title estimates.`);
    console.log(`Campaign budget: ${report.budget.used}/${report.budget.limit}; stage: ${report.stage}`);
    for(const row of report.comparison?.summary??[])console.log(`${row.name}: ${row.expectedTitles.mean?.toFixed(3)??'—'} expected titles; Δ ${row.deltaFromBaseline.mean?.toFixed(3)??'—'}; 95% Δ interval ${JSON.stringify(row.deltaFromBaseline.interval95)}`);
    if(report.predictor)console.log('EXPERIMENTAL learned screening enabled; predictions are not validated championship probabilities.');
    if(report.shortRanking)for(const row of report.shortRanking)console.log(`${row.id}: short-run win rate ${(100*row.winPercentage).toFixed(1)}%`);
    if(report.finalists)console.log(`Finalists: ${report.finalists.map(p=>p.id).join(', ')}`);
    if(report.comparison?.error)console.error(report.comparison.error.message);
    if(report.error)console.error(report.error);
    console.log(`Report: ${out}\nReusable plans: ${plansOut}\nHeuristic shortlist; small trial counts cannot establish which plan is better.`);
    if(!['complete','preliminary','budget-limited','generated','no-candidates'].includes(report.status))process.exitCode=report.status==='cancelled'?130:1;
  } finally {process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
