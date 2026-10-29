import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { paths } from '../lib/core.js'
import { root, findPython, pythonDependencies } from './runtime.mjs'

const python = findPython()
if (!python || !pythonDependencies(python)) {
  console.error('Python 3.10+ 或 numpy / fastembed 尚未就绪。运行 npm run doctor 查看安装提示。')
  process.exitCode = 1
} else {
  const db = process.env.MEMVEC_DB_PATH || paths().db
  const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const legacy = path.join(root, 'memvec', 'memories.db')
  if (normalize(db) !== normalize(paths().db)) {
    console.error('MEMVEC_DB_PATH 和控制台数据库路径不同。请同时设置 FEIYU_MEMVEC_DB，或取消冲突的覆盖项。')
    process.exitCode = 1
  } else if (!fs.existsSync(db) && fs.existsSync(legacy) && normalize(legacy) !== normalize(db)) {
    console.error('发现旧的 memvec/memories.db。请先备份，并让 MEMVEC_DB_PATH 与 FEIYU_MEMVEC_DB 同时指向它；不会自动创建另一个空库。')
    process.exitCode = 1
  } else {
    const env = { ...process.env, MEMVEC_DB_PATH: db,
      MEMVEC_CACHE_PATH: process.env.MEMVEC_CACHE_PATH || path.join(path.dirname(db), 'hfcache') }
    console.log(`数据库：${db}\n模型缓存：${env.MEMVEC_CACHE_PATH}\n首次启动可能下载模型；Ctrl+C 停止。`)
    const child = spawn(python.command, [...python.args, path.join(root, 'memvec', 'server.py')], { env, stdio: 'inherit', windowsHide: true })
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
    child.on('exit', (code) => { process.exitCode = code ?? 1 })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal) })
  }
}
