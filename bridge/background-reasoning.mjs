import {FEATURE_LABELS} from './usage-features.mjs';
export const EFFORTS = Object.freeze(['low', 'high', 'max']);
export const BACKGROUND_DEFAULTS = Object.freeze(Object.fromEntries(Object.keys(FEATURE_LABELS).map(key =>
  [key, ['event_understanding','emotion_review','idle_association'].includes(key) ? 'low' : 'high'])));
export function validateEffortPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw Error('请选择要调整的模块');
  for (const [key, effort] of Object.entries(value)) {
    if (!Object.hasOwn(BACKGROUND_DEFAULTS,key) || !EFFORTS.includes(effort)) throw Error('模块或推理档位无效');
  }
  return {...value};
}
export function backgroundEffort(config, feature) {
  const selected = config?.backgroundReasoning?.[feature];
  return EFFORTS.includes(selected) ? selected : (BACKGROUND_DEFAULTS[feature] || 'high');
}
export function reasoningView(config) {
  return {options:EFFORTS, chatEffort:config?.dsh?.reasoningEffort || 'max', modules:Object.entries(FEATURE_LABELS).map(([id,label])=>
    ({id,label,effort:backgroundEffort(config,id),defaultEffort:BACKGROUND_DEFAULTS[id],note:id==='confirmation_review'?'同时核对完整原话和当前页的记忆关系，建议高档。':id==='candidate_review'?'旧版单独核对的兼容入口；自动确认使用确认联合复核。':id==='fact_review'?'手动关系核对和后续历史分页继续使用此档。':['memory_extract','coverage_check'].includes(id)?'默认保留高档；低档需先通过提取和查漏验证。':['fact_review','candidate_review','confirmation_review'].includes(id)?'涉及事实归属与冲突，建议保留高档。':'只调整此后台模块，不修改聊天档位。'}))};
}

// Cancellation must finish before releasing ownership. If it fails the caller
// retains the session and blocks admission until stopSessionWork succeeds.
export async function runBoundedHeadless({dispatch, wait, cancel, cleanup, timeoutMs, onCancelFailure=()=>{}}) {
  let timer, finished=false, abandoned=false, dispatchSettled=false;
  const submitted=Promise.resolve().then(dispatch);
  submitted.then(()=>{dispatchSettled=true;if(abandoned)void cancel().catch(error=>onCancelFailure(error,submitted));},()=>{dispatchSettled=true;});
  const result=submitted.then(()=>wait);
  wait.catch(()=>{});result.catch(()=>{});
  try {
    const value=await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('后台任务超时，已请求停止生成')),timeoutMs);})]);
    finished=true;return value;
  } finally {
    clearTimeout(timer);
    if(!finished){
      abandoned=true;
      try{await cancel();}catch(error){onCancelFailure(error,submitted);throw Error('后台任务停止失败，已暂停新的后台调用，等待重试取消');}
      if(!dispatchSettled){onCancelFailure(Error('后台提交尚未返回，等待确认后再次取消'),submitted);throw Error('后台提交尚未确认结束，已暂停新的后台调用');}
    }
    await cleanup();
  }
}
