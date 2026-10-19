import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { assessTrade, TRADE_RULES_PROVENANCE } from '../src/trade-rules.mjs';

function fixture() {
  const settings = { season: 2026, phase: 0, userTid: 0, difficulty: 0, salaryCapType: 'none', salaryCap: 100000,
    minContract: 500, maxContract: 35000, softCapTradeSalaryMatch: 125, minRosterSize: 5, maxRosterSize: 18,
    challengeNoTrades: false, spectator: false, godMode: false };
  const teams = new Map([0,1].map(tid => [tid, Array.from({length:8}, (_,i) => ({
    pid: tid * 10 + i, tid, value: 30 + i * 6 + tid * 2, valueNoPot: 30 + i * 5,
    born: { year: 1995 + i }, draft: { year: 2014 + i }, injury: { gamesRemaining: 0 },
    gamesUntilTradable: 0, contract: { amount: 1000 + i * 250, exp: 2028 }, ratings: [{ season: 2026, ovr: 30 + i * 6 }],
  }))]));
  const rawData = { teams: [{tid:0,strategy:'contending'},{tid:1,strategy:'rebuilding'}],
    players: [...teams.values()].flat(), releasedPlayers: [], draftPicks: [{dpid:1,tid:0},{dpid:2,tid:1}] };
  return { settings, teams, rawData };
}
const swap = (send = [7], receive = [10]) => ({ teams: [{tid:0,send},{tid:1,send:receive}] });

