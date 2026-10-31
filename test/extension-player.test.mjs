import test from 'node:test';
import assert from 'node:assert/strict';
import {readLeague} from '../src/importer.mjs';
import {analyzeRoster} from '../extension/math.mjs';
import {analyzePlayer} from '../extension/player-math.mjs';
const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
const player=()=>({...structuredClone(league.teams.get(0)[0]),name:'Test Player',injury:{type:'Healthy',gamesRemaining:0}});
test('profile skills match roster contributions for healthy and playing-hurt players',()=>{
 for(const days of [0,3]){
  const p=player();p.injury.gamesRemaining=days;
  const snapshot={player:p,phase:3,threshold:4},copy=structuredClone(snapshot);
  const profile=analyzePlayer(snapshot);
  const roster=analyzeRoster({phase:3,threshold:4,numPlayersOnCourt:1,players:[p]});
  assert.deepEqual(profile.currentSkills,roster.lineup[0].skills);
  assert.equal(Object.keys(profile.skills).length,8);
  if(days)for(const key of Object.keys(profile.skills))assert.ok(profile.currentSkills[key]<profile.skills[key]);
  else assert.deepEqual(profile.currentSkills,profile.skills);
  assert.deepEqual(snapshot,copy);
 }
});
test('profile supports players without roster order and shows healthy skills when unavailable',()=>{
 const p=player();delete p.rosterOrder;delete p.ptModifier;p.tid=-2;p.injury.gamesRemaining=20;
 const result=analyzePlayer({player:p,phase:1,threshold:0});
 assert.equal(result.available,false);assert.equal(result.currentSkills,null);
 assert.equal(Object.keys(result.skills).length,8);
 delete p.rating.pss;assert.throws(()=>analyzePlayer({player:p,phase:1,threshold:0}),/ratings/);
});
