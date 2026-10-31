import { diverse, actionKey } from './generate.mjs';

export const firstTradeKey = c => actionKey((c.actions ?? [c.action]).slice(0,1));
// One representative from each opening family before returning to that family.
// A combination gets the first slot; its opening is allowed to be weak alone.
export function openingOrder(candidates, usePredictor = false) {
  const remaining = usePredictor ? [...candidates].sort((a,b)=>b.predictedTitles-a.predictedTitles||a.key.localeCompare(b.key)) : diverse(candidates,candidates.length);
  const combination=remaining.find(c=>(c.actions??[]).length>1);
  if(combination){remaining.splice(remaining.indexOf(combination),1);remaining.unshift(combination);}
  const result=[];
  while(remaining.length){
    const seen=new Set();
    for(let i=0;i<remaining.length;){
      const key=firstTradeKey(remaining[i]);
      if(seen.has(key)){i++;continue;}
      seen.add(key);result.push(remaining.splice(i,1)[0]);
    }
  }
  return result;
}
export function shortRanking(comparison) {
  const complete=comparison.trials.filter(t=>comparison.plans.every(p=>t.results[p.id]?.years.length===comparison.seasons));
  return comparison.plans.filter(p=>p.id!=='baseline').map(plan=>{
    const runs=complete.map(t=>t.results[plan.id]);
    const years=runs.flatMap(r=>r.years);
    const games=years.reduce((s,y)=>s+y.won+y.lost,0);
    return {id:plan.id,observedTitles:runs.length?runs.reduce((s,r)=>s+r.titles,0)/runs.length:0,
      winPercentage:games?years.reduce((s,y)=>s+y.won,0)/games:0};
  }).sort((a,b)=>b.observedTitles-a.observedTitles||b.winPercentage-a.winPercentage||a.id.localeCompare(b.id));
}
export function pickFinalists(plans,candidates,ranking,limit) {
  const selected=[];
  const add=plan=>{if(plan&&!selected.some(p=>p.id===plan.id)&&selected.length<limit)selected.push(plan);};
  add(plans.find(p=>p.id===ranking[0]?.id));
  // Reserve a slot for a long-term heuristic candidate, regardless of short wins.
  const pool=candidates.filter(c=>plans.some(p=>actionKey(p.actions)===c.key));
  const protectedCandidate=[...pool].sort((a,b)=>b.screen.youth-a.screen.youth||b.screen.assets-a.screen.assets).find(c=>!selected.some(p=>actionKey(p.actions)===c.key));
  add(plans.find(p=>actionKey(p.actions)===protectedCandidate?.key));
  for(const row of ranking)add(plans.find(p=>p.id===row.id));
  return selected;
}
