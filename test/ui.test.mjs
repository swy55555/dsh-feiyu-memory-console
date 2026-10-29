// 控制台界面回归（需要先起 Chrome CDP）：
//   chrome --headless=new --remote-debugging-port=9223 http://127.0.0.1:3999/
//   node test/ui.test.mjs
//
// 会通过界面新增一条带唯一标记的记忆，再从界面删掉，最后按标记硬清一次。

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

const CDP = 'http://127.0.0.1:9223'
const PAGE = 'http://127.0.0.1:3999/'

assert.ok(process.env.DSH_HOME && process.env.FEIYU_ALLOW_LEGACY_UI_WRITES === '1',
  '旧版 UI 测试会修改数据库；仅可在明确设置 DSH_HOME 的测试副本中运行，并设置 FEIYU_ALLOW_LEGACY_UI_WRITES=1。日常请使用隔离的 test/browser.test.mjs。')

const targets = await (await fetch(`${CDP}/json`)).json()
const target = targets.find((t) => t.type === 'page' && t.url.startsWith(PAGE))
assert.ok(target, '找不到控制台页面，先启动 Chrome CDP')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = (event) => reject(new Error(`CDP 连接失败：${event.message || ''}`))
})

let seq = 0
const pending = new Map()
const errors = []

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id) {
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message))
    else entry.resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown exception')
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
}

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result?.value
}

async function waitFor(expression, timeout = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`等不到：${expression}`)
}

async function click(selector) {
  const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
  assert.equal(ok, true, `点不到 ${selector}`)
}

async function goHash(hash) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`)
  await new Promise((r) => setTimeout(r, 300))
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: PAGE })
await new Promise((r) => setTimeout(r, 400))
await waitFor(`document.readyState === 'complete' && !!document.querySelector('#view .hero')`, 15000)

// 总览
const heroText = await evaluate(`document.querySelector('#view .hero h2').innerText`)
assert.match(heroText, /她记得/)
const statCount = await evaluate(`document.querySelectorAll('.stats .stat').length`)
assert.equal(statCount, 4)

// 长期记忆
await goHash('#/library')
await waitFor(`document.querySelectorAll('.mem').length > 0`)
const memCount = await evaluate(`document.querySelectorAll('.mem').length`)
assert.ok(memCount > 0)
const scopePill = await evaluate(`document.querySelector('.mem .meta .pill:nth-child(2)')?.innerText || ''`)
assert.ok(scopePill.length > 0, '每条应该带聊天标签')

// 语义找
await evaluate(`(() => { const el = document.querySelector('.search input'); el.value = '唱歌'; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await new Promise((r) => setTimeout(r, 450))
const semBtnFound = await evaluate(`(() => { const b = [...document.querySelectorAll('.toolbar .btn')].find(x => x.innerText.includes('语义找')); if (!b) return false; b.click(); return true })()`)
assert.equal(semBtnFound, true)
await waitFor(`!!document.querySelector('.semantic-head')`, 15000)
const semRows = await evaluate(`document.querySelectorAll('.mem').length`)
assert.ok(semRows > 0, '语义找应该有结果')

// 新增（走界面）
const marker = `界面自测-${Date.now()}`
await click('.top-actions .btn.primary')
await waitFor(`!!document.querySelector('#modal-root .modal')`)
await evaluate(`(() => {
  const ta = document.querySelector('#modal-root textarea')
  ta.value = ${JSON.stringify(`${marker}：这条是界面回归留下的，稍后删掉。`)}
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await click('#modal-root .modal button[type=submit]')
await waitFor(`[...document.querySelectorAll('.toast')].some(t => /记下|好了/.test(t.innerText))`, 10000)
await waitFor(`!document.querySelector('#modal-root .modal')`, 5000)

// 回到长期记忆里找它
await goHash('#/library')
await waitFor(`document.querySelectorAll('.mem').length > 0`)
await evaluate(`(() => { const el = document.querySelector('.search input'); el.value = ${JSON.stringify(marker)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await waitFor(`[...document.querySelectorAll('.mem .text')].some(x => x.innerText.includes(${JSON.stringify(marker)}))`, 10000)
const rowCount = await evaluate(`document.querySelectorAll('.mem').length`)
assert.ok(rowCount >= 1)

// 通过这一行的删除按钮删掉
const clickedTrash = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.mem')].find(x => x.innerText.includes(${JSON.stringify(marker)}))
  if (!row) return false
  const btn = [...row.querySelectorAll('button')].find(b => (b.getAttribute('title') || '').includes('删掉'))
  if (!btn) return false
  btn.click(); return true
})()`)
assert.equal(clickedTrash, true)
await waitFor(`!!document.querySelector('#modal-root .modal')`)
const confirmText = await evaluate(`document.querySelector('#modal-root .modal h3').innerText`)
assert.match(confirmText, /删掉/)
await evaluate(`(() => { const b = [...document.querySelectorAll('#modal-root .modal button')].find(x => x.innerText.trim() === '删掉'); b.click(); return true })()`)
await waitFor(`[...document.querySelectorAll('.toast')].some(t => /删掉了/.test(t.innerText))`, 10000)

// 轻量记忆
await goHash('#/light')
await waitFor(`document.querySelectorAll('.conv-card').length > 0`)
await evaluate(`document.querySelector('.conv-card').click()`)
await waitFor(`!!document.querySelector('.light-head')`, 10000)
const lightHead = await evaluate(`document.querySelector('.light-head h2').innerText`)
assert.ok(lightHead.length > 0)

// 整理
await goHash('#/upkeep')
await waitFor(`document.querySelectorAll('.upkeep-grid .card').length >= 4`)
const queueCount = await evaluate(`document.querySelectorAll('.queue-item').length`)
if (queueCount > 0) {
  assert.ok(await evaluate(`!!document.querySelector('.todo-card')`), '整理页应该有「现在要做的」清单')
  assert.ok(await evaluate(`document.querySelectorAll('.todo-item').length >= 1`), '清单至少有一项')
} else {
  assert.ok(await evaluate(`!!document.querySelector('#queue-box .empty')`), '空队列应该显示空状态')
}

// 日记
await goHash('#/diary')
await waitFor(`!!document.querySelector('.diary-main')`, 10000)
assert.ok(await evaluate(`document.querySelector('.diary-body')?.innerText.length > 0`))
assert.ok(await evaluate(`document.querySelectorAll('.book-tab').length === 2`))

// 收尾：硬清掉任何带标记的测试行
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const db = new DatabaseSync(path.join(home, 'memvec', 'memories.db'), { timeout: 5000 })
const removed = db.prepare("DELETE FROM memories WHERE text LIKE ?").run(`%${marker}%`)
db.close()

assert.deepEqual(errors, [], `页面不该有 JS 错误：\n${errors.join('\n')}`)
console.log(`ui ok: overview / library(${memCount}) / semantic(${semRows}) / add+delete / light / upkeep`)
console.log(`cleaned ${removed.changes} row(s)`)
ws.close()
