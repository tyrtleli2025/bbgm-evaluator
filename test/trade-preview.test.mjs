import test from 'node:test';
import assert from 'node:assert/strict';
import { readLeague } from '../src/importer.mjs';
import { normalizeTradeScenario, previewTrade, previewBaselineKey } from '../src/trade-preview.mjs';
const imported=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
const league={...imported,teams:new Map([...imported.teams].slice(0,3))};
const scenario={teams:[{tid:0,send:[league.teams.get(0)[0].pid]},{tid:1,send:[league.teams.get(1)[0].pid]}]};
const options={teamId:0,gamesPerOpponent:4,seed:21};

test('preview uses paired before/after games, accurate synergy changes, and immutable input',()=>{
  const original=structuredClone(league),events=[];
  const result=previewTrade(league,scenario,{...options,onProgress:p=>events.push(p)});
  assert.deepEqual(league,original);
  assert.ok(Math.abs(result.after.strength-result.before.strength-result.delta.net.estimate)<1e-9);
  for(const key of ['off','def','reb']) assert.equal(result.synergyChange[key],result.after.synergy.scale100[key]-result.before.synergy.scale100[key]);
  assert.equal(result.simulatedGames,16);
  assert.ok(events.some(p=>p.stage==='baseline') && events.some(p=>p.stage==='trade'));
  assert.equal(result.assessment.aiAcceptance,null);
});

test('baseline reuse preserves exact results across packages and partners and rejects incompatible keys',()=>{
  let cached;
  const first=previewTrade(league,scenario,{...options,onBaseline:value=>{cached=value;}});
  const replay=previewTrade(league,scenario,{...options,baselineCache:cached});
  assert.equal(replay.baselineReused,true);assert.equal(replay.simulatedGames,8);
  assert.deepEqual(first.before,replay.before);assert.deepEqual(first.after,replay.after);assert.deepEqual(first.delta,replay.delta);
  const other={teams:[scenario.teams[0],{tid:2,send:[league.teams.get(2)[0].pid]}]};
  const result=previewTrade(league,other,{...options,baselineCache:cached});
  assert.equal(result.baselineReused,true);assert.deepEqual(result.before,first.before);
  const more=previewTrade(league,scenario,{...options,gamesPerOpponent:6,baselineCache:cached});
  assert.equal(more.baselineReused,false);assert.equal(more.simulatedGames,24);
  assert.notEqual(previewBaselineKey(league,options),previewBaselineKey(league,{...options,health:'healthy'}));
});

test('illegal transactions still show hypothetical impact and pick-only deals have zero current impact',()=>{
  const locked=structuredClone(league);locked.settings.phase=3;
  const hypothetical=previewTrade(locked,scenario,options);
  assert.equal(hypothetical.assessment.legal,false);assert.ok(Number.isFinite(hypothetical.after.strength));
  locked.rawData.draftPicks=[{dpid:0,tid:0,season:2007,round:1}];
  const picks=previewTrade(locked,{teams:[{tid:0,send:[],picks:[0]},{tid:1,send:[]}]},options);
  assert.equal(picks.delta.net.estimate,0);assert.deepEqual(picks.delta.net.confidence95,[0,0]);
  assert.deepEqual(picks.synergyChange,{off:0,def:0,reb:0});
  assert.equal(picks.simulatedGames,8);assert.ok(picks.warnings.some(w=>w.includes('future cost/value')));
});

test('selection normalization rejects incorrect ownership and unplayable rosters before simulation',()=>{
  assert.throws(()=>normalizeTradeScenario(league,{teams:[{tid:0,send:[999999]},{tid:1,send:[]}]},0),/owned player/);
  assert.throws(()=>normalizeTradeScenario(league,{teams:[{tid:0,send:[],picks:[999]},{tid:1,send:[]}]},0),/draft pick/);
  assert.throws(()=>normalizeTradeScenario(league,scenario,2),/participate/);
  assert.throws(()=>previewTrade(league,{teams:[{tid:0,send:league.teams.get(0).map(p=>p.pid)},{tid:1,send:[]}]},options),/too few players/);
  const sorted=normalizeTradeScenario(league,{teams:[scenario.teams[1],scenario.teams[0]]},0);
  assert.equal(sorted.teams[0].tid,0);
});
