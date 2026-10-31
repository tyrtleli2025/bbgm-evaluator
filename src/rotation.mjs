import { evaluate, scheduleSeed } from './evaluator.mjs';
import { collectTrial, pairedChanges } from './trade.mjs';
import { prepareTeam } from './adapter.mjs';
import { makeSeededRandom } from '../.engine/common/random.js';

// Pinned upstream src/ui/views/Roster/PlayingTime.tsx.
export const playingTimeSettings=[0,0.75,1,1.25,1.5];
export const playingTimeLabel=value=>({0:'0',0.75:'−',1:'Normal',1.25:'+',1.5:'++'})[value]??`${value}×`;
const key=roster=>roster.map(p=>`${p.pid}:${p.ptModifier}`).join(',');
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const withRoster=(league,tid,roster)=>({...league,teams:new Map(league.teams).set(tid,roster)});

export function optimizeRotation(league,{teamId,phase='regular',health='current',seed=12345,gamesPerOpponent=20,onProgress}={}) {
  if(!league.teams.has(teamId))throw new Error('Choose a team in this league');
  if(!['regular','playoffs'].includes(phase)||!['current','healthy'].includes(health)||!Number.isSafeInteger(seed)||!Number.isInteger(gamesPerOpponent)||gamesPerOpponent<4||gamesPerOpponent>100||gamesPerOpponent%2)throw new Error('Invalid rotation settings');
  const original=league.teams.get(teamId),settings=league.settings;
  const prepared=prepareTeam(teamId,original,settings,{phase,health});
  const available=new Set(prepared.player.filter(p=>!p.injured).map(p=>p.id));
  const opponents=[...league.teams.keys()].filter(tid=>tid!==teamId).sort((a,b)=>mean(league.teams.get(a).map(p=>p.valueNoPot))-mean(league.teams.get(b).map(p=>p.valueNoPot))||a-b);
  if(!opponents.length)throw new Error('Rotation search requires an opposing team');
  const sampled=Array.from({length:Math.min(4,opponents.length)},(_,i)=>opponents[Math.floor((i+.5)*opponents.length/Math.min(4,opponents.length))]);
  const screenLeague={...league,teams:new Map([teamId,...sampled].sort((a,b)=>a-b).map(tid=>[tid,league.teams.get(tid)]))};
  const normalize=roster=>roster.map((p,i)=>({...p,rosterOrder:i}));
  const auto=rating=>normalize(original.slice().sort((a,b)=>Number(available.has(b.pid))-Number(available.has(a.pid))||rating(b)-rating(a)||a.pid-b.pid).map(p=>({...p,ptModifier:1})));
  const automatic=auto(p=>p.valueNoPot),byOVR=auto(p=>p.rating.ovr??p.valueNoPot);
  const rng=makeSeededRandom(scheduleSeed(seed,teamId,0,'rotation-search'));
  const pick=items=>items[Math.floor(rng()*items.length)];
  const candidates=[],seen=new Set();let simulatedGames=0;
  const run=(source,roster,stage,games,onGame)=>{
    const result=evaluate(withRoster(source,teamId,roster),{teamId,phase,health,gamesPerOpponent:games,seed:scheduleSeed(seed,teamId,0,stage),onGame});
    simulatedGames+=result.simulatedGames;return result;
  };
  const consider=roster=>{
    const id=key(roster);if(seen.has(id))return;
    seen.add(id);
    const score=run(screenLeague,roster,'rotation-screen',4).teams[0].strength;
    candidates.push({roster,score});candidates.sort((a,b)=>b.score-a.score||key(a.roster).localeCompare(key(b.roster)));
    onProgress?.({message:`Searching roster orders and playing time: ${seen.size} / 96 candidates`,completed:seen.size,total:96});
  };
  consider(original);consider(automatic);consider(byOVR);
  for(const boost of [1,1.25,1.5])for(const depth of [settings.numPlayersOnCourt+2,settings.numPlayersOnCourt+4]) {
    consider(automatic.map((p,i)=>({...p,ptModifier:i<settings.numPlayersOnCourt?boost:i<depth?1:0.75})));
  }
  // Beam-guided mutations explore starters, bench priority, and real game controls.
  // The cap includes duplicate attempts so tiny rosters cannot stall the search.
  for(let attempts=0;seen.size<96&&attempts<960;attempts++) {
    const parent=pick(candidates.slice(0,6)).roster.map(p=>({...p}));
    if(rng()<.5&&available.size>1) {
      const indices=parent.flatMap((p,i)=>available.has(p.pid)?[i]:[]);
      const a=pick(indices),b=pick(indices.filter(i=>i!==a));
      [parent[a],parent[b]]=[parent[b],parent[a]];
    } else {
      const p=pick(parent.filter(p=>available.has(p.pid)));
      p.ptModifier=pick(playingTimeSettings.filter(value=>value!==p.ptModifier));
    }
    consider(normalize(parent));
  }
  // Rerank only a few finalists, then lock one before the independent league-wide check.
  const finalists=candidates.slice(0,3);
  finalists.forEach((candidate,i)=>{
    onProgress?.({message:`Comparing finalist ${i+1} / ${finalists.length}`,completed:i,total:finalists.length});
    candidate.refined=run(screenLeague,candidate.roster,'rotation-refine',12).teams[0].strength;
  });
  finalists.sort((a,b)=>b.refined-a.refined||key(a.roster).localeCompare(key(b.roster)));
  const candidate=finalists[0].roster,validationGamesPerOpponent=Math.max(8,gamesPerOpponent);
  const beforeRows=[],afterRows=[],starts=new Map(),baselineStarts=new Map();
  const observer=(rows,counts)=>{
    const collect=collectTrial(teamId,rows);
    return trial=>{collect(trial);for(const p of trial.game.team.find(t=>t.id===teamId).player)counts.set(p.id,(counts.get(p.id)??0)+p.stat.gs);};
  };
  onProgress?.({stage:'Checking on fresh league-wide simulations',message:'Checking exported rotation on fresh league-wide simulations'});
  const before=run(league,original,'rotation-validation',validationGamesPerOpponent,observer(beforeRows,baselineStarts));
  onProgress?.({message:'Checking recommended rotation on the same fresh games'});
  const after=run(league,candidate,'rotation-validation',validationGamesPerOpponent,observer(afterRows,starts));
  const delta=pairedChanges(beforeRows,afterRows),changed=key(original)!==key(candidate);
  const keepCurrent=!changed||delta.net.estimate<=0;
  const chosen=keepCurrent?original:candidate,chosenSummary=(keepCurrent?before:after).teams[0],chosenStarts=keepCurrent?baselineStarts:starts;
  const rotation=chosen.map((p,i)=>({order:i+1,pid:p.pid,name:`${p.firstName} ${p.lastName}`,position:p.rating.pos,
    ovr:p.rating.ovr,available:available.has(p.pid),playingThrough:prepared.player.find(x=>x.id===p.pid).injury.playingThrough,
    ptModifier:p.ptModifier,playingTime:playingTimeLabel(p.ptModifier),
    startRate:(chosenStarts.get(p.pid)??0)/chosenSummary.games,
    minutes:chosenSummary.players.find(x=>x.pid===p.pid).min,
    beforeMinutes:before.teams[0].players.find(x=>x.pid===p.pid).min}));
  return {model:'rotation-search-v1',engineRevision:before.engineRevision,inputSha256:league.inputHash,teamId,phase,health,seed,
    status:keepCurrent?'keep-current':delta.net.confidence95[0]>0?'improved':'tentative',
    searchedCandidates:seen.size,sampledOpponents:sampled,simulatedGames,validationGamesPerOpponent,
    before:before.teams[0],tested:after.teams[0],recommended:chosenSummary,delta,
    rotation,testedRotation:candidate.map(p=>({pid:p.pid,ptModifier:p.ptModifier})),
    warnings:[...before.warnings,
      'Bounded simulation search finds a promising rotation, not a guaranteed global optimum. A finalist is selected before independent validation; small improvements can still be noise.',
      'Copy the roster order and playing-time settings into BBGM. Minutes are simulation averages, not exact assignments. The engine handles substitutions, fatigue, fouls, and blowouts; 0 can still play when needed.',
      'Opponents retain exported rotations. Current injuries follow the selected regular-season or playoff policy. Re-run when the roster or injuries change.',
      'The recommendation leaves your imported league unchanged. Main Team overview metrics continue to describe the exported rotation.']};
}
