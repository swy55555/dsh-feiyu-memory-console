// 情绪层：核心情绪（valence/arousal）+ 心情（慢 EMA）+ 性格基线（不在这里改）。
// 科学依据：Russell 环形模型、Scherer 的 appraisal 维度、稳态/衰减。
// 这一层刻意不用模型：规则打分，0 token；只把结果写进本地 JSON。

export const EMOTION_VERSION = 1

export const DEFAULT_BASELINE = { valence: 0.12, arousal: 0.32 }

// 原型点：只用来把二维坐标翻译成一个词，不参与“计算情绪”。
export const EMOTION_PROTOTYPES = [
  { key: 'calm', label: '平静', v: 0.10, a: 0.22 },
  { key: 'joy', label: '开心', v: 0.72, a: 0.62 },
  { key: 'content', label: '安心', v: 0.52, a: 0.18 },
  { key: 'excited', label: '兴奋', v: 0.62, a: 0.85 },
  { key: 'affection', label: '亲近', v: 0.58, a: 0.38 },
  { key: 'shy', label: '害羞', v: 0.38, a: 0.56 },
  { key: 'sad', label: '难过', v: -0.62, a: 0.24 },
  { key: 'lonely', label: '失落', v: -0.48, a: 0.12 },
  { key: 'anxious', label: '不安', v: -0.38, a: 0.66 },
  { key: 'angry', label: '生气', v: -0.58, a: 0.82 },
  { key: 'wronged', label: '委屈', v: -0.52, a: 0.44 },
  { key: 'tired', label: '疲惫', v: -0.22, a: 0.10 },
]

const POSITIVE = [
  '喜欢', '爱你', '想你', '谢谢', '开心', '厉害', '可爱', '抱抱', '亲亲', '夸', '牛', '棒', '辛苦',
  '想你啦', '真好', '好耶', '乖', '心疼', '舍不得', '重要', '在乎', '陪', '温柔', '聪明', '好看',
]
const NEGATIVE = [
  '讨厌', '烦', '滚', '闭嘴', '傻', '笨', '废物', '失望', '难过', '委屈', '生气', '别烦', '滚开',
  '不理', '冷战', '敷衍', '冷淡', '算了', '随便', '不想理', '恶心', '难受', '哭', '孤单', '害怕',
]
const REPAIR = ['对不起', '抱歉', '我错了', '别生气', '原谅']
const NOVELTY = ['第一次', '竟然', '居然', '没想到', '突然', '新', '刚看到', '刷到']

function clamp(n, lo, hi) {
  const x = Number(n)
  if (!Number.isFinite(x)) return lo
  return Math.max(lo, Math.min(hi, x))
}

function countHits(text, words) {
  let n = 0
  for (const w of words) if (text.includes(w)) n++
  return n
}

export function emptyEmotion(now = Date.now()) {
  return {
    version: EMOTION_VERSION,
    createdAt: now,
    updatedAt: now,
    baseline: { ...DEFAULT_BASELINE },
    mood: { ...DEFAULT_BASELINE },
    state: { valence: DEFAULT_BASELINE.valence, arousal: DEFAULT_BASELINE.arousal, label: '平静', intensity: 0, updatedAt: now, holdUntil: 0, holdValence: 0 },
    climate: {
      all: { valence: DEFAULT_BASELINE.valence, arousal: DEFAULT_BASELINE.arousal, social: 0, samples: 0, since: now, lastAt: 0 },
      owner: { valence: DEFAULT_BASELINE.valence, arousal: DEFAULT_BASELINE.arousal, social: 0, samples: 0, since: now, lastAt: 0 },
      chats: {},
    },
    lastDriftAt: 0,
    drifts: [],
    history: [],
    triggers: [],
    metrics: { events: 0, positive: 0, negative: 0, maxJump: 0, lastLabel: '平静', lastChangeAt: 0 },
  }
}

