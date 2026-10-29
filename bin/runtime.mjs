import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function findPython() {
  const local = path.join(root, 'memvec', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const candidates = process.env.FEIYU_PYTHON ? [[process.env.FEIYU_PYTHON, []]]
    : [...(fs.existsSync(local) ? [[local, []]] : []), ['python', []], ['python3', []], ...(process.platform === 'win32' ? [['py', ['-3']]] : [])]
  for (const [command, args] of candidates) {
    const result = spawnSync(command, [...args, '-c', 'import sys; print(sys.version.split()[0]); sys.exit(0 if sys.version_info >= (3,10) else 1)'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (result.status === 0) return { command, args, version: result.stdout.trim() }
  }
  return null
}

export function pythonDependencies(python) {
  if (!python) return false
  return spawnSync(python.command, [...python.args, '-c', 'import numpy, fastembed'],
    { timeout: 15000, windowsHide: true, stdio: 'ignore' }).status === 0
}
