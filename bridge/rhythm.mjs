// P2 节律：只做本地时间规则，不调用模型、不记录“疲惫/生理状态”、不写长期记忆。
export const RHYTHM_DEFAULTS = Object.freeze({
  enabled: true,
  timezone: 'Asia/Shanghai',
  quietHours: ['01:00', '09:00'], // 安静时段：不主动发消息
  briefHours: ['23:00', '08:00'], // 简短倾向：只影响表达倾向
});

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

const inRange = (cur, start, end) => (start <= end ? cur >= start && cur < end : cur >= start || cur < end);

export function rhythmConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (v, fallback) => (Array.isArray(v) && v.length === 2 && v.every((x) => /^\d{2}:\d{2}$/.test(String(x))) ? v.map(String) : fallback);
  return {
    enabled: src.enabled !== false,
    timezone: typeof src.timezone === 'string' && src.timezone ? src.timezone : RHYTHM_DEFAULTS.timezone,
    quietHours: pick(src.quietHours, RHYTHM_DEFAULTS.quietHours),
    briefHours: pick(src.briefHours, RHYTHM_DEFAULTS.briefHours),
  };
}

export function rhythmView(conf, now = Date.now()) {
  const c = rhythmConfig(conf);
  if (!c.enabled) return { enabled: false, quiet: false, brief: false, time: '', timezone: c.timezone };
  let hour = 0; let minute = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
    hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  } catch {
    const d = new Date(now); hour = d.getHours(); minute = d.getMinutes();
  }
  const cur = hour * 60 + minute;
  return {
    enabled: true,
    quiet: inRange(cur, toMinutes(c.quietHours[0]), toMinutes(c.quietHours[1])),
    brief: inRange(cur, toMinutes(c.briefHours[0]), toMinutes(c.briefHours[1])),
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    timezone: c.timezone,
  };
}

export function rhythmPromptLine(view) {
  if (!view?.enabled) return '';
  const parts = [];
  if (view.quiet) parts.push('现在是安静时段：不要主动发起话题或找人，只回应来消息。');
  if (view.brief) parts.push('这个点倾向短句、少铺陈；但如果对方明确要求详细解释，就照常展开。');
  if (!parts.length) return '';
  return `\n【节律】${parts.join('')}\n`;
}
