// 新功能的宿主侧测试：capabilities、persona 路由、queue limit、记忆图。
// 跑：node test/features.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-features-'))
process.env.DSH_HOME = tmp
process.env.FEIYU_BRIDGE_DIR = path.join(tmp, 'qq-bridge')

const bridgeDir = path.join(tmp, 'qq-bridge')
const stateDir = path.join(bridgeDir, 'state')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'console-token'), 'test-token', 'utf8')
fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify({ ownerQQ: 10001, consolePort: 0, socialV2: { dailyMemory: { maxCallsPerDay: 40 } } }), 'utf8')
fs.writeFileSync(path.join(stateDir, 'daily-memory-queue.json'), JSON.stringify({ day: '2026-10-27', calls: 3, okCalls: 2, queues: {} }), 'utf8')

// 假桥接：接收 dailyMemory 配置和 persona reload
let bridgePort = 0
let mockChatProfiles = {}
let mockEmotion = null
const bridgeServer = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const data = body ? JSON.parse(body) : {}
  if (req.url === '/api/emotion' && mockEmotion) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ok:true, emotion:mockEmotion}))
    return
  }
  if (req.url === '/api/socialV2/config') {
    const cfg = JSON.parse(fs.readFileSync(path.join(bridgeDir, 'config.json'), 'utf8'))
    cfg.socialV2 = cfg.socialV2 || {}
    cfg.socialV2.dailyMemory = { ...(cfg.socialV2.dailyMemory || {}), ...(data.dailyMemory || {}) }
    if (data.emotion) {
      cfg.socialV2.emotion = { ...(cfg.socialV2.emotion || {}), ...data.emotion }
      if (data.emotion.drift) cfg.socialV2.emotion.drift = { ...(cfg.socialV2.emotion.drift || {}), ...data.emotion.drift }
    }
    fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify(cfg), 'utf8')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  if (req.url === '/api/persona/chat') {
    if (req.method === 'POST') {
      if (Object.keys(data.deltas || {}).length) mockChatProfiles[data.key] = { deltas: data.deltas, note: data.note || '' }
      else delete mockChatProfiles[data.key]
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, profiles: mockChatProfiles }))
    return
  }
  if (req.url === '/api/persona/reload') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"version":3,"dims":2}')
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"ok":false,"error":"not found"}')
})
await new Promise((resolve) => bridgeServer.listen(0, '127.0.0.1', resolve))
bridgePort = bridgeServer.address().port
{
  const cfg = JSON.parse(fs.readFileSync(path.join(bridgeDir, 'config.json'), 'utf8'))
  cfg.consolePort = bridgePort
  fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify(cfg), 'utf8')
}

const { createApiHandler } = await import('../lib/api.js')
const { health, memoryGraph, setPersonaSpec, setQueueLimit } = await import('../lib/core.js')

const apiServer = http.createServer((req, res) => createApiHandler().call(null, req, res))
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
const apiPort = apiServer.address().port
const api = `http://127.0.0.1:${apiPort}`

