import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {validateLegacyStarter} from './legacy-starter.mjs';
import {seedTemperament} from './self-temperament.mjs';

const clone=structuredClone;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownIdentity=row=>['identity','origin'].includes(row?.category)&&(!row.referenceKind||row.referenceKind==='self');
export const LEGACY_REBASE_CONFIRMATION='覆盖旧基态与身份理解';

export function legacyRebaseRevision(persona,selfState){return digest({persona,selfState});}

export function planLegacyRebase({persona,selfState,card,preview,starter,revision,confirmation,now=Date.now()}){
  const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode})};
  if(revision!==legacyRebaseRevision(persona,selfState))fail('成长状态已变化，请重新打开预览核对。',409);
  if(confirmation!==LEGACY_REBASE_CONFIRMATION)fail('请确认会覆盖原有六维与身份理解。');
  if(!selfState||selfState.version!==1||!Array.isArray(selfState.claims))fail('现有自我参考不可用，未覆盖。',409);
  if(typeof card!=='string'||card.length<10||card.length>12000)fail('旧卡长度应为 10–12000 字。');
  const effective=selfState.temperament||persona,dims=effective?.spec?.dimensions;
  if(!Array.isArray(dims)||!dims.length)fail('当前六维不可用，未覆盖。',409);
  const parsed=validateLegacyStarter(preview,card,dims.map(d=>({key:d.key,label:d.label,value:effective.baseline?.[d.key]??d.baseline})));
  if(!Array.isArray(starter)||starter.length!==dims.length||new Set(starter.map(r=>r?.key)).size!==dims.length||starter.some(r=>!dims.some(d=>d.key===r?.key)||!Number.isInteger(r.value)||r.value<0||r.value>100))fail('请核对全部六维，数值须为 0–100 的整数。');
  const values=Object.fromEntries(starter.map(({key,value})=>[key,value]));
  const newSpec=clone(effective.spec);
  for(const d of newSpec.dimensions)d.baseline=values[d.key];
  const nextPersona=clone(persona),nextSelf=clone(selfState),before=clone(effective.current);
  nextPersona.spec=clone(newSpec);nextPersona.baseline=clone(values);nextPersona.current=clone(values);nextPersona.originBaseline=clone(values);nextPersona.narrative='';nextPersona.updatedAt=now;nextPersona.lastChangeAt=now;
  nextPersona.history=[...(nextPersona.history||[]),{at:now,kind:'legacy-rebase',previousBaseline:clone(persona.baseline),newBaseline:clone(values)}].slice(-60);
  const temperament=nextSelf.temperament?clone(nextSelf.temperament):seedTemperament(effective);
  temperament.spec=clone(newSpec);temperament.baseline=clone(values);temperament.current=clone(values);temperament.originBaseline=clone(values);temperament.pending={};temperament.lastChangeAt=now;
  temperament.history=[...(temperament.history||[]),{at:now,source:'legacy-rebase',changes:dims.map(d=>({key:d.key,before:before[d.key],after:values[d.key]}))}].slice(-60);
  const removed=nextSelf.claims.filter(ownIdentity);
  nextSelf.history=[...(nextSelf.history||[]),{revision:nextSelf.revision,at:now,claims:clone(nextSelf.claims),temperament:clone(nextSelf.temperament||null)}].slice(-20);
  nextSelf.claims=nextSelf.claims.filter(row=>!ownIdentity(row));
  nextSelf.temperament=temperament;nextSelf.legacy=parsed.legacy;nextSelf.revision=(nextSelf.revision||0)+1;
  nextSelf.audit=[...(nextSelf.audit||[]),{at:now,action:'legacy-rebase',revision:nextSelf.revision,removedIdentityClaims:removed.length,cardHash:parsed.legacy.sourceHash}].slice(-80);
  return {persona:nextPersona,selfState:nextSelf,removedIdentityClaims:removed.length,oldDimensions:before,newDimensions:values};
}

function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+process.pid+'.'+randomBytes(6).toString('hex')+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file)}
  catch(error){try{fs.unlinkSync(tmp)}catch{}throw error}
}
const journalName='pending.json';
function validId(id){return typeof id==='string'&&/^rebase-[0-9]{13}-[a-f0-9]{8}$/.test(id)}

// Roll back a process exit between the two state-file renames before loading either state.
export function recoverLegacyRebase({personaFile,selfFile,backupRoot}){
  const journal=path.join(backupRoot,journalName);
  if(!fs.existsSync(journal))return false;
  const pending=JSON.parse(fs.readFileSync(journal,'utf8'));
  if(!validId(pending?.id))throw Error('旧卡重建回滚标记无效');
  const backup=path.join(backupRoot,pending.id);
  for(const [file,name]of [[personaFile,'persona.json'],[selfFile,'self-reference.json']]){
    const saved=path.join(backup,name);
    if(!fs.existsSync(saved))throw Error('旧卡重建备份不完整，未继续启动');
    fs.copyFileSync(saved,file);
  }
  fs.unlinkSync(journal);
  return true;
}

export function commitLegacyRebase({personaFile,selfFile,backupRoot,persona,selfState}){
  const journal=path.join(backupRoot,journalName);
  if(fs.existsSync(journal))throw Error('上次重建事务未恢复，拒绝再次覆盖');
  if(!fs.existsSync(personaFile)||!fs.existsSync(selfFile))throw Error('现有成长文件不完整，未覆盖');
  const id=`rebase-${Date.now()}-${randomBytes(4).toString('hex')}`,backup=path.join(backupRoot,id);
  fs.mkdirSync(backup,{recursive:true,mode:0o700});
  fs.copyFileSync(personaFile,path.join(backup,'persona.json'));
  fs.copyFileSync(selfFile,path.join(backup,'self-reference.json'));
  atomicJson(journal,{id,at:Date.now()});
  try{
    atomicJson(personaFile,persona);
    atomicJson(selfFile,selfState);
    fs.unlinkSync(journal);
  }catch(error){
    recoverLegacyRebase({personaFile,selfFile,backupRoot});
    throw error;
  }
  return {backupId:id};
}
