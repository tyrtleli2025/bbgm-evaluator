import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { stripTypeScriptTypes } from 'node:module';
import { readLeague, normalizeLeague } from '../src/importer.mjs';
import { prepareTeam, simulate } from '../src/adapter.mjs';
import { evaluate, validateGame, summarizeStrata } from '../src/evaluator.mjs';
import { configureEngine, g, helpers } from '../src/engine-runtime.mjs';
import { COMPOSITE_WEIGHTS, PHASE, DEFAULT_PLAY_THROUGH_INJURIES } from '../.engine/common/constants.js';
import compositeRating from '../.engine/worker/core/player/compositeRating.js';
import fuzzRating from '../.engine/worker/core/player/fuzzRating.js';
import playThroughInjuriesFactor from '../.engine/common/playThroughInjuriesFactor.js';
import playerStats from '../.engine/worker/core/player/stats.basketball.js';
import teamStats from '../.engine/worker/core/team/stats.basketball.js';
import { bySport } from '../.engine/common/sportFunctions.js';
import { last, assertDefined } from '../.engine/common/utils.js';

const path = new URL('./fixtures/league.json.gz',import.meta.url);
const raw = JSON.parse(gunzipSync(readFileSync(path)));
const league = readLeague(path);
const tiny = () => ({...league,teams:new Map([...league.teams].slice(0,3))});

test('fixed export fixture is complete; gzip import preserves state; ratings use rating height',()=>{
  assert.equal(league.teams.size,30);
  assert.equal([...league.teams.values()].flat().length,458);
  assert.equal(league.settings.threePointTendencyFactor,0.512);
  assert.equal(league.settings.season,2006);
  assert.ok([...league.teams.values()].flat().every(p=>p.rating.season===2006));
  const dir=mkdtempSync(join(tmpdir(),'bbgm-import-'));
  try {
    const gz=join(dir,'league.json.gz');writeFileSync(gz,gzipSync(JSON.stringify(raw)));
    assert.deepEqual(readLeague(gz).teams,league.teams);
  } finally {rmSync(dir,{recursive:true});}
  const p=league.teams.get(0)[0];
  const a=prepareTeam(0,[...league.teams.get(0)],league.settings);
  const c=a.player.find(x=>x.id===p.pid).compositeRating;
  assert.equal(c.shootingAtRim,Math.min(1,(2*p.rating.hgt+0.3*p.rating.stre+0.3*p.rating.dnk+0.2*p.rating.oiq)/280));
});

test('invalid imports and evaluation options fail rather than silently guessing',()=>{
  const bad=structuredClone(raw);delete bad.gameAttributes;
  assert.throws(()=>normalizeLeague(bad),/gameAttributes/);
  const bad2=structuredClone(raw);bad2.players.find(p=>p.tid>=0).ratings.at(-1).hgt=NaN;
  assert.throws(()=>normalizeLeague(bad2),/rating hgt/);
  assert.throws(()=>evaluate(tiny(),{gamesPerOpponent:3}),/even integer/);
  assert.throws(()=>evaluate(tiny(),{teamId:999}),/Unknown team/);
  assert.throws(()=>evaluate(tiny(),{phase:'finals'}),/phase/);
});

test('season-indexed attributes use current, not future, settings',()=>{
  const data=structuredClone(raw);
  data.gameAttributes.pace=[{start:null,value:100},{start:2005,value:90},{start:2007,value:105}];
  assert.equal(normalizeLeague(data).settings.pace,90);
});

