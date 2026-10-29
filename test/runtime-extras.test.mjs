// 回归：0.8.3/0.8.4 旧桥接升级必须在第一次 --apply 同时完成
// include_global=false 和 shared:true 标记，不能依赖第二次执行。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { root } from '../bin/runtime.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-upgrade-'))
const srcDir = path.join(tmp, 'src')
fs.mkdirSync(srcDir, { recursive: true })
const bridge = `const cfg = { socialV2: { memoryShare: { enabled: false } } };
const STATE_DIR = '.';
const shareCfg = cfg.socialV2?.memoryShare || {};
async function withMemoryContext(key) {
  const opts = { body: JSON.stringify({ query, scope: memoryScope(key), min_score: 0.4, k: Number(cfg.socialV2?.memoryRecall?.topK ?? 3) }), };
  const j = await res.json();
  if (human) return summaryBlock + sessionBlock + compose(priority.results, [...(j.results || []), ...sharedRows]);
  return j;
}
// memoryShare：跨聊天记忆共享开关
async function syncGroupDirectory() {}
const tk = 'internal:可塑性记忆';
if (shareCfg.enabled !== false) { }
`
fs.writeFileSync(path.join(srcDir, 'bridge.js'), bridge, 'utf8')
fs.writeFileSync(path.join(srcDir, 'human-context.mjs'), `export function buildHumanContext({ key, searchRows = [] }) {
  for (const r of searchRows) {
    const scope = r.scope;
      if (scope !== key && scope !== 'global') continue;
  }
}
`, 'utf8')

const installer = path.join(root, 'bridge', 'install-runtime-extras.mjs')
const first = spawnSync(process.execPath, [installer, '--target', tmp, '--apply'], { encoding: 'utf8' })
if (first.status !== 0) throw new Error('installer failed: ' + first.stderr)
const upgraded = fs.readFileSync(path.join(srcDir, 'bridge.js'), 'utf8')
if (!upgraded.includes('include_global: false')) throw new Error('first apply did not set include_global=false')
if (!upgraded.includes('sharedRows.map((r) => ({ ...r, shared: true }))')) throw new Error('first apply did not mark shared rows')
const human = fs.readFileSync(path.join(srcDir, 'human-context.mjs'), 'utf8')
if (!human.includes('!r.shared')) throw new Error('first apply did not patch human-context')
const hash = fs.readFileSync(path.join(srcDir, 'bridge.js'), 'utf8')
const second = spawnSync(process.execPath, [installer, '--target', tmp, '--check'], { encoding: 'utf8' })
if (second.status !== 0 || !second.stdout.includes('already-installed')) throw new Error('second check not idempotent: ' + second.stdout)
if (fs.readFileSync(path.join(srcDir, 'bridge.js'), 'utf8') !== hash) throw new Error('code changed on second run')
fs.rmSync(tmp, { recursive: true, force: true })
console.log('runtime-extras upgrade: one-pass include_global + shared flag, idempotent')
