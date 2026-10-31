import {analyzeRoster,synergyFromCounts,skills} from './math.mjs';
import {playerOVR} from './engine-data.mjs';
const cache=new Map();
const keys=Object.keys(skills);
// A transparent screening heuristic, not an expected margin or win probability.
// Mean healthy player OVR is discounted for playing hurt, then receives a fit bonus
// using the game's raw synergy scales and regular/playoff synergy factors.
export function lineupScore(talent,synergy,phase){
 return talent+(phase===3?25:10)*(synergy.off/100+synergy.def/100*5/6+synergy.reb/100*.5)/3;
}
export function analyzeLineups(snapshot){
 const key=JSON.stringify([snapshot.tid,snapshot.name,snapshot.season,snapshot.gameVersion,snapshot.phase,snapshot.threshold,snapshot.numPlayersOnCourt,snapshot.players]);
 if(cache.has(key))return cache.get(key);
 const current=analyzeRoster(snapshot),n=snapshot.numPlayersOnCourt;
 const eligible=snapshot.players.filter(p=>p.injury.gamesRemaining<=snapshot.threshold).sort((a,b)=>a.pid-b.pid);
 const talent=p=>playerOVR(p.rating)*(1-.025*p.injury.gamesRemaining);
 const base={...current,score:current.enoughPlayers?lineupScore(current.lineup.reduce((s,p)=>s+talent(snapshot.players.find(q=>q.pid===p.pid)),0)/n,current.synergy,snapshot.phase):null};
 if(eligible.length<n)return {...base,search:{tested:0,exact:true},best:null,alternatives:{}};
 const candidates=eligible.map(p=>({p,talent:talent(p),skills:analyzeRoster({...snapshot,players:[p],numPlayersOnCourt:1}).lineup[0].skills}));
 let tested=0;const winners={};
 function assess(indices){
  const count=Object.fromEntries(keys.map(k=>[k,0]));let sum=0;
  for(const i of indices){sum+=candidates[i].talent;for(const k of keys)count[k]+=candidates[i].skills[k];}
  const synergy=synergyFromCounts(count),score=lineupScore(sum/n,synergy,snapshot.phase);
  const metrics={best:score,fit:(synergy.off+synergy.def+synergy.reb)/3,off:synergy.off,def:synergy.def,reb:synergy.reb};
  tested++;
  for(const [k,value] of Object.entries(metrics))if(!winners[k]||value>winners[k].value+1e-10)winners[k]={indices:[...indices],value,score,synergy,count};
  return metrics;
 }
 let combinations=1;for(let i=1;i<=n;i++)combinations=combinations*(eligible.length-i+1)/i;
 const exact=combinations<=100000;
 if(exact){
  const selected=[];
  function visit(start){if(selected.length===n){assess(selected);return;}for(let i=start;i<=candidates.length-(n-selected.length);i++){selected.push(i);visit(i+1);selected.pop();}}
  visit(0);
 }else{
  // Bounded hill climbs from talent and each skill seed for unusually large rosters.
  const seeds=[null,...keys].map(k=>candidates.map((_,i)=>i).sort((a,b)=>(k?candidates[b].skills[k]-candidates[a].skills[k]:candidates[b].talent-candidates[a].talent)||a-b).slice(0,n));
  for(const seed of seeds)assess(seed);
  for(let pass=0;pass<10&&tested<20000;pass++){
   let improved=false;
   for(const objective of Object.keys(winners)){
    const start=winners[objective];
    for(let slot=0;slot<n&&tested<20000;slot++)for(let i=0;i<candidates.length&&tested<20000;i++)if(!start.indices.includes(i)){
     const next=[...start.indices];next[slot]=i;assess(next.sort((a,b)=>a-b));
    }
    if(winners[objective].value>start.value+1e-10)improved=true;
   }
   if(!improved)break;
  }
 }
 const summary=w=>({score:w.score,synergy:w.synergy,count:w.count,enoughPlayers:true,
  lineup:w.indices.map(i=>{const c=candidates[i];return {pid:c.p.pid,name:c.p.name,pos:c.p.rating.pos,skills:c.skills,injured:c.p.injury.gamesRemaining>0};}).sort((a,b)=>talent(eligible.find(p=>p.pid===b.pid))-talent(eligible.find(p=>p.pid===a.pid))||a.pid-b.pid)});
 const result={...base,best:summary(winners.best),alternatives:Object.fromEntries(['fit','off','def','reb'].map(k=>[k,summary(winners[k])])),search:{tested,exact}};
 if(cache.size>=24)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
}