test('adapter matches upstream processTeam simulation inputs, including injuries',async()=>{
  // Execute upstream loader itself, replacing only DB/metadata dependencies.
  // Its OVR output is display metadata, not an input used by GameSim.
  let source=stripTypeScriptTypes(readFileSync(new URL('../vendor/zengm/src/worker/core/game/loadTeams.ts',import.meta.url),'utf8'),{mode:'strip'});
  source=source.replace(/^import[\s\S]*?;\n/gm,'').replace(/^export default loadTeams;/m,'').replace(/^export /gm,'');
  const deps={player:{stats:playerStats,compositeRating,fuzzRating,fuzzOvrs:()=>undefined},
    team:{stats:teamStats,ovr:()=>0},season:{hasTies:()=>false},g,helpers,COMPOSITE_WEIGHTS,
    DEFAULT_PLAY_THROUGH_INJURIES,PHASE,playThroughInjuriesFactor,bySport,last,assertDefined,__SPORT:'basketball'};
  const processTeam=new Function(...Object.keys(deps),source+'\nreturn processTeam;')(...Object.values(deps));
  for(const phase of ['regular','playoffs']) {
    const roster=structuredClone(league.teams.get(0));
    roster[0].injury.gamesRemaining=3;
    roster[1].ptModifier=1.5;
    configureEngine({...league.settings,phase:phase==='playoffs'?PHASE.PLAYOFFS:PHASE.REGULAR_SEASON,
      userTids:[0],spectator:false});
    const upstream=await processTeam({tid:0,playThroughInjuries:DEFAULT_PLAY_THROUGH_INJURIES},
      {won:0,lost:0,cid:0,did:0},roster);
    const local=prepareTeam(0,roster,league.settings,{phase});
    assert.equal(local.pace,upstream.pace);
    assert.deepEqual(local.stat,upstream.stat);
    for(let i=0;i<local.player.length;i++) {
      for(const key of ['id','name','age','pos','valueNoPot','skills','injury','injured','ptModifier','compositeRating','stat']) {
        assert.deepEqual(local.player[i][key],upstream.player[i][key],`${phase}: ${key}`);
      }
    }
    const healthy=prepareTeam(0,roster,league.settings,{phase,health:'healthy'});
    assert.equal(healthy.player[0].injured,false);
    assert.equal(healthy.player[0].injury.gamesRemaining,0);
  }
});

test('seeded games reset state, restore RNG, and preserve box-score identities including OT',()=>{
  const a=prepareTeam(0,league.teams.get(0),league.settings);
  const b=prepareTeam(1,league.teams.get(1),league.settings);
  const original=structuredClone(a),random=Math.random;
  const first=simulate(a,b,league.settings,{seed:20});
  assert.deepEqual(first,simulate(a,b,league.settings,{seed:20}));
  assert.deepEqual(a,original);assert.equal(Math.random,random);
  let overtime=false;
  for(let seed=0;seed<200;seed++) {
    const game=simulate(a,b,league.settings,{seed});
    validateGame(game,league.settings,'regular');
    overtime ||= game.overtimes>0;
  }
  assert.ok(overtime,'exercise overtime minute accounting');
});

test('symmetric neutral teams have no material side advantage',()=>{
  const a=prepareTeam(0,league.teams.get(0),league.settings);
  const b=structuredClone(a);b.id=1;
  const margins=[];
  for(let seed=0;seed<600;seed++) {
    const game=simulate(a,b,league.settings,{seed,neutral:true});
    margins.push(game.team[0].stat.pts-game.team[1].stat.pts);
  }
  const avg=margins.reduce((s,x)=>s+x,0)/margins.length;
  assert.ok(Math.abs(avg)<2.5,`neutral clone mean margin ${avg}`);
});

test('stronger underlying ratings outperform weaker ones with equal rotation values',()=>{
  const base=structuredClone(league.teams.get(0));
  const altered=amount=>base.map(p=>({...p,rating:Object.fromEntries(Object.entries(p.rating).map(([k,v])=>
    [k,'hgt stre spd jmp endu ins dnk ft fg tp oiq diq drb pss reb'.split(' ').includes(k)?Math.min(100,Math.max(0,v+amount)):v]))}));
  const strong=prepareTeam(0,altered(15),league.settings),weak=prepareTeam(1,altered(-15),league.settings);
  let margin=0;
  for(let seed=0;seed<100;seed++) {
    const game=simulate(strong,weak,league.settings,{seed,neutral:true});
    margin+=game.team[0].stat.pts-game.team[1].stat.pts;
  }
  assert.ok(margin/100>15);
});

test('round-robin scores sum to zero, selected-team scores agree, and inputs remain unchanged',()=>{
  const l=tiny(),before=structuredClone(l);
  const options={gamesPerOpponent:4,seed:10};
  const all=evaluate(l,options);
  assert.equal(all.simulatedGames,12);
  assert.ok(Math.abs(all.teams.reduce((s,t)=>s+t.strength,0))<1e-10);
  assert.deepEqual(evaluate(l,{...options,teamId:0}).teams[0],all.teams.find(t=>t.tid===0));
  assert.deepEqual(l,before);
  for(const t of all.teams) {
    assert.ok(Math.abs(t.offensiveRating-t.defensiveRating-t.strength)<1e-10);
    assert.ok(t.strengthConfidence95[0]<t.strength && t.strength<t.strengthConfidence95[1]);
  }
});

test('stratified score keeps opponent weights fixed under unequal budgets',()=>{
  const s=summarizeStrata([[{net:10},{net:10}],[{net:0},{net:0},{net:0},{net:0}]],'net');
  assert.equal(s.estimate,5);
});
