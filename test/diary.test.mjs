// 日记解析 / 保存 / 补页 / 乐观锁 / 备份（全部在临时目录里，不碰真日记）。
// 跑：node test/diary.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-diary-test-'))
const diaryDir = path.join(root, 'diary')
const home = path.join(root, 'home')
fs.mkdirSync(diaryDir, { recursive: true })
fs.mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home
process.env.FEIYU_DIARY_DIR = diaryDir

const publicText = `# 鲸的日记

> 给主人看的这一本。

## 2026-10-24（第一页）

### 今天

第一段。

## 看过

| 时间 | BV |
| --- | --- |
| 2026-10-24 | BV1xx |

## 2026-10-25（第二页）

第二页。
`
const privateText = `# 私人日记

> 这一本不给他看。

## 2026-10-24（第一页）

私密的一页。
`
fs.writeFileSync(path.join(diaryDir, 'whale-diary.md'), publicText, 'utf8')
fs.writeFileSync(path.join(diaryDir, 'whale-diary-private.md'), privateText, 'utf8')

const { readBooks, saveEntry, appendEntry, diaryDates, diarySummary, plainFromMarkdown, parseDiary } = await import('../lib/diary.js')

const books = readBooks()
assert.equal(books.length, 2)
const pub = books.find((b) => b.id === 'public')
const priv = books.find((b) => b.id === 'private')
assert.equal(pub.entries.length, 2)
assert.equal(pub.entries[0].date, '2026-10-24')
assert.equal(pub.entries[0].label, '（第一页）')
assert.match(pub.entries[0].body, /## 看过/) // 非日期二级标题留在当天正文
assert.equal(pub.entries[1].date, '2026-10-25')
assert.equal(priv.locked, true)
assert.equal(priv.entries.length, 0)
assert.deepEqual(diaryDates(), { '2026-10-24': ['public'], '2026-10-25': ['public'] })
assert.equal(diarySummary().count, 2)

const parsed = parseDiary(publicText)
assert.equal(parsed.entries[0].index, 0)
assert.match(parsed.intro, /# 鲸的日记/)

// 改第一页：保留第二页和非日期标题
const mtime = pub.mtime
const saved = saveEntry('public', 0, '### 今天\n\n改过的内容。', mtime)
assert.equal(saved.entries.length, 2)
assert.equal(saved.entries[0].date, '2026-10-24')
assert.match(saved.entries[0].body, /改过的内容/)
assert.equal(saved.entries[1].date, '2026-10-25')
assert.match(fs.readFileSync(path.join(diaryDir, 'whale-diary.md'), 'utf8'), /改过的内容/)

// 补一页
const appended = appendEntry('public', { date: '2026-10-26', label: '第三页', body: '新的第三页。' }, saved.mtime)
assert.equal(appended.entries.length, 3)
assert.equal(appended.entries[2].date, '2026-10-26')
assert.equal(appended.entries[2].label, '（第三页）')

// 乐观锁：文件刚被外部改过，旧 mtime 不能再写
const file = path.join(diaryDir, 'whale-diary.md')
fs.appendFileSync(file, '\n外部改动\n', 'utf8')
let locked = false
try {
  saveEntry('public', 0, '不该写进去', appended.mtime)
} catch (error) {
  locked = error.status === 409
}
assert.equal(locked, true, '旧 mtime 保存应该 409')

// 备份至少存在
const backups = fs.readdirSync(path.join(home, 'feiyu-memory-console', 'diary-backups'))
assert.ok(backups.length >= 2, '每次写入都该有备份')

assert.match(plainFromMarkdown('## 标题\n\n- **重点**\n- [链接](https://x.test)'), /重点/)
assert.ok(!plainFromMarkdown('| a | b |').includes('|'))

fs.rmSync(root, { recursive: true, force: true })
console.log('diary ok: parse / save / append / optimistic lock / backup')
