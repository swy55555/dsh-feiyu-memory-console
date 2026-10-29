import {
  inspectSituation,
  installSituation,
  contextIdentity,
  expectedAbsence,
} from "./emotion-context.mjs";
// v2: contextual events, bounded movement and one continuous time update.
import {
  classifyEmotion,
  validateSemanticAppraisal,
  appraisalScores,
} from "./emotion-appraisal.mjs";
export { validateSemanticAppraisal } from "./emotion-appraisal.mjs";
export const EMOTION_VERSION = 2;
export const DEFAULT_BASELINE = { valence: 0.12, arousal: 0.32 };
export const EMOTION_PROTOTYPES = [
  { key: "calm", label: "平静", v: 0.12, a: 0.32 },
  { key: "joy", label: "愉快", v: 0.4, a: 0.5 },
  { key: "sad", label: "不快", v: -0.15, a: 0.45 },
  { key: "angry", label: "生气", v: -0.5, a: 0.7 },
];
const clamp = (n, lo, hi) =>
  Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo));
const clone = (x) => JSON.parse(JSON.stringify(x));
export function emptyEmotion(now = Date.now()) {
  const climate = () => ({
    valence: 0.12,
    arousal: 0.32,
    social: 0,
    samples: 0,
    since: now,
    lastAt: 0,
  });
  return {
    version: 2,
    createdAt: now,
    updatedAt: now,
    baseline: { ...DEFAULT_BASELINE },
    mood: { ...DEFAULT_BASELINE },
    state: {
      ...DEFAULT_BASELINE,
      label: "平静",
      intensity: 0,
      updatedAt: now,
      holdUntil: 0,
      holdValence: 0,
    },
    dynamics: { v: 0, a: 0, conflict: 0, longing: 0, updatedAt: now },
    stance: "正常交流",
    lastCause: null,
    lastEvent: null,
    latestEventId: null,
    relationshipSamples: 0,
    relationshipSamplesByChat: {},
    seenEvents: [],
    situations: {},
    journal: null,
    corrections: [],
    climate: { all: climate(), owner: climate(), chats: {} },
    lastDriftAt: 0,
    drifts: [],
    history: [],
    triggers: [],
    metrics: {
      events: 0,
      positive: 0,
      negative: 0,
      maxJump: 0,
      lastLabel: "平静",
      lastChangeAt: now,
    },
  };
}
export function normalizeEmotion(raw, now = Date.now()) {
  const s = emptyEmotion(now);
  if (!raw || typeof raw !== "object") return s;
  Object.assign(s, clone(raw));
  s.baseline = { ...DEFAULT_BASELINE, ...s.baseline };
  s.mood = { ...s.baseline, ...s.mood };
  s.state = { ...emptyEmotion(now).state, ...s.state };
  for (const k of ["valence", "arousal"]) {
    s.baseline[k] = clamp(s.baseline[k], k === "valence" ? -1 : 0, 1);
    s.mood[k] = clamp(s.mood[k], k === "valence" ? -1 : 0, 1);
    s.state[k] = clamp(s.state[k], k === "valence" ? -1 : 0, 1);
  }
  if (raw.version !== 2 || !raw.dynamics) {
    s.dynamics = {
      v: clamp(s.state.valence - s.baseline.valence, -0.7, 0.18),
      a: clamp(s.state.arousal - s.baseline.arousal, -0.3, 0.55),
      conflict: 0,
      longing: 0,
      updatedAt: now,
    };
    s.relationshipSamples = 0;
    s.relationshipSamplesByChat = {};
    s.lastCause = null;
    s.migration = { from: raw.version ?? 1, at: now };
  } else
    s.dynamics = {
      v: clamp(s.dynamics.v, -0.7, 0.18),
      a: clamp(s.dynamics.a, -0.3, 0.55),
      conflict: clamp(s.dynamics.conflict, 0, 1),
      longing: clamp(s.dynamics.longing || 0, 0, 0.08),
      updatedAt: Number.isFinite(s.dynamics.updatedAt)
        ? s.dynamics.updatedAt
        : now,
    };
  s.version = 2;
  s.state.holdUntil = 0;
  s.state.holdValence = 0;
  s.state.intensity = clamp(s.state.intensity, 0, 1);
  const fresh = emptyEmotion(now);
  s.climate = {
    ...fresh.climate,
    ...s.climate,
    all: { ...fresh.climate.all, ...s.climate?.all },
    owner: { ...fresh.climate.owner, ...s.climate?.owner },
    chats: { ...s.climate?.chats },
  };
  s.metrics = { ...fresh.metrics, ...s.metrics };
  for (const k of ["history", "triggers", "drifts", "seenEvents"])
    s[k] = Array.isArray(s[k])
      ? k === "history"
        ? s[k].filter(Boolean).slice(-500)
        : k === "seenEvents"
          ? s[k].slice(-200)
          : s[k].filter(Boolean).slice(0, 80)
      : [];
  return s;
}
export function appraise(text, options = {}) {
  return appraisalScores(classifyEmotion(text, options), options.weight);
}
function options(raw = {}) {
  raw ||= {};
  const n = (key, def, min, max) =>
    Number.isFinite(Number(raw[key])) ? clamp(raw[key], min, max) : def;
  return {
    emotionHalfLifeMinutes: n("emotionHalfLifeMinutes", 12, 1, 240),
    conflictHalfLifeMinutes: n("conflictHalfLifeMinutes", 20, 1, 1440),
    moodHalfLifeMinutes: n("moodHalfLifeMinutes", 360, 10, 10080),
  };
}
export function labelFor(s) {
  const v = s.state.valence,
    old = s.state.label,
    c = s.dynamics?.conflict || 0;
  let label = "平静",
    key = "calm";
  if ((v < -0.25 && c >= 0.5) || (old === "生气" && v < -0.15 && c > 0.4)) {
    label = "生气";
    key = "angry";
  } else if (v < -0.04 || (old === "不快" && v < 0)) {
    label = "不快";
    key = "sad";
  } else if (v > 0.28 || (old === "愉快" && v > 0.23)) {
    label = "愉快";
    key = "joy";
  }
  return {
    label,
    key,
    intensity:
      Math.round(
        clamp(
          Math.hypot(
            v - s.baseline.valence,
            s.state.arousal - s.baseline.arousal,
          ),
          0,
          1,
        ) * 100,
      ) / 100,
  };
}
export function moodLabel(s) {
  return s.mood.valence < -0.08
    ? "偏低"
    : s.mood.valence > 0.28
      ? "偏暖"
      : "平稳";
}
function render(s, now) {
  s.state.valence = clamp(
    s.baseline.valence + s.dynamics.v - s.dynamics.longing,
    -1,
    1,
  );
  s.state.arousal = clamp(s.baseline.arousal + s.dynamics.a, 0, 1);
  Object.assign(s.state, labelFor(s), {
    updatedAt: now,
    holdUntil: 0,
    holdValence: 0,
  });
  s.updatedAt = now;
  s.stance =
    s.dynamics.conflict > 0.1
      ? "谨慎交流"
      : s.dynamics.longing > 0.01
        ? "想念用户，有点小失落"
        : "正常交流";
  return s;
}
export function tickEmotion(raw, now = Date.now(), recovery = {}) {
  const s = normalizeEmotion(raw, now),
    opts = options(recovery);
  const at = Math.max(Number(now) || 0, s.dynamics.updatedAt),
    mins = (at - s.dynamics.updatedAt) / 60000;
  const decay = (half) => 2 ** (-mins / half);
  s.dynamics.v *= decay(opts.emotionHalfLifeMinutes);
  s.dynamics.a *= decay(opts.emotionHalfLifeMinutes);
  s.dynamics.conflict *= decay(opts.conflictHalfLifeMinutes);
  s.dynamics.longing *= decay(60);
  for (const k of ["valence", "arousal"])
    s.mood[k] =
      s.baseline[k] +
      (s.mood[k] - s.baseline[k]) * decay(opts.moodHalfLifeMinutes);
  s.dynamics.updatedAt = at;
  render(s, at);
  if (mins > 0) sampleHistory(s, at);
  return s;
}
function applyEmotionCore(raw, input = {}, now = Date.now(), recovery = {}) {
  const s = tickEmotion(raw, now, recovery);
  now = s.updatedAt;
  const eventId = String(input.eventId || input.id || "");
  if (eventId && s.seenEvents.includes(eventId)) return s;
  const text = String(input.text || "").slice(0, 4000);
  const semantic = validateSemanticAppraisal(input.appraisal, text);
  let ap = semantic
    ? appraisalScores(semantic, input.weight)
    : appraise(text, input);
  if (
    ["neglect", "bedtime"].includes(input.kind) ||
    (ap.target === "character" && input.directed === false)
  )
    ap = appraisalScores({
      kind: "neutral",
      target: "none",
      confidence: 1,
      intensity: 0,
      evidence: [],
    });
  if (ap.confidence < 0.85 && !["neutral", "uncertain"].includes(ap.kind))
    ap = appraisalScores({
      kind: "uncertain",
      target: "unknown",
      confidence: ap.confidence,
      intensity: 0,
      evidence: ap.evidence,
    });
  const before = s.state.valence,
    beforeA = s.state.arousal;
  const d = s.dynamics;
  const weight = clamp(ap.weight, 0.5, 1.25);
  let changed = false;
  if (input.kind === "neglect" && !input.expectedAbsence) {
    // Scheduled absence is a separate, bounded feeling, never evidence of hostility.
    ap = appraisalScores({
      kind: "absence",
      target: "relationship",
      confidence: 1,
      intensity: 0.2,
      evidence: [],
    });
    d.longing = 0.08;
    changed = d.conflict < 0.1;
  } else if (input.source === "owner" && input.kind !== "bedtime") {
    d.longing = 0;
    if (s.lastCause?.kind === "absence") s.lastCause = null;
  }
  if (ap.kind === "conflict") {
    d.v = clamp(d.v - 0.24 * ap.intensity * weight, -0.7, 0.18);
    d.a = clamp(d.a + 0.18 * ap.intensity * weight, 0, 0.55);
    d.conflict = clamp(d.conflict + 0.3 * ap.intensity * weight, 0, 1);
    changed = true;
  } else if (ap.kind === "repair") {
    if (d.v < 0) d.v *= 0.55;
    d.a *= 0.8;
    d.conflict *= 0.55;
    changed = true;
  } else if (ap.kind === "affection") {
    if (d.v < 0 || d.conflict > 0.1) {
      if (d.v < 0) d.v *= 0.75;
      d.conflict *= 0.8;
    } else d.v = clamp(d.v + 0.06 * weight, 0, 0.18);
    d.a = clamp(d.a + 0.025, 0, 0.55);
    changed = true;
  } else if (ap.kind === "criticism") {
    if (d.v > -0.05) d.v = Math.max(-0.05, d.v - 0.025);
    changed = true;
  }
  render(s, now);
  if (["user_distress", "third_party"].includes(ap.kind)) s.stance = "关切用户";
  if (changed && (ap.kind !== "criticism" || d.conflict < 0.1))
    s.lastCause = {
      eventId,
      kind: ap.kind,
      evidence: ap.evidence,
      source: input.source || "owner",
      at: now,
    };
  s.lastEvent = {
    ...ap,
    eventId,
    kind: ap.kind,
    target: ap.target,
    confidence: ap.confidence,
    evidence: ap.evidence,
    at: now,
  };
  s.latestEventId = eventId || null;
  if (eventId) s.seenEvents = [...s.seenEvents, eventId].slice(-200);
  // Neutral input, user distress and task criticism never train relationship/personality climate.
  if (["conflict", "affection"].includes(ap.kind)) {
    for (const k of ["valence", "arousal"])
      s.mood[k] += 0.04 * (s.state[k] - s.mood[k]);
    updateClimate(s.climate.all, s, ap, now);
    if (input.source === "owner") {
      updateClimate(s.climate.owner, s, ap, now);
      s.relationshipSamples = (Number(s.relationshipSamples) || 0) + 1;
    }
    if (input.chatKey) {
      const c = s.climate.chats[input.chatKey] || {
        ...s.baseline,
        social: 0,
        samples: 0,
        since: now,
        lastAt: 0,
      };
      updateClimate(c, s, ap, now);
      s.climate.chats[input.chatKey] = c;
      s.relationshipSamplesByChat ||= {};
      s.relationshipSamplesByChat[input.chatKey] =
        (Number(s.relationshipSamplesByChat[input.chatKey]) || 0) + 1;
    }
  }
  s.metrics.events++;
  if (ap.polarity > 0) s.metrics.positive++;
  if (ap.polarity < 0) s.metrics.negative++;
  s.metrics.maxJump = Math.max(
    s.metrics.maxJump,
    Math.abs(s.state.valence - before),
  );
  s.metrics.lastLabel = s.state.label;
  if (changed) s.metrics.lastChangeAt = now;
  s.triggers.unshift({
    at: now,
    eventId,
    source: input.source || "owner",
    kind: ap.kind,
    target: ap.target,
    confidence: ap.confidence,
    evidence: ap.evidence,
    summary: text.slice(0, 80),
    label: s.state.label,
    valence: s.state.valence,
    arousal: s.state.arousal,
    deltaV: s.state.valence - before,
    deltaA: s.state.arousal - beforeA,
    polarity: ap.polarity,
  });
  s.triggers = s.triggers.slice(0, 80);
  sampleHistory(s, now);
  return s;
}

