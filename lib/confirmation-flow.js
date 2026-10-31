import {candidateEvidenceContext,validateCandidateVerdict} from './candidate-auto.js';

// One model request per step at most; persistence and confirmation remain separate.
export async function advanceConfirmation(prepared,{combined,facts,save,confirm,valid}) {
  const check=()=>{if(!valid())throw Error('自动核对已关闭');};check();
  const evidence=candidateEvidenceContext(prepared);
  let verdict=prepared.evidenceVerdict;
  let readiness=prepared.automatic;
  if(readiness?.status==='manual')return {status:'manual',dependency:readiness.dependency||'relations',reason:readiness.reason};
  if(!verdict || prepared.needed){
    let review,evidenceOnly=false;
    if(!verdict){
      evidenceOnly=!prepared.needed;
      review=await combined({...prepared.context,operation:'confirm',evidence:prepared.evidence,evidenceOnly,
        ...(evidenceOnly?{related:[],offset:0}: {})});
      verdict=review.evidenceVerdict;
    }else{
      if(!validateCandidateVerdict(verdict,evidence))return {status:'manual',dependency:'source',reason:'原话支持不足或存在歧义，保留待确认'};
      review=await facts(prepared.context);
    }
    check();
    const result=await save({offset:evidenceOnly?0:prepared.context.offset,review,evidenceOnly});check();
    readiness=result.automatic;
    if(!validateCandidateVerdict(verdict,evidence))return {status:'manual',dependency:'source',reason:'原话支持不足或存在歧义，保留待确认'};
    if(readiness?.status==='manual')return {status:'manual',dependency:readiness.dependency||'relations',reason:readiness.reason};
    if(result.pending)return {status:'pending',reason:`历史已复核 ${result.reviewed}/${result.total} 条，原话核对结果已保存`};
  }
  if(!validateCandidateVerdict(verdict,evidence))return {status:'manual',dependency:'source',reason:'原话支持不足或存在歧义，保留待确认'};
  if(readiness?.status==='manual')return {status:'manual',dependency:readiness.dependency||'relations',reason:readiness.reason};
  if(readiness?.status==='reviewing')return {status:'pending',reason:readiness.reason};
  check();
  return confirm(evidence.revision);
}
