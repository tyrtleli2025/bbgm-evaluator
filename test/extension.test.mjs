import test from 'node:test';import assert from 'node:assert/strict';
import {readLeague} from '../src/importer.mjs';import {prepareTeam} from '../src/adapter.mjs';
import {configureEngine} from '../src/engine-runtime.mjs';import GameSim from '../.engine/worker/core/GameSim.basketball/index.js';
import {analyzeRoster} from '../extension/math.mjs';
const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
const snapshot=()=>({name:'Test team',phase:1,numPlayersOnCourt:5,threshold:0,players:league.teams.get(0).map(p=>({...structuredClone(p),name:`${p.firstName} ${p.lastName}`}))});
test('extension starting synergy matches the actual engine, including injuries and reordered starters',()=>{
 for(const phase of [1,3]){
  const s=snapshot();s.phase=phase;s.threshold=phase===3?4:0;
  s.players.forEach((p,i)=>{p.rosterOrder=s.players.length-i;p.injury={type:'Healthy',gamesRemaining:0};});
  s.players[0].injury.gamesRemaining=3;s.players.at(-1).injury.gamesRemaining=20;
  const before=structuredClone(s),result=analyzeRoster(s);
  configureEngine({...league.settings,phase,injuryRate:0});
  const roster=s.players.slice().sort((a,b)=>a.rosterOrder-b.rosterOrder);
  const team=prepareTeam(0,roster,league.settings,{phase:phase===3?'playoffs':'regular'});
  const other=prepareTeam(1,league.teams.get(1),league.settings,{health:'healthy'});
  const sim=new GameSim({gid:1,teams:structuredClone([team,other]),doPlayByPlay:false,homeCourtFactor:1,allStarGame:false,baseInjuryRate:0,neutralSite:false});
  for(const [key,max] of Object.entries({off:1,def:5/6,reb:.5}))assert.ok(Math.abs(result.synergy[key]-100*sim.team[0].synergy[key]/max)<1e-10);
  assert.deepEqual(result.lineup.map(p=>p.pid).sort((a,b)=>a-b),sim.playersOnCourt[0].map(p=>p.id).sort((a,b)=>a-b));
  assert.deepEqual(s,before);
  const modifiers=structuredClone(s);modifiers.players.forEach(p=>p.ptModifier=1.5);
  assert.deepEqual(analyzeRoster(modifiers).synergy,result.synergy);
 }
});
test('extension reports unavailable lineup and validates incomplete ratings',()=>{
 const s=snapshot();s.players.forEach(p=>p.injury.gamesRemaining=99);
 assert.equal(analyzeRoster(s).synergy,null);assert.equal(analyzeRoster(s).enoughPlayers,false);
 delete s.players[0].rating.pss;assert.throws(()=>analyzeRoster(s),/ratings/);
});
