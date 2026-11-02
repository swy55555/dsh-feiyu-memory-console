// 兴趣档案（P0.5）：爱好不能预设，只能从她实际看过的内容里长出来。
// 每条兴趣必须有证据（来源 + 摘录 + 时间），强度会随时间衰减。
export const TASTE_LIMITS = Object.freeze({
  maxTopics: 40,
  maxEvidence: 8,
  halfLifeDays: 30,
  minStrength: 0.05,
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(Number(v)) ? Number(v) : a));
const norm = (s) => String(s || '').trim().toLowerCase();

export function emptyTaste() {
  return { version: 1, topics: [], updatedAt: Date.now() };
}

export function normalizeTaste(raw) {
  const out = emptyTaste();
  const list = Array.isArray(raw?.topics) ? raw.topics : [];
  for (const row of list) {
    const topic = String(row?.topic || '').trim().slice(0, 24);
    if (!topic) continue;
    out.topics.push({
      id: String(row.id || topic),
      topic,
      strength: clamp(row.strength ?? 0.2, 0, 1),
      evidence: Array.isArray(row.evidence) ? row.evidence.filter((e) => e && e.excerpt).slice(-TASTE_LIMITS.maxEvidence) : [],
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
      lastSeenAt: Number(row.lastSeenAt) || Number(row.updatedAt) || Date.now(),
      source: String(row.source || ''),
    });
  }
  out.updatedAt = Number(raw?.updatedAt) || Date.now();
  return out;
}

export function tasteView(state, now = Date.now()) {
  const s = normalizeTaste(state);
  return s.topics
    .map((t) => {
      const days = Math.max(0, (now - t.lastSeenAt) / 86400000);
      const keep = 0.5 ** (days / TASTE_LIMITS.halfLifeDays);
      return { ...t, strength: clamp(0.05 + (t.strength - 0.05) * keep, 0, 1) };
    })
    .sort((a, b) => b.strength - a.strength);
}

function findTopic(state, topic) {
  const key = norm(topic);
  return state.topics.find((t) => norm(t.topic) === key) || state.topics.find((t) => norm(t.topic).includes(key) || key.includes(norm(t.topic)));
}

// 有证据才加强度；没有证据的“印象”不落库。
export function noteTaste(state, { topic, evidence, delta = 0.12, source = '' } = {}) {
  const s = normalizeTaste(state);
  const name = String(topic || '').trim().slice(0, 24);
  const excerpt = String(evidence?.excerpt || '').trim();
  if (!name || !excerpt) return { state: s, ok: false, reason: 'need-topic-and-evidence' };
  const now = Number(evidence?.at) || Date.now();
  let row = findTopic(s, name);
  if (!row) {
    row = { id: name, topic: name, strength: 0.2, evidence: [], createdAt: now, updatedAt: now, lastSeenAt: now, source };
    s.topics.push(row);
  }
  row.strength = clamp(row.strength + clamp(delta, 0, 0.3), 0, 1);
  row.evidence = [...row.evidence, { url: String(evidence?.url || ''), excerpt: excerpt.slice(0, 300), at: now }].slice(-TASTE_LIMITS.maxEvidence);
  row.updatedAt = now;
  row.lastSeenAt = now;
  if (source) row.source = source;
  s.topics = s.topics.slice(-TASTE_LIMITS.maxTopics);
  s.updatedAt = now;
  return { state: s, ok: true, topic: row.topic };
}

export function topTaste(state, now = Date.now(), n = 1) {
  return tasteView(state, now).filter((t) => t.strength >= TASTE_LIMITS.minStrength).slice(0, n);
}

// 选题：在最强的前 5 个里按强度加权随机，避免总是同一项。
export function pickExploreTopic(state, now = Date.now(), random = Math.random) {
  const pool = tasteView(state, now).filter((t) => t.strength >= TASTE_LIMITS.minStrength).slice(0, 5);
  if (!pool.length) return null;
  const total = pool.reduce((a, t) => a + t.strength, 0);
  let r = random() * total;
  for (const t of pool) {
    r -= t.strength;
    if (r <= 0) return t;
  }
  return pool[0];
}

