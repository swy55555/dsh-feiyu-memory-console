// 目标层（P0）：四种驱力 + 探索动机。
// 重要：这里的数值都是【设计先验】，不是心理测量值，也没有标定过。
// 目标是角色状态参数，用来产生连贯行为，不声称代表真实动机或主观体验。
export const GOAL_IDS = Object.freeze(['autonomy', 'competence', 'curiosity', 'relatedness']);

export const GOAL_LABELS = Object.freeze({
  autonomy: '想按自己的意愿做事',
  competence: '想弄懂、想做成',
  curiosity: '想知道新鲜事（探索动机，不属于 SDT 基本需要）',
  relatedness: '想和他亲近',
});

const SHORT = Object.freeze({
  autonomy: '按自己的想法来',
  competence: '把一件事弄懂',
  curiosity: '想知道点新鲜的',
  relatedness: '想和他近一点',
});

// 设计先验（未标定）：可调，但不能宣称是经验测量。
export const PRIORS = Object.freeze({
  baseline: { autonomy: 0.55, competence: 0.5, curiosity: 0.55, relatedness: 0.5 },
  perHitMax: 0.05,
  perDayMax: 0.15,
  perWeekMax: 0.2,        // 滚动 7 天内 sum(abs(delta)) 的上限，防止正负抵消后仍大幅震荡
  halfLifeDays: 7,
  minConfidence: 0.6,     // 置信度门槛（未标定）
  relatednessLift: 0.05,  // relatedness 被明确关系证据抬高这么多才允许进入“最强两项”
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(Number(v)) ? Number(v) : a));
const dayKey = (now) => new Date(now).toLocaleDateString('en-CA');
const WEEK = 7 * 86400000;

export function emptyGoals(now = Date.now()) {
  const goals = {};
  for (const id of GOAL_IDS) {
    goals[id] = { weight: PRIORS.baseline[id], baseline: PRIORS.baseline[id], updatedAt: now, dayStamp: '', dayDelta: 0, evidence: [] };
  }
  return { version: 1, goals, updatedAt: now, recent: [], processed: [] };
}

export function normalizeGoals(raw, now = Date.now()) {
  const out = emptyGoals(now);
  const src = raw && typeof raw === 'object' && raw.goals && typeof raw.goals === 'object' ? raw.goals : {};
  for (const id of GOAL_IDS) {
    const row = src[id];
    if (!row || typeof row !== 'object') continue;
    out.goals[id] = {
      weight: clamp(row.weight ?? PRIORS.baseline[id], 0, 1),
      baseline: clamp(row.baseline ?? PRIORS.baseline[id], 0, 1),
      updatedAt: Number(row.updatedAt) || now,
      dayStamp: String(row.dayStamp || ''),
      dayDelta: Math.max(0, Number(row.dayDelta) || 0),
      evidence: Array.isArray(row.evidence) ? row.evidence.slice(-20) : [],
    };
  }
  out.recent = Array.isArray(raw?.recent)
    ? raw.recent.filter((r) => r && Number.isFinite(Number(r.at)) && Number.isFinite(Number(r.abs))).slice(-200)
    : [];
  // 只保留最近 500 个事件 ID：更早的 ID 会 fall out，理论上可被重放；
  // 同时 changelog 里能找到同 ID 的 apply 记录，可作为第二道判断（见 applyGoalHits）。
  out.processed = Array.isArray(raw?.processed) ? raw.processed.filter((x) => typeof x === 'string').slice(-500) : [];
  out.changelog = Array.isArray(raw?.changelog)
    ? raw.changelog
      .filter((r) => r && Number.isFinite(Number(r.delta)) && GOAL_IDS.includes(String(r.goal)))
      // 保留期 45 天 + 最多 500 条：两者取更严的一个，防止无限增长。
      .filter((r) => !Number.isFinite(Number(r.at)) || now - Number(r.at) <= 45 * 86400000)
      .slice(-500)
    : [];
  out.updatedAt = Number(raw?.updatedAt) || now;
  return out;
}

