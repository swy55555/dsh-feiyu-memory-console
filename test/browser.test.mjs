// Optional isolated browser regression: requires Playwright + Chromium.
// Does not connect to the user's running console or QQ bridge.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { findPython, root } from '../bin/runtime.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.FEIYU_PLAYWRIGHT_PATH || 'playwright')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-browser-'))
process.env.DSH_HOME = tmp
process.env.FEIYU_MEMVEC_DB = path.join(tmp, 'memvec', 'memories.db')
process.env.FEIYU_MEMVEC_URL = 'http://127.0.0.1:1'
const { createApiHandler } = await import('../lib/api.js')
const { health } = await import('../lib/core.js')
const server = http.createServer(createApiHandler())
let browser, child, childExit
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.FEIYU_BROWSER_CHANNEL ? { channel: process.env.FEIYU_BROWSER_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } })
  const errors = [], dialogs = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss() })
  await page.goto(url)
  await page.getByText('记忆库还没有就绪，先完成下面的启动检查。').waitFor()
  const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/overview'))
  await page.getByRole('button', { name: '重新检查', exact: true }).click()
  await refreshed

  const python = findPython()
  assert.ok(python)
  child = spawn(python.command, [...python.args, path.join(root, 'test/memvec_fixture.py'), process.env.FEIYU_MEMVEC_DB], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  childExit = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture timeout')), 10000)
    child.once('error', (e) => { clearTimeout(timer); reject(e) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited')) })
    lines.once('line', (line) => { clearTimeout(timer); resolve(JSON.parse(line)) })
  })
  process.env.FEIYU_MEMVEC_URL = `http://127.0.0.1:${info.port}`
  await health(true)
  await page.goto(`${url}/#/library?scope=private:10001&status=candidate`)
  await page.getByRole('button', { name: '确认这条是真的', exact: true }).click()
  await page.getByText('确认了，这回她真的记住了', { exact: true }).waitFor()
  await page.getByRole('button', { name: '活着', exact: true }).click()
  await page.locator('article.mem').filter({ hasText: 'I no longer drink coffee' }).waitFor()
  const searchLoad = page.waitForResponse((r) => r.url().includes('/api/library?') && r.url().includes('q=coffee'))
  await page.getByRole('searchbox', { name: '文字筛选' }).fill('coffee')
  await searchLoad
  await page.getByRole('button', { name: '语义找', exact: true }).click()
  await page.getByText('这是本次控制台检索的实际结果，不代表任何 QQ 回复已经使用这些记忆。').waitFor()
  await page.getByText('查看检索依据与来源', { exact: true }).click()
  await page.locator('blockquote').filter({ hasText: '<img src=x onerror=alert(1)> original user wording' }).waitFor()
  assert.equal(await page.locator('blockquote img').count(), 0)
  assert.equal(dialogs.length, 0)
  assert.ok((await page.locator('.memory-evidence').innerText()).includes('综合分'))
  if (process.env.FEIYU_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.FEIYU_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(process.env.FEIYU_SCREENSHOT_DIR, 'retrieval-evidence.png'), fullPage: true })
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop horizontal overflow')
  await page.setViewportSize({ width: 390, height: 844 })
  if (process.env.FEIYU_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.FEIYU_SCREENSHOT_DIR, 'retrieval-evidence-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1365, height: 1000 })
  await page.goto(`${url}/#/overview`)
  await page.getByText('启动检查 · 2 项待处理', { exact: true }).waitFor()
  if (process.env.FEIYU_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.FEIYU_SCREENSHOT_DIR, 'startup-checks.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log('browser OK: first-run guidance, recheck, confirm, semantic evidence, source escaping, desktop layout')
} finally {
  if (browser) await browser.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  if (child && child.exitCode === null) child.kill()
  if (childExit) await childExit
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tmp))
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(tmp, { recursive: true, force: true })
}
