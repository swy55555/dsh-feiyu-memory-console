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

  const confirmChoice = async (id) => {
    const pending = await json(`${api}/api/action`, { op: 'confirm', scope: 'private:10001', id })
    if (pending.status !== 409 || !pending.data.conflict) return pending
    return json(`${api}/api/action`, { op: 'confirm', scope: 'private:10001', id, resolution: 'use-candidate', revision: pending.data.conflict.revision })
  }
  const before = [row(info.old), row(info.new)]
  const confirmed = await confirmChoice(info.new)
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

  const next = await confirmChoice(info.new)
  const op = next.data.undo
  const undoPair = await Promise.all([1, 2].map(() => json(`${realService}/confirm/undo`, op)))
  assert.deepEqual(undoPair.map((r) => r.status).sort(), [200, 409], 'concurrent undo applies only once')

  // Conflict details survive both HTTP layers; explicit choices remain auditable and undoable.
  const candidate = await json(`${realService}/add`, { text: 'older choice', scope: 'private:10001', subject_id: '10001', fact_key: 'choice', source_time: Date.now()/1000-1000 })
  const current = await json(`${realService}/add`, { text: 'current choice', scope: 'private:10001', subject_id: '10001', fact_key: 'choice', confirmed: true })
  const conflict = await json(`${api}/api/action`, { op: 'confirm', scope: 'private:10001', id: candidate.data.memory.id })
  assert.equal(conflict.status, 409)
  assert.ok(conflict.data.conflict.confirmed.some(r => r.id === current.data.memory.id))
  const resolved = await json(`${api}/api/action`, { op: 'confirm', scope: 'private:10001', id: candidate.data.memory.id, resolution: 'keep-confirmed', revision: conflict.data.conflict.revision })
  assert.equal(resolved.status, 200)
  assert.equal(row(candidate.data.memory.id).status, 'archived')
  const restoreConflict = await json(`${api}/api/action`, { op:'restore', id:candidate.data.memory.id })
  assert.equal(restoreConflict.status,409)
  assert.equal(restoreConflict.data.conflict.operation,'restore')
  await assert.rejects(core.memoryAction('restore',{id:candidate.data.memory.id,scope:'global'}),e=>e.status===409)
  const restored = await json(`${api}/api/action`, { op:'restore', id:candidate.data.memory.id, resolution:'coexist', revision:restoreConflict.data.conflict.revision })
  assert.equal(restored.status,200)
  assert.equal(row(candidate.data.memory.id).status,'active')
  assert.equal((await json(`${api}/api/undo`,{id:restored.data.auditId})).status,200)
  assert.equal(row(candidate.data.memory.id).status,'archived')
  assert.equal((await json(`${api}/api/undo`, { id: resolved.data.auditId })).status, 200)
  assert.equal(row(candidate.data.memory.id).status, 'candidate')
  assert.equal(row(current.data.memory.id).status, 'active')

  // Relevance feedback must resolve an actual trace, never trust a supplied query.
  const automatic = await json(`${realService}/add`, {text:'喜欢散步',scope:'private:40004',subject_id:'40004',source_text:'我喜欢散步',source_id:'original-auto'})
  const autoId=automatic.data.memory.id
  const autoContext=await json(`${realService}/confirm/context`,{scope:'private:40004',id:autoId})
  assert.equal(autoContext.data.evidence.quote,'我喜欢散步')
  assert.equal((await json(`${realService}/confirm`,{scope:'private:40004',id:autoId,autoRevision:'stale'})).status,409)
  const automaticArgs={scope:'private:40004',id:autoId,automatic:true,autoRevision:autoContext.data.context.revision}
  await assert.rejects(core.memoryAction('confirm',{...automaticArgs,isStillAllowed:()=>false}),e=>e.status===409)
  await assert.rejects(core.memoryAction('confirm',{...automaticArgs,isStillAllowed:()=>true}),e=>e.status===409)
  const proof={id:autoId,revision:autoContext.data.context.revision,evidence:autoContext.data.evidence.quote,supported:true,speakerMatches:true,literal:true,current:true,confidence:.99,reason:'测试原话完整支持'}
  assert.equal((await json(`${realService}/confirm/review`,{scope:'private:40004',id:autoId,operation:'confirm',offset:0,evidenceOnly:true,review:{revision:proof.revision,candidateEvidence:autoContext.data.context.candidate.quote,relations:[],evidenceVerdict:proof}})).status,200)
  const autoResult=await core.memoryAction('confirm',{...automaticArgs,isStillAllowed:()=>true})
  assert.equal(autoResult.changed,1);assert.ok(autoResult.auditId)
  assert.equal((await json(`${api}/api/undo`,{id:autoResult.auditId})).status,200)
  assert.equal(row(autoId).status,'candidate')

  const mockBridge = await serve((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ok:true,traces:[{traceId:'trace-real',key:'private:10001',query:'actual query',candidates:[{id:info.new,scope:'private:10001'}],injected:[]}]}))
  })
  fs.mkdirSync(path.dirname(core.paths().bridgeConfig), {recursive:true})
  fs.writeFileSync(core.paths().bridgeConfig, JSON.stringify({consolePort:Number(new URL(mockBridge).port),consoleToken:"isolated-test-token"}))
  const feedbackBefore=row(info.new)
  await core.memoryAction('irrelevant', {id:info.new,scope:'private:10001',key:'private:10001',traceId:'trace-real',query:'forged query'})
  const feedback=JSON.parse(fs.readFileSync(path.join(tmp,'feiyu-memory-console','relevance-feedback.jsonl'),'utf8').trim())
  assert.equal(feedback.query,'actual query');assert.equal(feedback.traceId,'trace-real');assert.equal(feedback.injected,false)
  assert.deepEqual(row(info.new),feedbackBefore)
  await assert.rejects(core.memoryAction('irrelevant', {id:info.new,scope:'private:10001',key:'private:10001',traceId:'forged'}), e=>e.status===409)

  // Paged review persists through model failure; reviewing alone never activates a fact.
  let failReview = false, reviewCalls = 0
  const reviewBridge = await serve(async (req,res) => {
    let body=''; for await(const chunk of req) body+=chunk
    res.setHeader('content-type','application/json')
    if(!body){res.end(JSON.stringify({ok:true}));return}
    const {context}=JSON.parse(body); reviewCalls++
    if(failReview){res.writeHead(503);res.end(JSON.stringify({ok:false,error:'temporary model failure'}));return}
    res.end(JSON.stringify({ok:true,review:{revision:context.revision,candidateEvidence:context.candidate.quote,
      relations:context.related.map(r=>({id:r.id,relation:'coexist',confidence:1,evidence:r.quote}))}}))
  })
  fs.writeFileSync(core.paths().bridgeConfig,JSON.stringify({consolePort:Number(new URL(reviewBridge).port),consoleToken:'isolated-test-token'}))
  for(let i=0;i<17;i++) await json(`${realService}/add`,{text:`independent fact ${i}`,scope:'private:20002',subject_id:'20002',confirmed:true})
  const paged=await json(`${realService}/add`,{text:'new unrelated fact',scope:'private:20002',subject_id:'20002'})
  const reviewBody={op:'confirm',scope:'private:20002',id:paged.data.memory.id,reviewOnly:true}
  const page1=await json(`${api}/api/action`,reviewBody)
  assert.equal(page1.data.reviewed,8);assert.equal(page1.data.total,17);assert.equal(page1.data.pending,true)
  assert.equal(page1.data.auditId,undefined);assert.equal(row(reviewBody.id).status,'candidate')
  failReview=true
  const failedPage=await json(`${api}/api/action`,reviewBody)
  assert.equal(failedPage.data.reviewed,8);assert.ok(failedPage.data.reviewError)
  failReview=false
  assert.equal((await json(`${api}/api/action`,reviewBody)).data.reviewed,16)
  assert.equal((await json(`${api}/api/action`,reviewBody)).data.reviewed,17)
  const ready=await json(`${api}/api/action`,reviewBody)
  assert.equal(ready.data.readyToApply,true);assert.equal(row(reviewBody.id).status,'candidate')
  assert.equal(reviewCalls,4)
  const applied=await json(`${api}/api/action`,{...reviewBody,reviewOnly:false})
  assert.equal(applied.status,200);assert.equal(row(reviewBody.id).status,'active');assert.ok(applied.data.auditId)
  assert.equal((await json(`${api}/api/undo`,{id:applied.data.auditId})).status,200)
  assert.equal(row(reviewBody.id).status,'candidate')

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
