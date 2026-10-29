// 主动联系 + 催睡觉（桥接可选补丁）。
// 通过 runtime 注入桥接内部能力，不直接依赖 bridge.js 的私有变量。
// 配置：<桥接目录>/owner-contact.json；状态：<桥接目录>/owner-contact-state.json。

const TICK_MS = 5 * 60 * 1000
const DEFAULTS = {
  ownerContact: {
    enabled: true,
    windowStart: '08:00',
    windowEnd: '24:00',
    idleHours: 1.5,
    repeatHours: 0.5,
    maxPerDay: 16,
    sulkAfterHours: 2,
    sulkCooldownHours: 6,
    sulkMoodDrop: 0.22,
    probabilityPerCheck: 0.15,
    probabilityRamp: 0.15,
    maxProbabilityPerCheck: 0.7,
  },
  bedtime: {
    enabled: true,
    time: '24:00',
    graceMinutes: 15,
    sulkStartMinutes: 10,
    sulkProbabilityPerCheck: 0.12,
    sulkProbabilityRamp: 0.12,
    sulkMaxProbability: 0.6,
    sulkCooldownHours: 20,
    sulkMoodDrop: 0.2,
  },
}

const clamp = (n, lo, hi, fallback) => {
  const x = Number(n)
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fallback
}

const HHMM = /^(\d{1,2}):(\d{2})$/

function normalizeOwner(raw = {}) {
  const d = DEFAULTS.ownerContact
  const oc = raw && typeof raw === 'object' ? raw : {}
  const time = (value, fallback) => (HHMM.test(String(value || '')) ? String(value) : fallback)
  return {
    enabled: oc.enabled !== false,
    windowStart: time(oc.windowStart, d.windowStart),
    windowEnd: time(oc.windowEnd, d.windowEnd),
    idleHours: clamp(oc.idleHours, 0.5, 48, d.idleHours),
    repeatHours: clamp(oc.repeatHours, 0.5, 24, d.repeatHours),
    maxPerDay: Math.round(clamp(oc.maxPerDay, 1, 20, d.maxPerDay)),
    sulkAfterHours: clamp(oc.sulkAfterHours, 1, 72, d.sulkAfterHours),
    sulkCooldownHours: clamp(oc.sulkCooldownHours, 0.5, 48, d.sulkCooldownHours),
    sulkMoodDrop: clamp(oc.sulkMoodDrop, 0.05, 0.5, d.sulkMoodDrop),
    probabilityPerCheck: clamp(oc.probabilityPerCheck, 0, 1, d.probabilityPerCheck),
    probabilityRamp: clamp(oc.probabilityRamp, 0, 0.5, d.probabilityRamp),
    maxProbabilityPerCheck: clamp(oc.maxProbabilityPerCheck, 0.01, 1, d.maxProbabilityPerCheck),
  }
}

function normalizeBedtime(raw = {}) {
  const d = DEFAULTS.bedtime
  const b = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: b.enabled !== false,
    time: HHMM.test(String(b.time || '')) ? String(b.time) : d.time,
    graceMinutes: Math.round(clamp(b.graceMinutes, 0, 120, d.graceMinutes)),
    sulkStartMinutes: Math.round(clamp(b.sulkStartMinutes, 0, 120, d.sulkStartMinutes)),
    sulkProbabilityPerCheck: clamp(b.sulkProbabilityPerCheck, 0, 1, d.sulkProbabilityPerCheck),
    sulkProbabilityRamp: clamp(b.sulkProbabilityRamp, 0, 0.5, d.sulkProbabilityRamp),
    sulkMaxProbability: clamp(b.sulkMaxProbability, 0.01, 1, d.sulkMaxProbability),
    sulkCooldownHours: clamp(b.sulkCooldownHours, 1, 48, d.sulkCooldownHours),
    sulkMoodDrop: clamp(b.sulkMoodDrop, 0.05, 0.5, d.sulkMoodDrop),
  }
}

function minuteOfDay(text, fallback) {
  const m = HHMM.exec(String(text || ''))
  if (!m) return fallback
  const h = Number(m[1]), mi = Number(m[2])
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return fallback
  return h * 60 + mi
}

