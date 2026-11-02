// 她自己的记忆（P0.5 v1）：不放进向量库，先用本地 JSON，避免动 memvec 服务。
// 每条必须带来源（url/摘录/时间）；「读到的事实」和「模型的印象」分开标记。
export const SELF_MEMORY_LIMITS = Object.freeze({
  maxItems: 300,
  maxText: 200,
  maxExcerpt: 300,
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(Number(v)) ? Number(v) : a));

export function emptySelfMemory() {
  return { version: 1, items: [], updatedAt: Date.now() };
}

export function normalizeSelfMemory(raw) {
  const out = emptySelfMemory();
  const list = Array.isArray(raw?.items) ? raw.items : [];
  for (const row of list) {
    const text = String(row?.text || '').trim();
    if (!text) continue;
    out.items.push({
      id: String(row.id || `${Date.now()}-${out.items.length}`),
      text: text.slice(0, SELF_MEMORY_LIMITS.maxText),
      kind: row.kind === 'fact' ? 'fact' : 'impression',
      topic: String(row.topic || '').slice(0, 24),
      sourceUrl: String(row.sourceUrl || ''),
      // 旧记录没有 verified 字段：一律标 unknown，不靠模型回忆补来源。
      verified: ['verbatim', 'paraphrase', 'unverified'].includes(row.verified) ? row.verified : 'unknown',
      episodeId: String(row.episodeId || ''),
      excerpt: String(row.excerpt || '').slice(0, SELF_MEMORY_LIMITS.maxExcerpt),
      at: Number(row.at) || Date.now(),
      confidence: clamp(row.confidence ?? 0.6, 0, 1),
    });
  }
  out.items = out.items.slice(-SELF_MEMORY_LIMITS.maxItems);
  out.updatedAt = Number(raw?.updatedAt) || Date.now();
  return out;
}

export function addSelfMemory(state, { text, kind = 'impression', topic = '', sourceUrl = '', excerpt = '', episodeId = '', verified = '', at = Date.now(), confidence = 0.6 } = {}) {
  const s = normalizeSelfMemory(state);
  const body = String(text || '').trim();
  if (!body) return { state: s, ok: false, reason: 'empty' };
  if (!excerpt) return { state: s, ok: false, reason: 'need-evidence' };
  if (s.items.some((x) => x.text === body.slice(0, SELF_MEMORY_LIMITS.maxText))) return { state: s, ok: false, reason: 'duplicate' };
  // 印象默认低置信；事实才允许高置信
  const conf = kind === 'fact' ? clamp(confidence, 0, 0.9) : clamp(Math.min(confidence, 0.6), 0, 0.6);
  const evidenceLevel = ['verbatim', 'paraphrase', 'unverified'].includes(verified) ? verified : 'verbatim';
  s.items = [...s.items, {
    id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    text: body.slice(0, SELF_MEMORY_LIMITS.maxText),
    kind: kind === 'fact' ? 'fact' : 'impression',
    topic: String(topic || '').slice(0, 24),
    sourceUrl: String(sourceUrl || ''),
    verified: evidenceLevel,
    episodeId: String(episodeId || ''),
    excerpt: String(excerpt).slice(0, SELF_MEMORY_LIMITS.maxExcerpt),
    at,
    confidence: conf,
  }].slice(-SELF_MEMORY_LIMITS.maxItems);
  s.updatedAt = at;
  return { state: s, ok: true };
}

const bigrams = (s) => {
  const t = String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
  return set;
};

function overlap(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / A.size;
}

// 召回：只按字面相关度挑，不带 embedding；宁可少带，不硬塞。
export function recallSelf(state, query, { limit = 2, minScore = 0.08, now = Date.now() } = {}) {
  const s = normalizeSelfMemory(state);
  const q = String(query || '').trim();
  if (!q) return [];
  return s.items
    .map((item) => ({ ...item, score: Math.max(overlap(q, item.topic), overlap(q, item.text)) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, limit);
}

export function selfMemoryLine(rows) {
  if (!rows?.length) return '';
  // 只证明“来源里出现过”，不证明内容为真：事实类也带来源归属。
  const lines = rows.map((r) => ({
    记得: r.text,
    来源: r.sourceUrl || '（未记录）',
    类型: r.kind === 'fact' ? '读到的内容（未经核实）' : '印象',
  }));
  return `\n【你自己记着的事（不是他说的）】\n${JSON.stringify(lines)}\n这些是你自己看到的，聊到再说；引用时带来源（例如「某篇页面提到…」），不要当成已核实的事实，也不要当结论用。\n`;
}

export function resetSelfMemory() {
  return emptySelfMemory();
}

// 只读分页：可按 kind / topic / 关键词过滤，默认按时间倒序。
export function selfMemoryPage(state, { offset = 0, limit = 20, kind = '', topic = '', q = '' } = {}) {
  const s = normalizeSelfMemory(state);
  const query = String(q || '').trim();
  const kindFilter = kind === 'fact' || kind === 'impression' ? kind : '';
  const topicFilter = String(topic || '').trim();
  const items = s.items
    .filter((x) => (!kindFilter || x.kind === kindFilter))
    .filter((x) => (!topicFilter || x.topic === topicFilter))
    .filter((x) => !query || `${x.text} ${x.topic} ${x.excerpt}`.includes(query))
    .sort((a, b) => b.at - a.at);
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(100, Math.max(1, Number(limit) || 20));
  return {
    total: items.length,
    offset: start,
    limit: size,
    items: items.slice(start, start + size),
  };
}

// 保留策略：默认 365 天；印象比事实更容易被清。
export function purgeSelfMemory(state, now = Date.now(), maxAgeDays = 365) {
  const s = normalizeSelfMemory(state);
  const cutoff = now - maxAgeDays * 86400000;
  s.items = s.items.filter((x) => x.at >= cutoff || x.kind === 'fact');
  s.updatedAt = now;
  return s;
}
