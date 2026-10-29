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
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  await page.locator('.app-version').filter({ hasText: `v${packageVersion}` }).waitFor()
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
  await page.locator('select[name="resolution"]').selectOption('use-candidate')
  await page.getByRole('button', { name: '应用选择', exact: true }).click()
  await page.getByText('已按所选记忆更新，旧事实保留在「被取代」中', { exact: true }).waitFor()
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
  const postService = async (endpoint, body) => {
    const response = await fetch(`${process.env.FEIYU_MEMVEC_URL}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const staleText = 'older coffee <img src=x onerror=alert(1)>'
  const stale = await postService('/add', { text: staleText, scope: 'private:10001', subject_id: '10001', fact_key: 'drink', source_time: Date.now() / 1000 - 1000 })
  await page.goto(`${url}/#/library?scope=private:10001&status=candidate`)
  await page.reload()
  await page.getByRole('button', { name: '确认这条是真的', exact: true }).click()
  await page.getByRole('heading', { name: '这些记忆可以都是真的' }).waitFor()
  await page.locator('.conflict-uncertain > summary').click()
  assert.equal(await page.locator('select[name="resolution"]').inputValue(),'coexist')
  assert.equal(await page.locator('select[name="resolution"] option[value="use-candidate"]').count(),0)
  assert.ok((await page.locator('.conflict-comparison').innerText()).includes('I no longer drink coffee'))
  assert.ok((await page.locator('.conflict-comparison').innerText()).includes(staleText))
  assert.equal(await page.locator('.conflict-comparison img').count(), 0)
  await page.getByRole('button', { name: '暂不处理', exact: true }).click()
  assert.ok((await postService('/list', { scope: 'private:10001', status: 'candidate' })).memories.some(r => r.id === stale.memory.id))
  await page.getByRole('button', { name: '确认这条是真的', exact: true }).click()
  await page.locator('select[name="resolution"]').selectOption('keep-confirmed')
  await page.getByRole('button', { name: '应用选择', exact: true }).click()
  await page.getByText('已保留现状，候选移入「已归档」', { exact: true }).waitFor()
  assert.ok((await postService('/list', { scope: 'private:10001', status: 'archived' })).memories.some(r => r.id === stale.memory.id))
  const older = await postService('/add', { text: 'different older coffee fact', scope: 'private:10001', subject_id: '10001', fact_key: 'drink', source_time: Date.now() / 1000 - 900 })
  await page.reload()
  await page.getByRole('button', { name: '确认这条是真的', exact: true }).click()
  assert.equal(await page.locator('select[name="resolution"]').inputValue(),'coexist')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'conflict modal mobile overflow')
  if (process.env.FEIYU_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.FEIYU_SCREENSHOT_DIR, 'confirmation-conflict-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: '应用选择', exact: true }).click()
  await page.getByText('已分别保留，原有事实没有被覆盖', { exact: true }).waitFor()
  const afterCoexist=(await postService('/list', { scope: 'private:10001', status: 'active' })).memories
  assert.ok(afterCoexist.some(r=>r.id===older.memory.id))
  assert.ok(afterCoexist.some(r=>r.id===info.new))
  await page.goto(`${url}/#/library?scope=private:10001&status=archived`)
  await page.reload()
  await page.getByRole('button', { name:'恢复这条',exact:true }).click()
  await page.getByText('待恢复记忆',{exact:true}).waitFor()
  await page.locator('select[name="resolution"]').selectOption('keep-confirmed')
  await page.getByRole('button',{name:'应用选择',exact:true}).click()
  await page.getByText('已保留现状，未恢复这条记忆',{exact:true}).waitFor()
  assert.ok((await postService('/list',{scope:'private:10001',status:'archived'})).memories.some(r=>r.id===stale.memory.id))
  await page.getByRole('button',{name:'恢复这条',exact:true}).click()
  await page.locator('select[name="resolution"]').selectOption('coexist')
  await page.getByRole('button',{name:'应用选择',exact:true}).click()
  await page.getByText('已分别保留，原有事实没有被覆盖',{exact:true}).waitFor()
  assert.ok((await postService('/list',{scope:'private:10001',status:'active'})).memories.some(r=>r.id===stale.memory.id))
  await page.goto(`${url}/?embed=1#/overview`)
  await page.locator('.app-version').filter({ hasText: `v${packageVersion}` }).waitFor()
  assert.equal(await page.locator('.app-version').isVisible(), true)
  await page.setViewportSize({ width: 1365, height: 1000 })
  await page.goto(`${url}/#/overview`)
  await page.getByText('启动检查 · 2 项待处理', { exact: true }).waitFor()
  let idleEnabled=false
  await page.route('**/api/association/idle', async route=>{
    if(route.request().method()==='POST') idleEnabled=route.request().postDataJSON().enabled
    await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,enabled:idleEnabled,status:'ready',nodes:[{kind:'question',topic:'雨声配阅读？<img src=x onerror=alert(1)>'}],sources:[{text:'喜欢雨声'}]})})
  })
  await page.getByRole('button',{name:'开启空闲联想',exact:true}).click()
  await page.getByRole('button',{name:'关闭空闲联想',exact:true}).waitFor()
  assert.equal(idleEnabled,true)
  await page.getByRole('button',{name:'查看联想去向',exact:true}).click()
  await page.getByRole('heading',{name:'联想去向',exact:true}).waitFor()
  assert.ok((await page.locator('.modal').innerText()).includes('雨声配阅读'))
  assert.equal(await page.locator('.modal img').count(),0)
  await page.getByRole('button',{name:'知道了',exact:true}).click()
  await page.getByRole('button',{name:'关闭空闲联想',exact:true}).click()
  assert.equal(idleEnabled,false)
  if (process.env.FEIYU_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.FEIYU_SCREENSHOT_DIR, 'startup-checks.png'), fullPage: true })
  // Processing receipts are visible even when the queue is empty, with safe source rendering.
  const stateDir=path.join(tmp,'qq-bridge','state');fs.mkdirSync(stateDir,{recursive:true})
  fs.writeFileSync(path.join(stateDir,'daily-memory-queue.json'),JSON.stringify({queues:{},processing:[
    {key:'private:10001',id:'receipt-1',text:'我不喜欢香菜 <img src=x onerror=alert(1)>',status:'partial',updatedAt:Date.now(),missingQuotes:['我不喜欢香菜'],reason:'发现一处遗漏',evidence:[]},
    {key:'private:10001',id:'receipt-2',text:'晚安',status:'checked',updatedAt:Date.now()-1,reason:'没有新增事实',evidence:[]}
  ]}))
  await page.goto(`${url}/#/upkeep`)
  await page.getByText('查看消息处理状态与遗漏检查',{exact:true}).click()
  await page.locator('#processing-box summary').filter({hasText:'发现遗漏 / 继续处理'}).waitFor()
  assert.ok((await page.locator('#processing-box').innerText()).includes('已检查，无新增有效事实'))
  await page.locator('#processing-box summary').filter({hasText:'发现遗漏'}).click()
  await page.getByText('待补齐原话：我不喜欢香菜',{exact:true}).waitFor()
  assert.equal(await page.locator('#processing-box img').count(),0)
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'processing receipts mobile overflow')

  // Stop means no subsequent page or commit; the in-flight page can still save its progress.
  const paging=await postService('/add',{text:'paged browser fact',scope:'private:30003',subject_id:'30003'})
  let actionCalls=0, releasePage, secondRequested
  const secondReady=new Promise(resolve=>secondRequested=resolve)
  const heldPage=new Promise(resolve=>releasePage=resolve)
  await page.route('**/api/action',async route=>{
    const body=route.request().postDataJSON()
    if(body.id!==paging.memory.id)return route.continue()
    assert.equal(body.reviewOnly,true)
    actionCalls++
    if(actionCalls===2){secondRequested();await heldPage}
    await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,pending:true,reviewed:actionCalls*8,total:24})})
  })
  await page.goto(`${url}/#/library?scope=private:30003&status=candidate`)
  await page.getByRole('button',{name:'确认这条是真的',exact:true}).click()
  await secondReady
  await page.getByRole('button',{name:'停止后续检查',exact:true}).click()
  releasePage()
  await page.locator('.review-progress').waitFor({state:'detached'})
  assert.equal(actionCalls,2)
  assert.ok((await postService('/list',{scope:'private:30003',status:'candidate'})).memories.some(r=>r.id===paging.memory.id))
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
