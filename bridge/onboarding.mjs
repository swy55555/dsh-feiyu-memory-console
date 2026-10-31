import {createHash} from 'node:crypto';

export const SETUP_FEATURES = Object.freeze({
  memory:['dailyMemory','enabled',true],
  continuity:['continuity','enabled',false],
  self:['selfReference','enabled',false],
  learning:['mind','learningEnabled',false],
  association:['association','idleEnabled',false],
  feeling:['association','idleAffectEnabled',false],
});
export const setupRevision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function setupFeatures(cfg) {
  return Object.fromEntries(Object.entries(SETUP_FEATURES).map(([key,[group,field,def]])=>[key,def ? cfg.socialV2?.[group]?.[field]!==false : cfg.socialV2?.[group]?.[field]===true]));
}
const hasSelfHistory = state => Boolean(state?.temperament || state?.revision || ['claims','queue','seen','history','audit'].some(k=>state?.[k]?.length));
export function canChooseStarter(origin,state) { return origin?.freshPersona===true&&!hasSelfHistory(state); }
const personaSignature = p => setupRevision({spec:p.spec,baseline:p.baseline,current:p.current});

// A starter is a one-time seed for the NEW self-reference, never a reset of
// existing persona/experience files. Reject stale seeds after any prior growth.
export function setupInitialPersona(persona,setup,state,origin) {
  if(!setup?.starter||!canChooseStarter(origin,state)||setup.starterBaseHash!==personaSignature(persona))return persona;
  if(!Array.isArray(setup.starter)||setup.starter.length!==persona.spec.dimensions.length||new Set(setup.starter.map(r=>r?.key)).size!==persona.spec.dimensions.length)return persona;
  const result=structuredClone(persona);
  for(const row of setup.starter){
    if(!row||typeof row!=='object')return persona;
    const dim=result.spec.dimensions.find(d=>d.key===row.key);
    if(!dim||!Number.isInteger(row.value)||row.value<0||row.value>100)return persona;
    dim.baseline=row.value;result.baseline[row.key]=row.value;result.current[row.key]=row.value;
  }
  result.originBaseline=structuredClone(result.baseline);
  return result;
}

export function planSetup(file,body,{origin,state,persona,ownerAllowed,now=Date.now()}) {
  const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode})};
  if(body.revision!==setupRevision(file))fail('设置已被其他页面更新，请重新打开向导核对。',409);
  if(!body.features||Object.keys(body.features).length!==Object.keys(SETUP_FEATURES).length||Object.keys(body.features).some(k=>!Object.hasOwn(SETUP_FEATURES,k)||typeof body.features[k]!=='boolean'))fail('成长功能选项不完整。');
  const f=body.features;
  if((f.self||f.learning)&&!f.continuity)fail('自我成长与回应习惯需要开启连续事件理解。');
  if(f.feeling&&!f.association)fail('联想感受需要开启空闲联想。');
  if((f.self||f.continuity||f.learning||f.association)&&!ownerAllowed)fail('请先在访问与安全中设置主要使用者，并允许其私聊。');
  const next=structuredClone(file);next.socialV2??={};
  for(const [key,[group,field]]of Object.entries(SETUP_FEATURES))next.socialV2[group]={...(next.socialV2[group]||{}),[field]:f[key]};
  const setup={...(next.xinjiSetup||{}),completedAt:now};
  if(body.starter===null&&canChooseStarter(origin,state)){delete setup.starter;delete setup.starterBaseHash;}
  if(body.starter!==undefined&&body.starter!==null){
    if(!canChooseStarter(origin,state))fail('已有性格或经历，请在成长页面调整，向导不会重置。',409);
    if(!f.self)fail('选择初始倾向需要同时开启自我成长。');
    const dims=persona.spec.dimensions;
    if(!Array.isArray(body.starter)||body.starter.length!==dims.length||new Set(body.starter.map(r=>r?.key)).size!==dims.length||body.starter.some(r=>!dims.some(d=>d.key===r?.key)||!Number.isInteger(r.value)||r.value<0||r.value>100))fail('初始倾向必须包含全部维度，数值为 0–100 的整数。');
    setup.starter=body.starter.map(({key,value})=>({key,value}));setup.starterBaseHash=personaSignature(persona);
  }
  next.xinjiSetup=setup;
  return next;
}

export function growthStatus({cfg,state,ownerAllowed,paused=false,dshReady=true,now=Date.now()}) {
  const f=setupFeatures(cfg),queued=state?.queue?.length||0;
  const result={queued,required:12,claims:state?.claims?.filter(c=>c.status!=='retracted').length||0};
  if(!f.self)return {...result,kind:'disabled',text:'自我成长尚未开启'};
  if(!f.continuity)return {...result,kind:'blocked',text:'等待开启连续事件理解'};
  if(!ownerAllowed)return {...result,kind:'blocked',text:'等待配置主要使用者的私聊权限'};
  if(paused||!dshReady)return {...result,kind:'paused',text:paused?'桥接已暂停，成长暂缓':'DSH 未连接，等待恢复'};
  if(state?.lastReview?.status==='failed')return {...result,kind:'failed',text:'上次整理未完成，原话仍保留，等待重试'};
  if(!queued)return {...result,kind:result.claims?'ready':'empty',text:result.claims?'已有可修正的自我参考':'尚无待整理经历，从正常聊天开始'};
  if(queued<12)return {...result,kind:'accumulating',text:`正在积累：${queued}/12 条合格原话`};
  const wait=Math.max(0,(state.lastAttempt||0)+6*3600000-now);
  return {...result,kind:wait?'cooldown':'queued',text:wait?'已有足够原话，等待六小时整理间隔结束':'已进入整理队列，等待后台处理'};
}
