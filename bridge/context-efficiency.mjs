export function rotationBlockers({queue,turn,collector,wait,wake,pending,unread=0,lastActivity=0,now=Date.now()}={}) {
  const reasons=[];
  if(queue?.running||queue?.queue?.length)reasons.push('prompt-queue');
  if(turn)reasons.push('model-turn');
  if(collector)reasons.push('reply-collector');
  if(wait)reasons.push('tool-wait');
  if(wake||pending)reasons.push('pending-wake');
  if(unread)reasons.push('unread-messages');
  if(now-lastActivity<60000)reasons.push('recent-activity');
  return reasons;
}

// Metadata only, bounded per chat. Reading diagnostics never schedules work.
export class ContextEfficiency {
  constructor({now=Date.now,maxChats=128}={}){this.now=now;this.maxChats=maxChats;this.rows=new Map();}
  record(key,kind,data){
    if(!/^(private|group):\d+$/.test(key))return;
    const row=this.rows.get(key)||{};
    row[kind]={...structuredClone(data),at:this.now()};this.rows.delete(key);this.rows.set(key,row);
    while(this.rows.size>this.maxChats)this.rows.delete(this.rows.keys().next().value);
  }
  view(key){return structuredClone(this.rows.get(key)||{});}
}
