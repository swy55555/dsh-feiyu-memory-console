// 大肥鱼的记忆 · 数据层
//
// 只做三件事：把散在三个地方的东西读出来、把管理员的操作送回去、把错误说成人话。
//
//   长期记忆   ~/.dsh/memvec/memories.db      （读：只读 SQLite；写：正文/新增走 memvec HTTP）
//   轻量记忆   ~/.dsh/qq-bridge/state/social-v2.json
//   整理队列   ~/.dsh/qq-bridge/state/daily-memory-queue.json
//
// 为什么读库、写走 HTTP：
//   - 记忆库里除了正文，还有鲜活度 / 重要度 / 召回次数，memvec 的 /list 不返回这些，
//     控制台要看「哪条快忘了」，只能直接读。只读连接不会跟正在跑的服务抢写锁。
//   - 新增和改写要重新算向量，这是 memvec 的活（本地 fastembed）；控制台不自己造。
//   - 分层、重要度、从「已删/已归档」恢复，memvec 没有端点，只能直接 UPDATE（同样先确认行存在）。
//   - 删除 / 确认 / 完成本来就有 HTTP 端点和它们的状态机，照着走，不另写一套。
//
// 所有时间：数据库里是「秒」，桥接的 state 里是「毫秒」。出口统一换成毫秒，前端不再猜。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { findAudit, logAudit } from './audit.js'

export class ConsoleError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const MAX_TEXT = 500

// ---------------------------------------------------------------- 路径

export function paths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const bridge = process.env.FEIYU_BRIDGE_DIR || path.join(home, 'qq-bridge')
  return {
    home,
    db: process.env.FEIYU_MEMVEC_DB || path.join(home, 'memvec', 'memories.db'),
    bridge,
    social: path.join(bridge, 'state', 'social-v2.json'),
    queue: path.join(bridge, 'state', 'daily-memory-queue.json'),
    persona: path.join(home, 'feiyu-memory-console', 'persona.json'),
    emotion: path.join(home, 'feiyu-memory-console', 'emotion.json'),
    episodes: path.join(home, 'feiyu-memory-console', 'episodes.json'),
    token: path.join(bridge, 'state', 'console-token'),
    bridgeConfig: path.join(bridge, 'config.json'),
    labels: path.join(home, 'feiyu-memory-console', 'labels.json'),
    diaryDir: process.env.FEIYU_DIARY_DIR || home,
    diaryBackups: path.join(home, 'feiyu-memory-console', 'diary-backups'),
    memvecUrl: (process.env.FEIYU_MEMVEC_URL || 'http://127.0.0.1:9881').replace(/\/+$/, ''),
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readJsonRetry(file, fallback = null) {
  // 桥接写 state 是「整份覆盖」，恰好撞上时会读到半截 JSON。一次重试就够了。
  const first = readJson(file, undefined)
  if (first !== undefined) return first
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------- 标签

export function readLabels() {
  const raw = readJson(paths().labels, {})
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

export function setLabel(scope, label) {
  const key = String(scope || '').trim()
  if (!/^(global|private:\d+|group:\d+)$/.test(key)) throw new ConsoleError('这个聊天标识不对')
  const clean = String(label || '').trim().slice(0, 40)
  const labels = readLabels()
  if (clean) labels[key] = clean
  else delete labels[key]
  writeJsonAtomic(paths().labels, labels)
  return labels
}

function baseScopeMeta(scope, ownerQQ) {
  if (scope === 'global') return { kind: 'global', label: '旧档案 / 全局', short: '全局' }
  if (scope === `private:${ownerQQ}`) return { kind: 'owner', label: '老大的私聊', short: '老大' }
  if (scope.startsWith('private:')) {
    const id = scope.slice(8)
    return { kind: 'private', label: `私聊 · ${id}`, short: id.slice(-6) }
  }
  if (scope.startsWith('group:')) {
    const id = scope.slice(6)
    return { kind: 'group', label: `群 · ${id}`, short: `群 ${id.slice(-6)}` }
  }
  return { kind: 'other', label: scope, short: scope }
}

export function scopeMeta(scope, ownerQQ, labels = readLabels()) {
  const base = baseScopeMeta(scope, ownerQQ)
  const alias = labels[scope]
  return alias ? { ...base, label: alias, alias } : base
}

// ---------------------------------------------------------------- 时间 / 遗忘曲线

const DAY = 86400

export function recallOf(row, now = Date.now()) {
  if (row.tier && row.tier !== 'normal') return 1
  const strength = Math.max(Number(row.strength) || 1, 0.1)
  const last = Number(row.lastAccess) || now
  const t = Math.max(0, (now - last) / (DAY * 1000))
  const r = 1 / (1 + t / (9 * strength))
  return Math.min(1, r + (Number(row.importance) || 0) * 0.1)
}

// ---------------------------------------------------------------- SQLite

let sqlitePromise
async function sqlite() {
  if (sqlitePromise === undefined) {
    try {
      sqlitePromise = await import('node:sqlite')
    } catch {
      sqlitePromise = null
    }
  }
  if (!sqlitePromise) {
    throw new ConsoleError('这个运行环境没有 node:sqlite，读不了记忆库（需要 DSH 2.x 桌面版）', 503)
  }
  return sqlitePromise
}

async function withDb(fn, { write = false } = {}) {
  const { DatabaseSync } = await sqlite()
  const file = paths().db
  if (!fs.existsSync(file)) throw new ConsoleError(`找不到记忆库：${file}`, 503)
  let db
  try {
    db = new DatabaseSync(file, write ? { timeout: 5000 } : { readOnly: true, timeout: 5000 })
    db.exec('PRAGMA busy_timeout = 5000')
    return await fn(db)
  } finally {
    try { db?.close() } catch {}
  }
}

function plain(row) {
  return row ? { ...row } : null
}

function normalize(row, now = Date.now()) {
  const out = {
    id: String(row.id || ''),
    text: String(row.text || ''),
    tags: String(row.tags || ''),
    scope: String(row.scope || 'global'),
    subjectId: String(row.subject_id || ''),
    status: String(row.status || 'active'),
    tier: String(row.tier || 'normal'),
    factKey: String(row.fact_key || ''),
    relation: String(row.relation || ''),
    relatedId: String(row.related_id || ''),
    supersededBy: String(row.superseded_by || ''),
    sourceId: String(row.source_id || ''),
    sourceText: String(row.source_text || ''),
    importance: Number(row.importance ?? 0.5),
    confidence: Number(row.confidence ?? 1),
    strength: Number(row.strength_days ?? 1),
    accessCount: Number(row.access_count || 0),
    createdAt: Number(row.created_at || 0) * 1000,
    lastAccess: Number(row.last_access || 0) * 1000,
    sourceTime: Number(row.source_time || 0) * 1000,
    expiresAt: Number(row.expires_at || 0) * 1000,
    lastReinforced: Number(row.last_reinforced || 0) * 1000,
  }
  out.recall = recallOf(out, now)
  return out
}

const COLUMNS = `id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,
  status,fact_key,subject_id,source_id,source_text,source_time,confidence,expires_at,
  superseded_by,last_reinforced,tier,relation,related_id`

function scopeClause(scope) {
  if (!scope || scope === 'all') return { sql: '', params: [] }
  if (scope === 'private' || scope === 'group') return { sql: ' AND scope LIKE ?', params: [`${scope}:%`] }
  return { sql: ' AND scope = ?', params: [scope] }
}

export async function listMemories({ scope = 'all', status = 'active', tier = 'all', q = '', sort = 'recent', limit = 60, offset = 0 } = {}) {
  const now = Date.now()
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 60))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const order =
    sort === 'oldest' ? 'created_at ASC'
      : sort === 'recall' ? 'last_access DESC'
        : sort === 'importance' ? 'importance DESC, created_at DESC'
          : 'created_at DESC'

  return withDb((db) => {
    const where = ['1=1']
    const params = []
    const sc = scopeClause(scope)
    if (sc.sql) {
      where.push(sc.sql.replace(/^ AND /, ''))
      params.push(...sc.params)
    }
    if (status && status !== 'all') {
      where.push('status = ?')
      params.push(status)
    }
    if (tier && tier !== 'all') {
      where.push('tier = ?')
      params.push(tier)
    }
    const needle = String(q || '').trim()
    if (needle) {
      where.push(`(text LIKE ? ESCAPE '\\' OR subject_id LIKE ? ESCAPE '\\' OR fact_key LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`)
      const like = `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      params.push(like, like, like, like)
    }
    const clause = where.join(' AND ')
    const total = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${clause}`).get(...params)?.n || 0
    const rows = db.prepare(`SELECT ${COLUMNS} FROM memories WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, safeLimit, safeOffset)
    return {
      rows: rows.map((r) => normalize(r, now)),
      total: Number(total),
      limit: safeLimit,
      offset: safeOffset,
    }
  })
}

export async function getMemoriesByIds(ids) {
  const clean = [...new Set((ids || []).filter(Boolean))].slice(0, 50)
  if (!clean.length) return new Map()
  const now = Date.now()
  return withDb((db) => {
    const marks = clean.map(() => '?').join(',')
    const rows = db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id IN (${marks})`).all(...clean)
    return new Map(rows.map((r) => [r.id, normalize(r, now)]))
  })
}

export async function countsByStatus() {
  return withDb((db) => {
    const out = {}
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all()) {
      out[row.status] = Number(row.n)
    }
    return out
  })
}