const journalGuard = (s) =>
  JSON.stringify([s.baseline, s.lastDriftAt, s.drifts]);
function snapshot(s) {
  const copy = clone(s);
  delete copy.journal;
  return copy;
}
function recordedEvent(state, input, at, recovery) {
  const inspection = inspectSituation(state, input, at);
  const busy = expectedAbsence(state, input, at);
  let appraisal = input.appraisal || inspection.override;
  if (
    input.deferToModel &&
    inspection.reviewNeeded &&
    !input.appraisal &&
    !inspection.clarification
  )
    appraisal = {
      kind: "uncertain",
      target: "unknown",
      confidence: 0.3,
      intensity: 0,
      evidence: [],
    };
  const next = applyEmotionCore(
    state,
    { ...input, appraisal, expectedAbsence: busy },
    at,
    recovery,
  );
  const context = inspection.context;
  if (next.lastEvent.kind === "conflict")
    context.unresolved = {
      eventId: input.eventId,
      messageId: input.messageId || null,
      at,
      kind: "conflict",
      status: "open",
    };
  if (next.lastEvent.kind === "repair" && context.unresolved)
    context.unresolved = { ...context.unresolved, status: "repairing" };
  if (context.unresolved && at - context.unresolved.at > 30 * 60000)
    context.unresolved = null;
  installSituation(next, inspection);
  Object.assign(next.lastEvent, {
    reviewNeeded: inspection.reviewNeeded,
    contextReason: inspection.reason,
    expectedAbsence: busy,
  });
  return next;
}

