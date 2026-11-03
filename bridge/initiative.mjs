// P1 自我驱动决策层：只算“现在想做什么”，不执行。dryRun 只写日志。
export const INITIATIVE_DEFAULTS = Object.freeze({
  enabled: true,
  dryRun: true,
  maxPerDay: 12,
  minGapMinutes: 30,
  allowContact: false,
  allowExplore: true,
  threshold: 0.45,
  cooldownMinutes: { explore: 30, contact: 60, revisit: 180, reflect: 240 },
  contactMaxPerDay: 1,
  contactIdleHours: 12,
  allowShared: true,
  sharedGapDays: 7,
  quietHours: ['01:00', '09:00'],
  timezone: 'Asia/Shanghai',
});

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
const inRange = (cur, start, end) => (start <= end ? cur >= start && cur < end : cur >= start || cur < end);
function localMinutes(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
    return Number(parts.find((p) => p.type === 'hour')?.value || 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value || 0);
  } catch {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
  }
}

export function computeInitiatives({ goals = {}, concerns = [], now = Date.now(), lastAt = 0, budget = {}, conf = {}, lastByType = {}, ownerIdleHours = 0, lastContactAt = 0, contactCountToday = 0, hasNewEvidence = false, sharedActive = false, lastSharedAt = 0, actionableOnly = false } = {}) {
  const c = { ...INITIATIVE_DEFAULTS, ...(conf || {}) };
  const g = (k) => Math.max(0, Math.min(1, Number(goals[k]) || 0));
  const cur = localMinutes(now, c.timezone);
  const quiet = inRange(cur, toMinutes(c.quietHours[0]), toMinutes(c.quietHours[1]));
  const used = Number(budget.runsToday) || 0;
  const openConcerns = concerns.filter((x) => ['open', 'paused'].includes(x.status)).length;
  const cooldown = { ...INITIATIVE_DEFAULTS.cooldownMinutes, ...(c.cooldownMinutes || {}) };
  const onCooldown = (type) => Number(lastByType[type] || 0) && now - Number(lastByType[type]) < Number(cooldown[type] || 0) * 60000;

  const candidates = [];
  // 探索：好奇为主，自主为辅；预算用完就挡。
  const exploreScore = 0.7 * g('curiosity') + 0.3 * g('autonomy');
  candidates.push({
    type: 'explore',
    score: Number(exploreScore.toFixed(2)),
    blocked: !c.allowExplore ? 'disabled' : used >= Number(c.maxPerDay || 6) ? 'daily-budget' : quiet ? 'quiet-hours' : onCooldown('explore') ? 'cooldown' : '',
  });
  // 主动联系：联结为主；P1 默认关闭。
  const contactScore = 0.8 * g('relatedness') + 0.2 * g('autonomy') + (Number(ownerIdleHours) >= Number(c.contactIdleHours || 12) ? 0.05 : 0);
  const contactReason = openConcerns > 0 ? 'concern' : hasNewEvidence ? 'new-evidence' : Number(ownerIdleHours) >= Number(c.contactIdleHours || 12) ? 'idle' : '';
  // 每天可主动几次，由驱力决定：基础 1，联结高 +1，好奇高且有新证据 +1，自主高 +1，最多 4。
  const baseLimit = Math.min(4, 1
    + (g('relatedness') >= 0.6 ? 1 : 0)
    + (g('curiosity') >= 0.6 && hasNewEvidence ? 1 : 0)
    + (g('autonomy') >= 0.75 ? 1 : 0));
  const contactLimit = c.contactNoDailyCap === true ? 999 : baseLimit;
  candidates.push({
    type: 'contact',
    score: Number(contactScore.toFixed(2)),
    reason: contactReason,
    blocked: !c.allowContact ? 'disabled'
      : quiet ? 'quiet-hours'
        : Number(contactCountToday) >= contactLimit ? 'daily-cap'
          : now - Number(lastContactAt || 0) < Number(c.cooldownMinutes?.contact || 360) * 60000 ? 'recent-contact'
            : !contactReason ? 'no-reason'
              : onCooldown('contact') ? 'cooldown' : '',
  });
  // 回看挂念：有未了的事才成为候选。
  if (openConcerns > 0) {
    candidates.push({ type: 'revisit', score: Number((0.5 + Math.min(0.2, openConcerns * 0.02)).toFixed(2)), blocked: onCooldown('revisit') ? 'cooldown' : '' });
  }
  // 共同经历：一起看/一起改；有进行中的活动或没到间隔就不提。
  candidates.push({
    type: 'shared',
    score: Number((0.48 + g('relatedness') * 0.1).toFixed(2)),
    blocked: !c.allowShared ? 'disabled'
      : sharedActive ? 'active-exists'
        : quiet ? 'quiet-hours'
        : lastSharedAt && now - Number(lastSharedAt) < Number(c.sharedGapDays || 7) * 86400000 ? 'too-soon' : '',
  });
  // 整理/反思：固定低优先级，避免永远不整理。
  candidates.push({ type: 'reflect', score: 0.46, blocked: onCooldown('reflect') ? 'cooldown' : '' });

  // Revisit/reflect are observational intentions; the live dispatcher has no
  // handler for them. Keep them in the trace but do not let them starve actions.
  const executable = actionableOnly ? candidates.filter(x => ['contact','explore','shared'].includes(x.type)) : candidates;
  const blockedAll = executable.every((x) => x.blocked);
  let chosen = null;
  let reason = '';
  if (now - Number(lastAt || 0) < Number(c.minGapMinutes ?? 30) * 60000) {
    reason = 'too-soon';
  } else if (blockedAll) {
    reason = 'all-blocked';
  } else {
    const available = executable.filter((x) => !x.blocked).sort((a, b) => b.score - a.score
      || (a.type === 'contact' && a.reason ? -1 : b.type === 'contact' && b.reason ? 1 : 0));
    const highest = available[0];
    const contact = available.find((x) => x.type === 'contact' && x.reason);
    // Scores are rounded to two decimals. A contact that is only one or two
    // points behind exploration must get a turn, or the same exploration score
    // can win forever even while contact remains eligible.
    const top = contact && contact.score >= Number(c.threshold || 0.45)
      && highest.score - contact.score <= 0.02 ? contact : highest;
    if (!top || top.score < Number(c.threshold || 0.45)) reason = 'below-threshold';
    else { chosen = top.type; reason = `chosen:${top.score}`; }
  }
  return { at: now, quiet, chosen, reason, candidates, contactLimit, dryRun: c.dryRun !== false };
}
