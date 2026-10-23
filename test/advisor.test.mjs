import test from 'node:test';import assert from 'node:assert/strict';
import {readLeague} from '../src/importer.mjs';
import {recommendTrades,validateAdvisorOptions,advisorContext,contractRoster,contractLedger} from '../src/advisor.mjs';
import {assessTrade} from '../src/trade-rules.mjs';
function fixture(){const l=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));l.teams=new Map([...l.teams].slice(0,3));Object.assign(l.settings,{phase:0,userTid:0,difficulty:0,salaryCapType:'none'});l.rawData.releasedPlayers=[];l.rawData.teams=[...l.teams.keys()].map(tid=>({tid,strategy:'contending'}));for(const roster of l.teams.values())for(const p of roster){p.gamesUntilTradable=0;p.draft={year:l.settings.season-5};}return l;}
test('advisor validates bounded settings, protections and explicit cap assumptions',async()=>{
 const l=fixture();for(const v of [{budget:1},{teamId:99},{protectedPids:[99999]},{coaching:101},{maxAnnualIncrease:-1},{assumeNoReleased:'yes'}])assert.throws(()=>validateAdvisorOptions(l,{teamId:0,...v}));
 delete l.rawData.releasedPlayers;l.settings.salaryCapType='soft';
 assert.equal((await recommendTrades(l,{teamId:0,budget:200})).status,'needs-context');
 const context=advisorContext(l,{assumeNoReleased:true});assert.deepEqual(context.league.rawData.releasedPlayers,[]);assert.ok(context.assumptions.length);assert.equal(l.rawData.releasedPlayers,undefined);
 l.settings.phase=3;assert.equal((await recommendTrades(l,{teamId:0,budget:200})).status,'unavailable');
});
test('contract expiration replaces players and ends salary commitments at the correct season',()=>{
 const l=fixture(),p=l.teams.get(0)[0],r={...p,contract:{amount:2000,exp:l.settings.season}};
 assert.equal(contractRoster([r],l.settings.season,1,p).openSlots,0);
 const expired=contractRoster([r],l.settings.season+1,1,p);assert.equal(expired.openSlots,1);assert.ok(expired.roster[0].pid<0);
 l.rawData.releasedPlayers=[{tid:0,contract:{amount:500,exp:l.settings.season+1}}];
 const rows=contractLedger(l,[r],[],0);assert.equal(rows[0].before,2500);assert.equal(rows[1].before,500);assert.equal(rows[2].before,0);assert.equal(rows[0].change,-2000);
});
test('advisor returns reproducible accepted packages that honor protections and annual salary limits',async()=>{
 const l=fixture(),before=structuredClone(l);const options={teamId:0,budget:200,protectedPids:[l.teams.get(0)[0].pid],maxAnnualIncrease:0};
 const r=await recommendTrades(l,options);assert.ok(r.candidates.length>0);assert.deepEqual(l,before);
 assert.deepEqual(await recommendTrades(l,options),r);
 for(const c of r.candidates){const a=assessTrade(l,c.scenario,{teamId:0});assert.equal(a.legal,true);assert.equal(a.aiAcceptance,true);assert.equal(c.conditional,false);assert.ok(!c.scenario.teams[0].send.includes(options.protectedPids[0]));assert.equal(c.yearly.length,5);assert.ok(c.yearly.every(y=>y.change<=0));assert.deepEqual(c.yearly[0].contract,c.yearly[0].retained);assert.ok(Number.isFinite(c.score.estimate));assert.ok(Math.abs(c.score.estimate-c.yearly.reduce((s,y)=>s+y.contract.estimate,0)/5)<1e-10);}
});
