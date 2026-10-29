import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { findPython, root } from '../bin/runtime.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-integration-'))
process.env.DSH_HOME = tmp
process.env.FEIYU_MEMVEC_DB = path.join(tmp, 'memvec', 'memories.db')
process.env.FEIYU_MEMVEC_URL = 'http://127.0.0.1:1'
const core = await import('../lib/core.js')
const { createApiHandler } = await import('../lib/api.js')
const { logAudit } = await import('../lib/audit.js')
const servers = []
let child
let childExit

const serve = async (handler) => {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
const json = async (url, body) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feiyu-console': '1' }, body: JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}
const row = (id) => {
  const db = new DatabaseSync(process.env.FEIYU_MEMVEC_DB, { readOnly: true })
  try { return { ...db.prepare('SELECT * FROM memories WHERE id=?').get(id) } } finally { db.close() }
}

try {
  const api = await serve(createApiHandler())
  const first = await (await fetch(`${api}/api/overview`)).json()
  assert.equal(first.ok, true)
  assert.equal(first.unavailable, true)
  assert.ok(first.health.checks.some((c) => c.id === 'database' && !c.ok))
  assert.equal((await (await fetch(`${api}/api/library`)).json()).unavailable, true)
  assert.equal((await json(`${api}/api/search`, { query: 'coffee' })).status, 503)

  const python = findPython()
  assert.ok(python, 'Python 3.10+ is required')
  child = spawn(python.command, [...python.args, path.join(root, 'test/memvec_fixture.py'), process.env.FEIYU_MEMVEC_DB], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  childExit = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 10000)
    child.once('error', (e) => { clearTimeout(timer); reject(e) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited before handshake')) })
    lines.once('line', (line) => { clearTimeout(timer); resolve(JSON.parse(line)) })
  })
  const realService = `http://127.0.0.1:${info.port}`
  process.env.FEIYU_MEMVEC_URL = realService
  const health = await core.health(true)
  assert.equal(health.db.ok, true)
  assert.equal(health.checks.find((c) => c.id === 'database-path').ok, true)
  assert.equal(health.checks.find((c) => c.id === 'confirm').ok, true)

  const before = [row(info.old), row(info.new)]
  const confirmed = await json(`${api}/api/action`, { op: 'confirm', scope: 'private:10001', id: info.new })
  assert.equal(confirmed.status, 200)
  assert.ok(confirmed.data.auditId)
  assert.equal(row(info.old).status, 'superseded')
  assert.equal(row(info.new).status, 'active')
  const noOp = await json(`${api}/api/action`, { op: 'confirm', scope: 'private:10001', id: info.new })
  assert.equal(noOp.data.changed, 0)
  const audit = await (await fetch(`${api}/api/audit`)).json()
  assert.equal(audit.entries.find((e) => e.id === noOp.data.auditId).undoable, false)

  const result = await json(`${api}/api/search`, { scope: 'private', query: 'coffee' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.data.trace.searchedScopes, ['private:10001'])
  assert.equal(result.data.trace.kind, 'retrieval-preview')
  assert.equal(result.data.results[0].sourceId, 'message-2')
  assert.equal(result.data.results[0].sourceText, '<img src=x onerror=alert(1)> original user wording')
  assert.equal(result.data.results[0].retrieval.method, 'vector-decay')
  const group = await json(`${api}/api/search`, { scope: 'group', query: 'coffee' })
  assert.deepEqual(group.data.trace.searchedScopes, ['group:20001'])
  assert.ok(group.data.results.every((r) => r.scope === 'group:20001'))

  const undo = await json(`${api}/api/undo`, { id: confirmed.data.auditId })
  assert.equal(undo.status, 200)
  assert.deepEqual([row(info.old), row(info.new)], before)
  assert.equal((await json(`${api}/api/undo`, { id: confirmed.data.auditId })).status, 409)
  assert.equal((await json(`${api}/api/action`, { op: 'confirm', id: info.new, scope: 'group:20001' })).status, 409)

  const next = await json(`${api}/api/action`, { op: 'confirm', scope: 'private:10001', id: info.new })
  const op = next.data.undo
  const undoPair = await Promise.all([1, 2].map(() => json(`${realService}/confirm/undo`, op)))
  assert.deepEqual(undoPair.map((r) => r.status).sort(), [200, 409], 'concurrent undo applies only once')

  // Expiry is stored in seconds; editing must not divide it a second time.
  const expires = Date.now() / 1000 + 86400
  const added = await json(`${realService}/add`, { text: 'temporary plan', scope: 'private:10001', subject_id: '10001', confirmed: true, expires_at: expires })
  const edited = await core.memoryAction('edit', { id: added.data.memory.id, text: 'changed temporary plan' })
  assert.equal(row(edited.id).expires_at, expires)

  // Report partial service failure; never disguise all failures as an empty hit list.
  const flaky = await serve(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const data = JSON.parse(body || '{}')
    if (data.scope.startsWith('group:')) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'fixture unavailable' })); return }
    const response = await json(`${realService}/search`, data)
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(response.data))
  })
  process.env.FEIYU_MEMVEC_URL = flaky
  const partial = await core.searchWithEvidence({ scope: 'all', query: 'coffee' })
  assert.equal(partial.trace.partial, true)
  assert.equal(partial.trace.warnings[0].scope, 'group:20001')
  await assert.rejects(core.searchWithEvidence({ scope: 'group', query: 'coffee' }), (e) => e.status === 503)

  const oldServer = await serve((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, stats: { db: process.env.FEIYU_MEMVEC_DB } }))
  })
  process.env.FEIYU_MEMVEC_URL = oldServer
  await assert.rejects(core.memoryAction('confirm', { scope: 'private:10001', id: info.new }), (e) => e.status === 409)
  assert.equal(row(info.new).status, 'candidate')
  const mismatch = await serve((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, stats: { db: path.join(tmp, 'other.db'), capabilities: ['transactional-confirm'] } }))
  })
  process.env.FEIYU_MEMVEC_URL = mismatch
  await assert.rejects(core.memoryAction('confirm', { scope: 'private:10001', id: info.new }), (e) => e.status === 409 && e.message.includes('不同数据库'))
  const legacy = logAudit({ op: 'confirm', status: 'ok', undo: { kind: 'status', id: info.new, expect: 'candidate', restore: 'active' } })
  await assert.rejects(core.undoAudit(legacy.id), (e) => e.status === 409)
  const broken = path.join(tmp, 'broken.db')
  fs.writeFileSync(broken, 'not a sqlite database')
  process.env.FEIYU_MEMVEC_DB = broken
  await core.health(true)
  assert.equal((await core.overview()).unavailable, true, 'unreadable databases still show startup guidance')
  console.log('integration OK: clean startup, transactional confirm/undo, source evidence, scope isolation, expiry, partial failure, old-service guard')
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  if (child && child.exitCode === null) child.kill()
  if (childExit) await childExit
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tmp))
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(tmp, { recursive: true, force: true })
}