export async function scopeBreakdown() {
  return withDb((db) => {
    const map = new Map()
    for (const row of db.prepare('SELECT scope, status, COUNT(*) AS n FROM memories GROUP BY scope, status').all()) {
      const cur = map.get(row.scope) || { scope: row.scope, total: 0, byStatus: {} }
      cur.total += Number(row.n)
      cur.byStatus[row.status] = Number(row.n)
      map.set(row.scope, cur)
    }
    return [...map.values()].sort((a, b) => b.total - a.total)
  })
}

export async function tierBreakdown() {
  return withDb((db) => {
    const out = {}
    for (const row of db.prepare("SELECT tier, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY tier").all()) {
      out[row.tier] = Number(row.n)
    }
    return out
  })
}

export async function activeSnapshot(limit = 600) {
  const now = Date.now()
  return withDb((db) => {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(5000, limit)))
    return rows.map((r) => normalize(r, now))
  })
}

async function rowRawById(id) {
  return withDb((db) => plain(db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(String(id))))
}

async function updateRaw(id, fields) {
  const allowed = {
    status: 'status',
    tier: 'tier',
    importance: 'importance',
    expiresAt: 'expires_at',
    supersededBy: 'superseded_by',
  }
  const sets = []
  const params = []
  for (const [key, col] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue
    sets.push(`${col} = ?`)
    params.push(fields[key])
  }
  if (!sets.length) return 0
  return withDb((db) => db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, String(id)).changes, { write: true })
}

// ---------------------------------------------------------------- memvec HTTP

async function memvec(method, pathname, body, timeout = 20000) {
  const url = `${paths().memvecUrl}${pathname}`
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '等太久没回' : '连不上'
    throw new ConsoleError(`记忆服务（127.0.0.1:9881）${reason}。它现在没在跑？`, 503)
  }
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch {}
  if (!res.ok || data.ok === false) {
    const raw = String(data.error || `记忆服务返回 HTTP ${res.status}`).replace(/^[A-Za-z_]*Error:\s*/, '')
    throw new ConsoleError(raw, res.status >= 400 && res.status < 500 ? 400 : 502)
  }
  return data
}

export async function memvecStats() {
  return memvec('GET', '/stats', undefined, 2500)
}

// ---------------------------------------------------------------- 桥接

function bridgeSettings() {
  const cfg = readJson(paths().bridgeConfig, {}) || {}
  let token = ''
  try { token = fs.readFileSync(paths().token, 'utf8').trim() } catch {}
  if (!token && cfg.consoleToken) token = String(cfg.consoleToken).trim()
  return { port: Number(cfg.consolePort) || 3100, token }
}

async function bridge(pathname, { method = 'GET', body, timeout = 8000, headers = {} } = {}) {
  const { port, token } = bridgeSettings()
  if (!token) throw new ConsoleError('桥接控制台令牌还没生成（state/console-token 不存在），桥接可能没启动', 503)
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        'x-console-token': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '等太久没回' : '连不上'
    throw new ConsoleError(`QQ 桥接（127.0.0.1:${port}）${reason}，轻量记忆现在改不了。`, 503)
  }
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch {}
  if (!res.ok || data.ok === false) throw new ConsoleError(String(data.error || `桥接返回 HTTP ${res.status}`).replace(/^[A-Za-z_]*Error:\s*/, ''), 502)
  return data
}

// ---------------------------------------------------------------- 轻量记忆

const lightCache = { at: 0, data: null, mtime: 0 }

function socialState() {
  const file = paths().social
  let stat
  try { stat = fs.statSync(file) } catch { return { paused: false, conversations: {} } }
  if (lightCache.data && lightCache.mtime === stat.mtimeMs && Date.now() - lightCache.at < 3000) return lightCache.data
  const data = readJsonRetry(file, { paused: false, conversations: {} }) || {}
  if (!data.conversations || typeof data.conversations !== 'object') data.conversations = {}
  lightCache.data = data
  lightCache.at = Date.now()
  lightCache.mtime = stat.mtimeMs
  return data
}