/** Keep a small replay window so clarification removes its own event, not later messages. */
export function applyEmotionEvent(
  raw,
  input = {},
  now = Date.now(),
  recovery = {},
) {
  let state = tickEmotion(raw, now, recovery);
  now = state.updatedAt;
  const eventId = String(
    input.eventId || input.id || `${now}-${state.metrics.events}`,
  );
  if (state.seenEvents.includes(eventId)) return state;
  input = { ...input, eventId, text: String(input.text || "").slice(0, 4000) };
  if (Array.isArray(input.recentMessages))
    input.recentMessages = input.recentMessages
      .slice(-8)
      .map((m) => ({
        chatKey: m.chatKey,
        text: String(m.plain ?? m.text ?? "").slice(0, 300),
        truncated: m.truncated === true || String(m.plain ?? m.text ?? '').length > 300,
        speakerId: String(m.speakerId ?? m.userId ?? m.sender ?? ""),
        messageId: String(m.messageId ?? m.id ?? ""),
        isSelf: m.isSelf === true,
        role: m.role,
        time: m.time ?? m.at,
      }));
  let journal = state.journal;
  if (
    !journal?.base ||
    !Array.isArray(journal.events) ||
    journal.guard !== journalGuard(state)
  )
    journal = { base: snapshot(state), events: [], guard: journalGuard(state) };
  else journal = clone(journal);
  while (
    journal.events.length >= 16 ||
    (journal.events[0] && now - journal.events[0].at > 20 * 60000)
  ) {
    const first = journal.events.shift();
    journal.base = snapshot(
      recordedEvent(journal.base, first.input, first.at, recovery),
    );
  }
  const inspection = inspectSituation(state, input, now);
  let correction = null;
  if (inspection.clarification) {
    const candidate = [...journal.events]
      .reverse()
      .find(
        (e) =>
          e.kind === "conflict" &&
          contextIdentity(e.input) === contextIdentity(input) &&
          now - e.at <= 10 * 60000 &&
          (!input.replyToId ||
            String(e.input.messageId || e.input.eventId) ===
              String(input.replyToId)),
      );
    if (candidate) {
      candidate.input.appraisal = {
        kind: "neutral",
        target: "none",
        confidence: 1,
        intensity: 0,
        evidence: [],
      };
      candidate.kind = "neutral";
      correction = {
        at: now,
        eventId: candidate.input.eventId,
        clarifiedBy: eventId,
        reason: "explicit-clarification",
        status: "replayed",
      };
      let rebuilt = snapshot(journal.base);
      for (const e of journal.events)
        rebuilt = recordedEvent(rebuilt, e.input, e.at, recovery);
      const audit = [...(state.corrections || []), correction].slice(-20);
      state = tickEmotion(rebuilt, now, recovery);
      state.corrections = audit;
    } else
      correction = {
        at: now,
        clarifiedBy: eventId,
        status: "no-matching-event",
      };
  }
  state = recordedEvent(state, input, now, recovery);
  if (correction) state.lastEvent.correction = correction;
  journal.events.push({
    input: clone(input),
    at: now,
    kind: state.lastEvent.kind,
  });
  state.journal = journal;
  return state;
}
export function refineEmotionEvent(
  current,
  before,
  input,
  appraisal,
  now = Date.now(),
  recovery = {},
) {
  if (
    !input.eventId ||
    current.latestEventId !== input.eventId ||
    current.lastDriftAt !== before.lastDriftAt ||
    JSON.stringify(current.drifts) !== JSON.stringify(before.drifts) ||
    JSON.stringify(current.baseline) !== JSON.stringify(before.baseline) ||
    !validateSemanticAppraisal(appraisal, input.text)
  )
    return current;
  const revised = applyEmotionEvent(
    before,
    { ...input, appraisal },
    input.at,
    recovery,
  );
  return tickEmotion(revised, now, recovery);
}
export function emotionPromptLine(raw, { isOwner = false } = {}) {
  const s = normalizeEmotion(raw),
    cause = s.lastCause;
  const reason =
    isOwner && cause?.source === "owner" && s.state.intensity >= 0.1
      ? `；相关事件：${JSON.stringify(cause.evidence || []).slice(0, 120)}`
      : "";
  return `现在情绪：${s.state.label}（强度 ${s.state.intensity.toFixed(2)}）；回应态度：${s.stance}${reason}。用户诉苦时关切用户；普通请求和纠错正常处理，不要求对方安抚。`;
}
function updateClimate(c, s, ap, now) {
  const n = Number(c.samples || 0);
  // 前 10 个样本跟得快，之后变成慢 EMA：让“长期气候”真的长期。
  const alpha = n < 10 ? 0.2 : 0.05;
  c.valence = clamp(
    (Number(c.valence) || 0) +
      (s.state.valence - (Number(c.valence) || 0)) * alpha,
    -1,
    1,
  );
  c.arousal = clamp(
    (Number(c.arousal) || 0) +
      (s.state.arousal - (Number(c.arousal) || 0)) * alpha,
    0,
    1,
  );
  const targetSocial = Number(ap.social) || 0;
  c.social = clamp(
    (Number(c.social) || 0) + (targetSocial - (Number(c.social) || 0)) * alpha,
    -1,
    1,
  );
  c.samples = n + 1;
  c.lastAt = now;
  if (!c.since) c.since = now;
}

