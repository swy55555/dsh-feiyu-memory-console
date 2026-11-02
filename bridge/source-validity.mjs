// Read-only local invalidation boundary. No model, state-file rewrite or numerical rollback.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
export class SourceValidity {
  constructor({file}){this.file=file;this.db=null;this.version=null;this.rows=[];this.signature='';}
  snapshot(){
    try{
      this.db??=new DatabaseSync(this.file,{readOnly:true});
      const version=this.db.prepare('PRAGMA data_version').get().data_version;
      if(version!==this.version){
        const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_corrections'").get();
        this.rows=exists?this.db.prepare("SELECT scope,event_id,source_version,revision FROM source_corrections WHERE state='revoked' ORDER BY scope,event_id,source_version").all():[];
        this.signature=createHash('sha256').update(JSON.stringify(this.rows)).digest('hex');this.version=version;
      }
      return {ok:true,rows:this.rows,revision:this.signature};
    }catch{this.close();return {ok:false,rows:[],revision:'unavailable'};}
  }
  revision(){return this.snapshot().revision;}
  correctionStatus(scope,version){
    try{if(!this.snapshot().ok)return null;return this.db.prepare('SELECT state,revision FROM source_corrections WHERE scope=? AND source_version=?').get(scope,version)||null;}catch{return null;}
  }
  clarificationReceipt(scope,version){
    try{if(!this.snapshot().ok)return null;const row=this.db.prepare('SELECT target_version,result FROM source_clarifications WHERE scope=? AND current_version=?').get(scope,version);return row?{...JSON.parse(row.result),sourceVersion:row.target_version}:null;}catch{return null;}
  }
  clarificationCandidates(scope,input,recent){
    if(!/^private:\d+$/.test(scope)||input.speakerId!==scope.slice(8)||!input.messageId||!this.snapshot().ok)return null;
    const find=id=>this.db.prepare('SELECT * FROM evidence_source_lookup WHERE key=? AND message_id=? AND user_id=? AND is_self=0').all(scope,String(id),input.speakerId);
    const current=find(input.messageId);
    if(current.length!==1||current[0].source_truncated||current[0].text!==input.text||Date.now()-current[0].at>10*60000||current[0].at>Date.now()+5000)return null;
    const candidates=[];
    for(const row of [...recent].reverse()){
      if(row.role!=='user'||row.truncated||row.id===input.messageId||typeof row.text!=='string'||row.text.length>1000)continue;
      const found=find(row.id),old=found[0];
      if(found.length!==1||old.source_truncated||old.text!==row.text||old.at>=current[0].at||current[0].at-old.at>45*60000)continue;
      const prior=this.db.prepare('SELECT state,revision FROM source_corrections WHERE source_version=?').get(old.source_version);
      if(prior?.state==='revoked'||candidates.some(c=>c.id===row.id))continue;
      candidates.push({id:row.id,text:row.text,version:old.source_version,revision:prior?.revision||0});
      if(candidates.length>=6)break;
    }
    return candidates.length?{scope,id:String(input.messageId),text:input.text,version:current[0].source_version,candidates}:null;
  }
  blocked(scope,evidence=[]){
    const ids=evidence.map(e=>typeof e==='string'?e:e?.id).filter(Boolean);
    if(!ids.length)return false;
    const s=this.snapshot();
    return !s.ok||s.rows.some(r=>r.scope===scope&&ids.includes(r.event_id));
  }
  close(){try{this.db?.close();}catch{}this.db=null;this.version=null;}
}
