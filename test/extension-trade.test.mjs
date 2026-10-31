import test from 'node:test';
import assert from 'node:assert/strict';
import {readLeague} from '../src/importer.mjs';
import {analyzeTrade} from '../extension/trade-math.mjs';
const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
const snapshot=()=>({tid:0,name:'User',otherName:'Other',season:2025,phase:1,numPlayersOnCourt:5,threshold:0,
 players:[0,1].flatMap(tid=>league.teams.get(tid).map(p=>({...structuredClone(p),tid,name:`${p.firstName} ${p.lastName}`}))),
 trade:[{tid:0,pids:[],dpids:[]},{tid:1,pids:[],dpids:[]}],picks:[{dpid:1,tid:0,name:'2026 first'}]});
test('multi-player trade uses incoming talent regardless of bench order and does not mutate input',()=>{
 const s=snapshot(),own=s.players.filter(p=>p.tid===0),other=s.players.filter(p=>p.tid===1);
 const star=other[0];for(const key of Object.keys(star.rating))if(typeof star.rating[key]==='number')star.rating[key]=100;
 star.rosterOrder=999;star.injury.gamesRemaining=0;
 s.trade[0].pids=own.slice(0,2).map(p=>p.pid);s.trade[1].pids=other.slice(0,3).map(p=>p.pid);
 const copy=structuredClone(s),r=analyzeTrade(s);
 assert.deepEqual(s,copy);assert.equal(r.outgoing.players.length,2);assert.equal(r.incoming.players.length,3);
 assert.ok(r.after.lineup.some(p=>p.pid===star.pid));assert.ok(r.after.lineup.every(p=>!s.trade[0].pids.includes(p.pid)));
 s.players.forEach(p=>p.rosterOrder=-p.rosterOrder);
 assert.deepEqual(analyzeTrade(s).after.synergy,r.after.synergy);
 star.injury.gamesRemaining=20;assert.ok(!analyzeTrade(s).after.lineup.some(p=>p.pid===star.pid));
});
test('pick-only trades have zero current impact and stale assets fail explicitly',()=>{
 const s=snapshot();s.trade[0].dpids=[1];const r=analyzeTrade(s);
 assert.equal(r.before.teamOVR,r.after.teamOVR);assert.deepEqual(r.before.synergy,r.after.synergy);
 assert.equal(r.outgoing.picks.length,1);assert.equal(r.selected,true);
 s.trade[1].dpids=[1];assert.throws(()=>analyzeTrade(s),/assets changed/);
 s.trade[1].dpids=[];s.trade[1].pids=[-999];assert.throws(()=>analyzeTrade(s),/assets changed/);
});
test('trading away a roster reports unavailable lineup rather than invented synergy',()=>{
 const s=snapshot();s.trade[0].pids=s.players.filter(p=>p.tid===0).map(p=>p.pid);
 const r=analyzeTrade(s);assert.equal(r.after.synergy,null);assert.equal(r.after.teamOVR,null);
 assert.equal(r.after.enoughPlayers,false);
});