export function goalView(state, now = Date.now()) {
  const s = normalizeGoals(state, now);
  const out = {};
  for (const id of GOAL_IDS) {
    const row = s.goals[id];
    const elapsedDays = Math.max(0, (now - row.updatedAt) / 86400000);
    const keep = 0.5 ** (elapsedDays / PRIORS.halfLifeDays);
    out[id] = clamp(row.baseline + (row.weight - row.baseline) * keep, 0, 1);
  }
  return out;
}

export function bakeGoals(state, now = Date.now()) {
  const view = goalView(state, now);
  const s = normalizeGoals(state, now);
  for (const id of GOAL_IDS) s.goals[id].weight = view[id];
  s.updatedAt = now;
  return s;
}

// 幂等：同一个事件 ID 只应用一次。
export function applyGoalHits(state, hits, { now = Date.now(), eventId = '', quote = '' } = {}) {
  const s = bakeGoals(state, now);
  const today = dayKey(now);
  const applied = [];
  const skipped = [];
  for (const id of GOAL_IDS) {
    const row = s.goals[id];
    if (row.dayStamp !== today) { row.dayStamp = today; row.dayDelta = 0; }
  }
  // 滚动的七日窗口，按 sum(abs) 限幅
  s.recent = s.recent.filter((r) => now - Number(r.at) <= WEEK);
  let weekUsed = s.recent.reduce((a, r) => a + Number(r.abs || 0), 0);
  const dedupeKey = eventId ? String(eventId) : '';
  // 二道幂等：processed 只留 500 个，changelog 里若有同 ID 的 apply 记录也算重复。
  const alreadyApplied = dedupeKey && (s.processed.includes(dedupeKey) || (Array.isArray(s.changelog) && s.changelog.some((r) => r.eventId === dedupeKey && r.action === 'apply')));
  if (alreadyApplied) {
    return { state: s, applied, skipped: [{ reason: 'duplicate' }], duplicate: true };
  }
  for (const hit of Array.isArray(hits) ? hits : []) {
    const id = String(hit?.goal || '');
    const confidence = Number(hit?.confidence);
    const delta = Number(hit?.delta);
    if (!GOAL_IDS.includes(id) || !Number.isFinite(delta) || delta === 0) { skipped.push({ hit, reason: 'invalid' }); continue; }
    if (!Number.isFinite(confidence) || confidence < PRIORS.minConfidence) { skipped.push({ hit, reason: 'low-confidence' }); continue; }
    const row = s.goals[id];
    if (row.dayStamp !== today) { row.dayStamp = today; row.dayDelta = 0; }
    const dayRoom = Math.max(0, PRIORS.perDayMax - row.dayDelta);
    const weekRoom = Math.max(0, PRIORS.perWeekMax - weekUsed);
    if (dayRoom <= 0 || weekRoom <= 0) { skipped.push({ hit, reason: dayRoom <= 0 ? 'day-cap' : 'week-cap' }); continue; }
    // 先按置信度缩放，再逐层限幅
    const scaled = delta * clamp(confidence, 0, 1);
    const step = clamp(scaled, -PRIORS.perHitMax, PRIORS.perHitMax);
    const bounded = clamp(step, -Math.min(dayRoom, weekRoom), Math.min(dayRoom, weekRoom));
    if (!bounded) { skipped.push({ hit, reason: 'rounded-out' }); continue; }
    const beforeWeight = row.weight;
    row.weight = clamp(row.weight + bounded, 0, 1);
    // 记录「实际发生变化」的量：被 clamp 到 0/1 时，申请值不等于生效值。
    const actual = Math.round((row.weight - beforeWeight) * 1e6) / 1e6;
    if (!actual) { skipped.push({ hit, reason: 'rounded-out' }); continue; }
    row.dayDelta = Math.round((row.dayDelta + Math.abs(actual)) * 1000) / 1000;
    row.evidence = [...row.evidence, {
      at: now, delta: actual, confidence, eventId: dedupeKey,
      quote: String(hit?.quote || quote || '').slice(0, 160),
    }].slice(-20);
    s.recent = [...s.recent, { at: now, abs: Math.abs(actual), eventId: dedupeKey }].slice(-200);
    s.changelog = [...(Array.isArray(s.changelog) ? s.changelog : []), {
      at: now, eventId: dedupeKey, goal: id, delta: actual, confidence, action: 'apply',
      before: Math.round(beforeWeight * 10000) / 10000, after: Math.round(row.weight * 10000) / 10000,
    }].slice(-500);
    weekUsed += Math.abs(actual);
    applied.push({ goal: id, delta: actual, confidence });
  }
  if (dedupeKey) s.processed = [...s.processed, dedupeKey].slice(-500);
  s.updatedAt = now;
  return { state: s, applied, skipped, duplicate: false };
}

