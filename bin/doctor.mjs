import fs from 'node:fs'
import path from 'node:path'
import { health, paths } from '../lib/core.js'
import { findPython, pythonDependencies } from './runtime.mjs'

const python = findPython()
const state = await health(true)
const pythonOK = pythonDependencies(python)
const memvecUp = !!state.memvec?.ok
const runtime = [
  { id: 'node', title: 'Node.js 24+', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version },
  { id: 'python', title: 'Python 3.10+', ok: !!python, detail: python ? `${python.command} (${python.version})` : '请安装 Python，或用 FEIYU_PYTHON 指定解释器。' },
  {
    id: 'python-packages',
    title: '记忆服务依赖',
    ok: pythonOK || memvecUp,
    detail: pythonOK ? 'numpy / fastembed 可用' : memvecUp ? '记忆服务已在跑；本机解释器缺依赖，但当前实例可用' : '请用上述 Python 执行 -m pip install -r memvec/requirements.txt。',
  },
]
const extras = []
if (state.bridge?.ok) {
  const caps = new Set(state.bridge.capabilities || [])
  const coreMissing = ['emotion', 'persona-chat', 'diary-vault', 'queue-limit'].filter((cap) => !caps.has(cap))
  extras.push({
    id: 'bridge-caps',
    title: '桥接能力',
    ok: coreMissing.length === 0,
    detail: coreMissing.length ? `缺少：${coreMissing.join(' / ')}` : '桥接能力齐全',
    nextStep: '更新桥接补丁并重启桥接；缺少能力时对应页面会被禁用。',
  })
  const patched = fs.existsSync(path.join(paths().bridge, 'human-context-install.json'))
  extras.push({
    id: 'context-patch',
    title: '上下文层补丁',
    ok: patched,
    detail: patched ? '已安装（原文/摘要会写入）' : '未安装：原文/摘要不会写入，控制台会是空的',
    nextStep: '在插件目录运行：node bridge/install.mjs --target <桥接目录> --apply，然后重启桥接。',
  })
  extras.push({
    id: 'owner-contact',
    title: '主动联系 / 催睡',
    ok: true,
    detail: caps.has('owner-contact') ? '当前桥接已支持' : '当前桥接未包含（可选功能，不影响其他功能）',
    nextStep: caps.has('owner-contact') ? undefined : '运行 node bridge/install-owner-contact.mjs --target <桥接目录> --apply，然后重启桥接。',
  })
}
const checks = [...runtime, ...state.checks, ...extras]
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ at: state.at, checks, database: paths().db }, null, 2))
} else {
  console.log('可塑性记忆 · 启动检查（仅检查，不改配置、不下载模型）\n')
  for (const check of checks) {
    console.log(`${check.ok ? '✓' : '!'} ${check.title}：${check.detail}`)
    if (!check.ok && check.nextStep) console.log(`  下一步：${check.nextStep}`)
  }
  console.log('\n首次启动：npm run start:memvec；另一个终端运行 npm start。\n完整 QQ 功能还需要单独配置桥接和 SnowLuma。')
}
process.exitCode = checks.every((check) => check.ok) ? 0 : 1
