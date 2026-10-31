// Only information available at the decision point. No potential, future ratings,
// player IDs, names, draft outcomes, or simulated results enter the feature vector.
export const featureVersion = 1;
export const featureNames = ['top1','top3','top5','top8','depth','youngTalent','primeTalent','oldTalent','meanAge','payrollCap','committedCap','firstPicks','secondPicks','relativeTop5','bestOpponent','leagueSize','difficulty','phase','threePointFactor'];
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const strength = roster => mean(roster.map(p=>p.ratings.at(-1).ovr).sort((a,b)=>b-a).slice(0,5));
export function teamFeatures(players,picks,tid,settings,teams) {
  const roster=players.filter(p=>p.tid===tid).sort((a,b)=>b.ratings.at(-1).ovr-a.ratings.at(-1).ovr);
  const ratings=roster.map(p=>p.ratings.at(-1).ovr), cap=Math.max(1,settings.salaryCap);
  const age=p=>settings.season-p.born.year;
  const talent=predicate=>roster.filter(p=>predicate(age(p))).reduce((s,p)=>s+Math.max(0,p.ratings.at(-1).ovr-40),0);
  const others=teams.filter(t=>!t.disabled&&t.tid!==tid).map(t=>strength(players.filter(p=>p.tid===t.tid)));
  const ours=picks.filter(p=>p.tid===tid&&p.season<=settings.season+7);
  const values=[ratings[0]??0,...[3,5,8].map(n=>mean(ratings.slice(0,n))),mean(ratings.slice(5,10)),talent(a=>a<24),talent(a=>a>=24&&a<=29),talent(a=>a>29),mean(roster.map(age)),roster.reduce((s,p)=>s+p.contract.amount,0)/cap,roster.reduce((s,p)=>s+p.contract.amount*Math.max(0,p.contract.exp-settings.season),0)/cap,ours.filter(p=>p.round===1).length,ours.filter(p=>p.round===2).length,strength(roster)-mean(others),Math.max(0,...others),teams.filter(t=>!t.disabled).length,settings.difficulty,settings.phase,settings.threePointTendencyFactor??1];
  if(values.some(v=>!Number.isFinite(v)))throw new Error('Incomplete predictor features');
  return values;
}
export function featureSettings(g){return Object.fromEntries(['season','salaryCap','difficulty','phase','threePointTendencyFactor'].map(k=>[k,g.get(k)]));}