export function tasteLine(state, now = Date.now()) {
  const top = topTaste(state, now, 1);
  if (!top.length) return '';
  return `\n【你最近在琢磨】${top[0].topic}。是你自己看来的，不用主动汇报，聊到再说。\n`;
}

export function resetTaste() {
  return emptyTaste();
}

// 探索写入：一次随机只算“暂定证据”；两条独立内容（不同视频/不同作者）才升到 0.42。
export function recordExploration(state, { topic, evidence, now = Date.now() } = {}) {
  const s = normalizeTaste(state);
  const name = String(topic || '').trim().slice(0, 24);
  const excerpt = String(evidence?.excerpt || '').trim();
  const url = String(evidence?.url || '').trim();
  const author = String(evidence?.author || '').trim();
  if (!name || !excerpt) return { state: s, ok: false, reason: 'need-topic-and-evidence', status: 'none' };
  let row = findTopic(s, name);
  if (!row) {
    row = { id: name, topic: name, strength: 0.2, evidence: [], createdAt: now, updatedAt: now, lastSeenAt: now, source: 'bilibili' };
    s.topics.push(row);
    row.evidence = [{ url, excerpt: excerpt.slice(0, 300), at: now, author }].slice(-TASTE_LIMITS.maxEvidence);
    s.updatedAt = now;
    return { state: s, ok: true, status: 'provisional', strength: row.strength };
  }
  const seenUrl = row.evidence.some((e) => url && e.url === url);
  const otherContent = row.evidence.some((e) => (url && e.url !== url) || (!url && e.excerpt !== excerpt));
  const otherAuthor = author && row.evidence.some((e) => e.author && e.author !== author);
  row.evidence = [...row.evidence, { url, excerpt: excerpt.slice(0, 300), at: now, author }].slice(-TASTE_LIMITS.maxEvidence);
  row.updatedAt = now;
  row.lastSeenAt = now;
  if (seenUrl) {
    row.strength = clamp(row.strength + 0.02, 0, 1);
    s.updatedAt = now;
    return { state: s, ok: true, status: 'repeat', strength: row.strength };
  }
  if (otherContent && (!author || otherAuthor || row.evidence.length === 1)) {
    row.strength = Math.max(row.strength, 0.42);
    s.updatedAt = now;
    return { state: s, ok: true, status: 'confirmed', strength: row.strength };
  }
  row.strength = clamp(row.strength + 0.05, 0, 1);
  s.updatedAt = now;
  return { state: s, ok: true, status: 'provisional', strength: row.strength };
}

// 只读分页：给控制台/接口用，按当前（含衰减）强度排序。
export function tastePage(state, { offset = 0, limit = 20, now = Date.now() } = {}) {
  const all = tasteView(state, now);
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(100, Math.max(1, Number(limit) || 20));
  return {
    total: all.length,
    offset: start,
    limit: size,
    items: all.slice(start, start + size).map((t) => ({
      topic: t.topic,
      strength: Math.round(t.strength * 1000) / 1000,
      lastSeenAt: t.lastSeenAt,
      ...(t.source ? { source: t.source } : {}),
      evidence: t.evidence.slice(-3),
    })),
  };
}

// 保留策略：超过 maxAgeDays 没再看到、且强度已跌到下限以下的话题清掉。
export function purgeTaste(state, now = Date.now(), maxAgeDays = 180) {
  const s = normalizeTaste(state);
  const cutoff = now - maxAgeDays * 86400000;
  s.topics = s.topics.filter((t) => {
    if (t.lastSeenAt >= cutoff) return true;
    const days = Math.max(0, (now - t.lastSeenAt) / 86400000);
    const decayed = 0.05 + (t.strength - 0.05) * 0.5 ** (days / TASTE_LIMITS.halfLifeDays);
    return decayed >= TASTE_LIMITS.minStrength * 2;
  });
  s.updatedAt = now;
  return s;
}
