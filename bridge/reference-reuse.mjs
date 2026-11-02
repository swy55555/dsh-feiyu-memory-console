import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const labels = {summary: '会话摘要', history: '窗口前聊天原文'};
const understoodEvents = new Set(['user/message','assistant/message','assistant/chunk',
  'tool/call','tool/result','turn/start','turn/end','step/start','step/end',
  'request/header','request/context','todo/write','model/selection','agent/inbox/spliced','session/title']);
// Installed DSH records a transport acknowledgement watermark. It does not
// replace conversation nodes; refuse unfamiliar shapes of this plugin event.
const isDeliveryWatermark = e => e.type === 'session-log-deepseek/delivery-accepted'
  && !e.surfaceOp && Number.isInteger(e.data?.throughSeq) && Number.isInteger(e.data?.sessionFormatVersion)
  && typeof e.data?.sessionId === 'string'
  && Object.keys(e.data).every(k => ['sessionId','sessionFormatVersion','throughSeq'].includes(k));
const textOf = content => Array.isArray(content)
  ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';

// Receipts are process-local, scoped to both chat and DSH session. They contain
// hashes only. An accepted queue item alone is never proof of model context.
export class ReferenceReuse {
  constructor({now = Date.now, timeoutMs = 400, maxAgeMs = 10 * 60_000, maxReuse = 2, maxSessions = 128} = {}) {
    Object.assign(this, {now, timeoutMs, maxAgeMs, maxReuse, maxSessions});
    this.sessions = new Map();
    this.observed = new Map();
  }
  clear() { this.sessions.clear(); this.observed.clear(); }
  invalidate(sessionId) { this.sessions.delete(sessionId); this.observed.delete(sessionId); }
  observe(sessionId, event) {
    if(!sessionId || !Number.isInteger(event?.seq)) { this.invalidate(sessionId); return; }
    const prior=this.observed.get(sessionId);
    // A missed event may have compacted/replaced the surface. Never guess.
    if(prior && event.seq !== prior.lastSeq+1) this.invalidate(sessionId);
    if (event?.type?.startsWith('compaction/') || event?.type === 'session/end-seed'
      || (event?.surfaceOp !== undefined && event.surfaceOp !== 'append')
      || /(?:clear|reset|replace|truncate)/.test(event?.type || '')) this.invalidate(sessionId);
    const state=this.observed.get(sessionId)||{entries:[],lastSeq:event.seq};
    // Retain proof and placement only, never source text or tool outputs.
    const entry={type:event.type,seq:event.seq,surfaceOp:event.surfaceOp,ignorable:event.ignorable};
    if(event.type==='user/message')entry.promptHash=digest(textOf(event.data?.content));
    if(isDeliveryWatermark(event))entry.data={...event.data};
    state.entries.push(entry);state.lastSeq=event.seq;
    state.entries=state.entries.slice(-2048);
    let messages=0;
    for(let i=state.entries.length-1;i>=0;i--){
      if(state.entries[i].surfaceOp==='append'&&['user/message','assistant/message','tool/result'].includes(state.entries[i].type)&&++messages===24){state.entries=state.entries.slice(i);break;}
    }
    this.observed.set(sessionId,state);
    while(this.observed.size>this.maxSessions){const oldest=this.observed.keys().next().value;this.invalidate(oldest);}
  }
  history(sessionId){return {result:{ok:true,value:{events:(this.observed.get(sessionId)?.entries||[]).map(event=>({event}))}}};}
  async prepare({sessionId, key, content, blocks = [], history, enabled = true}) {
    const unchanged = {content, savedChars: 0, reused: [], commit() {}};
    if (!enabled || !sessionId || !key || !Array.isArray(content)) {
      this.invalidate(sessionId); return unchanged;
    }
    let state = this.sessions.get(sessionId);
    if (!state || state.key !== key) {
      state = {key, receipts: new Map(), busy: false};
      this.sessions.set(sessionId, state);
      while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    }
    // A simultaneous dispatch cannot rely on this uncommitted operation.
    if (state.busy) { this.invalidate(sessionId); return unchanged; }
    state.busy = true;
    const candidates = [];
    for (const block of blocks) {
      if (!labels[block?.id] || typeof block.text !== 'string' || block.text.length < 160
        || candidates.some(c => c.id === block.id)) continue;
      let count = 0, index = -1;
      content.forEach((part, i) => {
        if (part.type !== 'text' || typeof part.text !== 'string') return;
        const occurrences = part.text.split(block.text).length - 1;
        count += occurrences; if (occurrences) index = i;
      });
      if (count === 1) candidates.push({...block, index, hash: digest(block.text)});
    }
    const possible = candidates.filter(c => {
      const r = state.receipts.get(c.id);
      return r && r.hash === c.hash && this.now() - r.at < this.maxAgeMs && r.used < this.maxReuse;
    });
    let events = null, timer;
    if(history === undefined)history=()=>this.history(sessionId);
    if (possible.length && typeof history === 'function') {
      try {
        const response = await Promise.race([
          Promise.resolve().then(history),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), this.timeoutMs); })
        ]);
        if (response?.result?.ok && Array.isArray(response.result.value?.events))
          events = response.result.value.events.map(row => row.event);
      } catch {} finally { clearTimeout(timer); }
    }
    const current = () => this.sessions.get(sessionId) === state;
    // Refuse malformed history or context replacement. The
    // history tail includes replacement nodes and their compaction records.
    const safe = current() && events?.length && events.every(e => e && typeof e.type === 'string' && Number.isInteger(e.seq))
      && events.every((e, i) => !i || e.seq > events[i - 1].seq);
    const reusable = safe ? possible.filter(c => {
      const receipt = state.receipts.get(c.id);
      const source = events.find(e => e.type === 'user/message' && e.surfaceOp === 'append'
        && (e.promptHash || digest(textOf(e.data?.content))) === receipt.promptHash);
      // user/message is already on the model surface; inbox/spliced is only a
      // pending queue update and must never serve as proof. Waiting tools can
      // keep a turn open without removing this model-visible message.
      return source && events.filter(e => e.seq >= source.seq).every(e =>
        (understoodEvents.has(e.type) || e.ignorable === true || isDeliveryWatermark(e))
        && !e.type.startsWith('compaction/') && (e.surfaceOp === undefined || e.surfaceOp === 'append')
        && !/(?:clear|reset|replace|truncate)/.test(e.type));
    }) : [];
    let next = content.map(p => ({...p}));
    for (const block of reusable) {
      next[block.index].text = next[block.index].text.replace(block.text,
        `【沿用${labels[block.id]}】内容未变，沿用本会话此前全文；仅作历史参考，当前纠正优先，角色自述不证明身份。若全文不可见，按需检索，不要猜测。\n`);
    }
    let committed = false;
    return {
      content: next,
      savedChars: textOf(content).length - textOf(next).length,
      reused: reusable.map(c => c.id),
      commit: accepted => {
        if (committed) return; committed = true;
        if (!current()) return;
        state.busy = false;
        if (!accepted) { this.invalidate(sessionId); return; }
        const nextReceipts = new Map();
        for (const c of candidates) {
          const prior = state.receipts.get(c.id);
          nextReceipts.set(c.id, reusable.includes(c)
            ? {...prior, used: prior.used + 1}
            : {hash: c.hash, promptHash: digest(textOf(next)), at: this.now(), used: 0});
        }
        state.receipts = nextReceipts;
      }
    };
  }
}