function lightRowCount(conv) {
  return {
    activeTopics: Array.isArray(conv?.activeTopics) ? conv.activeTopics.length : 0,
    pendingThoughts: Array.isArray(conv?.pendingThoughts) ? conv.pendingThoughts.length : 0,
    memberImpressions: conv?.memberImpressions && typeof conv.memberImpressions === 'object' ? Object.keys(conv.memberImpressions).length : 0,
  }
}

export function lightScopes() {
  const { port } = bridgeSettings()
  const cfg = readJson(paths().bridgeConfig, {}) || {}
  const ownerQQ = String(cfg.ownerQQ || '')
  const labels = readLabels()
  const state = socialState()
  const rows = Object.entries(state.conversations).map(([key, conv]) => {
    const counts = lightRowCount(conv)
    return {
      key,
      ...scopeMeta(key, ownerQQ, labels),
      counts,
      total: counts.activeTopics + counts.pendingThoughts + counts.memberImpressions,
      lastActionAt: Number(conv?.lastActionAt || 0),
    }
  })
  rows.sort((a, b) => b.total - a.total || b.lastActionAt - a.lastActionAt)
  return { rows, paused: !!state.paused, port, ownerQQ }
}

export function lightGet(key) {
  const clean = String(key || '').trim()
  if (!/^(private|group):\d+$/.test(clean)) throw new ConsoleError('要指定一个私聊或群（private:QQ / group:群号）')
  const cfg = readJson(paths().bridgeConfig, {}) || {}
  const state = socialState()
  const conv = state.conversations[clean] || {}
  const counts = lightRowCount(conv)
  return {
    key: clean,
    ...scopeMeta(clean, String(cfg.ownerQQ || ''), readLabels()),
    paused: !!state.paused,
    counts,
    activeTopics: (Array.isArray(conv.activeTopics) ? conv.activeTopics : []).slice().reverse(),
    pendingThoughts: (Array.isArray(conv.pendingThoughts) ? conv.pendingThoughts : []).slice().reverse(),
    memberImpressions: conv.memberImpressions && typeof conv.memberImpressions === 'object' ? conv.memberImpressions : {},
    lastActionAt: Number(conv.lastActionAt || 0),
  }
}

export async function lightAction(op, payload = {}) {
  const key = String(payload.key || '').trim()
  const category = String(payload.category || '').trim()
  if (!/^(private|group):\d+$/.test(key)) throw new ConsoleError('聊天标识不对')
  if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) throw new ConsoleError('类别不对')

  if (op === 'add') {
    const content = String(payload.content || '').trim()
    if (!content) throw new ConsoleError('写点什么再存')
    const extra = payload.extra && typeof payload.extra === 'object' ? payload.extra : {}
    if (category === 'memberImpression' && !String(extra.target || '').trim()) throw new ConsoleError('群友印象要写是谁')
    await bridge('/api/socialV2/memory-append', { method: 'POST', body: { key, category, content, extra } })
  } else if (op === 'update') {
    const oldContent = String(payload.oldContent || '').trim()
    const newContent = String(payload.newContent || '').trim()
    if (!newContent) throw new ConsoleError('改完不能是空的')
    if (category !== 'memberImpression' && !oldContent) throw new ConsoleError('找不到要改的那一条')
    if (category === 'memberImpression' && !String(payload.target || '').trim()) throw new ConsoleError('群友印象要指定是谁')
    await bridge('/api/socialV2/memory-update', {
      method: 'POST',
      body: {
        key,
        category,
        oldContent,
        target: String(payload.target || ''),
        newContent,
        newExtra: payload.newExtra && typeof payload.newExtra === 'object' ? payload.newExtra : {},
      },
    })
  } else if (op === 'remove') {
    if (category !== 'memberImpression' && !String(payload.content || '').trim()) throw new ConsoleError('找不到要删的那一条')
    if (category === 'memberImpression' && !String(payload.target || '').trim()) throw new ConsoleError('群友印象要指定是谁')
    await bridge('/api/socialV2/memory-remove', {
      method: 'POST',
      body: { key, category, content: String(payload.content || ''), target: String(payload.target || '') },
    })
  } else if (op === 'clear') {
    const cat = String(payload.category || '')
    const ok = await confirmText(cat)
    await bridge('/api/socialV2/memory-clear', { method: 'POST', body: { key, category: cat } })
    return { ...lightGet(key), cleared: ok }
  } else {
    throw new ConsoleError('不认识的操作')
  }
  lightCache.at = 0
  return lightGet(key)
}

export async function flushQueue(key = '') {
  const clean = String(key || '').trim()
  if (clean && !/^(private|group):\d+$/.test(clean)) throw new ConsoleError('聊天标识不对')
  let result
  try {
    const data = await bridge('/api/socialV2/memory-flush', {
      method: 'POST',
      body: { key: clean, force: true },
      timeout: 180000,
    })
    result = data.result || data
  } catch (error) {
    logAudit({ op: 'flush', status: 'error', target: { kind: 'queue', key: clean || null }, summary: '手动提炼失败', error: error?.message })
    throw error
  }
  if (result?.ok) {
    logAudit({
      op: 'flush',
      status: 'ok',
      target: { kind: 'queue', key: result.scope || clean || null },
      summary: `手动提炼：${result.messages || 0} 条消息，新增 ${result.candidates || 0} 条候选`,
      after: result,
      undo: null,
    })
  } else {
    logAudit({ op: 'flush', status: 'error', target: { kind: 'queue', key: clean || null }, summary: '手动提炼没有执行', error: result?.reason || 'unknown' })
  }
  return result
}

// ---------------------------------------------------------------- 队列

export function queueSummary() {
  const q = readJsonRetry(paths().queue, { queues: {} }) || { queues: {} }
  const cfg = readJson(paths().bridgeConfig, {}) || {}
  const ownerQQ = String(cfg.ownerQQ || '')
  const labels = readLabels()
  const byScope = Object.entries(q.queues || {}).map(([key, list]) => {
    const messages = Array.isArray(list) ? list : []
    const last = messages[messages.length - 1] || {}
    return {
      key,
      ...scopeMeta(key, ownerQQ, labels),
      count: messages.length,
      oldestAt: Number(messages[0]?.time || 0),
      lastAt: Number(last.time || 0),
      pausedUntil: Number(q.paused?.[key] || 0) > Date.now() ? Number(q.paused[key]) : 0,
      yieldBatches: Number(q.yield?.[key]?.batches || 0),
      yieldCandidates: Number(q.yield?.[key]?.candidates || 0),
      samples: messages.slice(-3).map((m) => ({
        sender: String(m.sender || ''),
        text: String(m.text || '').slice(0, 160),
        time: Number(m.time || 0),
      })),
    }
  }).sort((a, b) => b.count - a.count)
  return {
    day: String(q.day || ''),
    calls: Number(q.calls || 0),
    okCalls: Number(q.okCalls || 0),
    maxCalls: Number(cfg.socialV2?.dailyMemory?.maxCallsPerDay ?? 40),
    enabled: cfg.socialV2?.dailyMemory?.enabled !== false,
    maxPerChat: Number(cfg.socialV2?.dailyMemory?.queueMax ?? 0),
    groupMaxCalls: Number(cfg.socialV2?.dailyMemory?.groupMaxCallsPerDay ?? 20),
    total: byScope.reduce((n, x) => n + x.count, 0),
    byScope,
  }
}

