import {weights,playerOVR,revision} from './engine-data.mjs';
const sigmoid=(x,k,c)=>1/(1+Math.exp(-k*(x-c)));
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
export const skills={
 '3':['Three-point shooting','shootingThreePointer',.59],A:['Athleticism','athleticism',.63],
 B:['Ball handling','dribbling',.68],Di:['Interior defense','defenseInterior',.57],
 Dp:['Perimeter defense','defensePerimeter',.61],Po:['Post scoring','shootingLowPost',.61],
 Ps:['Passing','passing',.63],R:['Rebounding','rebounding',.61],
};
export function analyzeRoster(snapshot) {
 const {players,numPlayersOnCourt:n,threshold}=snapshot;
 if(!Array.isArray(players)||!players.length||!Number.isInteger(n)||n<1||n>20||!Number.isFinite(threshold)||threshold<0)throw new Error('Unsupported roster data from this BBGM version.');
 const ids=new Set();
 for(const p of players){
  if(!Number.isInteger(p.pid)||ids.has(p.pid)||!Number.isFinite(p.rosterOrder)||!Number.isFinite(p.injury?.gamesRemaining)||p.injury.gamesRemaining<0)throw new Error('Incomplete roster data.');
  ids.add(p.pid);
  for(const key of 'hgt stre spd jmp endu ins dnk ft fg tp oiq diq drb pss reb'.split(' '))if(!Number.isFinite(p.rating?.[key]))throw new Error('Missing underlying player ratings.');
 }
 const ordered=players.slice().sort((a,b)=>a.rosterOrder-b.rosterOrder||a.pid-b.pid);
 const lineup=ordered.filter(p=>p.injury.gamesRemaining<=threshold).slice(0,n);
 const contributions=lineup.map(p=>({pid:p.pid,name:p.name,pos:p.rating.pos,ptModifier:p.ptModifier,injured:p.injury.gamesRemaining>0,
  skills:Object.fromEntries(Object.entries(skills).map(([key,[,composite,cutoff]])=>{
   const w=weights[composite],denom=w.ratings.reduce((s,_,i)=>s+100*(w.weights?.[i]??1),0);
   const raw=w.ratings.reduce((s,r,i)=>s+(typeof r==='number'?r:p.rating[r])*(w.weights?.[i]??1),0)/denom;
   return [key,sigmoid(clamp(raw,0,1)*(1-.025*p.injury.gamesRemaining),15,cutoff)];
  }))}));
 const count=Object.fromEntries(Object.keys(skills).map(key=>[key,contributions.reduce((s,p)=>s+p.skills[key],0)]));
 const synergy=synergyFromCounts(count);
 // Upstream team/ovr.basketball.ts: talent baseline, with healthy true ratings.
 const ratings=players.map(p=>playerOVR(p.rating)).sort((a,b)=>b-a);while(ratings.length<10)ratings.push(0);
 const playoffs=snapshot.phase===3,a=playoffs ? .6388 : .3334,b=playoffs ? -.2245 : -.1609,k=playoffs ? 157.43 : 102.98;
 let mov=-k;
 if(n>=5)for(let i=0;i<10;i++)mov+=a*Math.exp(b*i)*ratings[i];
 else {let ri=0;for(let i=0;i<n;i++)mov+=a*Math.exp(b*i)*ratings[ri++];for(let i=5;i<10;i++)mov+=a*Math.exp(b*i)*ratings[ri++];mov+=60*(5-n)/5;}
 return {name:snapshot.name,tid:snapshot.tid,season:snapshot.season,gameVersion:snapshot.gameVersion,revision,
  teamOVR:Math.round(mov*50/15+50-(playoffs?40:0)),playoffs,lineup:contributions,count,
  enoughPlayers:lineup.length===n,numPlayersOnCourt:n,
  synergy:lineup.length===n?synergy:null};
}

export function synergyFromCounts(count) {
 const s=sigmoid,c=count;
 const off=(5*s(c['3'],3,2)+3*s(c.B,15,.75)+s(c.B,5,1.75)+3*s(c.Ps,15,.75)+s(c.Ps,5,1.75)+s(c.Ps,5,2.75)+s(c.Po,15,.75)+s(c.A,15,1.75)+s(c.A,5,2.75))/17*(.5+.5*clamp(Math.sqrt(1+c.B+c.Ps+c['3'])-1,0,2)/2);
 const def=(s(c.Dp,15,.75)+2*s(c.Di,15,.75)+s(c.A,5,2)+s(c.A,5,3.25))/6;
 const reb=(s(c.R,15,.75)+s(c.R,5,1.75))/4;
 return {off:100*off,def:100*def/(5/6),reb:100*reb/.5};
}
