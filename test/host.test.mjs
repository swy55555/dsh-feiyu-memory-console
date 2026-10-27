// 不进 DSH 也能验证的两件事：
//   1. 宿主半边注册的路由真的能把页面 / API 送出去；
//   2. 浏览器半边的模块工厂能被模块加载器接住，并注册到 settings.section。
//
// 跑：node test/host.test.mjs

import assert from 'node:assert/strict'
import http from 'node:http'

// ---------------- 宿主半边

const registered = []
const fakeCtx = {
  effect(fn) { return fn() },
  webServer: {
    register(route) {
      registered.push(route)
      return () => {}
    },
  },
}

const { apply } = await import('../lib/index.js')
const { createApiHandler, isLoopbackAddress } = await import('../lib/api.js')

assert.equal(isLoopbackAddress('127.0.0.1'), true)
assert.equal(isLoopbackAddress('::1'), true)
assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
assert.equal(isLoopbackAddress('192.168.1.20'), false)
assert.equal(isLoopbackAddress(''), false)

// 来自非本机的请求必须在路由入口被拒掉
{
  const handler = createApiHandler()
  const res = {
    status: 0,
    body: '',
    writeHead(code) { this.status = code },
    end(body) { this.body = String(body || '') },
  }
  await handler({ url: '/api/health', method: 'GET', headers: { host: 'evil.example' }, socket: { remoteAddress: '192.168.1.20' } }, res)
  assert.equal(res.status, 403)
  assert.match(res.body, /只允许本机/)
}
apply(fakeCtx)
assert.equal(registered.length, 1, '应该注册一个路由')
assert.equal(registered[0].kind, 'prefix')
assert.equal(registered[0].path, '/dsh-feiyu-memory')

const server = http.createServer((req, res) => {
  registered[0].handler(req, res).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: String(error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const overview = await fetch(`${base}/dsh-feiyu-memory/api/overview`)
assert.equal(overview.status, 200)
const overviewJson = await overview.json()
assert.equal(overviewJson.ok, true)
assert.ok(typeof overviewJson.active === 'number')

const page = await fetch(`${base}/dsh-feiyu-memory/`)
assert.equal(page.status, 200)
assert.match(page.headers.get('content-type') || '', /text\/html/)
assert.match(await page.text(), /大肥鱼的记忆/)

const css = await fetch(`${base}/dsh-feiyu-memory/app.css`)
assert.equal(css.status, 200)
assert.match(css.headers.get('content-type') || '', /text\/css/)

const redirect = await fetch(`${base}/dsh-feiyu-memory`, { redirect: 'manual' })
assert.equal(redirect.status, 308)
assert.equal(redirect.headers.get('location'), '/dsh-feiyu-memory/')

const noHeader = await fetch(`${base}/dsh-feiyu-memory/api/labels`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scope: 'global', label: 'x' }),
})
assert.equal(noHeader.status, 403, '没有 x-feiyu-console 头的写入必须被拒绝')

const light = await fetch(`${base}/dsh-feiyu-memory/api/light/scopes`)
assert.equal(light.status, 200)
const lightJson = await light.json()
assert.equal(lightJson.ok, true)

const diary = await fetch(`${base}/dsh-feiyu-memory/api/diary`)
assert.equal(diary.status, 200)
const diaryJson = await diary.json()
assert.equal(diaryJson.ok, true)
assert.equal(diaryJson.books.length, 2)
assert.ok(diaryJson.books.every((book) => Array.isArray(book.entries)))

const day = await fetch(`${base}/dsh-feiyu-memory/api/diary/day?date=2026-10-24`)
assert.equal(day.status, 200)
assert.equal((await day.json()).ok, true)

const library = await fetch(`${base}/dsh-feiyu-memory/api/library`)
assert.equal(library.status, 200)
const libraryJson = await library.json()
assert.equal(libraryJson.rows.length, Math.min(libraryJson.total, 60), '不传 limit 时应该按默认 60 返回，而不是 1')

const audit = await fetch(`${base}/dsh-feiyu-memory/api/audit`)
assert.equal(audit.status, 200)
const auditJson = await audit.json()
assert.equal(auditJson.ok, true)
assert.ok(Array.isArray(auditJson.entries))

await new Promise((resolve) => server.close(resolve))
console.log('host ok: route registration, page, css, api, write guard, redirect')

// ---------------- 浏览器半边

let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: f }) {
      assert.equal(id, 'dsh-feiyu-memory-console')
      factory = f
    },
  },
}

await import('../client.js')
assert.equal(typeof factory, 'function', 'client.js 应该调用 __ModuleLoader__.load')

const fakeReact = {
  createElement() { return null },
  useState() { return [null, () => {}] },
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef() { return { current: null } },
}

const mod = factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
})
assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, ['slots'])

let slotName = ''
let slotOptions = null
mod.apply({
  get(name) {
    if (name !== 'slots') return undefined
    return {
      inject(name, fn) { slotName = name; fn() },
      register(options, component) {
        slotOptions = options
        assert.equal(typeof component, 'function')
      },
    }
  },
})
assert.equal(slotName, 'settings.section')
assert.equal(slotOptions.id, 'feiyu-memory')
assert.ok(slotOptions.order > 0)

console.log('client ok: module id, factory, slots registration')