export function normalizeEmotion(raw, now = Date.now()) {
  const base = emptyEmotion(now)
  if (!raw || typeof raw !== 'object') return base
  const s = {
    ...base,
    ...raw,
    baseline: { ...base.baseline, ...(raw.baseline || {}) },
    mood: { ...base.mood, ...(raw.mood || {}) },
    state: { ...base.state, ...(raw.state || {}) },
    metrics: { ...base.metrics, ...(raw.metrics || {}) },
    climate: {
      all: { ...base.climate.all, ...(raw.climate?.all || {}) },
      owner: { ...base.climate.owner, ...(raw.climate?.owner || {}) },
      chats: { ...(base.climate.chats || {}), ...(raw.climate?.chats || {}) },
    },
    lastDriftAt: Number(raw.lastDriftAt || 0),
    drifts: Array.isArray(raw.drifts) ? raw.drifts.filter(Boolean).slice(0, 40) : [],
    history: Array.isArray(raw.history) ? raw.history.filter(Boolean).slice(-500) : [],
    triggers: Array.isArray(raw.triggers) ? raw.triggers.filter(Boolean).slice(0, 80) : [],
  }
  for (const k of ['valence', 'arousal']) {
    s.baseline[k] = clamp(s.baseline[k], k === 'valence' ? -1 : 0, 1)
    s.mood[k] = clamp(s.mood[k], k === 'valence' ? -1 : 0, 1)
    s.state[k] = clamp(s.state[k], k === 'valence' ? -1 : 0, 1)
  }
  s.state.intensity = clamp(s.state.intensity, 0, 1)
  return s
}

/**
 * 规则 appraisal：把一句话拆成目标一致性 / 社会风险 / 新颖性 / 控制感。
 * 不是“理解”，只是便宜的先验；真正的理解仍归聊天模型。
 */
export function appraise(text, { source = 'owner', directed = true, weight = 1 } = {}) {
  const t = String(text || '')
  const pos = countHits(t, POSITIVE)
  const neg = countHits(t, NEGATIVE)
  const repair = countHits(t, REPAIR)
  const raw = pos - neg - (repair ? 0.5 : 0)
  const polarity = clamp(raw / 2, -1, 1)
  const punctuation = (t.match(/[!！]/g) || []).length
  const questions = (t.match(/[?？]/g) || []).length
  const novelty = clamp(0.3 + Math.min(0.4, countHits(t, NOVELTY) * 0.2) + Math.min(0.2, questions * 0.08), 0, 1)
  const control = clamp(0.55 - Math.min(0.25, punctuation * 0.05) - (questions ? 0.08 : 0), 0, 1)
  const social = directed ? polarity * 0.8 : polarity * 0.25
  const goal = polarity * (source === 'owner' ? 0.9 : source === 'group' ? 0.55 : 0.7)
  const intensity = clamp(Math.abs(polarity) * 0.7 + Math.min(0.3, punctuation * 0.08) + Math.min(0.2, (source === 'owner' ? 0.15 : 0.05)), 0, 1)
  return { polarity, goal, social, novelty, control, intensity, positive: pos, negative: neg, weight: clamp(weight, 0.2, 3) }
}

function nearestLabel(v, a) {
  let best = EMOTION_PROTOTYPES[0]
  let bestD = Infinity
  for (const p of EMOTION_PROTOTYPES) {
    //  arousal 的尺度比 valence 小，稍微压一下，避免全被高唤醒吸走
    const d = (p.v - v) ** 2 + ((p.a - a) * 0.75) ** 2
    if (d < bestD) { bestD = d; best = p }
  }
  return best
}

export function labelFor(state) {
  const v = Number(state?.state?.valence ?? 0)
  const a = Number(state?.state?.arousal ?? 0)
  const base = state?.baseline || DEFAULT_BASELINE
  const intensity = clamp(Math.hypot(v - base.valence, a - base.arousal) * 1.35, 0, 1)
  if (intensity < 0.10) return { label: '平静', intensity: 0, key: 'calm' }
  const p = nearestLabel(v, a)
  return { label: p.label, key: p.key, intensity: Math.round(intensity * 100) / 100 }
}

export function moodLabel(state) {
  const m = state?.mood || DEFAULT_BASELINE
  const p = nearestLabel(Number(m.valence) || 0, Number(m.arousal) || 0)
  return p.label
}

