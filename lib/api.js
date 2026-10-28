// 大肥鱼的记忆 · HTTP 层
//
// 同一份处理器给两个地方用：
//   1. DSH 插件：注册成 webServer 的 /dsh-feiyu-memory 前缀路由；
//   2. bin/preview.mjs：本地单开一个端口，改前端时不用重启 DSH。
//
// 写操作要求带 `x-feiyu-console: 1`。浏览器跨站表单发不出这个头，
// 带上它就必须先过 CORS 预检 —— 而这里从不放行跨站来源。
// 换句话说：别的网页没法偷偷替你把记忆删了。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConsoleError,
  countsByStatus,
  contextMessages,
  contextStats,
  contextSummaries,
  decayPreview,
  catchupDiary,
  deleteContextSummary,
  deleteEpisode,
  draftPersonaSpec,
  exportAll,
  flushQueue,
  getChatPersona,
  getPrivateDiary,
  appendPrivateDiary,
  unlockPrivateDiary,
  resetPrivateDiary,
  health,
  lightAction,
  lightGet,
  lightScopes,
  listMemories,
  memoriesOnDate,
  memoryAction,
  memoryGraph,
  overview,
  queueSummary,
  readLabels,
  resetEmotion,
  revertEmotionDrift,
  acceptEmotionDrift,
  rejectEmotionDrift,
  runDecay,
  scopeBreakdown,
  searchWithEvidence,
  setDiaryAutoImport,
  setOwnerTitle,
  setLabel,
  setAppraisalModel,
  setChatDrift,
  setEpisodeRecall,
  setChatPersona,
  setEmotionDrift,
  setEmotionWeights,
  setOwnerContact,
  ownerContactSettings,
  memeSettings,
  setMemeSettings,
  memeLibrary,
  setBedtime,
  setQueueEnabled,
  setPersonaSpec,
  setQueueLimit,
  summarizeContext,
  updateEpisode,
  undoPersonaChange,
  undoAudit,
  paths,
} from './core.js'
import { auditPath, OP_LABELS, readAudit } from './audit.js'
import { appendEntry, diaryDates, diarySummary, parseDiary, readBooks, saveEntry } from './diary.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, '..', 'web')
const PREFIX = '/dsh-feiyu-memory'

/**
 * 这个控制台只该在本机打开。
 * DSH 的 /api 有浏览器会话围栏，但插件注册的 prefix 路由不在那层后面；
 * 一旦 dsh web 绑到局域网，这里就是记忆和日记的入口。所以自己再挡一刀。
 */
export function isLoopbackAddress(value) {
  let addr = String(value || '').trim()
  if (addr.startsWith('::ffff:')) addr = addr.slice(7)
  if (addr === '::1') return true
  return /^127(?:\.\d{1,3}){3}$/.test(addr)
}

function localOnly(req) {
  return isLoopbackAddress(req.socket?.remoteAddress)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-feiyu-local-only': '1',
    ...headers,
  })
  res.end(payload)
}

function sendFile(res, file) {
  let data
  try {
    data = fs.readFileSync(file)
  } catch {
    send(res, 404, { ok: false, error: 'not found' })
    return
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-feiyu-local-only': '1',
  })
  res.end(data)
}

function privateBookFromMarkdown(markdown) {
  const parsed = parseDiary(markdown)
  return {
    id: 'private',
    title: '只给自己',
    subtitle: '私人日记 · 加密',
    file: 'private-diary.vault.json',
    private: true,
    locked: false,
    intro: parsed.intro,
    entries: parsed.entries,
    mtime: Date.now(),
    size: String(markdown || '').length,
  }
}

function lockedPrivateBook() {
  return {
    id: 'private', title: '只给自己', subtitle: '私人日记 · 已加密', file: 'private-diary.vault.json',
    private: true, locked: true, intro: [], entries: [], mtime: 0, size: 0,
  }
}

function booksDates(books) {
  const map = {}
  for (const book of books || []) {
    for (const entry of book.entries || []) {
      const cur = map[entry.date] || (map[entry.date] = [])
      if (!cur.includes(book.id)) cur.push(book.id)
    }
  }
  return map
}

