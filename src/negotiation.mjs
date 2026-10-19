import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { normalizeTradeScenario, tradeAssessment } from './trade-preview.mjs';

const manifest = JSON.parse(readFileSync(new URL('../vendor/zengm/manifest.json',import.meta.url)));
let factory;
function upstreamFactory() {
  if (!factory) {
    const source = readFileSync(new URL('../vendor/zengm/reference/makeItWork.ts',import.meta.url),'utf8');
    if (createHash('sha256').update(source).digest('hex') !== manifest.auditFiles['reference/makeItWork.ts'].sha256) throw new Error('Upstream makeItWork source hash mismatch');
    // Execute the audited algorithm unchanged. Only its database, valuation,
    // and utility dependencies are replaced with snapshot-backed adapters.
    const js = stripTypeScriptTypes(source,{mode:'strip'})
      .replace(/^import[\s\S]*?;\n/gm,'')
      .replace(/^export default makeItWork;/m,'return makeItWork;');
    factory = new Function('idb','isUntradable','helpers','__SPORT',js);
  }
  return factory;
}

export async function makeTradeWork(league, inputScenario, options = {}) {
  const scenario = normalizeTradeScenario(league,inputScenario,options.teamId);
  const original = tradeAssessment(league,scenario,options);
  const phase = options.tradePhase ?? league.settings.phase;
  const warnings = ['This executes the pinned game’s negotiation algorithm for player assets. Draft picks are not offered because local AI pick valuation is not implemented.',
    'A counteroffer reflects AI willingness, not the trade with the best basketball impact. Salary rules are checked separately.'];
  const provenance = {source:manifest.source,revision:manifest.revision,
    upstreamPath:'src/worker/core/trade/makeItWork.ts',sha256:manifest.auditFiles['reference/makeItWork.ts'].sha256};
  const result = (status,reasons,changedScenario=scenario,assessment=original,added=[]) => ({status,scenario:changedScenario,assessment,added,reasons,warnings,provenance});
  if (scenario.teams.some(t=>t.picks.length)) return result('unavailable',['Remove selected picks to use local player negotiation. You can still simulate the package, or negotiate it in Basketball GM.']);
  if ([-2,-1,2,3].includes(phase) || league.settings.challengeNoTrades || league.settings.spectator) return result('no-deal',original.reasons);
  if (!original.details.ai) return result('unavailable',original.details.missing.length ? original.details.missing : original.reasons);
  const blocked = p => !league.settings.godMode && (
    p.contract?.exp <= league.settings.season && phase > 3 && phase < 8 || p.gamesUntilTradable > 0);
  const uncertain = p => !league.settings.godMode && (!Number.isInteger(p.contract?.exp) || !Number.isFinite(p.gamesUntilTradable));
  if (scenario.teams.some(t=>t.send.some(pid=>blocked(league.teams.get(t.tid).find(p=>p.pid===pid))))) return result('no-deal',original.reasons);
  const exclusions = options.excluded ?? {};
  for (const [tid,ids] of Object.entries(exclusions)) {
    if (!scenario.teams.some(t=>t.tid===Number(tid)) || !Array.isArray(ids) || ids.some(pid=>!Number.isInteger(pid) || !league.teams.get(Number(tid)).some(p=>p.pid===pid))) throw new Error('Invalid excluded-player list');
  }
  const available = scenario.teams.map(t=>{
    const selected = new Set(t.send);
    return league.teams.get(t.tid).filter(p=>selected.has(p.pid) || (!blocked(p) && !uncertain(p)));
  });
  if (available.some((roster,i)=>roster.length < league.teams.get(scenario.teams[i].tid).filter(p=>!blocked(p)).length)) {
    warnings.push('Players with missing tradability data were excluded from counteroffer additions.');
  }
  const rosters = new Map(scenario.teams.map((t,i)=>[t.tid,available[i].slice().sort((a,b)=>a.pid-b.pid)]));
  const upstreamTeams = scenario.teams.map(t=>({tid:t.tid,pids:[...t.send],pidsExcluded:exclusions[t.tid]??[],dpids:[],dpidsExcluded:[]}));
  const maxAdditions = available.reduce((sum,players,i)=>sum+players.filter(p=>!scenario.teams[i].send.includes(p.pid) && !upstreamTeams[i].pidsExcluded.includes(p.pid)).length,0);
  if (maxAdditions === 0) return original.aiAcceptance ? result('already-works',['The AI requests no additional available players.',...original.reasons]) : result('no-deal',['No unprotected tradable players remain to add.',...original.reasons]);
  const makeItWork = upstreamFactory()({cache:{
    players:{indexGetAll:async(_index,tid)=>rosters.get(tid)??[]},
    draftPicks:{indexGetAll:async()=>[]},
  }},p=>({untradable:blocked(p)}),{deepCopy:structuredClone},'basketball');
  let evaluatedPackages = 0;
  try {
    const proposed = await makeItWork(upstreamTeams,{holdUserConstant:false,maxAssetsToAdd:maxAdditions,
      valueChangeCalculator:{evaluate:async({pidsAdd,pidsRemove})=>{
        const test = {teams:[{tid:scenario.teams[0].tid,send:pidsAdd,picks:[]},{tid:scenario.teams[1].tid,send:pidsRemove,picks:[]}]};
        const assessment = tradeAssessment(league,test,options);
        if (!assessment.details.ai) throw new Error(assessment.details.missing.join(' '));
        evaluatedPackages++;
        options.onProgress?.({stage:'negotiation',message:`Checking counteroffer ${evaluatedPackages}`});
        return assessment.details.ai.valueChange;
      }}});
    if (!proposed) return result('no-deal',['The game’s player-only negotiation could not find an AI-acceptable counteroffer with these selections and protections.']);
    const updated = normalizeTradeScenario(league,{teams:proposed.map(t=>({tid:t.tid,send:t.pids,picks:[]}))},options.teamId);
    const assessment = tradeAssessment(league,updated,options);
    const added = updated.teams.flatMap(t=>t.send.filter(pid=>!scenario.teams.find(o=>o.tid===t.tid).send.includes(pid)).map(pid=>{
      const p = league.teams.get(t.tid).find(p=>p.pid===pid);
      return {pid,name:`${p.firstName} ${p.lastName}`,fromTid:t.tid,toTid:updated.teams.find(o=>o.tid!==t.tid).tid};
    }));
    return {...result(added.length?'suggested':'already-works',[
      assessment.legal===false ? 'The AI accepts this player value, but the transaction still violates a league rule. Review the salary and eligibility checks.' : 'The AI accepts this player package under the supplied context.',
      ...assessment.reasons,
    ],updated,assessment,added),evaluatedPackages};
  } catch (error) {
    return result('unavailable',[`Counteroffer valuation could not be completed: ${error.message}`]);
  }
}
