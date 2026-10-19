import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTradeWork } from '../src/negotiation.mjs';
import { assessTrade } from '../src/trade-rules.mjs';

const fixture=()=>{
  const settings={season:2026,phase:0,userTid:0,difficulty:0,salaryCapType:'none',salaryCap:100000,minContract:500,maxContract:35000,godMode:false};
  const teams=new Map([0,1].map(tid=>[tid,Array.from({length:8},(_,i)=>({pid:10*tid+i,tid,firstName:'Player',lastName:String(10*tid+i),
    value:30+i*6+tid*2,valueNoPot:30+i*5,born:{year:1995+i},draft:{year:2014+i},injury:{gamesRemaining:0},gamesUntilTradable:0,
    contract:{amount:1000+i*250,exp:2028},ratings:[{season:2026,ovr:30+i*6}]}))]));
  return {settings,teams,rawData:{teams:[{tid:0,strategy:'contending'},{tid:1,strategy:'rebuilding'}],players:[...teams.values()].flat(),releasedPlayers:[],draftPicks:[]}};
};
const swap=(send=[0],receive=[16])=>({teams:[{tid:0,send},{tid:1,send:receive}]});

test('audited negotiation retains selected assets, adds an AI-acceptable player package, and stabilizes',async()=>{
  const league=fixture(),original=structuredClone(league);
  const result=await makeTradeWork(league,swap(),{teamId:0});
  assert.equal(result.status,'suggested');assert.equal(result.assessment.aiAcceptance,true);
  assert.ok(result.scenario.teams[0].send.includes(0));assert.ok(result.scenario.teams[1].send.includes(16));
  assert.ok(result.added.length>0);assert.match(result.provenance.upstreamPath,/makeItWork/);
  const second=await makeTradeWork(league,result.scenario,{teamId:0});
  assert.equal(second.status,'already-works');assert.deepEqual(second.scenario,result.scenario);
  assert.deepEqual(league,original);
});

test('negotiation respects protections, cooldowns, and missing data instead of inventing a deal',async()=>{
  const league=fixture();
  const protectedIds=league.teams.get(0).map(p=>p.pid);
  const protectedResult=await makeTradeWork(league,swap([],[17]),{teamId:0,excluded:{0:protectedIds}});
  assert.equal(protectedResult.status,'no-deal');
  league.teams.get(0)[0].gamesUntilTradable=4;
  assert.equal((await makeTradeWork(league,swap(),{teamId:0})).status,'no-deal');
  league.teams.get(0)[0].gamesUntilTradable=0;
  delete league.settings.difficulty;
  assert.equal((await makeTradeWork(league,swap(),{teamId:0})).status,'unavailable');
  const assumed=await makeTradeWork(league,swap(),{teamId:0,difficulty:0});
  assert.equal(assumed.status,'suggested');assert.equal(assumed.assessment.status,'conditional');
  assert.ok(assumed.assessment.details.assumptions.length);
});

test('salary legality stays separate from AI value and selected picks are explicitly unsupported for negotiation',async()=>{
  const league=fixture();league.settings.salaryCapType='soft';league.settings.salaryCap=1;league.settings.softCapTradeSalaryMatch=0;
  const result=await makeTradeWork(league,swap([7],[10]),{teamId:0});
  assert.equal(result.assessment.aiAcceptance,true);assert.equal(result.assessment.legal,false);
  assert.ok(result.reasons.some(r=>r.includes('violates') || r.includes('salary')));
  league.rawData.draftPicks=[{dpid:1,tid:0}];
  const picks=swap();picks.teams[0].picks=[1];
  assert.equal((await makeTradeWork(league,picks,{teamId:0})).status,'unavailable');
  assert.equal(assessTrade(league,swap([7],[10])).aiAcceptance,true);
});
