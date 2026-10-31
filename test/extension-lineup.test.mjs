import test from 'node:test';
import assert from 'node:assert/strict';
import {readLeague} from '../src/importer.mjs';
import {analyzeRoster} from '../extension/math.mjs';
import {analyzeLineups,lineupScore} from '../extension/lineup.mjs';
import {playerOVR} from '../extension/engine-data.mjs';
const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
const snapshot=()=>({name:'Test',phase:1,numPlayersOnCourt:5,threshold:0,players:league.teams.get(0).slice(0,7).map(p=>({...structuredClone(p),name:`${p.firstName} ${p.lastName}`,injury:{gamesRemaining:0}}))});
test('lineup search matches independent exhaustive enumeration and preserves roster',()=>{
 const s=snapshot(),copy=structuredClone(s),found=analyzeLineups(s);
 let best=-Infinity,maxOff=-Infinity;
 for(let a=0;a<7;a++)for(let b=a+1;b<7;b++){
  const players=s.players.filter((_,i)=>i!==a&&i!==b);
  const r=analyzeRoster({...s,players});
  best=Math.max(best,lineupScore(players.reduce((sum,p)=>sum+playerOVR(p.rating),0)/5,r.synergy,s.phase));
  maxOff=Math.max(maxOff,r.synergy.off);
 }
 assert.equal(found.search.tested,21);assert.equal(found.search.exact,true);
 assert.ok(Math.abs(found.best.score-best)<1e-9);assert.ok(Math.abs(found.alternatives.off.synergy.off-maxOff)<1e-9);
 assert.ok(found.best.score>=found.score-1e-9);assert.deepEqual(s,copy);
 assert.deepEqual(analyzeLineups({...s,players:s.players.slice().reverse()}).best,found.best);
});
test('injuries and insufficient eligibility update the search',()=>{
 const s=snapshot();const pid=analyzeLineups(s).best.lineup[0].pid;
 s.players.find(p=>p.pid===pid).injury.gamesRemaining=10;
 assert.ok(!analyzeLineups(s).best.lineup.some(p=>p.pid===pid));
 s.players.forEach(p=>p.injury.gamesRemaining=10);
 const unavailable=analyzeLineups(s);assert.equal(unavailable.best,null);assert.equal(unavailable.score,null);
});