/** 单次事件：快变量跳一下，心情只跟着动一点；人格基线不动。 */
const RECOVERY_DEFAULTS = { angerHoldMinMinutes: 10, angerHoldMaxMinutes: 45, minIntensity: 0.35, minNegativePolarity: 0.35, comfortBoost: 0.6, holdDecayPerHour: 0.02 }
function recoveryOptions(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    angerHoldMinMinutes: Math.max(0, Math.min(240, num(r.angerHoldMinMinutes, RECOVERY_DEFAULTS.angerHoldMinMinutes))),
    angerHoldMaxMinutes: Math.max(0, Math.min(240, num(r.angerHoldMaxMinutes, RECOVERY_DEFAULTS.angerHoldMaxMinutes))),
    minIntensity: Math.max(0, Math.min(1, num(r.minIntensity, RECOVERY_DEFAULTS.minIntensity))),
    minNegativePolarity: Math.max(0, Math.min(1, num(r.minNegativePolarity, RECOVERY_DEFAULTS.minNegativePolarity))),
    comfortBoost: Math.max(0, Math.min(1, num(r.comfortBoost, RECOVERY_DEFAULTS.comfortBoost))),
    holdDecayPerHour: Math.max(0, Math.min(0.5, num(r.holdDecayPerHour, RECOVERY_DEFAULTS.holdDecayPerHour))),
  }
}

export function applyEmotionEvent(rawState, input = {}, now = Date.now(), recovery = {}) {
  const rec = recoveryOptions(recovery)
  const s = normalizeEmotion(rawState, now)
  const ap = input.appraisal && typeof input.appraisal === 'object'
    ? {
        polarity: clamp(input.appraisal.polarity, -1, 1),
        goal: clamp(input.appraisal.goal, -1, 1),
        social: clamp(input.appraisal.social, -1, 1),
        novelty: clamp(input.appraisal.novelty, 0, 1),
        control: clamp(input.appraisal.control, 0, 1),
        intensity: clamp(input.appraisal.intensity, 0, 1),
        positive: 0, negative: 0,
        weight: clamp(input.weight || 1, 0.2, 3),
      }
    : appraise(input.text, {
        source: input.source || 'owner',
        directed: input.directed !== false,
        weight: input.weight || 1,
      })
  const base = s.baseline
  const targetV = clamp(base.valence + 0.55 * ap.goal + 0.35 * ap.social, -1, 1)
  const targetA = clamp(base.arousal + 0.35 * ap.novelty + 0.25 * Math.abs(ap.goal) + 0.12 * (1 - ap.control), 0, 1)
  const alpha = clamp(0.38 + 0.08 * ap.weight, 0.3, 0.62)
  const beforeV = s.state.valence
  const beforeA = s.state.arousal
  s.state.valence = clamp(s.state.valence + (targetV - s.state.valence) * alpha, -1, 1)
  s.state.arousal = clamp(s.state.arousal + (targetA - s.state.arousal) * alpha, 0, 1)
  // 生气后至少挂一段时间：半小时内不因为时间流逝自己消气；被哄会缩短。
  const eventText = String(input.text || '')
  const comfort = /哄|别气|不气|消消气|对不起|抱歉|抱抱|摸摸|乖|原谅/.test(eventText)
  if (ap.polarity <= -rec.minNegativePolarity && ap.intensity >= rec.minIntensity && rec.angerHoldMaxMinutes > 0) {
    const angerFloor = clamp(s.baseline.valence - 0.12 - 0.35 * ap.intensity, -1, 1)
    s.state.valence = Math.min(s.state.valence, angerFloor)
    const span = Math.max(0, rec.angerHoldMaxMinutes - rec.angerHoldMinMinutes)
    const factor = clamp(0.2 + 0.4 * ap.intensity + Math.random() * 0.4, 0, 1)
    const holdMinutes = rec.angerHoldMinMinutes + span * factor
    s.state.holdUntil = now + holdMinutes * 60000
    s.state.holdValence = Math.min(s.state.valence, s.baseline.valence - 0.08)
  } else if (comfort && Number(s.state.holdUntil || 0) > now) {
    const remain = Number(s.state.holdUntil) - now
    s.state.holdUntil = now + remain * (1 - rec.comfortBoost)
    s.state.holdValence = Math.min(s.baseline.valence, Number(s.state.holdValence || s.state.valence) + 0.22)
  }
  if (Number(s.state.holdUntil || 0) <= now) {
    s.state.holdUntil = 0
    s.state.holdValence = 0
  }
  // 心情是核心情绪的慢 EMA，只动 4%；所以一次事件改不了“长期心情”
  s.mood.valence = clamp(s.mood.valence + (s.state.valence - s.mood.valence) * 0.04, -1, 1)
  s.mood.arousal = clamp(s.mood.arousal + (s.state.arousal - s.mood.arousal) * 0.04, 0, 1)
  const lab = labelFor(s)
  s.state.label = lab.label
  s.state.intensity = lab.intensity
  s.state.updatedAt = now
  s.updatedAt = now
  s.metrics.events = Number(s.metrics.events || 0) + 1
  if (ap.polarity > 0.1) s.metrics.positive = Number(s.metrics.positive || 0) + 1
  if (ap.polarity < -0.1) s.metrics.negative = Number(s.metrics.negative || 0) + 1
  s.metrics.lastLabel = lab.label
  s.metrics.lastChangeAt = now
  const jump = Math.hypot(s.state.valence - beforeV, s.state.arousal - beforeA)
  s.metrics.maxJump = Math.max(Number(s.metrics.maxJump || 0), Math.round(jump * 1000) / 1000)
  updateClimate(s.climate.all, s, ap, now)
  if (input.source === 'owner') updateClimate(s.climate.owner, s, ap, now)
  if (input.chatKey) {
    const chatClimate = s.climate.chats[input.chatKey] || { valence: s.baseline.valence, arousal: s.baseline.arousal, social: 0, samples: 0, since: now, lastAt: 0 }
    updateClimate(chatClimate, s, ap, now)
    s.climate.chats[input.chatKey] = chatClimate
  }
  s.triggers.unshift({
    at: now,
    source: input.source || 'owner',
    kind: input.kind || '',
    summary: String(input.text || '').trim().slice(0, 80),
    label: lab.label,
    valence: Math.round(s.state.valence * 100) / 100,
    arousal: Math.round(s.state.arousal * 100) / 100,
    deltaV: Math.round((s.state.valence - beforeV) * 100) / 100,
    deltaA: Math.round((s.state.arousal - beforeA) * 100) / 100,
    polarity: Math.round(ap.polarity * 100) / 100,
  })
  s.triggers = s.triggers.slice(0, 80)
  sampleHistory(s, now)
  return s
}

