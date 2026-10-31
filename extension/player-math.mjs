import {analyzeRoster} from './math.mjs';

export function analyzePlayer(snapshot){
 const p=snapshot.player;
 if(!p||!Number.isFinite(p.injury?.gamesRemaining)||p.injury.gamesRemaining<0)throw new Error('Incomplete player data.');
 const base={...snapshot,numPlayersOnCourt:1,players:[{...p,rosterOrder:0,ptModifier:1}]};
 const current=analyzeRoster(base);
 const healthy=analyzeRoster({...base,players:[{...base.players[0],injury:{...p.injury,gamesRemaining:0}}]});
 return {kind:'player',pid:p.pid,name:p.name,pos:p.rating.pos,ratingSeason:p.rating.season,
  skills:healthy.lineup[0].skills,currentSkills:current.lineup[0]?.skills??null,
  injuryDays:p.injury.gamesRemaining,injuryType:p.injury.type,available:current.enoughPlayers,
  revision:healthy.revision,gameVersion:snapshot.gameVersion};
}