export async function setQueueEnabled(enabled) {
  await bridge('/api/socialV2/config', { method: 'POST', body: { dailyMemory: { enabled: enabled === true } } })
  return { enabled: enabled === true }
}

/** 改“每天自动提炼上限”；0 = 不限。桥接会热更新，不用重启。 */
export async function setQueueLimit({ maxCallsPerDay, groupMaxCallsPerDay } = {}) {
  const dailyMemory = {}
  if (maxCallsPerDay !== undefined) dailyMemory.maxCallsPerDay = Math.max(0, Math.round(Number(maxCallsPerDay) || 0))
  if (groupMaxCallsPerDay !== undefined) dailyMemory.groupMaxCallsPerDay = Math.max(0, Math.round(Number(groupMaxCallsPerDay) || 0))
  if (!Object.keys(dailyMemory).length) throw new ConsoleError('没给要改的额度')
  await bridge('/api/socialV2/config', { method: 'POST', body: { dailyMemory } })
  return queueSummary()
}

export async function draftPersonaSpec() {
  return bridge('/api/persona/draft', { method: 'POST', body: {}, timeout: 130000 })
}

export async function undoPersonaChange() {
  return bridge('/api/persona/undo', { method: 'POST', body: {} })
}

export async function getChatPersona() {
  const data = await bridge('/api/persona/chat')
  return data.profiles || {}
}

export async function setChatPersona({ key, deltas, note, clearAuto } = {}) {
  const data = await bridge('/api/persona/chat', { method: 'POST', body: { key, deltas, note, clearAuto } })
  return data.profiles || {}
}

export async function setEmotionDrift(enabled, mode) {
  const drift = { enabled: enabled === true }
  if (mode === 'apply' || mode === 'suggest') drift.mode = mode
  await bridge('/api/socialV2/config', { method: 'POST', body: { emotion: { drift } } })
  return { enabled: enabled === true, mode: drift.mode }
}

export async function setEmotionWeights(weights = {}) {
  const body = {}
  for (const k of ['owner', 'group', 'private']) {
    if (weights[k] !== undefined) body[k] = Math.max(0.2, Math.min(3, Number(weights[k]) || 1))
  }
  await bridge('/api/socialV2/config', { method: 'POST', body: { emotion: { weights: body } } })
  return body
}

export async function revertEmotionDrift() {
  return bridge('/api/emotion/drift/revert', { method: 'POST', body: {} })
}

export async function acceptEmotionDrift(id) {
  return bridge('/api/emotion/drift/accept', { method: 'POST', body: { id } })
}

export async function rejectEmotionDrift(id) {
  return bridge('/api/emotion/drift/reject', { method: 'POST', body: { id } })
}

export async function resetEmotion() {
  return bridge('/api/emotion/reset', { method: 'POST', body: {} })
}

export async function setAppraisalModel(enabled) {
  await bridge('/api/socialV2/config', { method: 'POST', body: { emotion: { appraisalModel: { enabled: enabled === true } } } })
  return { enabled: enabled === true }
}

export async function setChatDrift(enabled) {
  await bridge('/api/socialV2/config', { method: 'POST', body: { emotion: { chatDrift: { enabled: enabled === true } } } })
  return { enabled: enabled === true }
}

export async function setEpisodeRecall(enabled) {
  await bridge('/api/socialV2/config', { method: 'POST', body: { emotion: { episodeRecall: { enabled: enabled === true } } } })
  return { enabled: enabled === true }
}

export async function updateEpisode({ id, action, outcome } = {}) {
  return bridge('/api/episode/update', { method: 'POST', body: { id, action, outcome } })
}

export async function deleteEpisode(id) {
  return bridge('/api/episode/delete', { method: 'POST', body: { id } })
}

export async function catchupDiary() {
  return bridge('/api/diary/catchup', { method: 'POST', body: {}, timeout: 130000 })
}

export async function setDiaryAutoImport(enabled) {
  await bridge('/api/socialV2/config', { method: 'POST', body: { diary: { autoImport: { enabled: enabled === true } } } })
  return { enabled: enabled === true }
}

export async function setOwnerTitle(title) {
  const clean = String(title || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 12) || '老大'
  await bridge('/api/socialV2/config', { method: 'POST', body: { ownerTitle: clean } })
  return { ownerTitle: clean }
}

export async function unlockPrivateDiary(password) {
  return bridge('/api/diary/unlock', { method: 'POST', body: { password } })
}

export async function getPrivateDiary(token) {
  return bridge('/api/diary/private', { headers: { 'x-diary-token': token } })
}

export async function appendPrivateDiary({ date, label, body, token } = {}) {
  return bridge('/api/diary/private/append', { method: 'POST', body: { date, label, body }, headers: { 'x-diary-token': token } })
}

export async function resetPrivateDiary() {
  return bridge('/api/diary/reset', { method: 'POST', body: {} })
}