/** 时间流逝：情绪向心情回落，心情向基线回落；不回写人格。 */
export function tickEmotion(rawState, now = Date.now(), recovery = {}) {
  const rec = recoveryOptions(recovery)
  const s = normalizeEmotion(rawState, now)
  const dtHours = Math.max(0, (now - Number(s.updatedAt || now)) / 3600000)
  if (dtHours <= 0) return s
  const hold = Number(s.state.holdUntil || 0) > now
  const toMood = hold ? Math.min(0.45, rec.holdDecayPerHour * dtHours) : Math.min(0.45, 0.10 * dtHours)
  const toBase = Math.min(0.18, 0.012 * dtHours)
  const beforeV = s.state.valence
  const beforeA = s.state.arousal
  s.state.valence = clamp(s.state.valence + (s.mood.valence - s.state.valence) * toMood, -1, 1)
  s.state.arousal = clamp(s.state.arousal + (s.mood.arousal - s.state.arousal) * toMood, 0, 1)
  if (hold) {
    const floor = Number(s.state.holdValence)
    if (Number.isFinite(floor)) s.state.valence = Math.min(s.state.valence, floor)
  } else {
    if (Number(s.state.holdUntil) > 0) {
      s.state.valence += (s.baseline.valence - s.state.valence) * 0.5
      s.state.arousal += (s.baseline.arousal - s.state.arousal) * 0.3
    }
    s.state.holdUntil = 0
    s.state.holdValence = 0
  }
  s.mood.valence = clamp(s.mood.valence + (s.baseline.valence - s.mood.valence) * toBase, -1, 1)
  s.mood.arousal = clamp(s.mood.arousal + (s.baseline.arousal - s.mood.arousal) * toBase, 0, 1)
  const lab = labelFor(s)
  s.state.label = lab.label
  s.state.intensity = lab.intensity
  s.state.updatedAt = now
  s.updatedAt = now
  if (Math.hypot(s.state.valence - beforeV, s.state.arousal - beforeA) > 0.01) {
    s.metrics.lastChangeAt = now
  }
  sampleHistory(s, now)
  return s
}

