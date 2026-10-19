import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { createApp, importSnapshot, validateJobOptions } from '../src/server.mjs';

const bytes = readFileSync(new URL('./fixtures/league.json.gz',import.meta.url));
const raw = JSON.parse(gunzipSync(bytes));
const tiny = {...raw, players:raw.players.filter(p=>[0,1].includes(p.tid))};

test('web import supports gzip, team selection metadata, and complete transaction context', () => {
  const imported=importSnapshot(bytes,'league.json.gz');
  assert.equal(imported.summary.teams.length,30);
  assert.equal(imported.summary.tradeContext.phase,null);
  assert.equal(imported.summary.tradeContext.hasTeamStrategies,false);
  assert.equal(imported.summary.teams[0].name,'Team 0');
  const complete=structuredClone(tiny);
  complete.gameAttributes.phase=0; complete.gameAttributes.userTid=1; complete.gameAttributes.difficulty=0;
  complete.teams=[{tid:0,region:'Test',name:'Zero',strategy:'contending'},{tid:1,region:'Test',name:'One',strategy:'rebuilding'}];
  complete.releasedPlayers=[{tid:0,contract:{amount:1000,exp:2007}}]; complete.draftPicks=[];
  const full=importSnapshot(Buffer.from(JSON.stringify(complete)));
  assert.equal(full.summary.teamId,1); assert.equal(full.summary.teams[1].name,'Test One');
  assert.equal(full.summary.tradeContext.hasTeamStrategies,true);
  assert.deepEqual(full.league.rawData.releasedPlayers,complete.releasedPlayers);
  assert.ok(full.league.rawData.players.every(p=>!p.stats && p.ratings.length===1));
  const bundle=importSnapshot(Buffer.from(JSON.stringify({format:'bbgm-proposals-v1',context:{userTid:1},league:complete,offers:[]})));
  assert.equal(bundle.summary.hasProposals,true);
  assert.throws(()=>importSnapshot(Buffer.from('not json')),/valid BBGM/);
  assert.throws(()=>importSnapshot(Buffer.from('null')),/league JSON object/);
});

test('web job budgets and modes are bounded before launching workers', () => {
  const {league}=importSnapshot(bytes);
  assert.equal(validateJobOptions(league,'evaluate',{teamId:29}).gamesPerOpponent,20);
  for (const options of [{teamId:999},{teamId:0,gamesPerOpponent:3},{teamId:0,gamesPerOpponent:5},
    {teamId:0,gamesPerOpponent:102},{teamId:0,phase:'finals'},{teamId:0,health:'wrong'},
    {teamId:0,iterations:5001},{teamId:0,maxDepth:6},{teamId:0,tradePhase:99},{teamId:0,feasibility:'force'}]) {
    assert.throws(()=>validateJobOptions(league,'search',options));
  }
});