/** 改性格 spec（维度/底色/边界）。写 persona.json 后让桥接热重读。 */
export async function setPersonaSpec(dimensions = []) {
  const file = paths().persona
  if (!Array.isArray(dimensions) || !dimensions.length) throw new ConsoleError('至少保留一个维度', 400)
  const cleaned = []
  const seen = new Set()
  for (const raw of dimensions.slice(0, 12)) {
    const d = raw || {}
    const key = String(d.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24)
    if (!key || seen.has(key)) continue
    seen.add(key)
    cleaned.push({
      key,
      label: String(d.label || key).trim().slice(0, 12) || key,
      desc: String(d.desc || '').trim().slice(0, 40),
      baseline: Math.max(0, Math.min(100, Math.round(Number(d.baseline) || 0))),
      band: Math.max(0, Math.min(40, Math.round(Number(d.band) || 0))),
    })
  }
  if (!cleaned.length) throw new ConsoleError('至少保留一个合法维度', 400)
  let p = readJson(file, null)
  if (!p || typeof p !== 'object') {
    p = {
      version: 3, createdAt: Date.now(), updatedAt: Date.now(),
      spec: {}, originBaseline: {}, baseline: {}, current: {},
      narrative: '', events: [], history: [],
      lastChangeAt: 0, lastAttemptAt: 0, lastBaselineChangeAt: 0,
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  p.spec = { ...(p.spec || {}), dimensions: cleaned }
  p.originBaseline ||= {}
  p.baseline ||= {}
  p.current ||= {}
  const keep = new Set(cleaned.map((d) => d.key))
  for (const d of cleaned) {
    p.originBaseline[d.key] = d.baseline
    p.baseline[d.key] = d.baseline
    if (p.current[d.key] === undefined) p.current[d.key] = d.baseline
    // 底色/边界改小后，当前值不能留在新边界外
    p.current[d.key] = Math.max(d.baseline - d.band, Math.min(d.baseline + d.band, Number(p.current[d.key]) || d.baseline))
  }
  for (const k of Object.keys(p.baseline)) if (!keep.has(k)) { delete p.baseline[k]; delete p.current[k]; delete p.originBaseline[k] }
  p.updatedAt = Date.now()
  try { fs.copyFileSync(file, `${file}.bak-${Date.now()}`) } catch {}
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n', 'utf8')
  // 桥接没开也允许保存；开了就让它立刻重读，不用重启。
  try { await bridge('/api/persona/reload', { method: 'POST', body: {} }) } catch {}
  return p
}

// ---------------------------------------------------------------- 健康

const healthCache = { at: 0, data: null }

export async function health(force = false) {
  if (!force && healthCache.data && Date.now() - healthCache.at < 12000) return healthCache.data
  // capabilities 是前后端的版本握手：页面是现读的，宿主路由要重启 DSH 才更新。
  // 页面发现这里少了一项，就把对应按钮禁用并提示重启，而不是让用户点了报 404。
  const result = { at: Date.now(), capabilities: ['queue-flush', 'queue-limit', 'persona', 'emotion', 'graph'], memvec: null, bridge: null, db: null }

  try {
    const stats = await memvecStats()
    result.memvec = { ok: true, ...stats.stats }
  } catch (error) {
    result.memvec = { ok: false, error: error.message }
  }

  try {
    const data = await bridge('/api/status', { timeout: 2500 })
    result.bridge = {
      ok: true,
      mode: data.mode,
      role: data.role,
      dshReady: !!data.dshReady,
      paused: !!data.socialV2Paused,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      snowluma: data.snowluma || null,
      activity: String(data.activity || '').slice(0, 4000),
    }
  } catch (error) {
    result.bridge = { ok: false, error: error.message }
  }

  try {
    const p = paths()
    const stat = fs.statSync(p.db)
    result.db = { ok: true, path: p.db, bytes: stat.size, mtime: stat.mtimeMs }
  } catch (error) {
    result.db = { ok: false, error: String(error.message) }
  }

  healthCache.at = Date.now()
  healthCache.data = result
  return result
}

// ---------------------------------------------------------------- 总览

export async function overview() {
  const now = Date.now()
  const [counts, scopesRaw, tiers, active, h] = await Promise.all([
    countsByStatus(),
    scopeBreakdown(),
    tierBreakdown(),
    activeSnapshot(3000),
    health(),
  ])
  const cfg = readJson(paths().bridgeConfig, {}) || {}
  const ownerQQ = String(cfg.ownerQQ || '')
  const labels = readLabels()

  const scopes = scopesRaw.map((s) => ({
    ...s,
    ...scopeMeta(s.scope, ownerQQ, labels),
    active: Number(s.byStatus.active || 0),
    candidate: Number(s.byStatus.candidate || 0),
  }))

  const recent = active.slice(0, 6)
  const fading = active
    .filter((r) => r.tier === 'normal' && r.status === 'active' && r.recall < 0.6)
    .sort((a, b) => a.recall - b.recall)
    .slice(0, 6)

  const decayRows = active.filter((r) => decayEligible(r, now))
  const fadingCount = active.filter((r) => r.tier === 'normal' && r.recall < 0.35).length
  const light = lightScopes()
  const queue = queueSummary()

  return {
    now,
    counts,
    total: Object.values(counts).reduce((n, x) => n + x, 0),
    active: Number(counts.active || 0),
    candidate: Number(counts.candidate || 0),
    core: Number(tiers.core || 0),
    task: Number(tiers.task || 0),
    normal: Number(tiers.normal || 0),
    tiers,
    scopes,
    recent,
    fading,
    fadingCount,
    decay: { count: decayRows.length, samples: decayRows.slice(0, 5) },
    light: { conversations: light.rows.length, used: light.rows.filter((r) => r.total > 0).length, total: light.rows.reduce((n, r) => n + r.total, 0) },
    queue,
    health: h,
    ownerQQ,
    ownerTitle: String(cfg.socialV2?.ownerTitle || '老大').slice(0, 12),
    labels,
  }
}

function decayEligible(row, now = Date.now()) {
  if (row.status !== 'active' || row.tier !== 'normal') return false
  if (row.importance >= 0.8) return false
  const last = Number(row.lastAccess) || now
  const ageDays = (now - last) / (DAY * 1000)
  return ageDays > 14 && recallOf(row, now) < 0.12
}

export async function decayPreview() {
  const now = Date.now()
  const active = await activeSnapshot(5000)
  const rows = active.filter((r) => decayEligible(r, now)).sort((a, b) => a.recall - b.recall)
  return { count: rows.length, rows: rows.slice(0, 40), totalActive: active.length, pruneR: 0.12, minAgeDays: 14 }
}

export async function runDecay() {
  const before = await decayPreview()
  const data = await memvec('POST', '/decay', { prune: true }, 60000)
  healthCache.at = 0
  logAudit({
    op: 'decay',
    status: 'ok',
    target: { kind: 'system' },
    summary: `跑了一次衰减：候选 ${before.count} 条，归档 ${data.result?.removed ?? 0} 条`,
    before: { candidates: before.count, active: before.totalActive },
    after: { ...data.result },
    undo: null,
  })
  return { ...data.result, preview: before.count }
}

// ---------------------------------------------------------------- 长期记忆操作

async function requireRow(id) {
  const row = await rowRawById(id)
  if (!row) throw new ConsoleError('这条记忆已经不在了，刷新看看', 404)
  return row
}

export async function memoryAction(op, payload = {}) {
  const id = String(payload.id || '').trim()
  let before = null
  try { if (id) before = await rowRawById(id) } catch {}
  try {
    const result = await memoryActionInner(op, payload)
    const afterId = result?.id || id
    let after = null
    try { if (afterId) after = await rowRawById(afterId) } catch {}
    const record = logAudit(memoryAudit(op, before, after, payload, result))
    return record ? { ...result, auditId: record.id } : result
  } catch (error) {
    logAudit({
      op,
      status: 'error',
      target: { kind: 'memory', id: id || null, scope: payload.scope || null },
      summary: `${op} 失败`,
      error: error?.message || String(error),
    })
    throw error
  }
}

function auditSnippet(text, n = 70) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n)
}

function auditRow(row) {
  if (!row) return null
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    tier: row.tier,
    importance: row.importance,
    expires_at: row.expires_at,
    fact_key: row.fact_key,
    subject_id: row.subject_id,
    superseded_by: row.superseded_by,
    text: auditSnippet(row.text, 120),
  }
}

