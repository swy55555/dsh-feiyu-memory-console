// 慢通道：探索倾向 → 轮廓（主动性）。默认只生成提案，不改人格。
export const OPENNESS_DEFAULTS = Object.freeze({
  minTopics: 5,
  minEvidencePerTopic: 2,
  minSpanDays: 28,
  minGapDays: 28,
  maxDelta: 1,
});

const DAY = 86400000;

export function evaluateOpennessDrift({ taste = null, now = Date.now(), lastProposalAt = 0, conf = {} } = {}) {
  const c = { ...OPENNESS_DEFAULTS, ...(conf || {}) };
  const topics = Array.isArray(taste?.topics) ? taste.topics : [];
  const eligible = [];
  for (const t of topics) {
    const evidence = Array.isArray(t.evidence) ? t.evidence : [];
    const urls = new Set(evidence.map((e) => e.url).filter(Boolean));
    if (urls.size < Number(c.minEvidencePerTopic || 2)) continue;
    const firstAt = Number(t.createdAt) || Number(evidence[0]?.at) || Number(t.lastSeenAt) || 0;
    if (!firstAt) continue;
    eligible.push({ topic: String(t.topic || ''), firstAt, urls: urls.size });
  }
  if (!eligible.length) return { ok: false, eligible: false, reason: 'no-topics', count: 0, spanDays: 0, topics: [] };
  const times = eligible.map((x) => x.firstAt).sort((a, b) => a - b);
  const spanDays = (times[times.length - 1] - times[0]) / DAY;
  const enoughTopics = eligible.length >= Number(c.minTopics || 5);
  const enoughSpan = spanDays >= Number(c.minSpanDays || 28);
  const gapOk = !lastProposalAt || now - lastProposalAt >= Number(c.minGapDays || 28) * DAY;
  const eligibleNow = enoughTopics && enoughSpan && gapOk;
  const reason = !enoughTopics ? `topics-${eligible.length}/${c.minTopics}`
    : !enoughSpan ? `span-${Math.round(spanDays)}d/${c.minSpanDays}d`
      : !gapOk ? 'too-soon' : 'ok';
  return {
    ok: true,
    eligible: eligibleNow,
    reason,
    count: eligible.length,
    spanDays: Math.round(spanDays),
    topics: eligible.slice(-8).map((x) => x.topic),
    delta: Number(c.maxDelta || 1),
    target: 'initiative',
  };
}
