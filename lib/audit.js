// 大肥鱼的记忆 · 审计日志
//
// 每次写操作都留一条：谁、什么时候、动了哪条、从什么改成什么、能不能撤销。
// 存在 ~/.dsh/feiyu-memory-console/audit.jsonl（纯文本，一行一条）。
//
// 日志本身永远不阻塞主操作：写日志失败只打 console.error。
// 但撤销必须依赖日志里完整的 before/after，所以能撤销的动作会把足够的信息写进去。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const MAX_BYTES = 2 * 1024 * 1024

function auditDir() {
  return process.env.FEIYU_AUDIT_DIR
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'feiyu-memory-console')
}

export function auditPath() {
  return path.join(auditDir(), 'audit.jsonl')
}

function rotateIfNeeded(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      const old = `${file}.1`
      try { fs.unlinkSync(old) } catch {}
      fs.renameSync(file, old)
    }
  } catch {}
}

/**
 * 追加一条审计。返回写入的记录；写失败返回 null（不抛）。
 * entry: { op, status, target, summary, before, after, undo, error }
 */
export function logAudit(entry = {}) {
  const record = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    op: String(entry.op || 'unknown'),
    status: entry.status === 'error' ? 'error' : 'ok',
    target: entry.target || null,
    summary: String(entry.summary || entry.op || ''),
    before: entry.before ?? null,
    after: entry.after ?? null,
    undo: entry.undo ?? null,
    ...(entry.ref ? { ref: String(entry.ref) } : {}),
    ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {}),
  }
  try {
    const file = auditPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    rotateIfNeeded(file)
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    return record
  } catch (error) {
    console.error('[feiyu-audit] 写不进去：', error?.message || error)
    return null
  }
}

function parseLines(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && row.id) out.push(row)
    } catch {}
  }
  return out
}

/** 最近 limit 条，新的在前；附带 undone / undoable。 */
export function readAudit(limit = 50) {
  let entries = []
  try {
    entries = parseLines(fs.readFileSync(auditPath(), 'utf8'))
  } catch {
    return []
  }
  const undone = new Set()
  for (const entry of entries) {
    if (entry.op === 'undo' && entry.status === 'ok' && entry.ref) undone.add(String(entry.ref))
  }
  const n = Math.max(1, Math.min(500, Number(limit) || 50))
  return entries.slice(-n).reverse().map((entry) => ({
    ...entry,
    undone: entry.op !== 'undo' && undone.has(String(entry.id)),
    undoable: Boolean(entry.undo) && entry.status === 'ok' && entry.op !== 'undo' && !undone.has(String(entry.id))
      && (entry.op !== 'confirm' || entry.undo.kind === 'memvec-confirm'),
  }))
}

export function findAudit(id) {
  return readAudit(1000).find((entry) => String(entry.id) === String(id)) || null
}

export function auditCount() {
  try {
    return parseLines(fs.readFileSync(auditPath(), 'utf8')).length
  } catch {
    return 0
  }
}

export const OP_LABELS = {
  add: '新增记忆',
  edit: '改记忆',
  delete: '软删记忆',
  restore: '恢复记忆',
  confirm: '确认候选',
  finish: '完成待办',
  meta: '调层级/重要度',
  tier: '调层级',
  importance: '调重要度',
  decay: '跑衰减',
  flush: '手动提炼',
  'diary-save': '改日记页',
  'diary-append': '补日记页',
  undo: '撤销',
}
