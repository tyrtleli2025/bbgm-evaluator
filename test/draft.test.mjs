import test from 'node:test';import assert from 'node:assert/strict';
import {readLeague} from '../src/importer.mjs';
import {draftBoard,developPath,evaluateDraft,validateDraftOptions} from '../src/draft.mjs';
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
test('draft fit comparisons are immutable and invariant to candidate ordering',()=>{
 const before=structuredClone(league),options={teamId:0,pids:[90000,90001],seed:71};
 const a=evaluateDraft(league,options),b=evaluateDraft(league,{...options,pids:[90001,90000]});
 assert.deepEqual(a.results,b.results);assert.deepEqual(league,before);
 for(const p of a.results){assert.ok(Number.isFinite(p.score));assert.equal(p.years.length,5);for(const y of p.years){assert.ok(y.ovrRange80[0]<=y.ovrRange80[1]);assert.ok(y.minutes>=0);assert.ok(Number.isFinite(y.synergy.off));}}
});
