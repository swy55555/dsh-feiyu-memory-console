import {EFFORTS} from '../bridge/background-reasoning.mjs';

// Adapter for the installed DSH session controller. Never use selectModel here:
// that endpoint also persists the application's global default model selection.
export async function selectBackgroundModel(ctx, {sessionId,provider,model,reasoningEffort}) {
  const controller=ctx.get?.('sessionController') || ctx.sessionController;
  const agents=controller?.agents, llm=ctx.get?.('llm') || ctx.llm;
  if(!agents?.resolveAgent || !agents?.serializeImageAdmission || !agents?.selectForNextRequest || !llm?.resolveCallConfig)
    throw Error('当前 DSH 不支持隔离的后台模型设置，请升级兼容版本');
  if(typeof sessionId!=='string'||!sessionId.startsWith('session-')||typeof provider!=='string'||!provider||typeof model!=='string'||!model||!EFFORTS.includes(reasoningEffort))throw Error('后台模型参数无效');
  const resolved=await agents.resolveAgent(sessionId);
  if(resolved.error)throw resolved.error;
  const agent=resolved.agent;
  if(agents.presetForSession(agent.session)!=='qq-memory')throw Error('只能设置无工具的 qq-memory 后台会话');
  return agents.serializeImageAdmission(agent,async()=>{
    const selected=await llm.resolveCallConfig({provider,model,reasoningEffort});
    if(selected.provider!==provider||selected.model!==model||selected.reasoningEffort!==reasoningEffort)throw Error('模型未接受请求的推理档位');
    const selection={provider,model,reasoningEffort};
    agents.selectForNextRequest(agent,selection);
    return {selected:selection};
  });
}
