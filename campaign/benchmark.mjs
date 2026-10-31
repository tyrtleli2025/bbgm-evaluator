import { trainRelative, diagnoseRelative } from './relative-predictor.mjs';
import { validateRows } from './predictor.mjs';
import { sha256 } from './input.mjs';

// Fix the candidates before inspecting the evaluation results.
export const benchmarkCandidates = [
  { id:'current', profile:'full', lambda:.1 },
  { id:'full_1', profile:'full', lambda:1 },
  { id:'full_10', profile:'full', lambda:10 },
  { id:'top5_01', profile:'top5', lambda:.1 },
  { id:'top5_1', profile:'top5', lambda:1 },
  { id:'talent_age_01', profile:'talentAge', lambda:.1 },
  { id:'talent_age_1', profile:'talentAge', lambda:1 },
  { id:'talent_age_10', profile:'talentAge', lambda:10 },
];
const mean = values => values.reduce((a,b)=>a+b,0)/values.length;

export function benchmarkPredictors(rows) {
  validateRows(rows);
  const groups=[...new Set(rows.map(r=>r.group))].sort();
  if(groups.length<2)throw new Error('Benchmark needs at least two independent lineage groups');
  const models=[],candidates=[];
  for(const candidate of benchmarkCandidates){
    const folds=groups.map((heldOutGroup,fold)=>{
      const model=trainRelative(rows,{holdoutGroups:[heldOutGroup],profile:candidate.profile,lambda:candidate.lambda});
      model.datasetSha256=sha256(JSON.stringify(rows));
      model.benchmark={candidate:candidate.id,developmentGroups:groups,scope:'Development comparison; candidate selection uses all evaluated lineages. Fresh independent validation required.'};
      const modelFile=`${candidate.id}-fold${fold}.json`;
      models.push({file:modelFile,model});
      const e=model.evaluation;
      return {heldOutGroup,trainingGroups:model.training.groups,modelFile,rows:e.rows,rollouts:e.rollouts,
        rmse:e.rmse,mae:e.mae,uniformRMSE:e.uniformRMSE,zeroRMSE:e.zeroRMSE,ranking:e.ranking};
    });
    candidates.push({...candidate,folds,macroRMSE:mean(folds.map(f=>f.rmse)),macroMAE:mean(folds.map(f=>f.mae)),
      beatsUniformEveryFold:folds.every(f=>f.rmse<f.uniformRMSE)});
  }
  candidates.sort((a,b)=>a.macroRMSE-b.macroRMSE||a.id.localeCompare(b.id));
  const uniform=mean(candidates[0].folds.map(f=>f.uniformRMSE)),zero=mean(candidates[0].folds.map(f=>f.zeroRMSE));
  return {models,report:{formatVersion:1,datasetSha256:sha256(JSON.stringify(rows)),groups,
    rows:rows.length,rollouts:new Set(rows.map(r=>r.rollout??r.source)).size,candidates,
    baselines:{uniformMacroRMSE:uniform,zeroMacroRMSE:zero},developmentLeader:candidates[0].id,
    leaderBeatsBothBaselines:candidates[0].macroRMSE<Math.min(uniform,zero),
    readyForRecommendations:false,
    scope:'Whole lineages held out per fold; related sources, seeds and trade plans stay together. Macro errors weight lineages equally. Candidate selection uses these folds, so this is development feedback, not independent validation or a trade-ranking accuracy estimate. No model is deployed automatically.'}};
}

export function evaluateFrozenPredictor(model, rows) {
  validateRows(rows);
  const groups=[...new Set(rows.map(r=>r.group))].sort();
  const used=new Set([...(model.training?.groups??[]),...(model.training?.heldOutGroups??[]),...(model.benchmark?.developmentGroups??[])]);
  if(groups.some(g=>used.has(g)))throw new Error('Fresh evaluation requires lineages absent from training and development');
  const diagnostics=diagnoseRelative({...model,training:{...model.training,heldOutGroups:groups}},rows);
  return {mode:'frozen-evaluation',modelSha256:sha256(JSON.stringify(model)),datasetSha256:sha256(JSON.stringify(rows)),groups,
    trainingGroups:model.training.groups,diagnostics,readyForRecommendations:false,
    scope:'Fixed model, no fitting or candidate selection. Independent lineage assignment must be verified by the user. Team title errors alone do not establish trade-ranking accuracy.'};
}
