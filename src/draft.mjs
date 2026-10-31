import { readFileSync } from 'node:fs';
import develop from '../.engine/worker/core/player/developSeason.basketball.js';
import ovr from '../.engine/worker/core/player/ovr.basketball.js';
import { makeSeededRandom } from '../.engine/common/random.js';
import { prepareTeam, simulate } from './adapter.mjs';
import { estimatedPossessions, scheduleSeed, validateGame } from './evaluator.mjs';
const manifest=JSON.parse(readFileSync(new URL('../vendor/zengm/manifest.json',import.meta.url)));
const keys='hgt stre spd jmp endu ins dnk ft fg tp oiq diq drb pss reb'.split(' ');
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const quantile=(a,q)=>a.toSorted((a,b)=>a-b)[Math.floor((a.length-1)*q)];
export function draftBoard(league) {
  return (league.prospects??[]).filter(p=>Number.isInteger(p.pid)&&Number.isInteger(p.draft?.year)&&Number.isInteger(p.born?.year)&&keys.every(k=>Number.isFinite(p.rating?.[k])&&p.rating[k]>=0&&p.rating[k]<=100))
    .map(p=>({pid:p.pid,name:`${p.firstName} ${p.lastName}`,year:p.draft.year,age:p.draft.year-p.born.year,ovr:ovr(p.rating),pot:p.rating.pot,position:p.rating.pos,
      priority: Number.isFinite(p.value)?p.value:ovr(p.rating)}))
    .sort((a,b)=>a.year-b.year||b.priority-a.priority||a.pid-b.pid)
    .map((p,i,all)=>({...p,rank:i-all.findIndex(x=>x.year===p.year)+1}));
}
export function validateDraftOptions(league,input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new Error('Invalid draft projection settings');
  const options={teamId:input.teamId,pids:input.pids,seed:input.seed??12345,coaching:input.coaching??34,window:input.window??'balanced',paths:200,fitPaths:20};
  if(!league.teams.has(options.teamId)) throw new Error('Choose a team in this league');
  const board=draftBoard(league);
  if(options.pids===undefined) {
    const year=input.year??league.settings.season;
    if(!Number.isInteger(year)) throw new Error('Choose a draft class');
    options.pids=board.filter(p=>p.year===year).map(p=>p.pid);
  }
  if(!Array.isArray(options.pids)||options.pids.length<1||new Set(options.pids).size!==options.pids.length||options.pids.some(pid=>!board.some(p=>p.pid===pid))) throw new Error('No valid available prospects selected in this draft class');
  if(new Set(options.pids.map(pid=>board.find(p=>p.pid===pid).year)).size!==1) throw new Error('Compare prospects in the same draft class');
  if(board.find(p=>p.pid===options.pids[0]).year!==league.settings.season) throw new Error('Import a snapshot in the draft class’s year to project team fit');
  if(!Number.isSafeInteger(options.seed)||!Number.isFinite(options.coaching)||options.coaching<1||options.coaching>100||!['soon','balanced','later'].includes(options.window)) throw new Error('Invalid draft projection settings');
  return options;
}
export function developPath(player,startSeason,seed,coaching) {
  const p={...player,rating:{...player.rating},injury:{type:'Healthy',gamesRemaining:0},ptModifier:1};
  const old=Math.random; Math.random=makeSeededRandom(seed);
  try {return Array.from({length:5},(_,i)=>{
    develop(p.rating,startSeason+i+1-p.born.year,coaching);
    p.rating.ovr=ovr(p.rating);
    return {...p,rating:{...p.rating},valueNoPot:p.rating.ovr};
  });} finally {Math.random=old;}
}
const rotation=roster=>roster.slice().sort((a,b)=>b.valueNoPot-a.valueNoPot||a.pid-b.pid);
export function developmentOutlook(paths) {
  const peaks=paths.map(path=>Math.max(...path.map(p=>p.rating.ovr)));
  const probability=(ratings,threshold)=>mean(ratings.map(v=>v>=threshold?1:0));
  return {
    upside:{peakOVR:mean(peaks),peakRange80:[quantile(peaks,.1),quantile(peaks,.9)],
      chance60:probability(peaks,60),chance70:probability(peaks,70)},
    years:Array.from({length:5},(_,y)=>{
      const ratings=paths.map(path=>path[y].rating.ovr);
      return {year:y+1,ovr:mean(ratings),ovrRange80:[quantile(ratings,.1),quantile(ratings,.9)],
        rotationProbability:probability(ratings,50),starProbability:probability(ratings,60),eliteProbability:probability(ratings,70)};
    }),
  };
}
export function evaluateDraft(league,input) {
  const opt=validateDraftOptions(league,input), {teamId,seed,coaching,paths,fitPaths}=opt;
  const board=draftBoard(league), players=opt.pids.map(pid=>league.prospects.find(p=>p.pid===pid));
  const year=players[0].draft.year;
  if(year!==league.settings.season) throw new Error('Import a snapshot in the draft class’s year to project team fit');
  const opponents=[...league.teams.keys()].filter(id=>id!==teamId);
  if(!opponents.length) throw new Error('Team-fit evaluation requires an opposing team');
  const weights=opt.window==='soon'?[5,4,2,1,1]:opt.window==='later'?[1,1,2,4,5]:[1,1,1,1,1];
  const totalWeight=weights.reduce((a,b)=>a+b,0);
  const outlooks=[];
  const futures=players.map((p,i)=>{
    const projected=Array.from({length:paths},(_,trial)=>developPath(p,year,scheduleSeed(`draft:${seed}`,p.pid,0,trial),coaching));
    outlooks.push(developmentOutlook(projected));
    input.onProgress?.({completed:i+1,total:players.length,message:`Projecting development: ${i+1} / ${players.length} prospects`});
    // Only the shared team scenarios need full player objects after summarizing development.
    return projected.slice(0,fitPaths);
  });
  const observations=players.map(()=>Array.from({length:5},()=>[]));
  for(let trial=0;trial<fitPaths;trial++) {
    const teammatePaths=league.teams.get(teamId).map(p=>developPath(p,year,scheduleSeed(`draft:${seed}`,p.pid,0,trial),coaching));
    const opponentId=opponents[Math.floor(trial*opponents.length/fitPaths)];
    const opponentPaths=league.teams.get(opponentId).map(p=>developPath(p,year,scheduleSeed(`draft:${seed}`,p.pid,0,trial),34));
    for(let y=0;y<5;y++) {
      const settings={...league.settings,season:year+y+1};
      const baseRoster=rotation(teammatePaths.map(p=>p[y]));
      const baseline=prepareTeam(teamId,baseRoster,settings,{health:'healthy'});
      const other=prepareTeam(opponentId,rotation(opponentPaths.map(p=>p[y])),settings,{health:'healthy'});
      const totals=players.map(()=>({net:0,min:0,off:0,def:0,reb:0}));
      for(let venue=0;venue<2;venue++) {
        const gameSeed=scheduleSeed(`draft-games:${seed}`,trial,y,venue);
        const run=team=>{
          const game=simulate(venue?other:team,venue?team:other,settings,{seed:gameSeed});validateGame(game,settings,'regular');
          const us=game.team[venue?1:0],them=game.team[venue?0:1];
          return {us,net:100*(us.stat.pts-them.stat.pts)/estimatedPossessions(us.stat,them.stat)};
        };
        const base=run(baseline);
        for(let i=0;i<players.length;i++) {
          const prospect={...futures[i][trial][y],tid:teamId};
          const result=run(prepareTeam(teamId,rotation([...baseRoster,prospect]),settings,{health:'healthy'}));
          totals[i].net+=(result.net-base.net)/2;
          totals[i].min+=result.us.player.find(p=>p.id===prospect.pid).stat.min/2;
          for(const [key,ceiling] of Object.entries({off:1,def:5/6,reb:.5})) totals[i][key]+=50*(result.us.synergyAverage.raw[key]-base.us.synergyAverage.raw[key])/ceiling;
        }
      }
      totals.forEach((v,i)=>observations[i][y].push(v));
    }
    input.onProgress?.({completed:trial+1,total:fitPaths,message:`Evaluating team fit for ${players.length} prospects: scenario ${trial+1} / ${fitPaths}`});
  }
  const results=players.map((p,i)=>{
    const years=Array.from({length:5},(_,y)=>{
      const rows=observations[i][y];
      return {...outlooks[i].years[y],
        impact:mean(rows.map(r=>r.net)),minutes:mean(rows.map(r=>r.min)),
        synergy:Object.fromEntries(['off','def','reb'].map(k=>[k,mean(rows.map(r=>r[k]))]))};
    });
    const scores=Array.from({length:fitPaths},(_,t)=>mean(weights.map((w,y)=>observations[i][y][t].net*w))*5/totalWeight);
    const score=mean(scores),se=Math.sqrt(scores.reduce((s,v)=>s+(v-score)**2,0)/(fitPaths-1)/fitPaths);
    return {...board.find(b=>b.pid===p.pid),years,upside:outlooks[i].upside,score,scoreConfidence95:[score-1.96*se,score+1.96*se]};
  }).sort((a,b)=>b.score-a.score||a.pid-b.pid);
  return {model:'draft-development-fit-v2',engineRevision:manifest.revision,engineSourceHashes:manifest.files,...opt,draftYear:year,results,inputSha256:league.inputHash,
    warnings:['True underlying ratings are used; POT is not a development ceiling. Ranges reflect random future development.',
      'Five stochastic development seasons are modeled. Historical real-player determinism and future era changes are not modeled.',
      'All existing players are retained and aged; no retirements, trades, signings, salary costs, or roster-limit cuts are projected.',
      'Healthy players and automatic OVR-ordered rotations are assumed; OVR is used as the rotation-value proxy.',
      'Team impact uses 20 shared development scenarios and home/away games against a rotating sample of opponents, with default opponent coaching 34. Close scores may be simulation noise.',
      'Year 1 is the first preseason after this draft. Ranking is a time-weighted mean change in net points per 100 possessions. Coaching is an explicit fixed effective-level assumption.',
      'Upside probabilities measure reaching an OVR threshold in at least one of the first five post-draft seasons, not career ceilings or guarantees of awards.',
      'Availability is frozen at the imported snapshot. Search by player name rather than predicting pick order. Trade-up costs are not evaluated.']};
}