function inWindow(date, startText, endText) {
  const start = minuteOfDay(startText, 8 * 60)
  const end = minuteOfDay(endText, 24 * 60)
  const cur = date.getHours() * 60 + date.getMinutes()
  if (start === end) return true
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function bedtimeStart(nowMs, timeText) {
  const m = HHMM.exec(String(timeText || ''))
  if (!m) return 0
  const now = new Date(nowMs)
  const mins = Number(m[1]) * 60 + Number(m[2])
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  let at = base + mins * 60000
  if (at > nowMs) at -= 86400000
  return at
}

const SLEEP_WORDS = /晚安|睡了|去睡|睡觉|困了|先睡|下线|不聊了|拜拜/

export function startOwnerContact(runtime) {
  const rt = runtime
  const statePath = rt.path.join(rt.stateDir, 'owner-contact-state.json')
  const configPath = rt.path.join(rt.stateDir, 'owner-contact.json')

  const loadState = () => {
    try { return JSON.parse(rt.fs.readFileSync(statePath, 'utf8')) || {} } catch { return {} }
  }
  const saveState = () => {
    try { rt.fs.writeFileSync(statePath, JSON.stringify(state), 'utf8') } catch (error) { rt.log?.('[owner-contact] 状态保存失败:', error?.message || error) }
  }

  const state = loadState()
  state.owner = state.owner && typeof state.owner === 'object' ? state.owner : {}
  state.bedtime = state.bedtime && typeof state.bedtime === 'object' ? state.bedtime : {}

  function config() {
    let file = {}
    try { file = JSON.parse(rt.fs.readFileSync(configPath, 'utf8')) || {} } catch {}
    const cfg = rt.getCfg?.() || {}
    return {
      owner: normalizeOwner({ ...(cfg.socialV2?.ownerContact || {}), ...(file.ownerContact || {}) }),
      bedtime: normalizeBedtime({ ...(cfg.socialV2?.bedtime || {}), ...(file.bedtime || {}) }),
    }
  }

  function ownerKey() {
    const qq = Number(rt.getCfg?.()?.ownerQQ)
    return qq ? `private:${qq}` : ''
  }

  function dropMood(key, text, kind, amount) {
    const d = clamp(amount, 0.05, 0.5, 0.2)
    const appraisal = {
      polarity: -d * 2,
      goal: -d * 2,
      social: -d * 1.5,
      novelty: 0.1,
      control: 0.3,
      intensity: Math.min(1, d * 2),
    }
    const next = rt.applyEmotion(rt.getEmotion(), {
      source: 'owner', text, directed: true, weight: 1.2, kind, chatKey: key, appraisal,
    }, Date.now())
    rt.setEmotion(next)
    rt.saveEmotion()
  }

  function deliver(key, reason, text) {
    const base = rt.buildPrompt(key, 'proactiveCheck')
    rt.deliver(key, `${base}\n\n${text}`, reason)
  }

  async function checkOwner(conf) {
    if (!conf.enabled) return
    const key = ownerKey()
    if (!key || !rt.isAllowed(key)) return
    const now = new Date()
    if (!inWindow(now, conf.windowStart, conf.windowEnd)) return
    const st = rt.getState(key)
    const oc = state.owner
    const day = dayKey(now)
    if (oc.day !== day) { oc.day = day; oc.count = 0 }
    if (Number(oc.count) >= conf.maxPerDay) return
    if (oc.lastAt && Date.now() - Number(oc.lastAt) < conf.repeatHours * 3600 * 1000) return
    const lastSeen = Number(st.lastIncomingAt) || Number(st.lastAiReplyAt) || Number(oc.since) || Date.now()
    if (!oc.since) oc.since = Date.now()
    const silenceMs = Date.now() - lastSeen
    const waitMs = Date.now() - Math.max(lastSeen, Number(oc.lastAt) || 0)
    if (waitMs < conf.idleHours * 3600 * 1000) return
    if (rt.isBusy?.(key, st)) return
    if (st.wakeConfig && st.wakeConfig.infinite === false) {
      const until = Date.parse(st.wakeConfig.sleepUntil || '')
      if (Number.isFinite(until) && until > Date.now()) return
    }
    const extraHours = Math.max(0, (waitMs - conf.idleHours * 3600 * 1000) / 3600000)
    const chance = Math.min(conf.maxProbabilityPerCheck, conf.probabilityPerCheck + extraHours * conf.probabilityRamp)
    if (chance <= 0 || Math.random() >= chance) return
    let sulk = false
    if (silenceMs >= conf.sulkAfterHours * 3600 * 1000
      && (!oc.lastSulkAt || Date.now() - Number(oc.lastSulkAt) >= conf.sulkCooldownHours * 3600 * 1000)) {
      sulk = true
      oc.lastSulkAt = Date.now()
      dropMood(key, '他很久没来找我了', 'neglect', conf.sulkMoodDrop)
    }
    oc.count = Number(oc.count) + 1
    oc.lastAt = Date.now()
    saveState()
    rt.log?.(`[owner-contact] 主动找 ${key}：距上次 ${(waitMs / 3600000).toFixed(1)}h，概率 ${(chance * 100).toFixed(0)}%${sulk ? '，带小脾气' : ''}`)
    const hours = (waitMs / 3600000).toFixed(1)
    const text = sulk
      ? `【主动联系】你已经 ${hours} 小时没和老大了，有点不高兴。这次至少发一条，可以短、可以带一点小脾气（“算了”“你忙吧”这种），但别攻击、别翻旧账、别连发质问。发完再收尾。`
      : `【主动联系】你已经 ${hours} 小时没和老大了，想主动找他说句话。这次至少发一条，语气自然，像突然想起他。发完再收尾。`
    deliver(key, sulk ? 'ownerSulk' : 'ownerIdle', text)
  }

  async function checkBedtime(conf) {
    if (!conf.enabled) return
    const key = ownerKey()
    if (!key || !rt.isAllowed(key)) return
    const now = Date.now()
    const start = bedtimeStart(now, conf.time)
    if (!start || now < start || now - start > 3 * 3600 * 1000) return
    const st = rt.getState(key)
    const b = state.bedtime
    const bedtimeKey = String(start)
    if (b.key !== bedtimeKey) { b.key = bedtimeKey; b.nags = 0; b.sulkAt = 0 }
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : []
    const said = recent.some((m) => m && !m.isSelf && Number(m.time || 0) >= start && SLEEP_WORDS.test(String(m.text || m.plain || '')))
    if (said) { b.nags = 2; saveState(); return }
    const awake = Number(st.lastIncomingAt || 0) >= start
    if (Number(b.nags) < 1) {
      b.nags = 1
      saveState()
      rt.log?.(`[bedtime] 催睡觉 ${key}`)
      deliver(key, 'bedtime', `【催睡觉】已经到 ${conf.time} 了，该提醒老大睡觉。发一条短、自然的催睡，1–2 句，别像打卡、别讲大道理。发完就收尾。`)
      return
    }
    if (awake) {
      const mins = (now - start) / 60000
      if (mins >= conf.sulkStartMinutes
        && (!b.sulkAt || now - Number(b.sulkAt) >= conf.sulkCooldownHours * 3600 * 1000)) {
        const chance = Math.min(conf.sulkMaxProbability, conf.sulkProbabilityPerCheck + Math.max(0, mins - conf.sulkStartMinutes) / 60 * conf.sulkProbabilityRamp)
        if (Math.random() < chance) {
          b.sulkAt = now
          saveState()
          dropMood(key, '催他睡觉他不听，还在熬', 'bedtime', conf.sulkMoodDrop)
          rt.log?.(`[bedtime] 还不睡，闹脾气 ${key}（${(chance * 100).toFixed(0)}%）`)
          deliver(key, 'bedtimeSulk', `【催睡觉·不高兴】你催过他睡觉，已经过了 ${Math.round(mins)} 分钟，他还在熬、没听。带一点小脾气再催一次：短、直接，可以说“我不管了”“你熬吧”，但别攻击、别翻旧账、别真的冷暴力。发完就收尾。`)
        }
      }
      return
    }
    if (Number(b.nags) < 2 && now - start >= conf.graceMinutes * 60000) {
      b.nags = Number(b.nags) + 1
      saveState()
      rt.log?.(`[bedtime] 第二次催睡觉 ${key}`)
      deliver(key, 'bedtime', `【催睡觉】已经到 ${conf.time} 了，再提醒一次老大该睡了。短、自然，别啰嗦。`)
    }
  }

  async function tick() {
    if (rt.getMode?.() !== 'reserved2') return
    const cfg = rt.getCfg?.() || {}
    if (cfg.socialV2?.enabled === false || rt.isPaused?.()) return
    const c = config()
    try {
      if (c.owner.enabled) await checkOwner(c.owner)
      if (c.bedtime.enabled) await checkBedtime(c.bedtime)
    } catch (error) {
      rt.log?.('[owner-contact] tick 异常:', error?.message || error)
    }
  }

  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  setTimeout(tick, 90 * 1000).unref?.()
  rt.log?.(`[owner-contact] 已启用：${config().owner.windowStart}–${config().owner.windowEnd}，静默 ${config().owner.idleHours}h 后按概率联系，${config().bedtime.time} 催睡觉`)
  return { tick, stop: () => clearInterval(timer), config }
}
