// 相关性门槛：生产装配与离线样本构建共用这一份实现。
// 规则固定：消息与兴趣话题/自我记忆的 bigram Jaccard >= 0.25 才算命中。
export const LINKAGE_GATE = Object.freeze({ jaccard: 0.25, maxItems: 3 });

function bigrams(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function gateLinkage({ message = '', taste = [], selfMemory = [], boundaryAt = 0 } = {}) {
  const before = (at) => !boundaryAt || (Number(at) || 0) < boundaryAt;
  const tasteBefore = taste.filter((t) => before(t.updatedAt || t.lastSeenAt || t.createdAt));
  const selfBefore = selfMemory.filter((m) => before(m.at));
  const available = tasteBefore.length > 0 || selfBefore.length > 0;
  const grams = bigrams(message);
  const matches = [];
  for (const t of tasteBefore) {
    const topic = String(t.topic || '').trim();
    if (!topic) continue;
    // 短话题用包含判断（比 Jaccard 更稳），长话题仍用重合度。
    const hit = message.includes(topic) || topic.includes(message) || jaccard(grams, bigrams(topic)) >= LINKAGE_GATE.jaccard;
    if (hit) matches.push({ kind: 'taste', text: topic });
  }
  for (const m of selfBefore) {
    const text = String(m.text || '').trim();
    if (text && jaccard(grams, bigrams(text)) >= LINKAGE_GATE.jaccard) matches.push({ kind: 'self', text });
  }
  const hit = matches.length > 0;
  return {
    available,
    hit,
    reason: !available ? 'no-memory' : hit ? `match:${matches[0].kind}` : 'no-overlap',
    matches: matches.slice(0, LINKAGE_GATE.maxItems),
  };
}
