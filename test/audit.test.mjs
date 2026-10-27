// 审计 / 撤销（临时 DB + 临时日记，不碰真数据）。
// 跑：node test/audit.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-audit-test-'))
const home = path.join(root, 'home')
const diaryDir = path.join(root, 'diary')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(diaryDir, { recursive: true })
process.env.DSH_HOME = home
process.env.FEIYU_DIARY_DIR = diaryDir
process.env.FEIYU_AUDIT_DIR = path.join(home, 'feiyu-memory-console')
const dbFile = path.join(home, 'memvec', 'memories.db')
fs.mkdirSync(path.dirname(dbFile), { recursive: true })

const db = new DatabaseSync(dbFile)
db.exec(`CREATE TABLE memories (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'global', importance REAL NOT NULL DEFAULT 0.5,
  created_at REAL NOT NULL, last_access REAL NOT NULL, strength_days REAL NOT NULL DEFAULT 1,
  access_count INTEGER NOT NULL DEFAULT 0, embedding BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', fact_key TEXT NOT NULL DEFAULT '',
  subject_id TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL DEFAULT '', source_time REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1, expires_at REAL NOT NULL DEFAULT 0,
  superseded_by TEXT NOT NULL DEFAULT '', last_reinforced REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'normal', relation TEXT NOT NULL DEFAULT '',
  related_id TEXT NOT NULL DEFAULT ''
)`)
const now = Date.now() / 1000
db.prepare(`INSERT INTO memories (id,text,tags,scope,importance,created_at,last_access,strength_days,access_count,embedding,status,tier,source_time)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('m1', '审计测试：原来是一条普通记忆。', '', 'global', 0.5, now, now, 1, 0, Buffer.alloc(4), 'active', 'normal', now)
db.close()

const { memoryAction, undoAudit } = await import('../lib/core.js')
const { readAudit } = await import('../lib/audit.js')
const { saveEntry, appendEntry, readBook } = await import('../lib/diary.js')

// meta -> undo 恢复
await memoryAction('meta', { id: 'm1', tier: 'core', importance: 0.9 })
let entries = readAudit(20)
assert.equal(entries[0].op, 'meta')
assert.equal(entries[0].undoable, true)
await undoAudit(entries[0].id)
function readRow(sql, ...params) {
  const conn = new DatabaseSync(dbFile, { readOnly: true })
  try { return conn.prepare(sql).get(...params) } finally { conn.close() }
}
let row = readRow('SELECT tier, importance FROM memories WHERE id=?', 'm1')
assert.equal(row.tier, 'normal')
assert.equal(Number(row.importance), 0.5)
entries = readAudit(20)
assert.equal(entries.find((x) => x.id === entries[0].ref)?.undone, true, '原记录应标成已撤销')
let second = false
try { await undoAudit(entries.find((x) => x.op === 'meta').id) } catch (error) { second = /撤销过|撤销/.test(error.message) }
assert.equal(second, true, '同一条不能撤销两次')

// delete -> undo 恢复状态
await memoryAction('delete', { id: 'm1', scope: 'global' })
entries = readAudit(20)
assert.equal(entries[0].op, 'delete')
await undoAudit(entries[0].id)
row = readRow('SELECT status FROM memories WHERE id=?', 'm1')
assert.equal(row.status, 'active')

// 日记：改页 -> 撤销回原文
const diaryFile = path.join(diaryDir, 'whale-diary.md')
fs.writeFileSync(diaryFile, '# 鲸的日记\n\n## 2026-10-24（第一页）\n\n原文。\n', 'utf8')
const before = readBook('public')
await saveEntry('public', 0, '### 今天\n\n改过。', before.mtime)
entries = readAudit(20)
assert.equal(entries[0].op, 'diary-save')
await undoAudit(entries[0].id)
assert.match(fs.readFileSync(diaryFile, 'utf8'), /原文/)
assert.doesNotMatch(fs.readFileSync(diaryFile, 'utf8'), /改过/)

// 日记：补页 -> 撤销删掉新页
const beforeAppend = readBook('public')
await appendEntry('public', { date: '2026-10-25', label: '新页', body: '新页正文。' }, beforeAppend.mtime)
assert.equal(readBook('public').entries.length, 2)
entries = readAudit(20)
assert.equal(entries[0].op, 'diary-append')
await undoAudit(entries[0].id)
assert.equal(readBook('public').entries.length, 1)

fs.rmSync(root, { recursive: true, force: true })
console.log('audit ok: meta undo / delete undo / twice refused / diary save undo / diary append undo')