function booksSummary(books) {
  const all = []
  for (const book of books || []) {
    for (const entry of book.entries || []) {
      all.push({ book: book.id, bookTitle: book.title, date: entry.date, label: entry.label, body: entry.body })
    }
  }
  all.sort((a, b) => b.date.localeCompare(a.date))
  const latest = all[0] || null
  return {
    count: all.length,
    latest: latest ? {
      book: latest.book, bookTitle: latest.bookTitle, date: latest.date, label: latest.label,
      snippet: String(latest.body || '').replace(/[#*_>`~]/g, '').replace(/\s+/g, ' ').slice(0, 120),
    } : null,
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new ConsoleError('请求太大了', 413)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object')
    return data
  } catch {
    throw new ConsoleError('请求体不是合法 JSON', 400)
  }
}

function guardWrite(req) {
  if (req.headers['x-feiyu-console'] !== '1') {
    throw new ConsoleError('缺少控制台请求头（跨站请求已被拒绝）', 403)
  }
  const origin = req.headers.origin
  if (origin) {
    let host = ''
    try { host = new URL(origin).host } catch {}
    if (!host || host !== req.headers.host) throw new ConsoleError('跨站写入已被拒绝', 403)
  }
}

function int(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function within(base, target) {
  const rel = path.relative(base, target)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 生成一个 node:http 处理器。`mountPrefix` 为 true 时按 DSH 的前缀挂载方式工作，
 * 会剥掉 /dsh-feiyu-memory；预览服务器传 false。
 */
export function createApiHandler({ mountPrefix = false } = {}) {
  return async function handler(req, res) {
    if (!localOnly(req)) {
      send(res, 403, { ok: false, error: '这个控制台只允许本机（127.0.0.1 / ::1）访问。远程请用 SSH 隧道，不要把记忆端口直接暴露出去。' })
      return
    }

    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    } catch {
      send(res, 400, { ok: false, error: 'bad url' })
      return
    }

    let pathname = url.pathname
    if (mountPrefix) {
      if (pathname === PREFIX) {
        // 没有结尾斜杠时相对路径会解析错，先补一刀
        res.writeHead(308, { location: `${PREFIX}/${url.search}` })
        res.end()
        return
      }
      if (pathname === `${PREFIX}/`) pathname = '/'
      else if (pathname.startsWith(`${PREFIX}/`)) pathname = pathname.slice(PREFIX.length)
      else {
        send(res, 404, { ok: false, error: 'not found' })
        return
      }
    }

    const method = String(req.method || 'GET').toUpperCase()

    try {
      // ---------------- 静态
      if (method === 'GET' || method === 'HEAD') {
        if (pathname === '/' || pathname === '/index.html') {
          sendFile(res, path.join(WEB, 'index.html'))
          return
        }
        if (pathname === '/app.js') { sendFile(res, path.join(WEB, 'app.js')); return }
        if (pathname === '/app.css') { sendFile(res, path.join(WEB, 'app.css')); return }
        if (pathname === '/favicon.svg' || pathname === '/icon.svg') {
          sendFile(res, path.join(HERE, '..', 'icon.svg'))
          return
        }
        // 万一以后有别的静态文件：只允许 web/ 里面的（可带一层子目录，如 vendor/）
        if (/^\/(?:[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(pathname) && path.extname(pathname)) {
          const file = path.resolve(WEB, `.${pathname}`)
          if (within(WEB, file) && fs.existsSync(file)) {
            sendFile(res, file)
            return
          }
        }
      }

      if (!pathname.startsWith('/api/')) {
        send(res, 404, { ok: false, error: 'not found' })
        return
      }

      const api = pathname.slice(4)

      // ---------------- 读
      if (method === 'GET' && api === '/health') {
        send(res, 200, { ok: true, ...(await health(url.searchParams.get('force') === '1')) })
        return
      }

      if (method === 'GET' && api === '/overview') {
        send(res, 200, { ok: true, ...(await overview()), diary: diarySummary() })
        return
      }

      if (method === 'GET' && api === '/memes') {
        send(res, 200, { ok: true, settings: memeSettings(), ...memeLibrary({ q: url.searchParams.get('q') || '', page: url.searchParams.get('page') || 1, pageSize: url.searchParams.get('pageSize') || 20 }) })
        return
      }

      if (method === 'GET' && api === '/context') {
        const key = String(url.searchParams.get('key') || '')
        if (!/^(private|group):\d+$/.test(key)) throw new ConsoleError('key 必须是 private:ID 或 group:ID')
        const [stats, summaries, messages] = await Promise.all([
          contextStats(key),
          contextSummaries(key, 20),
          contextMessages(key, { limit: 30 }),
        ])
        let config = {}
        try { config = JSON.parse(fs.readFileSync(paths().bridgeConfig, 'utf8'))?.socialV2?.context || {} } catch {}
        send(res, 200, { ok: true, key, stats, summaries: summaries.summaries || [], messages: messages.messages || [], config })
        return
      }

      if (method === 'GET' && api === '/context/messages') {
        const key = String(url.searchParams.get('key') || '')
        if (!/^(private|group):\d+$/.test(key)) throw new ConsoleError('key 必须是 private:ID 或 group:ID')
        const data = await contextMessages(key, {
          limit: int(url.searchParams.get('limit'), 50, 1, 200),
          beforeAt: Number(url.searchParams.get('beforeAt')) || undefined,
        })
        send(res, 200, { ok: true, messages: data.messages || [] })
        return
      }

      if (method === 'GET' && api === '/diary') {
        let autoImport = false
        try {
          const cfg = JSON.parse(fs.readFileSync(paths().bridgeConfig, 'utf8'))
          autoImport = cfg.socialV2?.diary?.autoImport?.enabled === true
        } catch {}
        const publicBooks = readBooks().filter((b) => b.id !== 'private')
        let privateBook = lockedPrivateBook()
        if (req.headers['x-diary-token']) {
          try {
            const data = await getPrivateDiary(req.headers['x-diary-token'])
            privateBook = privateBookFromMarkdown(data.markdown || '')
          } catch {}
        }
        const books = [...publicBooks, privateBook]
        send(res, 200, { ok: true, autoImport, books, dates: booksDates(books), summary: booksSummary(books) })
        return
      }

      if (method === 'GET' && api === '/diary/day') {
        const date = url.searchParams.get('date') || ''
        send(res, 200, { ok: true, date, memories: await memoriesOnDate(date) })
        return
      }

      if (method === 'GET' && api === '/persona') {
        if (!fs.existsSync(paths().persona)) {
          // 没有文件不是错误：前端会显示空状态，并提供“从角色卡起草”
          send(res, 200, { ok: true, missing: true, persona: null, pending: 0, pendingWeight: 0, limits: {} })
          return
        }
        let persona = null
        try { persona = JSON.parse(fs.readFileSync(paths().persona, 'utf8')) } catch {}
        const events = Array.isArray(persona?.events) ? persona.events : []
        const pendingEvents = events.filter((e) => !e.appliedAt)
        const pendingWeight = pendingEvents.reduce((sum, e) => sum + (Number(e.weight) || 0), 0)
        let limits = {}
        try { limits = JSON.parse(fs.readFileSync(paths().bridgeConfig, 'utf8'))?.socialV2?.persona || {} } catch {}
        // 顺手把她自己的叙事和最近那次变化挑出来，前端不用再猜
        const history = Array.isArray(persona?.history) ? persona.history.slice(-5) : []
        send(res, 200, { ok: true, persona, pending: pendingEvents.length, pendingWeight, limits, history })
        return
      }

      if (method === 'GET' && api === '/library') {
        const data = await listMemories({
          scope: url.searchParams.get('scope') || 'all',
          status: url.searchParams.get('status') || 'active',
          tier: url.searchParams.get('tier') || 'all',
          q: url.searchParams.get('q') || '',
          sort: url.searchParams.get('sort') || 'recent',
          limit: int(url.searchParams.get('limit'), 60, 1, 500),
          offset: int(url.searchParams.get('offset'), 0, 0, 1_000_000),
        })
        send(res, 200, {
          ok: true,
          ...data,
          counts: await countsByStatus(),
          scopes: (await scopeBreakdown()).map((s) => ({ ...s, label: readLabels()[s.scope] || '' })),
          diaryDates: diaryDates(),
        })
        return
      }

      if (method === 'GET' && api === '/emotion') {
        let driftEnabled = true
        let driftMode = 'apply'
        let appraisalModelEnabled = false
        let chatDriftEnabled = true
        let episodeRecallEnabled = true
        let weights = { owner: 1.1, group: 1, private: 0.8 }
        let ownerContact = ownerContactSettings().ownerContact
        let bedtime = ownerContactSettings().bedtime
        try {
          const cfg = JSON.parse(fs.readFileSync(paths().bridgeConfig, 'utf8'))
          driftEnabled = cfg.socialV2?.emotion?.drift?.enabled !== false
          driftMode = cfg.socialV2?.emotion?.drift?.mode === 'suggest' ? 'suggest' : 'apply'
          appraisalModelEnabled = cfg.socialV2?.emotion?.appraisalModel?.enabled === true
          chatDriftEnabled = cfg.socialV2?.emotion?.chatDrift?.enabled !== false
          episodeRecallEnabled = cfg.socialV2?.emotion?.episodeRecall?.enabled !== false
          if (cfg.socialV2?.emotion?.weights) weights = { ...weights, ...cfg.socialV2.emotion.weights }
        } catch {}
        try {
          const raw = JSON.parse(fs.readFileSync(paths().emotion, 'utf8'))
          send(res, 200, { ok: true, missing: false, driftEnabled, driftMode, appraisalModelEnabled, chatDriftEnabled, episodeRecallEnabled, weights, ownerContact, bedtime, emotion: raw })
        } catch {
          send(res, 200, { ok: true, missing: true, driftEnabled, driftMode, appraisalModelEnabled, chatDriftEnabled, episodeRecallEnabled, weights, ownerContact, bedtime, emotion: null })
        }
        return
      }

      if (method === 'GET' && api === '/episodes') {
        try {
          const raw = JSON.parse(fs.readFileSync(paths().episodes, 'utf8'))
          const limit = int(url.searchParams.get('limit'), 20, 1, 100)
          const key = String(url.searchParams.get('key') || '')
          const items = (Array.isArray(raw.items) ? raw.items : []).filter((e) => !key || e.chatKey === key).slice(0, limit)
          send(res, 200, { ok: true, items })
        } catch {
          send(res, 200, { ok: true, items: [] })
        }
        return
      }

      if (method === 'GET' && api === '/persona/chat') {
        send(res, 200, { ok: true, profiles: await getChatPersona() })
        return
      }

      if (method === 'GET' && api === '/graph') {
        const limit = int(url.searchParams.get('limit'), 220, 1, 800)
        const offset = int(url.searchParams.get('offset'), 0, 0, 1_000_000)
        const threshold = Number(url.searchParams.get('threshold')) || 0.55
        const topK = int(url.searchParams.get('topK'), 3, 1, 6)
        let etag = ''
        try {
          const st = fs.statSync(paths().db)
          let stamp = `${st.size}-${Math.round(st.mtimeMs)}`
          // WAL 模式下主库 mtime 可能滞后，把 -wal 也算进去
          try {
            const wal = fs.statSync(`${paths().db}-wal`)
            stamp += `-${wal.size}-${Math.round(wal.mtimeMs)}`
          } catch {}
          etag = `"${stamp}-${limit}-${offset}-${threshold}-${topK}"`
        } catch {}
        if (etag && req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag })
          res.end()
          return
        }
        const data = await memoryGraph({ limit, offset, threshold, topK })
        send(res, 200, { ok: true, ...data }, etag ? { etag } : {})
        return
      }

      if (method === 'GET' && api === '/light/scopes') {
        send(res, 200, { ok: true, ...lightScopes(), labels: readLabels() })
        return
      }

      if (method === 'GET' && api === '/light') {
        send(res, 200, { ok: true, ...lightGet(url.searchParams.get('key')) })
        return
      }

      if (method === 'GET' && api === '/queue') {
        send(res, 200, { ok: true, ...queueSummary() })
        return
      }

      if (method === 'GET' && api === '/decay/preview') {
        send(res, 200, { ok: true, ...(await decayPreview()) })
        return
      }

      if (method === 'GET' && api === '/labels') {
        send(res, 200, { ok: true, labels: readLabels() })
        return
      }

      if (method === 'GET' && api === '/audit') {
        const limit = int(url.searchParams.get('limit'), 40, 1, 200)
        const entries = readAudit(limit).map((entry) => ({
          id: entry.id,
          at: entry.at,
          op: entry.op,
          label: OP_LABELS[entry.op] || entry.op,
          status: entry.status,
          target: entry.target,
          summary: entry.summary,
          undone: entry.undone,
          undoable: entry.undoable,
          error: entry.error || '',
        }))
        send(res, 200, { ok: true, entries, path: auditPath() })
        return
      }

      if (method === 'GET' && api === '/export') {
        const rows = await exportAll()
        const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
        send(res, 200, JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, memories: rows }, null, 2), {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="feiyu-memories-${stamp}.json"`,
        })
        return
      }

      // ---------------- 写
      if (method === 'POST') {
        guardWrite(req)
        const body = await readBody(req)

        if (api === '/search') {
          send(res, 200, { ok: true, ...(await searchWithEvidence({ scope: body.scope, query: body.query, k: body.k })) })
          return
        }

        if (api === '/action') {
          send(res, 200, { ok: true, ...(await memoryAction(String(body.op || ''), body)) })
          return
        }

        if (api === '/light/action') {
          send(res, 200, { ok: true, ...(await lightAction(String(body.op || ''), body)) })
          return
        }

        if (api === '/episode/update') {
          send(res, 200, { ok: true, ...(await updateEpisode(body)) })
          return
        }

        if (api === '/diary/catchup') {
          send(res, 200, { ok: true, ...(await catchupDiary()) })
          return
        }

        if (api === '/diary/auto-import') {
          send(res, 200, { ok: true, ...(await setDiaryAutoImport(body.enabled === true)) })
          return
        }

        if (api === '/episode/delete') {
          send(res, 200, { ok: true, ...(await deleteEpisode(body.id)) })
          return
        }

        if (api === '/queue/limit') {
          send(res, 200, { ok: true, ...(await setQueueLimit(body)) })
          return
        }

        if (api === '/queue/enabled') {
          send(res, 200, { ok: true, ...(await setQueueEnabled(body.enabled === true)) })
          return
        }

        if (api === '/persona/chat') {
          const profiles = await setChatPersona({ key: body.key, deltas: body.deltas, note: body.note, clearAuto: body.clearAuto === true })
          send(res, 200, { ok: true, profiles })
          return
        }

        if (api === '/persona/undo') {
          send(res, 200, { ok: true, ...(await undoPersonaChange()) })
          return
        }

        if (api === '/emotion/drift') {
          send(res, 200, { ok: true, ...(await setEmotionDrift(body.enabled === true, body.mode)) })
          return
        }

        if (api === '/emotion/drift/revert') {
          send(res, 200, { ok: true, ...(await revertEmotionDrift()) })
          return
        }

        if (api === '/emotion/reset') {
          send(res, 200, { ok: true, ...(await resetEmotion()) })
          return
        }

        if (api === '/emotion/drift/accept') {
          send(res, 200, { ok: true, ...(await acceptEmotionDrift(body.id)) })
          return
        }

        if (api === '/emotion/drift/reject') {
          send(res, 200, { ok: true, ...(await rejectEmotionDrift(body.id)) })
          return
        }

        if (api === '/memes/settings') {
          send(res, 200, { ok: true, settings: await setMemeSettings(body || {}) })
          return
        }

        if (api === '/emotion/owner-contact') {
          send(res, 200, { ok: true, ownerContact: await setOwnerContact(body || {}) })
          return
        }

        if (api === '/emotion/bedtime') {
          send(res, 200, { ok: true, bedtime: await setBedtime(body || {}) })
          return
        }

        if (api === '/emotion/appraisal') {
          send(res, 200, { ok: true, ...(await setAppraisalModel(body.enabled === true)) })
          return
        }

        if (api === '/emotion/weights') {
          send(res, 200, { ok: true, weights: await setEmotionWeights(body.weights || body) })
          return
        }

        if (api === '/emotion/chat-drift') {
          send(res, 200, { ok: true, ...(await setChatDrift(body.enabled === true)) })
          return
        }

        if (api === '/emotion/episode-recall') {
          send(res, 200, { ok: true, ...(await setEpisodeRecall(body.enabled === true)) })
          return
        }

        if (api === '/persona/spec') {
          send(res, 200, { ok: true, persona: await setPersonaSpec(body.dimensions) })
          return
        }

        if (api === '/persona/draft') {
          send(res, 200, { ok: true, ...(await draftPersonaSpec()) })
          return
        }

        if (api === '/owner-title') {
          send(res, 200, { ok: true, ...(await setOwnerTitle(body.title)) })
          return
        }

        if (api === '/diary/unlock') {
          send(res, 200, { ok: true, ...(await unlockPrivateDiary(String(body.password || ''))) })
          return
        }

        if (api === '/diary/reset') {
          send(res, 200, { ok: true, ...(await resetPrivateDiary()) })
          return
        }

        if (api === '/diary/save') {
          if (body.book === 'private') throw new ConsoleError('私密本是只读的；要补写请用「补一页」', 403)
          send(res, 200, { ok: true, ...(saveEntry(body.book, body.index, body.body, body.mtime)) })
          return
        }

        if (api === '/diary/append') {
          if (body.book === 'private') {
            const token = req.headers['x-diary-token']
            if (!token) throw new ConsoleError('先解锁私密日记', 401)
            await appendPrivateDiary({ date: body.date, label: body.label, body: body.body, token })
            send(res, 200, { ok: true })
            return
          }
          send(res, 200, { ok: true, ...(appendEntry(body.book, { date: body.date, label: body.label, body: body.body }, body.mtime)) })
          return
        }

        if (api === '/queue/flush') {
          const result = await flushQueue(String(body.key || ''))
          send(res, 200, { ok: true, result, queue: queueSummary() })
          return
        }

        if (api === '/undo') {
          const id = String(body.id || '').trim()
          if (!id) throw new ConsoleError('要给一个要撤销的 id')
          send(res, 200, { ok: true, ...(await undoAudit(id)) })
          return
        }

        if (api === '/decay') {
          if (body.run !== true) throw new ConsoleError('要跑衰减得明确传 run: true')
          send(res, 200, { ok: true, ...(await runDecay()) })
          return
        }

        if (api === '/context/summarize') {
          const key = String(body.key || '')
          if (!/^(private|group):\d+$/.test(key)) throw new ConsoleError('key 必须是 private:ID 或 group:ID')
          const result = await summarizeContext(key)
          send(res, 200, { ok: true, result })
          return
        }

        if (api === '/context/summary/delete') {
          const key = String(body.key || '')
          const id = String(body.id || '')
          if (!/^(private|group):\d+$/.test(key) || !id) throw new ConsoleError('需要合法 key 和摘要 id')
          const result = await deleteContextSummary(key, id)
          send(res, 200, { ok: true, result })
          return
        }

        if (api === '/labels') {
          const labels = setLabel(body.scope, body.label)
          send(res, 200, { ok: true, labels })
          return
        }
      }

      send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      if (error instanceof ConsoleError) {
        send(res, error.status || 400, { ok: false, error: error.message })
        return
      }
      // 没料到的错：日志里留全的，界面上给一句能转述的
      console.error('[feiyu-memory]', error)
      send(res, 500, { ok: false, error: `控制台自己出错了：${error?.message || error}` })
    }
  }
}
