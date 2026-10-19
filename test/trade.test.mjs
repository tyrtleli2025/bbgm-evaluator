import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readLeague } from '../src/importer.mjs';
import { prepareTrade, evaluateTrade, pairedChanges } from '../src/trade.mjs';

const league = readLeague(new URL('./fixtures/league.json.gz', import.meta.url));
const tiny = { ...league, teams: new Map([0,1,2].map(tid => [tid,league.teams.get(tid)])) };
const trade = { teams: [0,1].map(tid => ({ tid, send: [tiny.teams.get(tid)[0].pid] })) };

test('trade moves players exactly once, updates ownership, and preserves input and other rosters', () => {
  const original = structuredClone(tiny), scenario = structuredClone(trade);
  const {baseline,candidate} = prepareTrade(tiny,trade,0);
  assert.deepEqual(tiny,original);
  assert.deepEqual(trade,scenario);
  assert.deepEqual(candidate.teams.get(2),original.teams.get(2));
  const players = [...candidate.teams.values()].flat();
  assert.equal(new Set(players.map(p=>p.pid)).size,players.length);
  for (const [i,side] of trade.teams.entries()) {
    const p = players.find(p=>p.pid===side.send[0]);
    assert.equal(p.tid,trade.teams[1-i].tid);
    assert.ok(!candidate.teams.get(side.tid).some(p=>side.send.includes(p.pid)));
  }
  for(const state of [baseline,candidate]) for(const tid of [0,1]) {
    const roster = state.teams.get(tid);
    assert.ok(roster.every((p,i)=>p.rosterOrder===i && p.ptModifier===1));
    assert.ok(roster.every((p,i)=>i===0 || roster[i-1].valueNoPot>=p.valueNoPot));
  }
});

test('invalid trade scenarios fail explicitly', () => {
  assert.throws(()=>prepareTrade(tiny,{...trade,picks:[]},0),/Unsupported/);
  assert.throws(()=>prepareTrade(tiny,{teams:[{tid:0,send:[999999]},{tid:1,send:[]}]},0),/does not belong/);
  assert.throws(()=>prepareTrade(tiny,{teams:[{tid:0,send:[trade.teams[0].send[0],trade.teams[0].send[0]]},{tid:1,send:[]}]},0),/duplicate/);
  assert.throws(()=>prepareTrade(tiny,trade,2),/one of the trade teams/);
  assert.throws(()=>prepareTrade(tiny,{teams:[{tid:0,send:tiny.teams.get(0).map(p=>p.pid)},{tid:1,send:[]}]},0),/too few players/);
});

test('multi-player packages and an empty return package are supported', () => {
  const send = tiny.teams.get(0).slice(0,2).map(p=>p.pid);
  const {candidate} = prepareTrade(tiny,{teams:[{tid:0,send},{tid:1,send:[]}]},0);
  assert.equal(candidate.teams.get(0).length,tiny.teams.get(0).length-2);
  assert.equal(candidate.teams.get(1).length,tiny.teams.get(1).length+2);
});

test('paired uncertainty uses differences, including exact zero for unchanged trials', () => {
  const before = [1,100,2,101].map((net,i)=>({key:String(i),opponent:1,venue:i%2?'away':'home',net,offense:net+100,defense:100,win:1}));
  assert.deepEqual(pairedChanges(before,before).net,{estimate:0,standardError:0,confidence95:[0,0]});
  const after = before.map(r=>({...r,net:r.net+3,offense:r.offense+3}));
  assert.deepEqual(pairedChanges(before,after).net,{estimate:3,standardError:0,confidence95:[3,3]});
});

test('comparison is reproducible and paired changes match reported before/after strengths', () => {
  const options = {teamId:0,gamesPerOpponent:4,seed:9};
  const r = evaluateTrade(tiny,trade,options);
  assert.deepEqual(r,evaluateTrade(tiny,trade,options));
  assert.equal(r.comparisons.length,2);
  assert.equal(r.simulatedGames,32);
  for(const c of r.comparisons) {
    assert.ok(Math.abs(c.after.strength-c.before.strength-c.delta.net.estimate)<1e-10);
    assert.deepEqual(c.before.matchups.map(x=>x.opponent),c.after.matchups.map(x=>x.opponent));
    assert.ok(c.playerChanges.some(p=>p.status==='incoming'));
    assert.ok(c.playerChanges.some(p=>p.status==='outgoing'));
  }
});

test('CLI evaluates an example trade and finds player IDs using a compressed league', () => {
  const cwd = new URL('../',import.meta.url);
  const args = ['src/cli.mjs','--league','test/fixtures/league.json.gz'];
  const r = JSON.parse(execFileSync(process.execPath,[...args,'--team-id','29','--trade','scenarios/example-trade.json','--games-per-opponent','4','--json'],{cwd,encoding:'utf8'}));
  assert.equal(r.teamId,29);
  assert.equal(r.transfers.length,2);
  const players = JSON.parse(execFileSync(process.execPath,[...args,'--players','Drobnjak','--json'],{cwd,encoding:'utf8'}));
  assert.equal(players[0].pid,151);
});