function sampleHistory(s, now) {
  const last = s.history[s.history.length - 1];
  if (last && now - Number(last.at || 0) < 30 * 60 * 1000) {
    last.v = Math.round(s.state.valence * 100) / 100;
    last.a = Math.round(s.state.arousal * 100) / 100;
    last.label = s.state.label;
    return;
  }
  s.history.push({
    at: now,
    v: Math.round(s.state.valence * 100) / 100,
    a: Math.round(s.state.arousal * 100) / 100,
    label: s.state.label,
  });
  while (s.history.length > 500) s.history.shift();
}

/**
 * 长期情绪 → 人格微调建议（只建议，不直接写）。
 * 约束：样本够、跨度够、冷却够、单次 ±1、最多两维、必须有明确方向。
 */
export function suggestPersonalityDrift(rawState, opts = {}) {
  const s = normalizeEmotion(rawState);
  const minSamples = Math.max(10, Number(opts.minSamples) || 40);
  const minDays = Math.max(1, Number(opts.minDays) || 3);
  const minValenceDelta = Math.max(0.05, Number(opts.minValenceDelta) || 0.18);
  const minArousalDelta = Math.max(0.05, Number(opts.minArousalDelta) || 0.15);
  const cooldownDays = Math.max(1, Number(opts.cooldownDays) || 7);
  const maxDelta = Math.max(1, Math.min(3, Number(opts.maxDelta) || 1));
  const maxDims = Math.max(1, Math.min(3, Number(opts.maxDims) || 2));
  const now = Number(opts.now) || Date.now();
  const c = s.climate?.owner;
  if (!c || Number(s.relationshipSamples || 0) < minSamples) {
    return {
      eligible: false,
      reason: `老大的情绪样本还不够（${Number(c?.samples || 0)}/${minSamples}）`,
      deltas: {},
    };
  }
  if (now - Number(c.lastAt || 0) > 2 * 86400000) {
    return {
      eligible: false,
      reason: "最近两天没有新的老大情绪样本",
      deltas: {},
    };
  }
  const spanDays = (now - Number(c.since || now)) / 86400000;
  if (spanDays < minDays) {
    return {
      eligible: false,
      reason: `观察跨度还不够（${spanDays.toFixed(1)}/${minDays} 天）`,
      deltas: {},
    };
  }
  if (s.lastDriftAt && now - Number(s.lastDriftAt) < cooldownDays * 86400000) {
    return {
      eligible: false,
      reason: `还在冷却期（${cooldownDays} 天）`,
      deltas: {},
    };
  }
  const dv = Number(c.valence || 0) - Number(s.baseline.valence || 0);
  const da = Number(c.arousal || 0) - Number(s.baseline.arousal || 0);
  const ds = Number(c.social || 0);
  if (Math.abs(dv) < minValenceDelta && Math.abs(da) < minArousalDelta) {
    return {
      eligible: false,
      reason: "长期情绪还没偏离底色",
      deltas: {},
      dv,
      da,
      ds,
    };
  }
  const deltas = {};
  const add = (key, dir) => {
    if (Object.keys(deltas).length >= maxDims && deltas[key] === undefined)
      return;
    deltas[key] = Math.max(
      -maxDelta,
      Math.min(maxDelta, (deltas[key] || 0) + Math.sign(dir) * maxDelta),
    );
  };
  if (dv >= minValenceDelta) {
    add("warm", 1);
    if (da >= 0.05) add("playful", 1);
    else add("stability", 1);
  } else if (dv <= -minValenceDelta) {
    if (da >= minArousalDelta || ds <= -0.15) {
      add("stability", -1);
      add("clingy", 1);
    } else {
      add("initiative", -1);
      add("clingy", 1);
    }
  } else if (da >= minArousalDelta) {
    add("playful", 1);
  } else if (da <= -minArousalDelta) {
    add("initiative", -1);
  }
  if (ds <= -0.2) add("clingy", 1);
  if (ds >= 0.25) add("warm", 1);
  if (!Object.keys(deltas).length)
    return {
      eligible: false,
      reason: "没有可落地的方向",
      deltas: {},
      dv,
      da,
      ds,
    };
  const trend = dv > 0 ? "偏暖" : dv < 0 ? "偏低" : "起伏";
  const narrative = `最近和你相处时，情绪长期${trend}；不是某一天的事，是慢慢变成这样的。`;
  return {
    eligible: true,
    deltas,
    reason: `老大情绪长期${trend}（V ${dv.toFixed(2)} / A ${da.toFixed(2)} / S ${ds.toFixed(2)}，${Number(c.samples)} 个样本，${spanDays.toFixed(1)} 天）`,
    narrative,
    dv,
    da,
    ds,
    samples: Number(c.samples),
    spanDays,
  };
}