// relatedness 不长期霸榜：只有被明确关系证据抬到 baseline+lift 以上，才允许进入“最强两项”。
export function goalLine(state, now = Date.now()) {
  const view = goalView(state, now);
  const ranked = GOAL_IDS
    .filter((id) => id !== 'relatedness' || view.relatedness >= PRIORS.baseline.relatedness + PRIORS.relatednessLift)
    .map((id) => ({ id, weight: view[id] }))
    .sort((a, b) => b.weight - a.weight);
  const top = (ranked.length ? ranked : GOAL_IDS.map((id) => ({ id, weight: view[id] }))).slice(0, 2);
  const text = top.map((t) => SHORT[t.id]).join('；');
  return `\n【你此刻在意的】${text}。这只是底色：别说出来，也别拿它当理由要求什么。\n【边界】上面这些只影响没有明确要求时的语气和选择，不覆盖他明确说的话、系统规则或工具权限。\n`;
}

export function goalPublic(state, now = Date.now()) {
  const view = goalView(state, now);
  return GOAL_IDS.map((id) => ({ id, label: GOAL_LABELS[id], weight: Math.round(view[id] * 100) / 100 }));
}

// 撤销一次事件带来的目标变化。
// 只允许撤销「该目标上最后一次 apply」：中间事件直接恢复 before 会覆盖后续更新，
// 所以这里不做重放；不是最新变更就返回 not-latest，由调用方决定是否手动处理。
export function revertGoalEvent(state, eventId, { now = Date.now() } = {}) {
  const s = bakeGoals(state, now);
  const key = String(eventId || '');
  if (!key) return { state: s, reverted: [], reason: 'no-event-id' };
  const log = Array.isArray(s.changelog) ? s.changelog : [];
  const targets = log.filter((r) => r.eventId === key && r.action === 'apply');
  if (!targets.length) return { state: s, reverted: [], reason: 'not-found' };
  // 每个目标：目标事件必须是该目标最后一条 apply，否则拒绝。
  for (const t of targets) {
    const lastApply = [...log].reverse().find((r) => r.goal === t.goal && r.action === 'apply');
    if (lastApply && lastApply.eventId !== key) return { state: s, reverted: [], reason: 'not-latest' };
  }
  const reverted = [];
  for (const e of targets) {
    const row = s.goals[e.goal];
    if (!row) continue;
    // 用「实际生效的 delta」反向扣回，而不是恢复 before 快照：
    // 这样中间发生过的衰减不会被一起撤掉；clamp 过的更新因为记的是实际 delta，也能精确还原。
    const target = Number.isFinite(Number(e.delta)) ? clamp(row.weight - Number(e.delta), 0, 1) : clamp(row.weight, 0, 1);
    const actual = Math.round((target - row.weight) * 1000) / 1000;
    row.weight = target;
    reverted.push({ goal: e.goal, delta: actual });
  }
  s.recent = (s.recent || []).filter((r) => r.eventId !== key);
  s.changelog = [...s.changelog, ...reverted.map((r) => ({ at: now, eventId: key, goal: r.goal, delta: r.delta, action: 'revert', before: null, after: null }))].slice(-500);
  s.processed = (s.processed || []).filter((x) => x !== key);
  s.updatedAt = now;
  return { state: s, reverted, reason: 'ok' };
}
