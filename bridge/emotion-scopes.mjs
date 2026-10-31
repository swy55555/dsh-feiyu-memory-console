import {emptyEmotion,normalizeEmotion,tickEmotion,applyEmotionEvent} from './emotion.js';
const bounded=(n,lo,hi)=>Math.max(lo,Math.min(hi,Number(n)||0));
export function emotionScope(key,speaker=''){
  if(/^private:\d+$/.test(String(key)))return key;
  if(/^group:\d+$/.test(String(key))&&/^\d+$/.test(String(speaker)))return key+'/member:'+speaker;
  return null; // Unknown/group-wide addressees cannot inherit a member's attitude.
}
export class EmotionScopes {
  constructor({ownerKey,legacy,load=()=>null,save=()=>{},now=Date.now}){
    Object.assign(this,{ownerKey,save,now});this.baseline=normalizeEmotion(legacy,now()).baseline;this.states=new Map();this.migrated=false;
    const stored=load();
    if(stored?.version===1&&Array.isArray(stored.states)){
      for(const [key,value] of stored.states)if(/^(private:\d+|group:\d+\/member:\d+)$/.test(key))this.states.set(key,normalizeEmotion(value,now()));
    }else{
      // Never attribute the old mixed global state to the owner. Rebuild only
      // attributable journal events; retain the complete legacy file as backup.
      for(const row of legacy?.journal?.events||[]){
        const i=row.input||{},key=emotionScope(i.chatKey||i.key,i.speakerId);
        if(!key||!Number.isFinite(row.at))continue;
        const base=this.states.get(key)||this.fresh(row.at);
        this.states.set(key,applyEmotionEvent(base,i,row.at));
      }
      this.migrated=true;
    }
    if(!this.states.has(ownerKey)&&emotionScope(ownerKey))this.states.set(ownerKey,this.fresh(now()));
    // Keep the personality change audit/cooldown; it is not a relationship mood.
    if(this.migrated&&this.states.has(ownerKey)){
      this.states.get(ownerKey).drifts=structuredClone(legacy?.drifts||[]);
      this.states.get(ownerKey).lastDriftAt=Number(legacy?.lastDriftAt)||0;
    }
  }
  fresh(now){const s=emptyEmotion(now);s.baseline={...this.baseline};s.mood={...this.baseline};Object.assign(s.state,this.baseline);return s;}
  get(key){return this.states.get(key)||this.fresh(this.now());}
  set(key,state){
    if(!/^(private:\d+|group:\d+\/member:\d+)$/.test(String(key)))return;
    // Never evict a relationship to make room: unknown excess scopes remain
    // neutral until the administrator removes old data explicitly.
    if(!this.states.has(key)&&this.states.size>=256)return;
    this.states.set(key,state);
  }
  persist(){this.save({version:1,states:[...this.states],migration:{legacyKept:true,attributableJournalOnly:true}});}
  owner(){return this.get(this.ownerKey);}
  sharedAt(now=this.now(),recovery={}){
    let v=0,a=0,mv=0,ma=0,conflictTone=0;const feelings=new Map();
    for(const raw of this.states.values()){
      const s=tickEmotion(raw,now,recovery);
      v+=s.state.valence-s.baseline.valence;a+=s.state.arousal-s.baseline.arousal;
      mv+=s.mood.valence-s.baseline.valence;ma+=s.mood.arousal-s.baseline.arousal;
      conflictTone=Math.max(conflictTone,s.dynamics.conflict);
      for(const f of s.state.feelings||[]){const old=feelings.get(f.kind);if(!old||old.level<f.level)feelings.set(f.kind,{kind:f.kind,label:f.label,level:f.level});}
    }
    return {mode:'shared',at:now,valence:bounded(this.baseline.valence+v,-1,1),arousal:bounded(this.baseline.arousal+a,0,1),moodValence:bounded(this.baseline.valence+mv,-1,1),moodArousal:bounded(this.baseline.arousal+ma,0,1),conflictTone,feelings:[...feelings.values()].sort((a,b)=>b.level-a.level).slice(0,2)};
  }
  view(chatKey,speaker='',now=this.now(),recovery={}){
    const key=emotionScope(chatKey,speaker),state=tickEmotion(this.get(key),now,recovery);
    state.sharedMood=this.sharedAt(now,recovery);
    state.scopeInfo={chat:chatKey||'',memberScoped:!!key&&key.includes('/member:'),isolated:true,moodShared:true,unknownAddressee:!key};
    // A group prompt without a specified recipient receives no member's event,
    // evidence or relationship score. Numeric overall mood remains available.
    return tickEmotion(state,now,recovery);
  }
}
