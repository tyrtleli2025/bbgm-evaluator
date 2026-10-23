import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { historicalTeamNames,resolveTeamNames } from '../src/team-names.mjs';
import { importSnapshot } from '../src/server.mjs';

test('historical names follow relocation and rebrand years without changing franchise IDs',()=>{
  const names=season=>historicalTeamNames(1990,season);
  assert.equal(names(1990).get(8).name,'Washington Bullets');
  assert.equal(names(2006).get(8).name,'Washington Wizards');
  assert.equal(names(2006).get(10).name,'Seattle SuperSonics');
  assert.equal(names(2026).get(10).name,'Oklahoma City Thunder');
  assert.equal(names(2006).get(18).name,'New Jersey Nets');
  assert.equal(names(2014).get(18).name,'Brooklyn Nets');
  assert.equal(names(1990).get(23).name,'Charlotte Hornets');
  assert.equal(names(2006).get(23).name,'New Orleans Hornets');
  assert.equal(names(2014).get(23).name,'New Orleans Pelicans');
  assert.equal(names(2006).get(29).name,'Charlotte Bobcats');
  assert.equal(names(2015).get(29).name,'Charlotte Hornets');
});

test('IDs compact at league creation, while expansions and later contractions preserve assigned IDs',()=>{
  assert.equal(historicalTeamNames(1947,1947).get(1).name,'Boston Celtics');
  assert.equal(historicalTeamNames(1947,1990).get(1).name,'Boston Celtics');
  assert.equal(historicalTeamNames(1990,1990).get(0).name,'Boston Celtics');
  assert.equal(historicalTeamNames(2004,2004,0).has(29),false);
  assert.equal(historicalTeamNames(2004,2004,8).get(29).name,'Charlotte Bobcats');
  assert.equal(historicalTeamNames(2026,2026).get(26).name,'Minnesota Timberwolves');
  assert.equal(historicalTeamNames(1800,2026).size,0);
});

test('exported names and custom labels take priority, and random leagues keep unknown IDs',()=>{
  const data={players:[{tid:0,real:true,srID:'example'}],teams:[{tid:0,region:'Custom',name:'Club',strategy:'rebuilding'}]};
  const settings={startingSeason:1990,season:2006};
  const resolved=resolveTeamNames(data,settings,[0,8,99]);
  assert.equal(resolved.get(0).name,'Custom Club');
  assert.equal(resolved.get(8).name,'Washington Wizards');
  assert.equal(resolved.get(99).name,'Team 99');
  assert.equal(data.teams[0].strategy,'rebuilding');
  assert.equal(resolveTeamNames({players:[]},settings,[0]).get(0).name,'Team 0');
  assert.equal(resolveTeamNames({players:[]},{...settings,teamInfoCache:[{region:'Cache',name:'Club'}]},[0]).get(0).name,'Cache Club');
});

test('web imports infer display names without inventing transaction metadata or editing the snapshot',()=>{
  const raw=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/league.json.gz',import.meta.url))));
  const player=raw.players.find(p=>p.tid>=0);player.real=true;player.srID='reference-player';
  const original=structuredClone(raw);
  const imported=importSnapshot(Buffer.from(JSON.stringify(raw)));
  assert.equal(imported.summary.teams.find(t=>t.tid===29).name,'Charlotte Bobcats');
  assert.equal(imported.summary.teams.find(t=>t.tid===8).name,'Washington Wizards');
  assert.equal(imported.summary.tradeContext.hasTeamStrategies,false);
  assert.equal(imported.league.rawData.teams,undefined);
  assert.deepEqual(raw,original);
});
