// 给已有 QQ 桥接安装/检查/撤销“主动联系 + 催睡觉”补丁。
// 用法：
//   node bridge/install-owner-contact.mjs --target <桥接目录> --check
//   node bridge/install-owner-contact.mjs --target <桥接目录> --apply
//   node bridge/install-owner-contact.mjs --target <桥接目录> --undo
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const targetArg = args.indexOf('--target')
const target = targetArg >= 0 ? path.resolve(args[targetArg + 1] || '') : ''
const mode = args.includes('--apply') ? 'apply' : args.includes('--undo') ? 'undo' : 'check'
const bridgePath = target ? path.join(target, 'src', 'bridge.js') : ''
const modulePath = target ? path.join(target, 'src', 'owner-contact.js') : ''
const receiptPath = target ? path.join(target, 'owner-contact-install.json') : ''
const backupDir = target ? path.join(target, '.owner-contact-backups') : ''

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!target) fail('缺少 --target <QQ 桥接目录>')
if (!fs.existsSync(bridgePath)) fail(`找不到桥接：${bridgePath}`)
const sourceRaw = fs.readFileSync(bridgePath, 'utf8')
const source = sourceRaw.replace(/\r\n/g, '\n')
const hasInline = /function\s+ownerContactCfg\s*\(/.test(source)
const hasPatch = source.includes('// [owner-contact] v1')

if (hasInline) {
  console.log(JSON.stringify({ status: 'already-inline', detail: '这个桥接已经内置了主动联系/催睡，不需要补丁。' }))
  process.exit(0)
}

if (mode === 'undo') {
  if (!fs.existsSync(receiptPath)) fail('没有安装回执，无法撤销。')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  if (hash(bridgePath) !== receipt.after) fail('安装后桥接被改过，拒绝自动撤销。')
  fs.copyFileSync(path.join(backupDir, receipt.bridgeBackup), bridgePath)
  if (receipt.moduleExisted) fs.copyFileSync(path.join(backupDir, receipt.moduleBackup), modulePath)
  else if (fs.existsSync(modulePath)) fs.unlinkSync(modulePath)
  fs.unlinkSync(receiptPath)
  console.log(JSON.stringify({ status: 'restored', bridge: bridgePath }))
  process.exit(0)
}

const importAnchor = 'from \'./emotion.js\';\n'
const fnAnchor = '  function scheduleProactiveCheckV2(key) {\n'
if (!hasPatch) {
  const importAt = source.indexOf(importAnchor)
  const fnAt = source.indexOf(fnAnchor)
  if (importAt < 0 || fnAt < 0) fail('incompatible：找不到插入点（bridge.js 结构不同）。')
  if (!source.includes("'queue-limit'")) fail('incompatible：找不到 capability 列表。')
}

if (mode === 'check') {
  console.log(JSON.stringify({ status: 'compatible', mode, bridge: bridgePath }))
  process.exit(0)
}

const glue = `  // [owner-contact] v1
  startOwnerContact({
    getCfg: () => cfg,
    getMode: () => currentMode,
    isPaused: () => socialV2.paused,
    getState: (key) => getSocialV2State(key),
    isAllowed: (key) => isSessionAllowedInCurrentMode(key),
    isBusy: (key, st) => isConversationBusyV2(key, st),
    buildPrompt: (key, reason) => buildWakePromptV2(key, reason),
    deliver: (key, text, reason) => { void deliverPrompt(key, text, { wakeReason: reason }).catch((e) => log('[owner-contact] 发送异常:', e?.message || e)); },
    applyEmotion: (state, input, now) => applyEmotionEvent(state, input, now),
    getEmotion: () => emotionState,
    setEmotion: (next) => { emotionState = next; },
    saveEmotion: () => saveEmotionState(),
    stateDir: STATE_DIR,
    path,
    fs,
    log,
  });

`

let next = source
if (!next.includes('owner-contact.js')) {
  next = next.replace(importAnchor, `${importAnchor}import { startOwnerContact } from './owner-contact.js';\n`)
}
next = next.replace(fnAnchor, glue + fnAnchor)
next = next.replace("'queue-limit',", "'queue-limit', 'owner-contact',")
next = next.replace(
  '  function scheduleProactiveCheckV2(key) {\n    if (cfg.socialV2?.proactive?.enabled === false) return;',
  '  function scheduleProactiveCheckV2(key) {\n    if (cfg.socialV2?.proactive?.enabled === false) return;\n    if (key === `private:${Number(cfg.ownerQQ)}` && cfg.socialV2?.ownerContact?.enabled !== false) return;',
)

fs.mkdirSync(backupDir, { recursive: true })
const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
const bridgeBackup = `bridge-${stamp}.js`
fs.copyFileSync(bridgePath, path.join(backupDir, bridgeBackup))
const moduleExisted = fs.existsSync(modulePath)
let moduleBackup = ''
if (moduleExisted) {
  moduleBackup = `owner-contact-${stamp}.js`
  fs.copyFileSync(modulePath, path.join(backupDir, moduleBackup))
}

fs.writeFileSync(modulePath, fs.readFileSync(path.join(here, 'owner-contact.js')))
fs.writeFileSync(bridgePath, next)

try {
  execFileSync(process.execPath, ['--check', bridgePath], { stdio: 'pipe' })
  execFileSync(process.execPath, ['--check', modulePath], { stdio: 'pipe' })
} catch (error) {
  fs.copyFileSync(path.join(backupDir, bridgeBackup), bridgePath)
  if (moduleExisted) fs.copyFileSync(path.join(backupDir, moduleBackup), modulePath)
  else if (fs.existsSync(modulePath)) fs.unlinkSync(modulePath)
  fail(`语法检查失败，已回滚：${String(error.stderr || error.message).slice(0, 400)}`)
}

const receipt = {
  version: 1,
  at: new Date().toISOString(),
  bridge: bridgePath,
  module: modulePath,
  before: hash(path.join(backupDir, bridgeBackup)),
  after: hash(bridgePath),
  moduleHash: hash(modulePath),
  moduleExisted,
  bridgeBackup,
  moduleBackup,
}
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ status: 'installed', bridge: bridgePath, receipt: receiptPath }))
