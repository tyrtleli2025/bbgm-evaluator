import { validateRelativeModel,relativeKind } from './relative-predictor.mjs';
import { runIsolated, compareCampaigns, trialSeed } from './compare.mjs';
import { validateLeague, sha256 } from './input.mjs';
import { verifyBuild } from './provenance.mjs';
import { diverse, actionKey } from './generate.mjs';
import { predict } from './predictor.mjs';
import { openingOrder, shortRanking, pickFinalists } from './stages.mjs';

export async function planTrades({ raw, teamId, attempts = 32, branches = 4, shortlist = 4, depth = 2,
  seed = 12345, trials = 2, jobs = 1, generateOnly = false, model, deep = false, shortSeasons = 1, shortTrials = 1, finalists = 2, budget = 12, signal,
  timeoutMs = 20*60000, onProgress = () => {}, onCheckpoint = async () => {} }) {
  for (const [name,value,min,max] of [['shortSeasons',shortSeasons,1,2],['shortTrials',shortTrials,1,100],['finalists',finalists,1,20],['budget',budget,2,100000],['attempts',attempts,1,500],['branches',branches,1,20],['shortlist',shortlist,1,20],['depth',depth,1,2],['seed',seed,0,0xffffffff],['trials',trials,1,10000],['jobs',jobs,1,4]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected ${min}–${max}`);
  }
  const input = validateLeague(raw,teamId);
  const engine = await verifyBuild();
  if(model && model.engine!==`${engine.revision}:${engine.bundleSha256}`)throw new Error('Predictor engine does not match campaign build');
  if(model?.kind===relativeKind)validateRelativeModel(model);else if(model)predict(model,model.means);
  const report = { status:'searching', input:{...input,sha256:sha256(JSON.stringify(raw))}, engine,
    predictor:model?{modelSha256:sha256(JSON.stringify(model)),experimental:true,training:model.training,evaluation:model.evaluation}:null,
    settings:{ attempts,branches,shortlist,depth,seed,trials,jobs,deep,shortSeasons,shortTrials,finalists,budget },
    budget:{limit:budget,used:0,unit:'Simulated campaigns; imports/preflights excluded'},stage:'generation', candidates:[], rejected:[], plans:[],
    screening:'Diverse heuristic shortlist: native playoff team OVR; young productive players; native player value plus rough pick credits; remaining salary commitments. Scores are not championship estimates.',
    scope:'Bounded heuristic search, not exhaustive or globally optimal. Native AI manages all teams after the opening trades. Comparison intervals are pointwise and do not establish the best plan among many.' };
  const options = {signal,timeoutMs,onProgress};
  const run = (plan,extra) => runIsolated({raw,teamId,seed,plan,...extra},options);
  const baseline = {id:'baseline',actions:[]};
  const save = () => onCheckpoint(structuredClone(report));
  const verify = async (candidate, checkSeed = seed) => {
    try { await run({id:'check',actions:candidate.actions},{preflight:true,seed:checkSeed}); return true; }
    catch(error) { if(signal?.aborted) throw error; report.rejected.push({key:candidate.key,message:error.message}); return false; }
  };
  try {
    const first = await run(baseline,{generate:{attempts,model,offset:seed % Math.max(1,(raw.teams.length-1)*8)}});
    report.baselineScreen = first.baseline;
    let pool = first.candidates.map(c=>({...c,actions:[c.action],details:[c.details]}));
    const parents = [];
    for (const c of diverse(pool,pool.length)) {
      if (parents.length >= branches) break;
      if(await verify(c)) parents.push(c);
    }
    if (depth === 2) for (const [index,parent] of parents.entries()) {
      onProgress({kind:'branch',text:`Exploring second trades ${index+1}/${parents.length}`});
      const next = await run({id:'branch',actions:parent.actions},{generate:{attempts,model,offset:(seed+index*17) % Math.max(1,(raw.teams.length-1)*8)}});
      for(const c of next.candidates) {
        const actions = [...parent.actions,c.action];
        pool.push({...c,actions,key:actionKey(actions),details:[...parent.details,c.details]});
      }
    }
    pool = [...new Map(pool.map(c=>[c.key,c])).values()];
    report.candidates = pool.map(({action,...c})=>c);
    const ordered = openingOrder(pool,!!model);
    for(const c of ordered) {
      if(report.plans.length >= shortlist) break;
      if(await verify(c)) report.plans.push({id:`plan_${report.plans.length+1}`,name:c.details.map(d=>`Trade with ${d[1].team}`).join(' → '),actions:c.actions});
    }
    report.status = report.plans.length ? 'generated' : 'no-candidates'; await save();
    if(generateOnly || !report.plans.length) return report;
    const capacity = Math.floor(budget / shortTrials) - 1;
    if(capacity < 1) {report.status='budget-limited';report.stage='screened';await save();return report;}
    const shortSeed=(seed ^ 0x9e3779b9) >>> 0;
    const testedPlans=[];
    for(const plan of report.plans){
      if(testedPlans.length>=capacity)break;
      let valid=true;
      for(let i=0;i<shortTrials;i++)if(!await verify({...plan,key:actionKey(plan.actions)},trialSeed(shortSeed,i))){valid=false;break;}
      if(valid)testedPlans.push(plan);
    }
    report.shortExcludedPlans=report.plans.filter(p=>!testedPlans.includes(p)).map(p=>p.id);
    if(!testedPlans.length){report.status='no-candidates';report.stage='short-preflight';await save();return report;}
    report.stage='short';report.status='comparing';await save();
    const countUsed = c => c.trials.reduce((n,t)=>n+Object.keys(t.results).length+Object.keys(t.failures).length,0);
    const common={raw,teamId,jobs,signal,timeoutMs,stopOnFailure:true,onProgress};
    report.shortComparison=await compareCampaigns({...common,plans:testedPlans,
      seed:shortSeed,trials:shortTrials,seasons:shortSeasons,
      onCheckpoint:async comparison=>{report.shortComparison=comparison;report.comparison=comparison;report.budget.used=countUsed(comparison);await save();}});
    report.comparison=report.shortComparison;
    report.budget.used=countUsed(report.shortComparison);
    if(report.shortComparison.status!=='complete'){report.status=report.shortComparison.status;await save();return report;}
    report.shortRanking=shortRanking(report.shortComparison);
    report.finalists=pickFinalists(testedPlans,report.candidates,report.shortRanking,finalists);
    report.status='preliminary';report.stage='short-complete';await save();
    if(!deep)return report;
    const deepPlans=[];
    for(const plan of report.finalists){
      let valid=true;
      for(let i=0;i<trials;i++)if(!await verify({...plan,key:actionKey(plan.actions)},trialSeed(seed,i))){valid=false;break;}
      if(valid)deepPlans.push(plan);
    }
    report.deepExcludedPlans=report.finalists.filter(p=>!deepPlans.includes(p)).map(p=>p.id);
    report.finalists=deepPlans;
    if(!deepPlans.length){report.status='no-candidates';report.stage='deep-preflight';await save();return report;}
    const needed=(report.finalists.length+1)*trials;
    if(report.budget.used+needed>budget){report.status='budget-limited';report.requiredDeepCampaigns=needed;await save();return report;}
    report.stage='deep';report.status='comparing';await save();
    const shortUsed=report.budget.used;
    report.deepComparison=await compareCampaigns({...common,plans:report.finalists,seed,trials,seasons:8,
      onCheckpoint:async comparison=>{report.deepComparison=comparison;report.comparison=comparison;report.budget.used=shortUsed+countUsed(comparison);await save();}});
    report.comparison=report.deepComparison;report.budget.used=shortUsed+countUsed(report.deepComparison);
    report.status=report.deepComparison.status;report.stage='deep-complete';await save();return report;
  } catch(error) {
    report.status=signal?.aborted?'cancelled':'error'; report.error=error.message; await save(); return report;
  }
}
