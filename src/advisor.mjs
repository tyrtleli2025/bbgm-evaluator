import { readFileSync } from 'node:fs';
import { makeSeededRandom } from '../.engine/common/random.js';
import { applyTrade, proposal, rosterProxy } from './search.mjs';
import { assessTrade } from './trade-rules.mjs';
import { makeTradeWork } from './negotiation.mjs';
import { developPath } from './draft.mjs';
import { prepareTeam, simulate } from './adapter.mjs';
import { scheduleSeed, estimatedPossessions, validateGame } from './evaluator.mjs';
const manifest=JSON.parse(readFileSync(new URL('../vendor/zengm/manifest.json',import.meta.url)));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const name=p=>`${p.firstName} ${p.lastName}`;
const weightsFor=w=>w==='soon'?[5,4,2,1,1]:w==='later'?[1,1,2,4,5]:[1,1,1,1,1];
const weighted=(values,weights)=>values.reduce((s,v,i)=>s+v*weights[i],0)/weights.reduce((s,v)=>s+v,0);
const auto=roster=>roster.map(p=>({...p,ptModifier:1})).sort((a,b)=>b.valueNoPot-a.valueNoPot||a.pid-b.pid);
export function validateAdvisorOptions(league,input={}) {
 const o={teamId:input.teamId,window:input.window??'balanced',budget:input.budget??500,seed:input.seed??12345,coaching:input.coaching??34,
  protectedPids:input.protectedPids??[],assumeNoReleased:input.assumeNoReleased??false,maxAnnualIncrease:input.maxAnnualIncrease??null,health:input.health??'current'};
 if(!league.teams.has(o.teamId))throw new Error('Choose your team');
 if(!['soon','balanced','later'].includes(o.window)||!['current','healthy'].includes(o.health)||![200,500,1500].includes(o.budget)||!Number.isSafeInteger(o.seed)||!Number.isFinite(o.coaching)||o.coaching<1||o.coaching>100)throw new Error('Invalid advisor settings');
 if(typeof o.assumeNoReleased!=='boolean'||o.maxAnnualIncrease!==null&&(!Number.isFinite(o.maxAnnualIncrease)||o.maxAnnualIncrease<0||o.maxAnnualIncrease>1e9))throw new Error('Invalid salary assumptions');
 if(!Array.isArray(o.protectedPids)||new Set(o.protectedPids).size!==o.protectedPids.length||o.protectedPids.some(pid=>!league.teams.get(o.teamId).some(p=>p.pid===pid)))throw new Error('Invalid protected players');
 return o;
}
export function advisorContext(league,options) {
 const assumptions=[];
 if(!Array.isArray(league.rawData?.releasedPlayers)&&options.assumeNoReleased){
  league={...league,rawData:{...league.rawData,releasedPlayers:[]}};
  assumptions.push('Explicit assumption: no released-player salary obligations. Cap legality depends on this assumption.');
 }
 return {league,assumptions};
}
export function contractRoster(roster,season,targetSize,replacement) {
 const retained=roster.filter(p=>p.contract.exp>=season);
 const count=retained.length;
 while(retained.length<targetSize)retained.push({...replacement,pid:-100000-retained.length,injury:{gamesRemaining:0,type:'Healthy'}});
 return {roster:retained,openSlots:targetSize-count};
}
export function contractLedger(league,before,after,tid) {
 const releases=league.rawData.releasedPlayers?.filter(p=>p.tid===tid)??[];
 return Array.from({length:5},(_,y)=>{
  const season=league.settings.season+y;
  const payroll=r=>[...r,...releases].filter(p=>p.contract.exp>=season).reduce((s,p)=>s+p.contract.amount,0);
  return {season,before:payroll(before),after:payroll(after),change:payroll(after)-payroll(before),
   retainedBefore:before.filter(p=>p.contract.exp>=season).length,retainedAfter:after.filter(p=>p.contract.exp>=season).length};
 });
}
const summarize=values=>{const estimate=mean(values),se=Math.sqrt(values.reduce((s,v)=>s+(v-estimate)**2,0)/Math.max(1,values.length-1)/values.length);return {estimate,confidence95:[estimate-1.96*se,estimate+1.96*se]};};
export async function recommendTrades(original,input={}) {
 const options=validateAdvisorOptions(original,input),{teamId,seed,budget}=options;
 const {league,assumptions}=advisorContext(original,options);
 const base=league.teams.get(teamId), opponents=[...league.teams.keys()].filter(id=>id!==teamId),weights=weightsFor(options.window);
 const stats={sampled:0,accepted:0,negotiated:0,duplicates:0,simulatedGames:0,rejected:{}};
 const reject=why=>{stats.rejected[why]=(stats.rejected[why]??0)+1;};
 const warnings=[...assumptions,'Bounded player-only search of one trade at a time; no global optimum or future AI acceptance is guaranteed.',
  'Current season uses exported ratings and chosen health. Future seasons use true ratings with stochastic development, healthy players, fixed league rules and no historical determinism or retirement.',
  'The contracts-only scenario replaces expired contracts with identical fixed replacement-level players. It is a scenario, not a lower bound or a prediction of free-agent signings.',
  'The retained scenario assumes everyone re-signs. Future re-signing salaries are unknown and excluded from the commitment ledger.',
  'Existing contracts and exported released-player liabilities determine committed payroll. Replacement signings, cap growth, luxury tax and future draft picks are not priced.',
  'Automatic rotations use exported valueNoPot this year and projected OVR as a future rotation-value proxy.',
  'Finalists use 16 shared development scenarios, sampled opponents and paired home/away games. Intervals include simulation noise but do not correct for selecting winners from a search. Close results are inconclusive.'];
 const report=(status,message,candidates=[])=>({model:'five-year-player-trade-advisor-v1',engineRevision:manifest.revision,inputSha256:league.inputHash,options,status,message,stats,assumptions,warnings,candidates});
 const probe={teams:[{tid:teamId,send:[]},{tid:opponents[0],send:[]}]};
 const check=assessTrade(league,probe,{teamId});
 if([-2,-1,2,3].includes(league.settings.phase)||league.settings.challengeNoTrades||league.settings.spectator)return report('unavailable','Trading is disabled in this league phase or mode.');
 if(check.details.missing.length||!check.details.ai)return report('needs-context',check.details.missing.join(' ')||'Trade context is incomplete.');
 if(!Array.isArray(league.rawData?.releasedPlayers))return report('needs-context','Released-player salary obligations were not exported. Import full context or explicitly assume zero obligations.');
 const all=[...league.teams.values()].flat();
 if([...all,...(league.rawData.releasedPlayers??[])].some(p=>!Number.isInteger(p.contract?.exp)||!Number.isFinite(p.contract?.amount)))return report('needs-context','Complete contract amounts and expiration seasons are required for projections.');
 if(all.some(p=>!Number.isFinite(p.rating.ovr)))return report('needs-context','OVR ratings are required for the screening and replacement benchmark.');
 const sorted=all.slice().sort((a,b)=>a.rating.ovr-b.rating.ovr||a.pid-b.pid);
 const replacement={...sorted[Math.floor(sorted.length/8)],valueNoPot:sorted[Math.floor(sorted.length/8)].rating.ovr,ptModifier:1};
 warnings.push(`Replacement benchmark: fixed ratings of ${name(replacement)} (OVR ${replacement.rating.ovr}), the median of the league’s bottom OVR quartile; this does not imply that player is available.`);
 // Screening uses common development draws for every roster, independent of package order.
 const forecast=new Map(all.map(p=>{
  const paths=Array.from({length:6},(_,t)=>developPath(p,league.settings.season,scheduleSeed(`advisor-screen:${seed}`,p.pid,0,t),options.coaching));
  return [p.pid,[p,...Array.from({length:4},(_,y)=>({...p,rating:{...p.rating,ovr:mean(paths.map(path=>path[y].rating.ovr))},valueNoPot:mean(paths.map(path=>path[y].rating.ovr))}))]];
 }));
 const proxy=(roster,y,mode)=>{
  let r=roster.map(p=>forecast.get(p.pid)[y]);
  if(mode==='contract')r=contractRoster(r,league.settings.season+y,Math.max(base.length,roster.length),replacement).roster;
  return rosterProxy(r,{phase:'regular',health:y? 'healthy':options.health,numPlayersOnCourt:league.settings.numPlayersOnCourt});
 };
 const baseProxy=Array.from({length:5},(_,y)=>proxy(base,y,'contract'));
 if(!baseProxy.every(Number.isFinite))return report('unavailable','Your team has too few available players. Choose healthy availability or import an updated roster.');
 const candidates=[],seen=new Set(),parents=[],random=makeSeededRandom(seed);
 function consider(scenario) {
  stats.sampled++;
  if(scenario.teams[0].send.some(pid=>options.protectedPids.includes(pid)))return reject('Protected player');
  if(!scenario.teams.some(t=>t.send.length))return;
  const key=JSON.stringify(scenario.teams.map(t=>[t.tid,t.send.slice().sort((a,b)=>a-b)]));
  if(seen.has(key)){stats.duplicates++;return;}seen.add(key);
  const assessment=assessTrade(league,scenario,{teamId});
  if(assessment.legal!==true||assessment.aiAcceptance!==true)return reject(assessment.reasons[0]??'AI rejected the package');
  const changed=applyTrade(league,scenario).league;
  if(scenario.teams.some(t=>{const n=changed.teams.get(t.tid).length;return n<(league.settings.minRosterSize??5)||n>(league.settings.maxRosterSize??Infinity);}))return reject('Roster would require additional signings or cuts');
  if(options.health==='current'&&scenario.teams.some(t=>changed.teams.get(t.tid).filter(p=>p.injury.gamesRemaining===0).length<league.settings.numPlayersOnCourt))return reject('Insufficient available players');
  const after=changed.teams.get(teamId),ledger=contractLedger(league,base,after,teamId);
  if(options.maxAnnualIncrease!==null&&ledger.some(y=>y.change>options.maxAnnualIncrease))return reject('Exceeds added annual commitment limit');
  const gains=Array.from({length:5},(_,y)=>proxy(after,y,'contract')-baseProxy[y]);
  if(!gains.every(Number.isFinite))return reject('Insufficient available players');
  const screen=weighted(gains,weights);
  stats.accepted++;
  const candidate={key,scenario,assessment,ledger,screen,gains,after};candidates.push(candidate);
  parents.push({scenario,score:screen});parents.sort((a,b)=>b.score-a.score);parents.length=Math.min(12,parents.length);
 }
 // Seed negotiation with desirable players, then let upstream add arbitrary assets.
 const targets=opponents.flatMap(tid=>league.teams.get(tid).map(p=>({tid,p}))).sort((a,b)=>
  (forecast.get(b.p.pid)[3].rating.ovr+b.p.rating.ovr)-(forecast.get(a.p.pid)[3].rating.ovr+a.p.rating.ovr)||a.p.pid-b.p.pid);
 const targetCount=Math.min(targets.length,budget===1500?40:budget===500?24:12);
 for(let i=0;i<targetCount;i++) {
  const {tid,p}=targets[i];
  const scenario={teams:[{tid:teamId,send:[]},{tid,send:[p.pid]}]};
  const answer=await makeTradeWork(league,scenario,{teamId,excluded:{[teamId]:options.protectedPids}});
  stats.negotiated++;if(['suggested','already-works'].includes(answer.status))consider(answer.scenario);
  input.onProgress?.({stage:'Generating counteroffers',completed:i+1,total:targetCount,message:`Negotiated ${i+1}/${targetCount} target packages`});
 }
 for(let i=0;i<budget;i++) {
  consider(proposal(league,teamId,opponents,random,parents));
  if(i%25===0)input.onProgress?.({stage:'Screening trades',completed:i+1,total:budget,message:`${stats.accepted} accepted, legal packages found`});
 }
 const shortlist=[];
 const add=c=>{if(c&&!shortlist.includes(c))shortlist.push(c);};
 add(candidates.toSorted((a,b)=>b.gains[0]-a.gains[0])[0]);
 add(candidates.toSorted((a,b)=>mean(b.gains.slice(1))-mean(a.gains.slice(1)))[0]);
 for(const c of candidates.toSorted((a,b)=>b.screen-a.screen||a.key.localeCompare(b.key)))if(shortlist.length<6)add(c);
 if(!shortlist.length)return report('no-deal','No accepted, legal trade fitting your constraints was found. This does not prove none exists.');
 const targetSizes=new Map([...league.teams].map(([tid,r])=>[tid,r.length]));
 for(const c of shortlist)for(const [tid,r] of applyTrade(league,c.scenario).league.teams)targetSizes.set(tid,Math.max(targetSizes.get(tid),r.length));
 const trials=16,paths=new Map();
 const path=(p,t)=>{const k=`${p.pid}:${t}`;if(!paths.has(k))paths.set(k,[p,...developPath(p,league.settings.season,scheduleSeed(`advisor-final:${seed}`,p.pid,0,t),p.tid===teamId?options.coaching:34).slice(0,4)]);return paths.get(k);};
 // Incoming players develop under our coaching; baseline and each trade keep paired random draws.
 const oursPath=(p,t)=>[p,...developPath(p,league.settings.season,scheduleSeed(`advisor-final:${seed}`,p.pid,0,t),options.coaching).slice(0,4)];
 const ownPaths=new Map([...new Map([base,...shortlist.map(c=>c.after)].flat().map(p=>[p.pid,p])).values()].map(p=>[p.pid,Array.from({length:trials},(_,t)=>oursPath(p,t))]));
 for(const tid of opponents)if(options.health==='current'&&league.teams.get(tid).filter(p=>p.injury.gamesRemaining===0).length<league.settings.numPlayersOnCourt)return report('unavailable','An opponent has too few healthy players for the comparison. Select fully healthy availability.');
 const rows=shortlist.map(()=>Array.from({length:5},()=>({contract:[],retained:[]})));
 for(let t=0;t<trials;t++)for(let y=0;y<5;y++) {
  const opponentId=opponents[Math.floor(t*opponents.length/trials)],settings={...league.settings,season:league.settings.season+y};
  const projected=(roster,own)=>roster.map(p=>({...((own?ownPaths.get(p.pid)[t]:path(p,t))[y]),tid:p.tid}));
  const baselineOther=projected(league.teams.get(opponentId),false);
  for(const mode of ['contract','retained']) {
   const make=(roster,tid)=>prepareTeam(tid,auto(mode==='contract'&&y>0?contractRoster(roster,settings.season,targetSizes.get(tid),replacement).roster:roster),settings,{health:y?'healthy':options.health});
   for(let venue=0;venue<2;venue++) {
    const run=(ours,other)=>{
     const game=simulate(venue?other:ours,venue?ours:other,settings,{seed:scheduleSeed(`advisor-games:${seed}`,t,y,venue)});validateGame(game,settings,'regular');stats.simulatedGames++;
     const a=game.team[venue?1:0],b=game.team[venue?0:1];return 100*(a.stat.pts-b.stat.pts)/estimatedPossessions(a.stat,b.stat);
    };
    const baseline=run(make(projected(base,true),teamId),make(baselineOther,opponentId));
    shortlist.forEach((c,i)=>{
     const changedOther=c.scenario.teams[1].tid===opponentId?applyTrade(league,c.scenario).league.teams.get(opponentId):league.teams.get(opponentId);
     const gain=run(make(projected(c.after,true),teamId),make(projected(changedOther,false),opponentId))-baseline;
     rows[i][y][mode][t]=(rows[i][y][mode][t]??0)+gain/2;
    });
   }
  }
  input.onProgress?.({stage:'Simulating finalists',completed:t*5+y+1,total:trials*5,message:`Comparing ${shortlist.length} deals over five seasons`});
 }
 const results=shortlist.map((c,i)=>{
  const yearly=rows[i].map((r,y)=>({season:league.settings.season+y,contract:summarize(r.contract),retained:summarize(r.retained),...c.ledger[y]}));
  const score=summarize(Array.from({length:trials},(_,t)=>weighted(rows[i].map(r=>r.contract[t]),weights)));
  const retained=summarize(Array.from({length:trials},(_,t)=>weighted(rows[i].map(r=>r.retained[t]),weights)));
  const transfers=c.scenario.teams.map(side=>({tid:side.tid,name:league.teamNames?.get(side.tid)?.name??`Team ${side.tid}`,players:league.teams.get(side.tid).filter(p=>side.send.includes(p.pid)).map(p=>({pid:p.pid,name:name(p),age:league.settings.season-p.born.year,ovr:p.rating.ovr,contract:p.contract}))}));
  return {scenario:c.scenario,assessment:c.assessment,conditional:assumptions.length>0||c.assessment.status!=='verified',transfers,yearly,score,retained,
   outgoingValue:base.filter(p=>c.scenario.teams[0].send.includes(p.pid)).reduce((s,p)=>s+Math.max(0,p.value??p.rating.ovr),0),
   immediate:yearly[0].contract.estimate,future:mean(yearly.slice(1).map(y=>y.contract.estimate)),labels:[]};
 }).sort((a,b)=>b.score.estimate-a.score.estimate);
 const bestNow=results.filter(c=>c.immediate>0).sort((a,b)=>b.immediate-a.immediate)[0];if(bestNow)bestNow.labels.push('Best immediate upgrade');
 const bestFuture=results.filter(c=>c.future>0).sort((a,b)=>b.future-a.future)[0];if(bestFuture)bestFuture.labels.push('Best long-term upgrade');
 const best=results[0];
 if(best.score.estimate>0){const value=results.filter(c=>c.score.estimate>=best.score.estimate/2).sort((a,b)=>a.outgoingValue-b.outgoingValue||b.score.estimate-a.score.estimate)[0];value.labels.push('Least sacrifice for meaningful gain');}
 warnings.push('Value label selects the least exported player value surrendered among deals reaching at least half the best weighted gain. It is not a dollar-to-wins calculation.');
 return {...report(best.score.estimate>0?'complete':'no-upgrade',best.score.estimate>0?'Compare the strongest deals found. Estimates whose intervals cross zero are inconclusive.':'Keep your roster: no simulated finalist improved the selected five-year objective.',results),replacement:{pid:replacement.pid,name:name(replacement),ovr:replacement.rating.ovr},trials};
}