test('audit sources match the pinned hashes', () => {
  for (const [name, hash] of Object.entries(TRADE_RULES_PROVENANCE.files)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../vendor/zengm/reference/${name}`,import.meta.url))).digest('hex'),hash);
  }
});

test('complete snapshots distinguish model-accepted, AI-rejected, and assumption-dependent trades', () => {
  const league = fixture(), original = structuredClone(league);
  assert.equal(assessTrade(league,swap()).status,'verified');
  const rejected = assessTrade(league,swap([0],[17]));
  assert.equal(rejected.status,'illegal'); assert.equal(rejected.legal,true); assert.equal(rejected.aiAcceptance,false);
  const assumed = assessTrade(league,swap(),{phase:1});
  assert.equal(assumed.status,'conditional'); assert.equal(assumed.aiAcceptance,true);
  assert.match(assumed.reasons.join(' '),/assumed/);
  assert.deepEqual(league,original);
});

test('missing metadata remains unknown rather than inventing AI acceptance or cap legality', () => {
  const league = fixture();
  league.settings.salaryCapType = 'soft';
  delete league.settings.phase; delete league.settings.difficulty; delete league.rawData.teams; delete league.rawData.releasedPlayers;
  const result = assessTrade(league,swap());
  assert.equal(result.status,'conditional'); assert.equal(result.legal,null); assert.equal(result.aiAcceptance,null);
  assert.match(result.reasons.join(' '),/phase/); assert.match(result.reasons.join(' '),/liabilities/); assert.match(result.reasons.join(' '),/strategy/);
});

test('soft cap uses the game floored percentage boundary and includes all released-player liabilities', () => {
  const league = fixture();
  league.settings.salaryCapType = 'soft'; league.settings.salaryCap = 100;
  league.teams.get(0)[7].contract.amount = 1000;
  league.teams.get(1)[0].contract.amount = 1259;
  assert.equal(assessTrade(league,swap()).legal,true); // 125.9 floors to 125
  league.teams.get(1)[0].contract.amount = 1260;
  assert.equal(assessTrade(league,swap()).legal,false);
  league.settings.salaryCap = 100000;
  assert.equal(assessTrade(league,swap()).legal,true);
  // Upstream current payroll intentionally does not filter releases by expiry.
  league.rawData.releasedPlayers.push({tid:0,contract:{amount:100000,exp:2000}});
  assert.equal(assessTrade(league,swap()).legal,false);
  const zero = fixture(); zero.settings.salaryCapType='soft'; zero.settings.salaryCap=1;
  assert.equal(assessTrade(zero,swap([], [10])).legal,false);
});

test('hard cap permits payroll decreases above cap and rejects increases above cap', () => {
  const league = fixture(); league.settings.salaryCapType='hard'; league.settings.salaryCap=1;
  assert.equal(assessTrade(league,swap()).legal,false); // the other side increases
  league.teams.get(0)[7].contract.amount = league.teams.get(1)[0].contract.amount;
  assert.equal(assessTrade(league,swap()).legal,true);
  const result = assessTrade(league,swap([7],[10,11]));
  assert.equal(result.legal,false);
});

test('transaction restrictions use phase, existing cooldown, and god-mode bypass, with no fictitious roster veto', () => {
  const league = fixture();
  for (const phase of [2,3]) assert.equal(assessTrade(league,swap(),{phase}).legal,false);
  league.teams.get(0)[7].contract.exp=2026; league.settings.phase=4;
  assert.equal(assessTrade(league,swap()).legal,false);
  league.settings.phase=8; assert.equal(assessTrade(league,swap()).legal,true);
  league.teams.get(0)[7].gamesUntilTradable=5;
  assert.equal(assessTrade(league,swap()).legal,false);
  league.settings.godMode=true; assert.equal(assessTrade(league,swap()).legal,true);
  league.settings.godMode=false; league.teams.get(0)[7].gamesUntilTradable=0;
  const result=assessTrade(league,swap([0,1,2,3,4,5,6,7],[]));
  assert.equal(result.legal,true); assert.ok(result.details.rosterWarnings.length);
  league.settings.challengeNoTrades=true; assert.equal(assessTrade(league,swap()).legal,false);
});

test('package ownership, arbitrary sizes, and pick valuation scope are explicit', () => {
  const league = fixture();
  assert.equal(assessTrade(league,swap([0,1,2],[10,11,12,13])).legal,true);
  for (const scenario of [swap([],[]),swap([0,0],[10]),swap([10],[0]),{teams:[{tid:0,send:[]},{tid:0,send:[0]}]}]) {
    assert.equal(assessTrade(league,scenario).legal,false);
  }
  const picks=swap(); picks.teams[0].picks=[1];
  assert.equal(assessTrade(league,picks).legal,true); assert.equal(assessTrade(league,picks).aiAcceptance,null);
  picks.teams[0].picks=[2]; assert.equal(assessTrade(league,picks).legal,false);
});

// Execute the actual audited upstream functions in a tiny DB/settings adapter.
// This checks the port against source rather than repeating its implementation.
const source=readFileSync(new URL('../vendor/zengm/reference/trade-rules-ai.ts',import.meta.url),'utf8');
function declaration(name) {
  const start=source.indexOf(`const ${name} = `);
  return source.slice(start,source.indexOf('\n};',start)+4);
}
const upstream = new Function('g','helpers','local','idb',stripTypeScriptTypes(`
 function factory() {
  const MIN_VALUE=-0.5, MAX_VALUE=2, EXPONENT=7;
  const PHASE={PLAYOFFS:3};
  const zscore=(value:number)=>(value-local.playerOvrMean)/local.playerOvrStd;
  ${declaration('getContractValue')}
  ${declaration('getPlayers')}
  ${declaration('valueToTradeValue')}
  ${declaration('sumValues')}
  return async function (pidsAdd,pidsRemove,strategy) {
    const add=[],remove=[];
    await getPlayers({add,remove,pidsAdd,pidsRemove,tid:1,tradingPartnerTid:0});
    return sumValues(add,strategy,1,true)-sumValues(remove,strategy,1);
  };
 }
`,{mode:'strip'}) + '\nreturn factory();');

test('player-only AI valuation matches the audited upstream implementation across packages and settings', async () => {
  for (const strategy of ['rebuilding','contending']) for (const phase of [0,1,4,8]) for (const difficulty of [-0.25,0,0.25,1]) {
    const league=fixture(); league.settings.phase=phase; league.settings.difficulty=difficulty;
    league.rawData.teams[1].strategy=strategy;
    const a=league.teams.get(0), b=league.teams.get(1);
    a[0].value=-10; a[1].value=90; a[2].value=60;
    a[1].injury.gamesRemaining=90; a[2].injury.gamesRemaining=35;
    a[0].contract={amount:30000,exp:2028,rookie:true}; a[0].draft.year=phase===0?2025:2026;
    a[2].contract.exp=2026; b[0].contract.exp=2027;
    league.rawData.players.push({tid:-1,ratings:[{ovr:85}]},{tid:-2,ratings:[{ovr:100}]});
    const values=league.rawData.players.filter(p=>p.tid>=-1).map(p=>p.ratings.at(-1).ovr);
    const mean=values.reduce((s,n)=>s+n,0)/values.length;
    const std=Math.sqrt(values.reduce((s,n)=>s+(n-mean)**2,0)/values.length);
    const fn=upstream({get:k=>league.settings[k]}, {
      bound:(x,min,max)=>Math.min(max,Math.max(min,x)),
      justDrafted:(p,ph,se)=>!!p.contract.rookie && ((p.draft.year===se && ph>=5)||(p.draft.year===se-1 && ph<1 && ph>=0)),
    }, {playerOvrMean:mean,playerOvrStd:std}, {cache:{players:{
      indexGetAll:async(_index,tid)=>league.teams.get(tid),get:async pid=>[...a,...b].find(p=>p.pid===pid),
    }}});
    for (const scenario of [swap([0,1,2],[10,11,12,13]),swap([1],[17]),swap([7],[])]) {
      // God mode permits expiring-contract transfers at phase 4; it does not
      // force acceptance, so the ordinary AI valuation is still checked.
      league.settings.godMode=true;
      const expected=await fn(scenario.teams[0].send,scenario.teams[1].send,strategy);
      const result=assessTrade(league,scenario);
      assert.ok(Math.abs(result.details.ai.valueChange-expected)<1e-9);
      assert.equal(result.aiAcceptance,expected>0);
    }
  }
});
