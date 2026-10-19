import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../scripts/collect-snapshot.js',import.meta.url),'utf8');

async function collect(changed=false) {
  const calls=[],errors=[],downloads=[];let count=0,blob;
  const game={version:73,gameAttributes:{season:2006,userTid:29},players:[],teams:[],releasedPlayers:[],draftPicks:[]};
  await vm.runInNewContext(source,{bbgm:{toWorker:async(channel,command,code)=>{
    calls.push({channel,command,code});count++;
    return JSON.stringify({...game,...(changed && count===2?{players:[{pid:1,tid:29}]}:{})});
  }},Blob,URL:{createObjectURL:value=>{blob=value;return 'blob:test';},revokeObjectURL:()=>{}},
  document:{createElement:()=>({click(){downloads.push(this.download);}})},setTimeout:()=>{},
  console:{log:()=>{},error:error=>errors.push(error.message)}});
  return {calls,errors,downloads,blob};
}
test('snapshot collector only reads league state and downloads complete matching capture',async()=>{
  const result=await collect();assert.equal(result.calls.length,2);
  assert.ok(result.calls.every(c=>c.channel==='main' && c.command==='evalOnWorker'));
  assert.ok(result.calls[0].code.includes('p.tid>=-1'));
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.downloads,['bbgm-snapshot-2006-tid29.json']);
  const raw=JSON.parse(await result.blob.text());assert.equal(raw.gameAttributes.userTid,29);
});
test('snapshot collector refuses mismatched captures',async()=>{
  const result=await collect(true);assert.equal(result.downloads.length,0);assert.match(result.errors[0],/changed/);
});