function updateClimate(c, s, ap, now) {
  const n = Number(c.samples || 0)
  // 前 10 个样本跟得快，之后变成慢 EMA：让“长期气候”真的长期。
  const alpha = n < 10 ? 0.2 : 0.05
  c.valence = clamp((Number(c.valence) || 0) + (s.state.valence - (Number(c.valence) || 0)) * alpha, -1, 1)
  c.arousal = clamp((Number(c.arousal) || 0) + (s.state.arousal - (Number(c.arousal) || 0)) * alpha, 0, 1)
  const targetSocial = Number(ap.social) || 0
  c.social = clamp((Number(c.social) || 0) + (targetSocial - (Number(c.social) || 0)) * alpha, -1, 1)
  c.samples = n + 1
  c.lastAt = now
  if (!c.since) c.since = now
}

function sampleHistory(s, now) {
  const last = s.history[s.history.length - 1]
  if (last && now - Number(last.at || 0) < 30 * 60 * 1000) {
    last.v = Math.round(s.state.valence * 100) / 100
    last.a = Math.round(s.state.arousal * 100) / 100
    last.label = s.state.label
    return
  }
  s.history.push({
    at: now,
    v: Math.round(s.state.valence * 100) / 100,
    a: Math.round(s.state.arousal * 100) / 100,
    label: s.state.label,
  })
  while (s.history.length > 500) s.history.shift()
}

/** 给提示词一行；群聊里不暴露私聊起因。 */
export function emotionPromptLine(rawState, { isOwner = false } = {}) {
  const s = normalizeEmotion(rawState)
  const lab = labelFor(s)
  if (lab.intensity < 0.10) return '现在情绪：平稳。'
  if (!isOwner) return `现在情绪：${lab.label}（强度 ${lab.intensity.toFixed(2)}）。`
  const cause = s.triggers.find((t) => t.source === 'owner')?.summary ? `，起因：${s.triggers.find((t) => t.source === 'owner').summary.slice(0, 40)}` : ''
  return `现在情绪：${lab.label}（强度 ${lab.intensity.toFixed(2)}${cause}）；心情：${moodLabel(s)}。`
}

/**
 * 长期情绪 → 人格微调建议（只建议，不直接写）。
 * 约束：样本够、跨度够、冷却够、单次 ±1、最多两维、必须有明确方向。
 */
export function suggestPersonalityDrift(rawState, opts = {}) {
  const s = normalizeEmotion(rawState)
  const minSamples = Math.max(10, Number(opts.minSamples) || 40)
  const minDays = Math.max(1, Number(opts.minDays) || 3)
  const minValenceDelta = Math.max(0.05, Number(opts.minValenceDelta) || 0.18)
  const minArousalDelta = Math.max(0.05, Number(opts.minArousalDelta) || 0.15)
  const cooldownDays = Math.max(1, Number(opts.cooldownDays) || 7)
  const maxDelta = Math.max(1, Math.min(3, Number(opts.maxDelta) || 1))
  const maxDims = Math.max(1, Math.min(3, Number(opts.maxDims) || 2))
  const now = Number(opts.now) || Date.now()
  const c = s.climate?.owner
  if (!c || Number(c.samples || 0) < minSamples) {
    return { eligible: false, reason: `老大的情绪样本还不够（${Number(c?.samples || 0)}/${minSamples}）`, deltas: {} }
  }
  if (now - Number(c.lastAt || 0) > 2 * 86400000) {
    return { eligible: false, reason: '最近两天没有新的老大情绪样本', deltas: {} }
  }
  const spanDays = (now - Number(c.since || now)) / 86400000
  if (spanDays < minDays) {
    return { eligible: false, reason: `观察跨度还不够（${spanDays.toFixed(1)}/${minDays} 天）`, deltas: {} }
  }
  if (s.lastDriftAt && now - Number(s.lastDriftAt) < cooldownDays * 86400000) {
    return { eligible: false, reason: `还在冷却期（${cooldownDays} 天）`, deltas: {} }
  }
  const dv = Number(c.valence || 0) - Number(s.baseline.valence || 0)
  const da = Number(c.arousal || 0) - Number(s.baseline.arousal || 0)
  const ds = Number(c.social || 0)
  if (Math.abs(dv) < minValenceDelta && Math.abs(da) < minArousalDelta) {
    return { eligible: false, reason: '长期情绪还没偏离底色', deltas: {}, dv, da, ds }
  }
  const deltas = {}
  const add = (key, dir) => {
    if (Object.keys(deltas).length >= maxDims && deltas[key] === undefined) return
    deltas[key] = Math.max(-maxDelta, Math.min(maxDelta, (deltas[key] || 0) + Math.sign(dir) * maxDelta))
  }
  if (dv >= minValenceDelta) {
    add('warm', 1)
    if (da >= 0.05) add('playful', 1)
    else add('stability', 1)
  } else if (dv <= -minValenceDelta) {
    if (da >= minArousalDelta || ds <= -0.15) {
      add('stability', -1)
      add('clingy', 1)
    } else {
      add('initiative', -1)
      add('clingy', 1)
    }
  } else if (da >= minArousalDelta) {
    add('playful', 1)
  } else if (da <= -minArousalDelta) {
    add('initiative', -1)
  }
  if (ds <= -0.2) add('clingy', 1)
  if (ds >= 0.25) add('warm', 1)
  if (!Object.keys(deltas).length) return { eligible: false, reason: '没有可落地的方向', deltas: {}, dv, da, ds }
  const trend = dv > 0 ? '偏暖' : dv < 0 ? '偏低' : '起伏'
  const narrative = `最近和你相处时，情绪长期${trend}；不是某一天的事，是慢慢变成这样的。`
  return {
    eligible: true,
    deltas,
    reason: `老大情绪长期${trend}（V ${dv.toFixed(2)} / A ${da.toFixed(2)} / S ${ds.toFixed(2)}，${Number(c.samples)} 个样本，${spanDays.toFixed(1)} 天）`,
    narrative,
    dv, da, ds, samples: Number(c.samples), spanDays,
  }
}

