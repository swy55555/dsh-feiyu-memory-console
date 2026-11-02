// Reuse validated current-turn understanding; keywords alone do not establish an error.
export function detectCorrection(text, interaction = null) {
  const s = String(text || '').trim();
  const quote = typeof interaction?.quote === 'string' ? interaction.quote.trim() : '';
  const valid = !!s && !!quote && s.includes(quote) && interaction?.focus === 'repair'
    && interaction.feedbackTarget === 'claim' && Number.isFinite(interaction.confidence)
    && interaction.confidence >= .65 && interaction.confidence <= 1
    && Array.isArray(interaction.contextEvidence) && interaction.contextEvidence.some(r => r.role === 'assistant' && r.id && r.quote);
  return { isCorrection: valid, cue: valid ? quote : '' };
}

export function repairHint({ isCorrection = false } = {}) {
  return isCorrection ? '\n【更正】本轮理解提示对方可能在纠正先前说法。核对当前原话与被指出的旧说法；确认有误再承认并更正，有效的当前澄清优先。信息不足时保留不确定，不自动认错，也不把旧说法继续当事实。\n' : '';
}

export function normalizeRepairs(raw) {
  const rows = Array.isArray(raw?.events) ? raw.events : [];
  return {
    version: 1,
    events: rows.slice(-100).map((r) => ({
      at: Number(r.at) || 0,
      cue: String(r.cue || ''),
      text: String(r.text || '').slice(0, 200),
    })).filter((r) => r.at),
    lessons: (Array.isArray(raw?.lessons) ? raw.lessons : []).slice(-5).map((x) => String(x).slice(0, 120)),
  };
}

export function addRepair(state, { cue = '', text = '', lesson = '', now = Date.now() } = {}) {
  const s = normalizeRepairs(state);
  s.events = [...s.events, { at: now, cue, text: String(text).slice(0, 200) }].slice(-100);
  if (lesson) {
    const l = String(lesson).slice(0, 120);
    if (!s.lessons.includes(l)) s.lessons = [...s.lessons, l].slice(-5);
  }
  return s;
}

export function lessonLine(state) {
  const s = normalizeRepairs(state);
  if (!s.lessons.length) return '';
  return `\n【别再犯】${s.lessons.map((x) => `- ${x}`).join('\n')}\n`;
}
