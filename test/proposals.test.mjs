import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { normalizeLeague } from '../src/importer.mjs';
import { rankProposals } from '../src/proposals.mjs';

const raw=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/league.json.gz',import.meta.url))));
const small={...raw,players:raw.players.filter(p=>[0,1,2].includes(p.tid)),draftPicks:[{dpid:1,tid:0,season:2007,round:1,desc:'2007 first'}]};
const league=normalizeLeague(small);
function offer(id,a,b) {
  return {id,warning:null,enablePropose:true,teams:[{tid:0,send:[a],picks:[]},{tid:1,send:[b],picks:[]}]};
}
const first=offer('one',league.teams.get(0)[0].pid,league.teams.get(1)[0].pid);
const second=offer('two',league.teams.get(0)[1].pid,league.teams.get(1)[1].pid);
function bundle(offers) {return {format:'bbgm-proposals-v1',context:{userTid:0,season:2006,phase:0},league:small,offers,collectedAt:'test',gameVersion:'test'};}

test('proposal ranking removes duplicates and warnings, preserves picks, and uses one baseline',()=>{
  const withPick=structuredClone(second);withPick.teams[0].picks=small.draftPicks;
  const data=bundle([first,{...first,id:'duplicate'},{...first,id:'bad',warning:'Over salary cap'},withPick]);
  const input=structuredClone(data);
  const r=rankProposals(league,data,{gamesPerOpponent:4,seed:4});
  assert.equal(r.evaluated,2);assert.equal(r.skipped.length,2);
  assert.equal(r.simulatedGames,24); // baseline + two candidates, 8 games each
  assert.ok(r.ranked[0].delta.net.estimate>=r.ranked[1].delta.net.estimate);
  for(const row of r.ranked) assert.ok(Math.abs(row.after.strength-r.baseline.strength-row.delta.net.estimate)<1e-10);
  assert.equal(r.ranked.find(r=>r.id==='two').picks[0].send[0].dpid,1);
  assert.deepEqual(data,input);
  const again=rankProposals(league,data,{gamesPerOpponent:4,seed:4});
  assert.deepEqual(r,again);
});

test('proposal validation rejects wrong team, blocked phase, stale ownership, and unknown picks',()=>{
  assert.throws(()=>rankProposals(league,bundle([first]),{teamId:2}),/userTid/);
  const blocked=bundle([first]);blocked.context.phase=2;
  assert.throws(()=>rankProposals(league,blocked),/deadline/);
  const stale=structuredClone(first);stale.teams[0].send=[999999];
  assert.throws(()=>rankProposals(league,bundle([stale])),/does not belong/);
  const pick=structuredClone(first);pick.teams[0].picks=[{dpid:9999}];
  assert.throws(()=>rankProposals(league,bundle([pick])),/Pick 9999/);
});

test('CLI proposal mode uses bundled snapshot and reports synergy',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bbgm-proposal-test-'));
  try {
    const path=join(dir,'offers.json');writeFileSync(path,JSON.stringify(bundle([first,second])));
    const result=JSON.parse(execFileSync(process.execPath,['src/cli.mjs','--proposals',path,'--games-per-opponent','4','--json'],{
      cwd:new URL('../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    assert.equal(result.evaluated,2);
    assert.ok(result.baseline.synergy.scale100.reb>=0);
  } finally {rmSync(dir,{recursive:true});}
});

test('browser collector uses live proposal API, deduplicates, filters warnings, downloads a snapshot',async()=>{
  const source=readFileSync(new URL('../scripts/collect-proposals.js',import.meta.url),'utf8');
  let batches=0,refreshes=0,blob,clicked=false;
  const errors=[];
  const context={userTid:0,season:2006,phase:0,lid:1};
  const rawOffer=(n,warning=null)=>({tid:1,pidsUser:[100+n],pids:[200+n],dpidsUser:[],dpids:[],picksUser:[],picks:[],summary:{warning,enablePropose:warning===null}});
  const api=async(category,name,args)=>{
    assert.equal(category,'main');
    if(name==='evalOnWorker') return JSON.stringify({context,league:{...small,gameAttributes:{...small.gameAttributes,tradeProposalsSeed:refreshes}}});
    if(name==='incrementTradeProposalsSeed') {refreshes++;return;}
    assert.equal(name,'runBefore');assert.equal(args.viewId,'tradeProposals');
    batches++;
    return {data:{seed:batches,offers:[rawOffer(0),rawOffer(batches*10+1),rawOffer(batches*10+2),rawOffer(batches*10+3),rawOffer(batches*10+4,'salary warning')]}};
  };
  await vm.runInNewContext(source,{bbgm:{toWorker:api},bbgmVersion:'test',structuredClone,Blob,
    URL:{createObjectURL:b=>{blob=b;return 'blob:test';},revokeObjectURL:()=>{}},
    document:{createElement:()=>({click:()=>{clicked=true;}})},setTimeout:fn=>fn(),
    console:{log:()=>{},error:e=>errors.push(e.message)}});
  assert.deepEqual(errors,[]);assert.ok(clicked);
  const data=JSON.parse(await blob.text());
  assert.equal(data.offers.length,20);assert.ok(refreshes>=3);assert.ok(data.rejected.length>0);
  assert.equal(data.context.userTid,0);assert.equal(data.format,'bbgm-proposals-v1');
  assert.equal(new Set(data.offers.map(o=>JSON.stringify(o.teams))).size,20);
});

test('browser collector refuses a download when league changes during collection',async()=>{
  const source=readFileSync(new URL('../scripts/collect-proposals.js',import.meta.url),'utf8');
  let reads=0,downloaded=false;const errors=[];
  await vm.runInNewContext(source,{bbgm:{toWorker:async(_,name)=>{
    if(name==='evalOnWorker') return JSON.stringify({context:{userTid:0,season:2006+(reads++),phase:0,lid:1},league:small});
    if(name==='runBefore') return {data:{offers:[]}};
  }},structuredClone,Blob,URL:{createObjectURL:()=>{downloaded=true;}},
    console:{log:()=>{},error:e=>errors.push(e.message)}});
  assert.equal(downloaded,false);assert.match(errors[0],/League state changed/);
});
