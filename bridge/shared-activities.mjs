// 共同经历：一起看 / 一起改。A 先做 watch，状态机 A/B 共用。
export const SHARED_DEFAULTS = Object.freeze({ minGapDays: 7, keepDays: 60, maxActivities: 40 });

const DAY = 86400000;
const clampText = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function emptyShared() {
  return { version: 1, activities: [], lastProposedAt: 0, updatedAt: Date.now() };
}

export function normalizeShared(raw) {
  const out = emptyShared();
  out.activities = (Array.isArray(raw?.activities) ? raw.activities : []).slice(-SHARED_DEFAULTS.maxActivities).map((a) => ({
    id: String(a.id || ''),
    type: a.type === 'edit' ? 'edit' : 'watch',
    title: clampText(a.title, 80),
    url: String(a.url || ''),
    draft: String(a.draft || '').slice(0, 2000),
    status: ['proposed', 'accepted', 'done', 'dropped'].includes(a.status) ? a.status : 'proposed',
    proposedAt: Number(a.proposedAt) || Date.now(),
    acceptedAt: Number(a.acceptedAt) || 0,
    doneAt: Number(a.doneAt) || 0,
    ownerQuote: clampText(a.ownerQuote, 200),
    herNotes: clampText(a.herNotes, 300),
    versions: Array.isArray(a.versions) ? a.versions.slice(-10) : [],
  })).filter((a) => a.id);
  out.lastProposedAt = Number(raw?.lastProposedAt) || 0;
  out.updatedAt = Number(raw?.updatedAt) || Date.now();
  return out;
}

export function activeShared(state) {
  return (state?.activities || []).find((a) => a.status === 'proposed' || a.status === 'accepted') || null;
}

export function proposeShared(state, { type = 'watch', title = '', url = '', draft = '', now = Date.now() } = {}) {
  const s = normalizeShared(state);
  if (activeShared(s)) return { ok: false, reason: 'active-exists', state: s };
  const gap = Number(SHARED_DEFAULTS.minGapDays) * DAY;
  if (s.lastProposedAt && now - s.lastProposedAt < gap) return { ok: false, reason: 'too-soon', state: s };
  const activity = {
    id: `shared-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: type === 'edit' ? 'edit' : 'watch',
    title: clampText(title, 80),
    url: String(url || ''),
    draft: String(draft || '').slice(0, 2000),
    status: 'proposed',
    proposedAt: now,
    acceptedAt: 0,
    doneAt: 0,
    ownerQuote: '',
    herNotes: '',
    versions: [],
  };
  s.activities = [...s.activities, activity].slice(-SHARED_DEFAULTS.maxActivities);
  s.lastProposedAt = now;
  s.updatedAt = now;
  return { ok: true, state: s, activity };
}

export function updateShared(state, id, status, extra = {}, now = Date.now()) {
  const s = normalizeShared(state);
  const a = s.activities.find((x) => x.id === id);
  if (!a) return { ok: false, reason: 'not-found', state: s };
  if (!['accepted', 'done', 'dropped'].includes(status)) return { ok: false, reason: 'bad-status', state: s };
  if (a.status === status) return { ok: true, state: s, activity: a };
  const allowed = { proposed: ['accepted', 'dropped'], accepted: ['done', 'dropped'], done: [], dropped: [] };
  if (!allowed[a.status]?.includes(status)) return { ok: false, reason: 'invalid-transition', state: s };
  a.status = status;
  if (status === 'accepted') a.acceptedAt = now;
  if (status === 'done') a.doneAt = now;
  if (extra.ownerQuote) a.ownerQuote = clampText(extra.ownerQuote, 200);
  if (extra.herNotes) a.herNotes = clampText(extra.herNotes, 300);
  if (Array.isArray(extra.versions)) a.versions = extra.versions.slice(-10);
  s.updatedAt = now;
  return { ok: true, state: s, activity: a };
}

export function recentSharedLine(state, now = Date.now(), days = 14) {
  const done = (state?.activities || []).filter((a) => a.status === 'done' && a.doneAt && now - a.doneAt < days * DAY);
  if (!done.length) return '';
  const last = done[done.length - 1];
  const what = last.type === 'watch' ? `一起看过《${last.title}》` : `一起改过「${last.title}」`;
  return `\n【共同经历】上次你们${what}${last.herNotes ? `，你记着：${last.herNotes}` : ''}。\n`;
}