function memoryAudit(op, before, after, payload, result) {
  const target = { kind: 'memory', id: after?.id || before?.id || null, scope: after?.scope || before?.scope || payload.scope || null }
  const b = auditRow(before)
  const a = auditRow(after)
  const bText = auditSnippet(before?.text)
  const aText = auditSnippet(after?.text)
  let summary = op
  let undo = null

  if (op === 'add') {
    summary = `新增记忆「${aText}」`
    undo = after ? { kind: 'soft-delete', id: after.id, expect: ['active', 'candidate'] } : null
  } else if (op === 'edit') {
    summary = `改正文「${bText}」→「${aText}」`
    undo = before && after ? { kind: 'edit', oldId: before.id, newId: after.id, oldStatus: before.status } : null
  } else if (op === 'delete') {
    summary = `软删记忆「${bText}」`
    undo = before ? { kind: 'status', id: before.id, expect: 'deleted', restore: before.status } : null
  } else if (op === 'restore') {
    summary = `恢复记忆「${aText}」`
    undo = before ? { kind: 'status', id: before.id, expect: 'active', restore: before.status } : null
  } else if (op === 'confirm') {
    summary = `确认候选「${aText}」`
    undo = before ? { kind: 'status', id: before.id, expect: 'active', restore: before.status } : null
  } else if (op === 'finish') {
    summary = `完成待办「${aText}」`
    undo = before ? { kind: 'status', id: before.id, expect: 'completed', restore: before.status } : null
  } else if (op === 'meta' || op === 'tier' || op === 'importance') {
    const bits = []
    if (before && after && before.tier !== after.tier) bits.push(`层级 ${before.tier} → ${after.tier}`)
    if (before && after && Number(before.importance) !== Number(after.importance)) bits.push(`重要度 ${before.importance} → ${after.importance}`)
    summary = `${op === 'meta' ? '调' : op === 'tier' ? '调层级' : '调重要度'}「${aText}」${bits.length ? '：' + bits.join('，') : ''}`
    undo = before && after ? {
      kind: 'fields',
      id: after.id,
      expect: { tier: after.tier, importance: after.importance, expires_at: after.expires_at },
      restore: { tier: before.tier, importance: before.importance, expires_at: before.expires_at },
    } : null
  } else {
    summary = `${op}「${aText || bText}」`
  }

  return { op, status: 'ok', target, summary, before: b, after: a, undo }
}

async function memoryActionInner(op, payload = {}) {
  const id = String(payload.id || '').trim()
  const scope = String(payload.scope || '').trim()

  if (op === 'delete') {
    if (!id || !scope) throw new ConsoleError('缺少 id / scope')
    if (scope === 'global') {
      // memvec 的 valid_scope 只收 private/group；旧 global 走直接软删
      await requireRow(id)
      await updateRaw(id, { status: 'deleted' })
      return { id, status: 'deleted' }
    }
    await memvec('POST', '/remove', { scope, id })
    return { id, status: 'deleted' }
  }

  if (op === 'confirm') {
    if (!id || !scope) throw new ConsoleError('缺少 id / scope')
    if (scope === 'global') {
      const row = await requireRow(id)
      if (row.status !== 'candidate') return { id, changed: 0 }
      await updateRaw(id, { status: 'active' })
      return { id, changed: 1 }
    }
    const data = await memvec('POST', '/confirm', { scope, id })
    return { id, changed: data.changed }
  }

  if (op === 'finish') {
    if (!id || !scope) throw new ConsoleError('缺少 id / scope')
    if (scope === 'global') {
      const row = await requireRow(id)
      if (row.tier !== 'task' || row.status !== 'active') return { id, changed: 0 }
      await updateRaw(id, { status: 'completed' })
      return { id, changed: 1 }
    }
    const data = await memvec('POST', '/finish', { scope, id })
    return { id, changed: data.changed }
  }

  if (op === 'restore') {
    const row = await requireRow(id)
    if (!['deleted', 'archived'].includes(row.status)) throw new ConsoleError('只有「已删」或「已归档」的才能恢复')
    if (row.fact_key) {
      const conflict = await withDb((db) => plain(db.prepare(
        "SELECT id FROM memories WHERE scope=? AND subject_id=? AND fact_key=? AND status='active' AND id<>? LIMIT 1",
      ).get(row.scope, row.subject_id || '', row.fact_key, row.id)))
      if (conflict) throw new ConsoleError('同一件事已经有一条更新的记忆还活着，先处理那条再恢复')
    }
    await updateRaw(id, { status: 'active', supersededBy: '' })
    return { id, status: 'active' }
  }

  if (op === 'meta') {
    const row = await requireRow(id)
    const fields = {}
    if (payload.tier !== undefined) {
      const tier = String(payload.tier || '')
      if (!['normal', 'core', 'task'].includes(tier)) throw new ConsoleError('层级只有 normal / core / task')
      fields.tier = tier
      if (tier === 'core') fields.expiresAt = 0
    }
    if (payload.importance !== undefined) {
      const value = Number(payload.importance)
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new ConsoleError('重要度要在 0 到 1 之间')
      fields.importance = Math.round(value * 1000) / 1000
    }
    if (!Object.keys(fields).length) throw new ConsoleError('没有要改的')
    await updateRaw(id, fields)
    return { id, ...fields, previous: { tier: row.tier, importance: row.importance } }
  }

  if (op === 'tier') {
    const tier = String(payload.tier || '')
    if (!['normal', 'core', 'task'].includes(tier)) throw new ConsoleError('层级只有 normal / core / task')
    const row = await requireRow(id)
    const fields = { tier }
    if (tier === 'core') fields.expiresAt = 0
    await updateRaw(id, fields)
    return { id, tier, previous: row.tier }
  }

  if (op === 'importance') {
    const value = Number(payload.importance)
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new ConsoleError('重要度要在 0 到 1 之间')
    await requireRow(id)
    await updateRaw(id, { importance: Math.round(value * 1000) / 1000 })
    return { id, importance: value }
  }

  if (op === 'edit') {
    const text = String(payload.text || '').trim()
    if (!text) throw new ConsoleError('不能改成空的')
    if (text.length > MAX_TEXT) throw new ConsoleError(`一条最多 ${MAX_TEXT} 字，现在 ${text.length}`)
    const row = await requireRow(id)
    if (text === row.text) throw new ConsoleError('跟原来一模一样，不用改')
    if (['deleted', 'archived', 'superseded', 'completed'].includes(row.status)) throw new ConsoleError('这条已经不在「活着」的状态里了，先恢复再改')
    if (row.scope === 'global') throw new ConsoleError('旧档案里的全局记忆不能改正文 —— 那是迁移前留下的归档，只读更安全')

    if (row.status === 'candidate') {
      // 先加新的，再删旧的：add 失败时旧的还在，不会白丢一条候选
      const data = await memvec('POST', '/add', {
        text,
        scope: row.scope,
        importance: row.importance,
        confidence: Math.max(0.8, row.confidence || 0.9),
        confirmed: true,
        tier: row.tier,
        tags: row.tags,
        subject_id: row.subject_id,
        fact_key: row.fact_key,
        expires_at: row.expires_at / 1000,
        source_id: `console-${Date.now()}`,
        source_text: text,
        source_time: Date.now() / 1000,
      }, 60000)
      if (data.memory?.duplicate) throw new ConsoleError('这段正文已经有一条一模一样的了，没有改')
      await memvec('POST', '/remove', { scope: row.scope, id: row.id })
      return { id: data.memory?.id || id, mode: 'replace-candidate', status: 'active' }
    }

    const data = await memvec('POST', '/add', {
      text,
      scope: row.scope,
      importance: row.importance,
      confidence: Math.max(0.9, row.confidence || 1),
      confirmed: true,
      tier: row.tier,
      tags: row.tags,
      subject_id: row.subject_id,
      fact_key: row.fact_key,
      expires_at: row.expires_at / 1000,
      semantic_checked: true,
      relation: 'replace',
      related_id: row.id,
      related_time: row.source_time,
      relation_confidence: 1,
      source_id: `console-${Date.now()}`,
      source_text: text,
      source_time: Date.now() / 1000,
    }, 60000)
    if (data.memory?.duplicate) throw new ConsoleError('这段正文已经有一条一模一样的了，没有改')
    return { id: data.memory?.id || id, mode: 'replace', status: 'active' }
  }

  if (op === 'add') {
    const text = String(payload.text || '').trim()
    if (!text) throw new ConsoleError('写点什么再记')
    if (text.length > MAX_TEXT) throw new ConsoleError(`一条最多 ${MAX_TEXT} 字，现在 ${text.length}`)
    const targetScope = String(payload.scope || '').trim()
    if (targetScope === 'global') throw new ConsoleError('旧的 global 只保留归档；新记忆要记到某个私聊或群里')
    if (!/^(private:\d+|group:\d+)$/.test(targetScope)) throw new ConsoleError('要选一个聊天（私聊或群）')
    const tier = ['normal', 'core', 'task'].includes(payload.tier) ? payload.tier : 'normal'
    const importance = Math.max(0, Math.min(1, Number(payload.importance ?? 0.7)))
    const data = await memvec('POST', '/add', {
      text,
      scope: targetScope,
      importance,
      confidence: 1,
      confirmed: true,
      tier,
      tags: String(payload.tags || '').slice(0, 80),
      subject_id: String(payload.subjectId || '').slice(0, 80),
      fact_key: String(payload.factKey || '').slice(0, 100),
      expires_at: tier === 'core' ? 0 : 0,
      source_id: String(payload.sourceId || `console-manual-${Date.now()}`).slice(0, 120),
      source_text: text,
      source_time: Number.isFinite(Number(payload.sourceTime)) && Number(payload.sourceTime) > 0
        ? Number(payload.sourceTime)
        : Date.now() / 1000,
    }, 60000)
    if (data.memory?.duplicate) throw new ConsoleError('已经有一条一模一样的了，没重复记')
    return { id: data.memory?.id, status: data.memory?.status || 'active', duplicate: !!data.memory?.duplicate }
  }

  throw new ConsoleError(`不认识的操作：${op}`)
}

