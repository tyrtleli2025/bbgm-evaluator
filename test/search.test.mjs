import test from 'node:test';
import assert from 'node:assert/strict';
import { readLeague } from '../src/importer.mjs';
import { prepareTrade } from '../src/trade.mjs';
import { searchTrades, rosterProxy } from '../src/search.mjs';
import { assessTrade } from '../src/trade-rules.mjs';

const fixture = readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
const tiny = { ...fixture,teams:new Map([...fixture.teams].slice(0,3)) };
const options = {teamId:0,iterations:120,maxDepth:2,beamWidth:6,finalists:2,gamesPerOpponent:4,seed:12345};

test('bounded search is reproducible, supports large packages, and leaves the import untouched', () => {
  const input = structuredClone(tiny), events = [];
  const result = searchTrades(tiny,{...options,onProgress:p => events.push(p)});
  assert.deepEqual(tiny,input);
  assert.deepEqual(result,searchTrades(tiny,options));
  assert.equal(result.search.candidatesEvaluated,120);
  assert.equal(result.search.depthReached,2);
  assert.ok(result.search.statesVisited <= 121);
  assert.ok(result.search.largestIncomingPackage > 2);
  assert.ok(result.search.largestOutgoingPackage > 2);
  assert.ok(result.routes.length > 0 && result.routes.length <= 2);
  assert.ok(events.some(p => p.stage === 'search'));
  assert.ok(events.some(p => p.stage === 'baseline'));
  assert.ok(events.some(p => p.stage === 'verify'));
});

test('every returned route can be replayed with ownership and transaction checks at each edge', () => {
  const result = searchTrades(tiny,options);
  for (const route of result.routes) {
    let current = structuredClone(tiny);
    for (const step of route.steps) {
      const assessment = assessTrade(current,step.scenario,{teamId:0});
      assert.notEqual(assessment.status,'illegal');
      assert.notEqual(assessment.aiAcceptance,false);
      const {candidate,transfers} = prepareTrade(current,step.scenario,0);
      assert.deepEqual(transfers,step.transfers);
      const ownership = new Map([...candidate.teams.values()].flat().map(p => [p.pid,p.tid]));
      candidate.rawData.players = candidate.rawData.players.map(p => ownership.has(p.pid) ? {...p,tid:ownership.get(p.pid)} : p);
      current = candidate;
      for (const [tid,roster] of current.teams) assert.ok(roster.every(p => p.tid === tid));
    }
    assert.deepEqual(route.roster.map(p => p.pid),current.teams.get(0).map(p => p.pid));
    assert.equal(route.depth,route.steps.length);
    assert.ok(route.depth <= options.maxDepth);
    assert.ok(route.roster.length >= tiny.settings.minRosterSize && route.roster.length <= tiny.settings.maxRosterSize);
    assert.ok(Math.abs(route.after.strength-result.baseline.teams[0].strength-route.delta.net.estimate) < 1e-9);
    assert.equal(route.gain,route.delta.net.estimate);
    assert.equal(route.feasibility,'conditional');
    assert.deepEqual(route.after.matchups.map(m => m.opponent),result.baseline.teams[0].matchups.map(m => m.opponent));
  }
  assert.ok(result.routes.every((route,i) => !i || result.routes[i-1].gain >= route.gain));
  assert.equal(result.search.simulatedGames,(1+result.routes.length)*8);
});

test('verified mode never describes missing transaction context as an achievable route', () => {
  const result = searchTrades(tiny,{...options,feasibility:'verified'});
  assert.deepEqual(result.routes,[]);
  assert.equal(result.bestRouteIndex,null);
  assert.equal(result.search.simulatedGames,8);
  assert.ok(result.warnings.some(w => w.includes('does not prove')));
  assert.ok(result.search.rejectedReasons['Trade feasibility is not fully verified'] > 0);
});

test('complete transaction context enables replayable routes accepted by the pinned AI', () => {
  const league=structuredClone(tiny);
  Object.assign(league.settings,{phase:0,userTid:0,difficulty:0});
  league.rawData.releasedPlayers=[];
  league.rawData.teams=[...league.teams.keys()].map(tid=>({tid,strategy:'contending'}));
  for(const roster of league.teams.values()) for(const p of roster) {
    p.gamesUntilTradable=0;
    p.draft={year:league.settings.season-5};
  }
  const result=searchTrades(league,{...options,iterations:1000,feasibility:'verified'});
  assert.ok(result.routes.length>0);
  for(const route of result.routes) {
    assert.equal(route.feasibility,'verified');
    for(const step of route.steps) {
      assert.equal(step.assessment.legal,true);
      assert.equal(step.assessment.aiAcceptance,true);
      assert.equal(step.assessment.details.assumptions.length,0);
    }
  }
});

test('search honors trade freezes and does not advance time to bypass them', () => {
  const locked = structuredClone(tiny);
  locked.settings.phase = 3;
  const result = searchTrades(locked,options);
  assert.deepEqual(result.routes,[]);
  assert.equal(result.search.legalCandidates,0);
  assert.ok(Object.keys(result.search.rejectedReasons).some(reason => /phase|playoff/i.test(reason)));
});

test('the cheap screen accounts for availability and stays distinct from simulator strength', () => {
  const roster = structuredClone(tiny.teams.get(0));
  const healthy = rosterProxy(roster,{health:'healthy'});
  const ranked = roster.slice().sort((a,b) => b.valueNoPot-a.valueNoPot);
  ranked[0].injury.gamesRemaining = 30;
  assert.equal(rosterProxy(roster,{health:'healthy'}),healthy);
  assert.ok(rosterProxy(roster,{health:'current'}) < healthy);
  roster.forEach(p => { p.injury.gamesRemaining = 30; });
  assert.equal(rosterProxy(roster),-Infinity);
});

test('work limits and invalid options fail before any search or simulation', () => {
  assert.throws(() => searchTrades(tiny,{...options,iterations:5001}),/iterations/);
  assert.throws(() => searchTrades(tiny,{...options,maxDepth:6}),/maxDepth/);
  assert.throws(() => searchTrades(tiny,{...options,finalists:11}),/finalists/);
  assert.throws(() => searchTrades(tiny,{...options,gamesPerOpponent:5}),/even/);
  assert.throws(() => searchTrades(tiny,{...options,teamId:999}),/Unknown team/);
  assert.throws(() => searchTrades(tiny,{...options,feasibility:'any'}),/feasibility/);
});