async function start(t,options) {
  const server=createApp(options);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
async function json(base,path,body,method='POST') {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
}
async function waitFor(base,id) {
  for(let i=0;i<200;i++) {
    const result=await json(base,`/api/jobs/${id}`,undefined,'GET');
    if(result.data.status!=='running') return result.data;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Job did not finish');
}

test('HTTP website imports, evaluates, searches, cancels, and enforces request boundaries', async t => {
  const base=await start(t);
  const page=await fetch(base+'/'); assert.equal(page.status,200); assert.match(await page.text(),/BBGM Solver/);
  const upload=await fetch(base+'/api/import',{method:'POST',headers:{'X-Filename':'tiny.json.gz'},body:gzipSync(JSON.stringify(tiny))});
  const session=await upload.json(); assert.equal(upload.status,200); assert.equal(session.teams.length,2);
  const spec={sessionId:session.sessionId,type:'evaluate',options:{teamId:0,gamesPerOpponent:4}};
  const created=await json(base,'/api/jobs',spec); assert.equal(created.status,202);
  const evaluated=await waitFor(base,created.data.jobId); assert.equal(evaluated.status,'complete');
  assert.equal(evaluated.result.teams[0].games,4); assert.ok(Number.isFinite(evaluated.result.teams[0].synergy.scale100.off));
  const search=await json(base,'/api/jobs',{...spec,type:'search',options:{...spec.options,iterations:100,finalists:2,tradePhase:0}});
  const searched=await waitFor(base,search.data.jobId); assert.equal(searched.status,'complete');
  assert.equal(searched.result.model,'bounded-player-trade-search-v1');
  const long=await json(base,'/api/jobs',{...spec,type:'search',options:{...spec.options,iterations:5000,maxDepth:5,gamesPerOpponent:100,finalists:10}});
  assert.equal((await json(base,'/api/jobs',spec)).status,409);
  assert.equal((await json(base,`/api/jobs/${long.data.jobId}`,undefined,'DELETE')).data.status,'cancelled');
  const evil=await fetch(base+'/api/import',{method:'POST',headers:{Origin:'https://example.com'},body:'{}'});
  assert.equal(evil.status,403);
  const unknown=await fetch(base+'/src/importer.mjs'); assert.equal(unknown.status,404);
  assert.equal((await json(base,'/api/jobs',{...spec,sessionId:'missing'})).status,404);
  assert.equal((await json(base,'/api/jobs',{...spec,type:'proposals'})).status,400);
});

test('worker timeout terminates work and leaves the server responsive', async t => {
  const base=await start(t,{maxJobMs:1});
  const response=await fetch(base+'/api/import',{method:'POST',body:bytes});
  const session=await response.json();
  const job=await json(base,'/api/jobs',{sessionId:session.sessionId,type:'evaluate',options:{teamId:0,gamesPerOpponent:100}});
  const result=await waitFor(base,job.data.jobId);
  assert.equal(result.status,'failed'); assert.match(result.error,/limit/);
  assert.equal((await fetch(base+'/api/health')).status,200);
});

test('manual trade HTTP checks, previews, cache, negotiation, and replacement stay isolated',async t=>{
  const base=await start(t);
  async function upload() {
    return (await fetch(base+'/api/import',{method:'POST',body:JSON.stringify(tiny)})).json();
  }
  const session=await upload(),otherSession=await upload();
  const scenario={teams:[{tid:0,send:[tiny.players.find(p=>p.tid===0).pid]},{tid:1,send:[tiny.players.find(p=>p.tid===1).pid]}]};
  const options={teamId:0,gamesPerOpponent:4,scenario};
  const spec={sessionId:session.sessionId,type:'trade',options};
  const check=await json(base,'/api/trade-check',spec);
  assert.equal(check.status,200);assert.equal(check.data.assessment.aiAcceptance,null);
  const bad=structuredClone(spec);bad.options.scenario.teams[0].send=[scenario.teams[1].send[0]];
  assert.equal((await json(base,'/api/trade-check',bad)).status,400);
  const first=await json(base,'/api/jobs',spec);
  const preview=await waitFor(base,first.data.jobId);
  assert.equal(preview.status,'complete');assert.equal(preview.result.model,'interactive-trade-impact-v1');
  assert.ok(Number.isFinite(preview.result.synergyChange.off));assert.equal(preview.result.baselineReused,false);
  const repeated=await json(base,'/api/jobs',spec);
  const cached=await waitFor(base,repeated.data.jobId);
  assert.equal(cached.result.resultReused,true);assert.deepEqual(cached.result.delta,preview.result.delta);
  const modified=structuredClone(spec);modified.options.scenario.teams[1].send=[];
  const next=await json(base,'/api/jobs',modified);
  assert.equal((await waitFor(base,next.data.jobId)).result.baselineReused,true);
  const negotiation=await json(base,'/api/jobs',{...spec,type:'make-work'});
  const response=await waitFor(base,negotiation.data.jobId);
  assert.equal(response.status,'complete');assert.equal(response.result.status,'unavailable');
  assert.ok(response.result.reasons.length);
  const long={...spec,options:{...options,gamesPerOpponent:100}};
  const running=await json(base,'/api/jobs',long);
  assert.equal((await json(base,'/api/jobs',{...bad,replace:true})).status,400);
  assert.equal((await json(base,'/api/jobs',{...spec,sessionId:otherSession.sessionId,replace:true})).status,409);
  const replacement=await json(base,'/api/jobs',{...spec,replace:true});
  assert.equal(replacement.status,202);
  assert.equal((await waitFor(base,running.data.jobId)).status,'cancelled');
  assert.equal((await waitFor(base,replacement.data.jobId)).status,'complete');
  assert.equal((await fetch(base+'/trade-builder.js')).status,200);
  assert.equal((await fetch(base+'/collect-snapshot.js')).status,200);
});
