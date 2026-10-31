import test from 'node:test';import assert from 'node:assert/strict';
import {readLeague} from '../src/importer.mjs';
import {draftBoard,developPath,developmentOutlook,evaluateDraft,validateDraftOptions} from '../src/draft.mjs';
const league=readLeague(new URL('./fixtures/league.json.gz',import.meta.url));
league.prospects=league.teams.get(0).slice(0,2).map((p,i)=>({...structuredClone(p),pid:90000+i,tid:-2,born:{year:league.settings.season-19},draft:{year:league.settings.season}}));
test('draft board keeps available prospects and validates selections and assumptions',()=>{
 assert.equal(draftBoard(league).length,2);
 for(const pids of [[],[90000,90000],[99]])assert.throws(()=>validateDraftOptions(league,{teamId:0,pids}));
 assert.throws(()=>validateDraftOptions(league,{teamId:0,pids:[90000],coaching:101}));
 assert.throws(()=>validateDraftOptions(league,{teamId:0,pids:[90000],window:'unknown'}));
});
test('development is reproducible, restores RNG, leaves inputs untouched and ignores POT and fuzz',()=>{
 const p=league.prospects[0],before=structuredClone(p),rng=Math.random;
 const a=developPath(p,league.settings.season,123,34);
 const changed={...p,rating:{...p.rating,pot:0,fuzz:99}};
 assert.deepEqual(a.map(p=>p.rating.ovr),developPath(changed,league.settings.season,123,34).map(p=>p.rating.ovr));
 assert.equal(Math.random,rng);assert.deepEqual(p,before);
 assert.deepEqual(developPath(p,league.settings.season,123,34),a);
 assert.notDeepEqual(developPath(p,league.settings.season,124,34),a);
});
test('whole-class selection includes more than six prospects and excludes other classes and incomplete ratings',()=>{
 const expanded={...league,prospects:Array.from({length:8},(_,i)=>({...structuredClone(league.prospects[0]),pid:91000+i}))};
 expanded.prospects.push({...structuredClone(league.prospects[0]),pid:92000,draft:{year:league.settings.season+1}});
 expanded.prospects.push({...structuredClone(league.prospects[0]),pid:92001,rating:{ovr:50}});
 const options=validateDraftOptions(expanded,{teamId:0,year:league.settings.season});
 assert.deepEqual(options.pids,Array.from({length:8},(_,i)=>91000+i));
 assert.deepEqual(validateDraftOptions(expanded,{teamId:0}).pids,options.pids);
 assert.deepEqual(validateDraftOptions(expanded,{teamId:0,pids:options.pids}).pids,options.pids);
 assert.throws(()=>validateDraftOptions(expanded,{teamId:0,year:league.settings.season+1}),/snapshot in the draft class/);
 assert.throws(()=>validateDraftOptions(expanded,{teamId:0,year:'1990'}));
 assert.throws(()=>validateDraftOptions(expanded,{teamId:0,year:3000}),/No valid available/);
});
test('upside counts each development path once and can capture peaks before year five',()=>{
 const paths=[[60,70,50,40,30],[30,40,60,60,50],[30,40,50,59,59],[70,70,70,70,70]]
   .map(ratings=>ratings.map(ovr=>({rating:{ovr}})));
 const outlook=developmentOutlook(paths);
 assert.equal(outlook.upside.chance60,.75);
 assert.equal(outlook.upside.chance70,.5);
 assert.equal(outlook.upside.peakOVR,(70+60+59+70)/4);
 assert.equal(outlook.years[4].starProbability,.25);
 assert.equal(outlook.years[4].eliteProbability,.25);
 assert.equal(outlook.years[4].rotationProbability,.75);
});
test('draft fit comparisons are immutable and invariant to candidate ordering',()=>{
 const before=structuredClone(league),options={teamId:0,pids:[90000,90001],seed:71};
 const a=evaluateDraft(league,options),b=evaluateDraft(league,{...options,pids:[90001,90000]});
 assert.deepEqual(a.results,b.results);assert.deepEqual(league,before);
 const all=evaluateDraft(league,{teamId:0,seed:71});
 assert.deepEqual(all.results,a.results);
 const single=evaluateDraft(league,{teamId:0,pids:[90000],seed:71});
 assert.deepEqual(single.results[0],all.results.find(p=>p.pid===90000));
 for(const p of all.results) {
  assert.ok(p.upside.chance70<=p.upside.chance60);
  assert.ok(p.upside.chance60>=0&&p.upside.chance60<=1);
  assert.ok(p.upside.peakOVR>=p.years[4].ovr);
  for(const y of p.years)assert.ok(y.eliteProbability<=y.starProbability&&y.starProbability<=y.rotationProbability);
 }
 for(const p of a.results){assert.ok(Number.isFinite(p.score));assert.equal(p.years.length,5);for(const y of p.years){assert.ok(y.ovrRange80[0]<=y.ovrRange80[1]);assert.ok(y.minutes>=0);assert.ok(Number.isFinite(y.synergy.off));}}
});
