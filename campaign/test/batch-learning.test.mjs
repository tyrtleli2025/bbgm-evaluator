import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,access,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smallLeague } from './fixture.mjs';
import { prepareBatch,collectBatch } from '../batch-learning.mjs';
let built=true;try{await access(new URL('../../.campaign-build/manifest.json',import.meta.url));}catch{built=false;}
test('batch preparation identifies lineages, skips incomplete files and deduplicates exports',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bbgm-prepare-'));
 try{
  const raw=smallLeague();await writeFile(join(dir,'BBGM_League_14_a.json'),JSON.stringify(raw));await writeFile(join(dir,'BBGM_League_14_b.json'),JSON.stringify(raw));
  await writeFile(join(dir,'BBGM_League_15_b.json'),JSON.stringify({players:[]}));
  const m=await prepareBatch(dir);assert.equal(m.entries.length,1);assert.equal(m.entries[0].group,'league14');assert.equal(m.skipped.length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('budgeted campaigns resume without duplicating data and reject changed inputs', {skip:!built,timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bbgm-batch-'));
 try{
  const path=join(dir,'input.json'),out=join(dir,'output');await writeFile(path,JSON.stringify(smallLeague()));
  const manifest={formatVersion:1,entries:[{league:path,group:'one',teamId:0,seeds:[1,2],plans:[]}]};
  const first=await collectBatch(manifest,{out,budget:1});assert.equal(first.status,'budget-limited');assert.equal(first.rows,4);assert.equal(first.budget.used,1);
  const second=await collectBatch(manifest,{out,budget:1});assert.equal(second.status,'complete');assert.equal(second.rows,8);assert.equal(second.reused,1);assert.equal(second.budget.used,1);
  const third=await collectBatch(manifest,{out,budget:0});assert.equal(third.reused,2);assert.equal(third.budget.used,0);assert.equal(third.rows,8);
  const reusable={...manifest,reuseReports:third.completed.map(t=>join(out,'runs',t.key+'.json'))};
  const copied=await collectBatch(reusable,{out:join(dir,'copy'),budget:0});assert.equal(copied.status,'complete');assert.equal(copied.reused,2);assert.equal(copied.rows,8);
  for(const row of copied.completed)assert.equal(JSON.parse(await readFile(join(dir,'copy','runs',row.key+'.json'))).batchKey,row.key);
  const rows=JSON.parse(await readFile(second.dataset));assert.equal(new Set(rows.map(r=>r.id)).size,8);assert.equal(new Set(rows.map(r=>r.rollout)).size,2);
  const changed=structuredClone(manifest);changed.entries[0].group='wrong';await assert.rejects(collectBatch(changed,{out,budget:1}),/changed/);
  await assert.rejects(collectBatch(manifest,{out:dir,budget:1}),/must not contain/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('batch stops after a rejected trade and retains its completed baseline', {skip:!built,timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bbgm-batch-fail-'));
 try{
  const path=join(dir,'input.json');await writeFile(path,JSON.stringify(smallLeague()));
  const bad={id:'bad',actions:[{type:'trade',teams:[{tid:0,pids:[999999],dpids:[]},{tid:1,pids:[],dpids:[]}]}]};
  const m={formatVersion:1,entries:[{league:path,group:'one',teamId:0,seeds:[1,2],plans:[bad]}]};
  const r=await collectBatch(m,{out:join(dir,'out'),budget:4});assert.equal(r.status,'failed');assert.equal(r.budget.used,2);assert.equal(r.rows,4);assert.equal(r.failures.length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