export function suggestChatPersonalityDrift(rawState, chatKey, opts = {}) {
  const s = normalizeEmotion(rawState);
  const c = s.climate?.chats?.[chatKey];
  const minSamples = Math.max(10, Number(opts.minSamples) || 40);
  const minDays = Math.max(1, Number(opts.minDays) || 3);
  const cooldownDays = Math.max(1, Number(opts.cooldownDays) || 7);
  const maxDelta = Math.max(1, Math.min(5, Number(opts.maxDelta) || 2));
  const now = Number(opts.now) || Date.now();
  if (!c || Number(s.relationshipSamplesByChat?.[chatKey] || 0) < minSamples)
    return { eligible: false, reason: "这个聊天的情绪样本还不够", deltas: {} };
  if (now - Number(c.lastAt || 0) > 2 * 86400000)
    return {
      eligible: false,
      reason: "这个聊天最近两天没有新样本",
      deltas: {},
    };
  if ((now - Number(c.since || now)) / 86400000 < minDays)
    return { eligible: false, reason: "这个聊天的观察跨度还不够", deltas: {} };
  if (
    opts.lastAutoAt &&
    now - Number(opts.lastAutoAt) < cooldownDays * 86400000
  )
    return { eligible: false, reason: "这个聊天还在冷却期", deltas: {} };
  const dv = Number(c.valence || 0) - Number(s.baseline.valence || 0);
  const da = Number(c.arousal || 0) - Number(s.baseline.arousal || 0);
  const ds = Number(c.social || 0);
  const deltas = {};
  const add = (key, dir) => {
    if (Object.keys(deltas).length >= 2 && deltas[key] === undefined) return;
    deltas[key] = Math.max(
      -maxDelta,
      Math.min(maxDelta, (deltas[key] || 0) + Math.sign(dir) * maxDelta),
    );
  };
  if (dv >= 0.18) {
    add("warm", 1);
    if (da >= 0.08) add("playful", 1);
    else add("stability", 1);
  } else if (dv <= -0.18) {
    add("stability", -1);
    add("clingy", 1);
  }
  if (ds <= -0.2) add("clingy", 1);
  if (ds >= 0.25) add("warm", 1);
  if (!Object.keys(deltas).length)
    return {
      eligible: false,
      reason: "这个聊天没有明确方向",
      deltas: {},
      dv,
      da,
      ds,
    };
  return {
    eligible: true,
    deltas,
    reason: `这个聊天长期情绪 ${dv >= 0 ? "偏暖" : "偏低"}（V ${dv.toFixed(2)} / A ${da.toFixed(2)} / S ${ds.toFixed(2)}，${Number(c.samples)} 个样本）`,
    dv,
    da,
    ds,
    samples: Number(c.samples),
  };
}

export function emotionSummary(rawState) {
  const s = normalizeEmotion(rawState);
  const lab = labelFor(s);
  return {
    state: { ...s.state, label: lab.label, intensity: lab.intensity },
    mood: { ...s.mood, label: moodLabel(s) },
    baseline: { ...s.baseline },
    climate: s.climate,
    lastDriftAt: s.lastDriftAt,
    drifts: s.drifts.slice(0, 10),
    history: s.history.slice(-120),
    triggers: s.triggers.slice(0, 20),
    metrics: s.metrics,
    contextVersion: 1,
    corrections: (s.corrections || []).slice(-10),
    version: s.version,
    stance: s.stance,
    lastEvent: s.lastEvent,
    lastCause: s.lastCause,
    dynamics: s.dynamics,
    migration: s.migration,
    updatedAt: s.updatedAt,
  };
}
