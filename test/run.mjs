import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { root, findPython } from '../bin/runtime.mjs'

const tempParent = path.resolve(os.tmpdir())
const temp = fs.mkdtempSync(path.join(tempParent, 'feiyu-suite-'))
const env = { ...process.env, TEMP: temp, TMP: temp, DSH_HOME: path.join(temp, 'empty-home'), FEIYU_MEMVEC_URL: 'http://127.0.0.1:1' }
let failures = 0
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', timeout: 60000, windowsHide: true })
  if (result.status !== 0) { failures++; console.error('FAILED:', args.join(' '), result.error?.message || '') }
}
try {
  for (const name of ['host', 'diary', 'audit', 'features', 'integration', 'human-context', 'runtime-extras', 'emotion-v2', 'turn-traces', 'runtime-bundle', 'runtime-integration', 'emotion-context', 'daily-memory', 'idle-association', 'usage-features']) run(process.execPath, [`test/${name}.test.mjs`])
  const python = findPython()
  if (python) run(python.command, [...python.args, 'test/memvec_test.py'])
  else { failures++; console.error('Python 3.10+ with numpy is required for memory regression tests.') }
} finally {
  const relative = path.relative(tempParent, path.resolve(temp))
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(temp, { recursive: true, force: true })
}
console.log(`Regression suites: ${16 - failures}/16 passed`)
process.exitCode = failures ? 1 : 0
