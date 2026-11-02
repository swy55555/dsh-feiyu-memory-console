// 修复：识别对方在纠正，生成“先认错再更正”的提示，并记录教训。
export const REPAIR_CUES = ['不是', '不对', '记错', '搞错', '我说的是', '并没有', '你弄错', '反了', '错了吧'];

export function detectCorrection(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 300) return { isCorrection: false, cue: '' };
  const cue = REPAIR_CUES.find((c) => s.includes(c)) || '';
  return { isCorrection: Boolean(cue), cue };
}

export function repairHint({ cue = '', text = '' } = {}) {
  return `\n【更正】对方在纠正你（线索：${cue || '语气'}）。先直接承认可能记错了，再按对方说的改；不要把旧说法继续当事实，也不要辩解。\n`;
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