export async function memoriesOnDate(date) {
  const day = String(date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ConsoleError('日期要写成 YYYY-MM-DD')
  const start = new Date(`${day}T00:00:00`)
  if (Number.isNaN(start.getTime())) throw new ConsoleError('这个日期不存在')
  const from = start.getTime() / 1000
  const to = from + DAY
  const now = Date.now()
  return withDb((db) => {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM memories
      WHERE status IN ('active','candidate')
        AND COALESCE(NULLIF(source_time, 0), created_at) >= ?
        AND COALESCE(NULLIF(source_time, 0), created_at) < ?
      ORDER BY COALESCE(NULLIF(source_time, 0), created_at) ASC
      LIMIT 100`).all(from, to)
    return rows.map((r) => normalize(r, now))
  })
}

async function applyUndo(recipe) {
  if (!recipe || !recipe.kind) throw new ConsoleError('这条操作没有可撤销的动作', 400)

  if (recipe.kind === 'status') {
    const row = await requireRow(recipe.id)
    if (row.status !== recipe.expect) {
      throw new ConsoleError(`这条后来又被改过（现在是 ${row.status}），不能盲目撤销`, 409)
    }
    await updateRaw(recipe.id, { status: recipe.restore })
    return
  }

  if (recipe.kind === 'fields') {
    const row = await requireRow(recipe.id)
    const e = recipe.expect || {}
    const same = row.tier === e.tier
      && Math.abs(Number(row.importance) - Number(e.importance)) < 0.0001
      && Number(row.expires_at) === Number(e.expires_at)
    if (!same) throw new ConsoleError('这条后来又被改过，不能盲目撤销', 409)
    await updateRaw(recipe.id, {
      tier: recipe.restore.tier,
      importance: recipe.restore.importance,
      expiresAt: recipe.restore.expires_at,
    })
    return
  }

  if (recipe.kind === 'soft-delete') {
    const row = await requireRow(recipe.id)
    if (row.status === 'deleted') return
    const expect = Array.isArray(recipe.expect) ? recipe.expect : ['active', 'candidate']
    if (!expect.includes(row.status)) throw new ConsoleError(`这条现在是 ${row.status}，不能这样撤销`, 409)
    await updateRaw(recipe.id, { status: 'deleted' })
    return
  }

  if (recipe.kind === 'edit') {
    const old = await requireRow(recipe.oldId)
    const neu = await requireRow(recipe.newId)
    if (!['superseded', 'deleted'].includes(old.status)) {
      throw new ConsoleError('旧的那条已经不在被取代/已删状态，不能撤销', 409)
    }
    if (!['active', 'candidate', 'deleted'].includes(neu.status)) {
      throw new ConsoleError('新那条的状态变了，不能撤销', 409)
    }
    await withDb((db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE memories SET status=?, superseded_by=? WHERE id=?').run(recipe.oldStatus, '', recipe.oldId)
        db.prepare("UPDATE memories SET status='deleted' WHERE id=?").run(recipe.newId)
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {}
        throw error
      }
    }, { write: true })
    return
  }

  if (recipe.kind === 'diary-file') {
    const diary = await import('./diary.js')
    await diary.restoreDiaryBackup(recipe)
    return
  }

  throw new ConsoleError(`不认识的撤销类型：${recipe.kind}`, 400)
}

export async function undoAudit(id) {
  const entry = findAudit(id)
  if (!entry) throw new ConsoleError('找不到这条操作记录（可能已经滚出日志了）', 404)
  if (entry.op === 'undo') throw new ConsoleError('撤销本身不能再撤销', 400)
  if (entry.status !== 'ok') throw new ConsoleError('这条操作当时是失败的，没有可撤销的内容', 400)
  if (entry.undone) throw new ConsoleError('这条已经撤销过了', 409)
  if (!entry.undo) throw new ConsoleError('这条操作没有可撤销的动作', 400)

  try {
    await applyUndo(entry.undo)
  } catch (error) {
    logAudit({
      op: 'undo',
      status: 'error',
      ref: entry.id,
      target: entry.target,
      summary: `撤销失败：${entry.summary}`,
      error: error?.message || String(error),
    })
    throw error
  }

  const record = logAudit({
    op: 'undo',
    status: 'ok',
    ref: entry.id,
    target: entry.target,
    summary: `撤销：${entry.summary}`,
    undo: null,
  })
  return { undone: entry.id, summary: entry.summary, auditId: record?.id || null }
}

// ---------------------------------------------------------------- 语义搜索

export async function search({ scope = 'all', query = '', k = 20 } = {}) {
  const q = String(query || '').trim()
  if (!q) throw new ConsoleError('先写一句要找什么')
  if (scope === 'all' || scope === 'private' || scope === 'group') {
    // memvec 的 /search 必须带一个具体 scope；「全部」就按聊天逐个问，再合并。
    const breakdown = await scopeBreakdown()
    const keys = breakdown.map((r) => r.scope).filter((k) => k !== 'global')
    if (breakdown.some((r) => r.scope === 'global' && Number(r.byStatus.active || 0) > 0)) keys.push('global')
    const results = await Promise.all(keys.map(async (key) => {
      try {
        const data = await memvec('POST', '/search', { scope: key, query: q, k: Math.min(20, Number(k) || 10), min_score: 0.28 }, 30000)
        return (data.results || []).map((r) => ({ ...r, scope: key }))
      } catch {
        return []
      }
    }))
    const flat = results.flat().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, Number(k) || 20)
    return withRows(flat)
  }
  const data = await memvec('POST', '/search', { scope, query: q, k: Number(k) || 20, min_score: 0.25 }, 30000)
  return withRows((data.results || []).map((r) => ({ ...r, scope })))
}

async function withRows(results) {
  const ids = results.map((r) => r.id)
  const byId = await getMemoriesByIds(ids)
  return results.map((r) => {
    const row = byId.get(r.id)
    return row ? { ...row, sim: r.sim, score: r.score, searchRecall: r.recall } : { ...r, recall: r.recall || 0 }
  })
}

// ---------------------------------------------------------------- 导出

export async function exportAll() {
  return withDb((db) => db.prepare(`SELECT ${COLUMNS} FROM memories ORDER BY created_at DESC`).all().map((r) => normalize(r)))
}

// ---------------------------------------------------------------- 记忆图

function decodeVector(value) {
  if (!value) return null
  try {
    const buf = value instanceof Uint8Array ? value : Buffer.from(value)
    if (buf.byteLength < 4 || buf.byteLength % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  } catch {
    return null
  }
}

function cosine(a, b, normA, normB) {
  if (!a || !b || a.length !== b.length || !normA || !normB) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot / (normA * normB)
}

/**
 * 记忆图：节点 = 记忆，边 = 显式关系 / 同一事实键 / 语义相近（embedding 余弦）。
 * 控制台只读 SQLite，向量直接读 BLOB，不需要 memvec 提供新接口。
 */
export async function memoryGraph({ limit = 220, offset = 0, threshold = 0.55, topK = 3 } = {}) {
  const max = Math.max(1, Math.min(800, Number(limit) || 220))
  const off = Math.max(0, Math.round(Number(offset) || 0))
  const thr = Math.max(0.3, Math.min(0.95, Number(threshold) || 0.55))
  const k = Math.max(1, Math.min(6, Number(topK) || 3))
  const now = Date.now()
  return withDb((db) => {
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status != 'deleted'").get()?.n) || 0
    const rows = db.prepare(`SELECT ${COLUMNS}, embedding FROM memories WHERE status != 'deleted' ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(max, off)
    const nodes = []
    const vectors = []
    for (const row of rows) {
      const n = normalize(row, now)
      nodes.push({
        id: n.id,
        text: String(n.text || '').slice(0, 90),
        scope: n.scope,
        status: n.status,
        tier: n.tier,
        importance: n.importance,
        confidence: n.confidence,
        relation: n.relation,
        strength: n.strength,
        recall: n.recall,
        createdAt: n.createdAt,
        lastAccess: n.lastAccess,
        expiresAt: n.expiresAt,
        factKey: n.factKey,
        subjectId: n.subjectId,
      })
      vectors.push(decodeVector(row.embedding))
    }
    const index = new Map(nodes.map((n, i) => [n.id, i]))
    const links = new Map()
    const addLink = (a, b, kind, w) => {
      if (!a || !b || a === b) return
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      const old = links.get(key)
      if (old && old.w >= w) return
      links.set(key, { source: a, target: b, kind, w: Math.round(w * 1000) / 1000 })
    }
    // 1) 显式关系（replace/conflict/equivalent...）
    rows.forEach((row, i) => {
      const related = String(row.related_id || '')
      if (related && index.has(related)) addLink(nodes[i].id, related, 'relation', 1)
    })
    // 2) 同一事实键：同一个方面的不同版本
    const byFact = new Map()
    for (const n of nodes) {
      if (!n.factKey) continue
      if (!byFact.has(n.factKey)) byFact.set(n.factKey, [])
      byFact.get(n.factKey).push(n.id)
    }
    for (const ids of byFact.values()) {
      for (let i = 1; i < ids.length; i++) addLink(ids[0], ids[i], 'fact', 0.8)
    }
    // 3) 语义相近：每条记忆连最像的 topK 条
    const norms = vectors.map((v) => {
      if (!v) return 0
      let s = 0
      for (let i = 0; i < v.length; i++) s += v[i] * v[i]
      return Math.sqrt(s)
    })
    for (let i = 0; i < nodes.length; i++) {
      if (!vectors[i] || !norms[i]) continue
      const scored = []
      for (let j = 0; j < nodes.length; j++) {
        if (i === j || !vectors[j] || !norms[j]) continue
        const s = cosine(vectors[i], vectors[j], norms[i], norms[j])
        if (s >= thr) scored.push([j, s])
      }
      scored.sort((a, b) => b[1] - a[1])
      for (const [j, s] of scored.slice(0, k)) addLink(nodes[i].id, nodes[j].id, 'similar', s)
    }
    return { generatedAt: now, count: nodes.length, total, offset: off, hasMore: off + nodes.length < total, nodes, links: [...links.values()], threshold: thr, topK: k }
  })
}
