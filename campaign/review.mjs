import { actionKey } from './generate.mjs';
import { estimate } from './report.mjs';

// Read-only diagnostics. No simulation, selection, or changes to saved plans.
export function reviewPlanner(planner, comparison = planner.comparison) {
  if (!Array.isArray(planner.candidates) || !Array.isArray(planner.plans) || !planner.input?.sha256) throw new Error('Expected a planner report.');
  if (comparison) {
    if (!comparison.plans?.some(p=>p.id==='baseline')) throw new Error('Comparison must include the baseline.');
    if (comparison.input?.sha256 !== planner.input.sha256 || comparison.input?.teamId !== planner.input.teamId) throw new Error('Comparison belongs to a different league or team.');
    if (comparison.engine?.revision !== planner.engine?.revision || comparison.engine?.bundleSha256 !== planner.engine?.bundleSha256) throw new Error('Comparison uses a different engine.');
    for (const plan of comparison.plans.filter(p=>p.id!=='baseline')) {
      const original=planner.plans.find(p=>p.id===plan.id);
      if(!original || actionKey(original.actions)!==actionKey(plan.actions)) throw new Error(`Comparison plan ${plan.id} does not match the saved shortlist.`);
    }
  }
  const seasons=comparison?.seasons??8;
  const plans=comparison?.plans ?? [{id:'baseline',actions:[]},...planner.plans];
  const complete=(comparison?.trials??[]).filter(t=>plans.every(p=>t.results[p.id]?.years?.length===seasons));
  const tested=plans.filter(p=>p.id!=='baseline');
  const alpha=.05/Math.max(1,tested.length);
  const ready=comparison?.status==='complete';
  const reviews=planner.plans.map(plan=>{
    const candidate=planner.candidates.find(c=>c.key===actionKey(plan.actions));
    const net=new Map();
    for(const trade of candidate?.details??[]) trade.forEach((side,i)=>{
      for(const p of side.players) {const key=`p${p.pid}`;const prev=net.get(key);net.set(key,{type:'player',name:p.name,id:p.pid,change:(prev?.change??0)+(i===0?-1:1)});}
      for(const p of side.picks) {const key=`d${p.dpid}`;const prev=net.get(key);net.set(key,{type:'pick',name:`${p.season} round ${p.round} (original tid ${p.originalTid})`,id:p.dpid,change:(prev?.change??0)+(i===0?-1:1)});}
    });
    const isTested=tested.some(p=>p.id===plan.id);
    const deltas=isTested?complete.map(t=>t.results[plan.id].titles-t.results.baseline.titles):[];
    const interval=estimate(deltas,-seasons,seasons,alpha);
    const verdict=!isTested || !comparison?'not simulated':!ready?'comparison incomplete':seasons<8?'preliminary short-horizon results':!deltas.length?'no complete trials':interval.interval95[0]>0?'evidence of improvement':interval.interval95[1]<0?'evidence of harm':'inconclusive';
    const years=isTested?complete.flatMap(t=>t.results[plan.id].years):[];
    const games=years.reduce((s,y)=>s+(y.won??0)+(y.lost??0),0);
    return {id:plan.id,name:plan.name,trades:plan.actions.length,netAssets:[...net.values()].filter(p=>p.change),
      screen:candidate?.screen,screenDelta:candidate&&planner.baselineScreen?Object.fromEntries(Object.entries(candidate.screen).map(([k,v])=>[k,v-planner.baselineScreen[k]])):null,
      expectedTitles:isTested&&complete.length?complete.reduce((s,t)=>s+t.results[plan.id].titles,0)/complete.length:null,
      winPercentage:games?years.reduce((s,y)=>s+y.won,0)/games:null,
      deltaFromBaseline:{...interval,confidence:1-alpha},verdict};
  });
  const firstMoves=new Set(planner.plans.filter(p=>p.actions.length).map(p=>actionKey(p.actions.slice(0,1))));
  const combinations=[];
  for(const plan of planner.plans.filter(p=>p.actions.length>1)) {
    const parent=planner.plans.find(p=>actionKey(p.actions)===actionKey(plan.actions.slice(0,-1)));
    if(!parent || !tested.some(p=>p.id===parent.id) || !tested.some(p=>p.id===plan.id))continue;
    combinations.push({planId:plan.id,parentId:parent.id,additionalTradeEffect:estimate(complete.map(t=>t.results[plan.id].titles-t.results[parent.id].titles),-seasons,seasons),note:'Paired descriptive comparison; 95% pointwise interval, not adjusted for choosing among combinations.'});
  }
  return {team:planner.input.teamName,status:comparison?.status??planner.status,seasons,stage:planner.stage??'legacy',budget:planner.budget,completePairedTrials:complete.length,
    generatedCandidates:planner.candidates.length,shortlistedPlans:planner.plans.length,rejectedSequences:planner.rejected?.length??0,
    errors:[planner.error,comparison?.error?.message,...(comparison?.trials??[]).flatMap(t=>Object.entries(t.failures??{}).map(([id,message])=>`Trial ${t.index+1}, ${id}: ${message}`))].filter(Boolean),
    diversity:{distinctFirstTrades:firstMoves.size,warning:planner.plans.length>1&&firstMoves.size===1?'Every shortlisted plan shares the same first trade; alternative opening strategies remain untested.':null},
    baselineExpectedTitles:complete.length?complete.reduce((s,t)=>s+t.results.baseline.titles,0)/complete.length:null,
    verdict:seasons<8?'Preliminary results only; eight-year championship impact has not been evaluated.':reviews.some(p=>p.verdict==='evidence of improvement')?'Some tested plans show improvement under the modeled policy.':ready?'No improvement established; more trials may be needed.':'Comparison has not completed.',
    intervalPolicy:'Bonferroni-adjusted Hoeffding intervals across tested plans versus baseline; complete paired trials only. Screening selected plans before these simulations.',
    screeningAudit:'Unselected candidates have not been simulated by this review. It cannot establish whether screening discarded the best plan.',
    reviews,combinations,scope:'Results depend on the pinned engine and native AI future management. This review does not certify optimal trades.'};
}
