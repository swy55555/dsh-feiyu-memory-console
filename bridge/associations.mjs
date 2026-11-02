// B 阶段：只读候选关联。
// 关系分三类，强度不同：
// 分数 confidence 是规则匹配分数，不是“内容正确的概率”。
//   same-source  : 同一明确 URL —— 只是“同源”，不表示内容互相支持
//   same-episode : 同一段经历 —— 表示来自同一次对话/探索，内容是否互相支持另判
//   candidate    : 同一 topic 且时间接近 —— 只做候选，必须带规则与置信度
const WEEK = 7 * 24 * 60 * 60 * 1000;

function itemOf(kind, row) {
  return {
    kind,
    id: String(row.id || row.key || ''),
    label: String(row.topic || row.text || '').slice(0, 40),
    at: Number(row.at) || 0,
    url: String(row.sourceUrl || row.url || ''),
    episodeId: String(row.episodeId || ''),
  };
}

export function buildAssociations({ taste = [], selfMemory = [], concerns = [] } = {}) {
  const items = [];
  for (const t of taste) {
    for (const ev of (t.evidence || [])) {
      items.push({ ...itemOf('taste', { ...ev, id: `${t.topic}-${ev.url || ev.at}`, topic: t.topic }), topic: String(t.topic || '') });
    }
  }
  for (const m of selfMemory) items.push({ ...itemOf('self', m), topic: String(m.topic || '') });
  for (const c of concerns) items.push({ ...itemOf('concern', { ...c, id: c.id, text: c.title }), topic: '' });

  const strong = [];
  const weak = [];

  const groupBy = (keyFn) => {
    const map = new Map();
    for (const it of items) {
      const key = keyFn(it);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    return map;
  };

  // 同源：同一 URL
  for (const [url, group] of groupBy((it) => it.url)) {
    if (group.length < 2) continue;
    strong.push({
      type: 'same-source',
      rule: 'exact-url',
      confidence: 1,
      scoreKind: 'rule-match',
      note: '同一来源；只代表出自同一个链接，不代表内容互相支持',
      items: group,
    });
  }

  // 同一段经历：同一 episodeId
  for (const [episodeId, group] of groupBy((it) => it.episodeId)) {
    if (group.length < 2) continue;
    if (group.every((it) => it.url) && new Set(group.map((it) => it.url)).size === 1) continue; // 已由同源覆盖
    strong.push({
      type: 'same-episode',
      rule: 'episode-id',
      confidence: 0.9,
      scoreKind: 'rule-match',
      note: '来自同一段经历；内容是否互相支持需要单独判断',
      items: group,
    });
  }

  // 候选：同 topic + 时间接近（7 天内）
  const byTopic = groupBy((it) => it.topic);
  for (const [topic, group] of byTopic) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.at - b.at);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i]; const b = sorted[j];
        if (!a.at || !b.at) continue;
        const gap = Math.abs(b.at - a.at);
        if (gap > WEEK) continue;
        if (a.url && a.url === b.url) continue; // 已由同源覆盖
        const confidence = Number((0.35 + 0.15 * (1 - gap / WEEK)).toFixed(2));
        weak.push({
          type: 'candidate',
          rule: 'same-topic+within-7d',
          confidence,
          scoreKind: 'rule-match',
          note: `同话题「${topic}」，时间相差 ${Math.round(gap / 86400000)} 天；只是候选`,
          items: [a, b],
        });
      }
    }
  }

  return { strong, weak, generatedAt: Date.now(), readOnly: true };
}
