import test from 'node:test';
import assert from 'node:assert/strict';
import { readLeague } from '../src/importer.mjs';
import { prepareTeam, simulate } from '../src/adapter.mjs';
import { evaluate } from '../src/evaluator.mjs';

const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));

test('synergy observation leaves random outcomes unchanged and covers game time including overtime',()=>{
  const a=prepareTeam(0,league.teams.get(0),league.settings),b=prepareTeam(1,league.teams.get(1),league.settings);
  let sawOvertime=false;
  for(let seed=0;seed<100;seed++) {
    const tracked=simulate(a,b,league.settings,{seed});
    const plain=simulate(a,b,league.settings,{seed,trackSynergy:false});
    for(const team of tracked.team) {
      const s=team.synergyAverage;
      assert.ok(Math.abs(s.seconds-team.stat.min*60/league.settings.numPlayersOnCourt)<1e-6);
      assert.ok(s.raw.off>=0 && s.raw.off<=1);
      assert.ok(s.raw.def>=0 && s.raw.def<=5/6);
      assert.ok(s.raw.reb>=0 && s.raw.reb<=0.5);
      for(const count of Object.values(s.fractionalSkills)) assert.ok(count>=0 && count<=5);
      delete team.synergyAverage;
    }
    assert.deepEqual(tracked,plain);
    sawOvertime ||= tracked.overtimes>0;
  }
  assert.ok(sawOvertime);
});

test('synergy uses lineup time rather than just the final lineup',()=>{
  const a=prepareTeam(0,league.teams.get(0),league.settings);
  const b=prepareTeam(1,league.teams.get(1),league.settings);
  const result=simulate(a,b,league.settings,{seed:7});
  assert.ok(result.team.some(t=>Math.abs(t.synergyAverage.raw.off-t.synergy.off)>1e-5));
});

test('synergy aggregates consistently when evaluating one team or a league',()=>{
  const small={...league,teams:new Map([...league.teams].slice(0,3))};
  const all=evaluate(small,{gamesPerOpponent:4});
  const one=evaluate(small,{teamId:0,gamesPerOpponent:4});
  assert.deepEqual(one.teams[0].synergy,all.teams.find(t=>t.tid===0).synergy);
  const s=one.teams[0].synergy;
  assert.equal(s.scale100.reb,200*s.raw.reb);
  for(const value of Object.values(s.scale100)) assert.ok(value>=0 && value<=100);
});
