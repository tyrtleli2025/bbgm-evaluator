import test from 'node:test';
import assert from 'node:assert/strict';
import { readLeague } from '../src/importer.mjs';
import { optimizeRotation,playingTimeSettings } from '../src/rotation.mjs';
import { evaluate,scheduleSeed } from '../src/evaluator.mjs';
import { collectTrial,pairedChanges } from '../src/trade.mjs';

test('rotation search preserves the league and verifies a reproducible order on independent games',()=>{
  const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
  league.teams=new Map([...league.teams].slice(0,3));
  const teamId=[...league.teams.keys()][0],roster=league.teams.get(teamId);
  roster.sort((a,b)=>a.valueNoPot-b.valueNoPot);
  roster.forEach((p,i)=>{p.rosterOrder=i;p.ptModifier=1;p.injury={type:'Healthy',gamesRemaining:0};});
  roster[0].injury={type:'Test injury',gamesRemaining:20};
  const before=structuredClone(league),options={teamId,seed:123,gamesPerOpponent:4};
  const result=optimizeRotation(league,options);
  assert.deepEqual(league,before);
  assert.deepEqual(optimizeRotation(league,options),result);
  assert.equal(result.rotation.length,roster.length);
  assert.deepEqual(result.rotation.map(p=>p.pid).sort((a,b)=>a-b),roster.map(p=>p.pid).sort((a,b)=>a-b));
  assert.equal(result.validationGamesPerOpponent,8);
  assert.ok(result.searchedCandidates<=96&&result.searchedCandidates>6);
  assert.ok(result.recommended.strength>=result.before.strength);
  assert.equal(result.rotation.find(p=>p.pid===roster[0].pid).available,false);
  assert.equal(result.rotation.find(p=>p.pid===roster[0].pid).minutes,0);
  assert.equal(result.rotation.find(p=>p.pid===roster[0].pid).startRate,0);
  assert.ok(Math.abs(result.rotation.reduce((sum,p)=>sum+p.startRate,0)-league.settings.numPlayersOnCourt)<1e-10);
  for(const [i,p] of result.rotation.entries()) {
    assert.equal(p.order,i+1);assert.ok(playingTimeSettings.includes(p.ptModifier));
    assert.ok(Number.isFinite(p.minutes)&&p.minutes>=0);
  }
  const candidate=result.testedRotation.map((p,i)=>({...roster.find(x=>x.pid===p.pid),ptModifier:p.ptModifier,rosterOrder:i}));
  const validation={teamId,seed:scheduleSeed(123,teamId,0,'rotation-validation'),gamesPerOpponent:8};
  const beforeRows=[],afterRows=[];
  const a=evaluate(league,{...validation,onGame:collectTrial(teamId,beforeRows)});
  const b=evaluate({...league,teams:new Map(league.teams).set(teamId,candidate)},{...validation,onGame:collectTrial(teamId,afterRows)});
  assert.deepEqual(result.before,a.teams[0]);assert.deepEqual(result.tested,b.teams[0]);
  assert.deepEqual(result.delta,pairedChanges(beforeRows,afterRows));
});

test('rotation search rejects unsupported settings and insufficient availability',()=>{
  const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url)),teamId=[...league.teams.keys()][0];
  for(const options of [{teamId:999},{teamId,phase:'draft'},{teamId,health:'maybe'},{teamId,gamesPerOpponent:3}])assert.throws(()=>optimizeRotation(league,options));
  league.teams.get(teamId).forEach(p=>p.injury={type:'Out',gamesRemaining:99});
  assert.throws(()=>optimizeRotation(league,{teamId}),/available players/);
});