export function suggestChatPersonalityDrift(rawState, chatKey, opts = {}) {
  const s = normalizeEmotion(rawState)
  const c = s.climate?.chats?.[chatKey]
  const minSamples = Math.max(10, Number(opts.minSamples) || 40)
  const minDays = Math.max(1, Number(opts.minDays) || 3)
  const cooldownDays = Math.max(1, Number(opts.cooldownDays) || 7)
  const maxDelta = Math.max(1, Math.min(5, Number(opts.maxDelta) || 2))
  const now = Number(opts.now) || Date.now()
  if (!c || Number(c.samples || 0) < minSamples) return { eligible: false, reason: '这个聊天的情绪样本还不够', deltas: {} }
  if (now - Number(c.lastAt || 0) > 2 * 86400000) return { eligible: false, reason: '这个聊天最近两天没有新样本', deltas: {} }
  if ((now - Number(c.since || now)) / 86400000 < minDays) return { eligible: false, reason: '这个聊天的观察跨度还不够', deltas: {} }
  if (opts.lastAutoAt && now - Number(opts.lastAutoAt) < cooldownDays * 86400000) return { eligible: false, reason: '这个聊天还在冷却期', deltas: {} }
  const dv = Number(c.valence || 0) - Number(s.baseline.valence || 0)
  const da = Number(c.arousal || 0) - Number(s.baseline.arousal || 0)
  const ds = Number(c.social || 0)
  const deltas = {}
  const add = (key, dir) => {
    if (Object.keys(deltas).length >= 2 && deltas[key] === undefined) return
    deltas[key] = Math.max(-maxDelta, Math.min(maxDelta, (deltas[key] || 0) + Math.sign(dir) * maxDelta))
  }
  if (dv >= 0.18) { add('warm', 1); if (da >= 0.08) add('playful', 1); else add('stability', 1) }
  else if (dv <= -0.18) { add('stability', -1); add('clingy', 1) }
  if (ds <= -0.2) add('clingy', 1)
  if (ds >= 0.25) add('warm', 1)
  if (!Object.keys(deltas).length) return { eligible: false, reason: '这个聊天没有明确方向', deltas: {}, dv, da, ds }
  return {
    eligible: true,
    deltas,
    reason: `这个聊天长期情绪 ${dv >= 0 ? '偏暖' : '偏低'}（V ${dv.toFixed(2)} / A ${da.toFixed(2)} / S ${ds.toFixed(2)}，${Number(c.samples)} 个样本）`,
    dv, da, ds, samples: Number(c.samples),
  }
}

export function emotionSummary(rawState) {
  const s = normalizeEmotion(rawState)
  const lab = labelFor(s)
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
    updatedAt: s.updatedAt,
  }
}