const post = (route, body) => fetch(`${api}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-feiyu-console': '1' },
  body: JSON.stringify(body),
})

// 1) capabilities：宿主声明了新能力，前端才知道按钮能不能用
{
  const h = await health(true)
  for (const cap of ['queue-flush', 'queue-limit', 'persona', 'emotion', 'graph']) {
    assert.ok(h.capabilities.includes(cap), `capabilities 缺少 ${cap}`)
  }
}

// 2) emotion：没有文件返回 missing；有文件返回内容
{
  const miss = await fetch(`${api}/api/emotion`)
  assert.equal(miss.status, 200)
  assert.equal((await miss.json()).missing, true)
  const dir = path.join(tmp, 'feiyu-memory-console')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'emotion.json'), JSON.stringify({ state: { valence: 0.2, arousal: 0.3, label: '平静' }, triggers: [] }), 'utf8')
  const hit = await fetch(`${api}/api/emotion`)
  assert.equal(hit.status, 200)
  const data = await hit.json()
  assert.equal(data.missing, false)
  assert.equal(data.emotion.state.label, '平静')
    mockEmotion = {state:{label:'平静',valence:.08,arousal:.34},subjective:{text:'可能有些压力',valence:-.04}}
    const live = await (await fetch(`${api}/api/emotion`)).json()
    assert.equal(live.emotion.subjective.text, '可能有些压力')
    assert.equal(live.emotion.state.valence, .08)
    mockEmotion = null
}

// 2) persona：没有文件返回 missing 空状态；有文件返回 200
{
  const miss = await fetch(`${api}/api/persona`)
  assert.equal(miss.status, 200, '没有 persona.json 时返回空状态')
  assert.equal((await miss.json()).missing, true)
  const personaDir = path.join(tmp, 'feiyu-memory-console')
  fs.mkdirSync(personaDir, { recursive: true })
  const p = {
    version: 3, createdAt: Date.now(), updatedAt: Date.now(),
    spec: { dimensions: [
      { key: 'warm', label: '温度', desc: '冷 ↔ 暖', baseline: 40, band: 20 },
      { key: 'proud', label: '嘴硬', desc: '坦率 ↔ 口是心非', baseline: 80, band: 12 },
    ] },
    originBaseline: { warm: 40, proud: 80 },
    baseline: { warm: 40, proud: 80 },
    current: { warm: 40, proud: 80 },
    narrative: '', events: [], history: [], lastChangeAt: 0, lastAttemptAt: 0, lastBaselineChangeAt: 0,
  }
  fs.writeFileSync(path.join(personaDir, 'persona.json'), JSON.stringify(p, null, 2), 'utf8')
  const hit = await fetch(`${api}/api/persona`)
  assert.equal(hit.status, 200)
  const data = await hit.json()
  assert.equal(data.persona.spec.dimensions.length, 2)
}

// 2b) episodes：本地情景文件能读出来
{
  const dir = path.join(tmp, 'feiyu-memory-console')
  fs.writeFileSync(path.join(dir, 'episodes.json'), JSON.stringify({ items: [
    { id: 'ep1', at: Date.now(), summary: '测试情景', detail: 'gist', importance: 0.4, emotion: { label: '平静' } },
  ] }), 'utf8')
  const res = await fetch(`${api}/api/episodes?limit=5`)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.items.length, 1)
  assert.equal(data.items[0].id, 'ep1')
}
{
  const res = await post('/api/queue/limit', { maxCallsPerDay: 123, groupMaxCallsPerDay: 7 })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.maxCalls, 123)
  assert.equal(data.groupMaxCalls, 7)
  assert.equal(data.okCalls, 2)
}

// 4) persona spec：保存后文件里的底色/边界变了
{
  const res = await post('/api/persona/spec', { dimensions: [
    { key: 'warm', label: '温度', baseline: 55, band: 18 },
    { key: 'proud', label: '嘴硬', baseline: 70, band: 10 },
  ] })
  assert.equal(res.status, 200)
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'feiyu-memory-console', 'persona.json'), 'utf8'))
  assert.equal(saved.spec.dimensions[0].baseline, 55)
  assert.equal(saved.baseline.warm, 55)
  assert.equal(saved.spec.dimensions[1].band, 10)
}

// 4b) 按聊天微调：保存/读取/清除
{
  const put = await post('/api/persona/chat', { key: 'private:10001', deltas: { warm: 3, clingy: 2 }, note: '测试' })
  assert.equal(put.status, 200)
  const got = await fetch(`${api}/api/persona/chat`)
  const list = await got.json()
  assert.equal(list.profiles['private:10001'].deltas.warm, 3)
  const del = await post('/api/persona/chat', { key: 'private:10001', deltas: {}, note: '' })
  assert.equal(del.status, 200)
  assert.equal((await del.json()).profiles['private:10001'], undefined)
}

// 4c) 情绪微调开关
{
  const off = await post('/api/emotion/drift', { enabled: false })
  assert.equal(off.status, 200)
  assert.equal((await off.json()).enabled, false)
  const em = await (await fetch(`${api}/api/emotion`)).json()
  assert.equal(em.driftEnabled, false)
  await post('/api/emotion/drift', { enabled: true })
}

// 5) 记忆图：显式关系 + 语义相近都能出边
{
  const dbPath = path.join(tmp, 'memvec', 'memories.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'global',
    importance REAL NOT NULL DEFAULT 0.5, created_at REAL NOT NULL, last_access REAL NOT NULL,
    strength_days REAL NOT NULL DEFAULT 1, access_count INTEGER NOT NULL DEFAULT 0, embedding BLOB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', fact_key TEXT NOT NULL DEFAULT '', subject_id TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '', source_time REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 1, expires_at REAL NOT NULL DEFAULT 0, superseded_by TEXT NOT NULL DEFAULT '',
    last_reinforced REAL NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'normal', relation TEXT NOT NULL DEFAULT '',
    related_id TEXT NOT NULL DEFAULT '')`)
  const vec = (x, y, z) => Buffer.from(new Float32Array([x, y, z, 0]).buffer)
  const now = Date.now() / 1000
  const insert = db.prepare(`INSERT INTO memories (id,text,scope,importance,created_at,last_access,strength_days,embedding,status,tier,related_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  insert.run('a', '老大喜欢吃肯德基', 'private:10001', 0.8, now, now, 180, vec(1, 0, 0), 'active', 'normal', 'b')
  insert.run('b', '老大不喝无糖茶', 'private:10001', 0.6, now, now, 180, vec(0.9, 0.1, 0), 'active', 'normal', '')
  db.close()
  process.env.FEIYU_MEMVEC_DB = dbPath
  const graph = await memoryGraph({ limit: 10, threshold: 0.5, topK: 2 })
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.total, 2)
  assert.equal(graph.hasMore, false)
  assert.ok(graph.links.some((l) => l.kind === 'relation'), '应该有显式关系边')

  // 分页 + ETag：第二页能拿到，重复请求返回 304
  const page = await memoryGraph({ limit: 1, offset: 0, threshold: 0.5, topK: 2 })
  assert.equal(page.nodes.length, 1)
  assert.equal(page.hasMore, true)
  const first = await fetch(`${api}/api/graph?limit=1`)
  assert.equal(first.status, 200)
  const etag = first.headers.get('etag')
  assert.ok(etag)
  const again = await fetch(`${api}/api/graph?limit=1`, { headers: { 'if-none-match': etag } })
  assert.equal(again.status, 304)
}

bridgeServer.close()
apiServer.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('features tests OK')
