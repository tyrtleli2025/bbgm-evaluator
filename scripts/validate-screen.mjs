// Empirical check of the cheap search screen on teams and independent random
// roster interventions. No fitting uses these observations.
import { readLeague } from '../src/importer.mjs';
import { evaluate } from '../src/evaluator.mjs';
import { rosterProxy } from '../src/search.mjs';
import { prepareTrade } from '../src/trade.mjs';
import { makeSeededRandom } from '../.engine/common/random.js';
import { writeFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/validate-screen.mjs league.json[.gz] [teamId] [output.json]');
const league = readLeague(path), teamId = Number(process.argv[3] ?? [...league.teams.keys()][0]);
if (!league.teams.has(teamId)) throw new Error('Unknown team ID');
for (const roster of league.teams.values()) {
  roster.sort((a,b) => b.valueNoPot-a.valueNoPot || a.pid-b.pid);
  roster.forEach((p,i) => {p.rosterOrder=i; p.ptModifier=1;});
}
const options = {gamesPerOpponent:12,seed:91723};
const start = performance.now();
const evaluated = evaluate(league,options);
const teams = evaluated.teams.map(t => ({tid:t.tid,proxy:rosterProxy(league.teams.get(t.tid)),strength:t.strength}));
function ranks(values) {
  const sorted = values.map((value,index) => ({value,index})).sort((a,b) => a.value-b.value), out = [];
  for (let i=0; i<sorted.length;) {
    let j=i+1; while (j<sorted.length && sorted[j].value === sorted[i].value) j++;
    for (let k=i; k<j; k++) out[sorted[k].index]=(i+j-1)/2;
    i=j;
  }
  return out;
}
function correlation(a,b) {
  const mean = values => values.reduce((s,x) => s+x,0)/values.length;
  const ma=mean(a), mb=mean(b);
  const covariance=a.reduce((s,x,i) => s+(x-ma)*(b[i]-mb),0);
  const spread=Math.sqrt(a.reduce((s,x) => s+(x-ma)**2,0)*b.reduce((s,x) => s+(x-mb)**2,0));
  return spread ? covariance/spread : null;
}
function metrics(rows) {
  const a=rows.map(r=>r.proxy), b=rows.map(r=>r.strength);
  let agreed=0,total=0;
  for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++) {
    if (a[i]===a[j] || b[i]===b[j]) continue;
    total++; if(Math.sign(a[i]-a[j])===Math.sign(b[i]-b[j])) agreed++;
  }
  return {pearson:correlation(a,b),spearman:correlation(ranks(a),ranks(b)),pairwiseOrderingAgreement:total?agreed/total:null};
}
const random=makeSeededRandom(62817), opponents=[...league.teams.keys()].filter(t=>t!==teamId), changes=[];
const baseline=evaluated.teams.find(t=>t.tid===teamId), baselineProxy=rosterProxy(league.teams.get(teamId));
const subset = roster => roster.map(p=>({pid:p.pid,priority:random()})).sort((a,b)=>a.priority-b.priority)
  .slice(0,1+Math.floor(random()*Math.min(6,roster.length))).map(p=>p.pid);
for(let attempt=0;attempt<300 && changes.length<32;attempt++) {
  const other=opponents[Math.floor(random()*opponents.length)];
  const scenario={teams:[{tid:teamId,send:subset(league.teams.get(teamId))},{tid:other,send:subset(league.teams.get(other))}]};
  let candidate;
  try { ({candidate}=prepareTrade(league,scenario,teamId)); } catch { continue; }
  if (![teamId,other].every(t=>Number.isFinite(rosterProxy(candidate.teams.get(t))))) continue;
  const after=evaluate(candidate,{...options,teamId}).teams[0];
  changes.push({scenario,proxy:rosterProxy(candidate.teams.get(teamId))-baselineProxy,strength:after.strength-baseline.strength});
}
const report={inputSha256:league.inputHash,season:league.settings.season,teamId,gamesPerOpponent:options.gamesPerOpponent,
  seed:options.seed,elapsedSeconds:(performance.now()-start)/1000,
  teams:{count:teams.length,...metrics(teams),observations:teams},
  rosterChanges:{count:changes.length,...metrics(changes),observations:changes},
  limitations:'One snapshot, frozen healthy/availability inputs, noisy simulations. Random interventions are for predictive validation, not necessarily legal or accepted trades. No guarantee of generalization; synergy-driven gains may be missed by the OVR screen.'};
if (process.argv[4]) writeFileSync(process.argv[4],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,teams:{...report.teams,observations:undefined},rosterChanges:{...report.rosterChanges,observations:undefined}},null,2));
