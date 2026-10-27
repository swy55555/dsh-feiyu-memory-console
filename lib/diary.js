// 大肥鱼的记忆 · 日记
//
// 两本日记：
//   ~/.dsh/whale-diary.md          给主人看的
//   ~/.dsh/feiyu-memory-console/private-diary.vault.json  只给自己看的（加密，由桥接解锁）
//
// 控制台只做三件事：按日期读出来、改某一天、在末尾补一页。
// 不改原来的写作流程，也不把日记内容偷偷搬进记忆库 —— 要不要「收进 QQ 记忆」由人点。
//
// 写之前一定备份；写的时候带 mtime 乐观锁：如果鲸刚好也在写，先让人刷新，别互相覆盖。

import fs from 'node:fs'
import path from 'node:path'
import { ConsoleError, paths } from './core.js'
import { logAudit } from './audit.js'

export const BOOKS = {
  public: {
    id: 'public',
    title: '给他看的',
    subtitle: '鲸的日记 · 公开本',
    file: 'whale-diary.md',
    private: false,
    seed: '# 鲸的日记\n\n> 给主人看的这一本：看过什么、想到什么、谁回过我。\n',
  },
  private: {
    id: 'private',
    title: '只给自己',
    subtitle: '私人日记 · 加密',
    file: 'private-diary.vault.json',
    private: true,
    seed: '# 私人日记\n\n> 这一本不给他看。写我自己的那一面。\n',
  },
}

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})(.*)$/

function bookConfig(id) {
  const book = BOOKS[id]
  if (!book) throw new ConsoleError('没有这本日记')
  return book
}

function bookPath(id) {
  const cfg = bookConfig(id)
  return path.join(paths().diaryDir, cfg.file)
}

export function diaryPaths() {
  return {
    public: bookPath('public'),
    private: bookPath('private'),
    dir: paths().diaryDir,
  }
}

function statOf(file) {
  try {
    const s = fs.statSync(file)
    return { exists: true, mtime: s.mtimeMs, size: s.size }
  } catch {
    return { exists: false, mtime: 0, size: 0 }
  }
}

/**
 * 只按「## YYYY-MM-DD…」切页。
 * 「## 看过」「## 给他的信」这种不是日期的二级标题留在当天正文里，
 * 这样一页仍是完整的一页，不会碎成一堆没有日期的条目。
 */
export function parseDiary(content) {
  const text = String(content || '').replace(/^\uFEFF/, '')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const intro = []
  const entries = []
  let current = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const match = DATE_HEADING.exec(line)
    if (match) {
      if (current) current.end = i
      current = {
        index: entries.length,
        date: match[1],
        label: match[2].trim(),
        heading: line,
        start: i,
        bodyStart: i + 1,
        end: lines.length,
      }
      entries.push(current)
    } else if (!current) {
      intro.push(line)
    }
  }

  for (const entry of entries) {
    entry.body = trimBlank(lines.slice(entry.bodyStart, entry.end)).join(eol)
  }

  return {
    eol,
    intro: trimBlank(intro).join(eol).trim(),
    entries,
  }
}

function trimBlank(lines) {
  let start = 0
  let end = lines.length
  while (start < end && !String(lines[start]).trim()) start += 1
  while (end > start && !String(lines[end - 1]).trim()) end -= 1
  return lines.slice(start, end)
}

export function readBook(id) {
  const cfg = bookConfig(id)
  const file = bookPath(id)
  const meta = statOf(file)
  if (cfg.private) {
    // 私密本是加密保险箱，不能当 markdown 直接读；解锁后由桥接返回明文再解析。
    return {
      id: cfg.id, title: cfg.title, subtitle: cfg.subtitle, file: cfg.file, path: file,
      private: true, locked: true, exists: meta.exists, mtime: meta.mtime, size: meta.size,
      intro: [], entries: [],
    }
  }
  let content = ''
  let readError = ''
  if (meta.exists) {
    try { content = fs.readFileSync(file, 'utf8') } catch (error) {
      readError = error.message
    }
  }
  const parsed = parseDiary(content)
  return {
    id: cfg.id,
    title: cfg.title,
    subtitle: cfg.subtitle,
    file: cfg.file,
    path: file,
    private: cfg.private,
    exists: meta.exists,
    mtime: meta.mtime,
    size: meta.size,
    ...(readError ? { error: `读不到 ${cfg.file}：${readError}` } : {}),
    intro: parsed.intro,
    entries: parsed.entries.map((entry) => ({
      index: entry.index,
      date: entry.date,
      label: entry.label,
      body: entry.body,
      words: entry.body.length,
    })),
  }
}

export function readBooks() {
  return [readBook('public'), readBook('private')]
}

export function diaryDates() {
  const map = {}
  for (const book of readBooks()) {
    if (book.error) continue
    for (const entry of book.entries) {
      const cur = map[entry.date] || (map[entry.date] = [])
      if (!cur.includes(book.id)) cur.push(book.id)
    }
  }
  return map
}

export function diarySummary() {
  const books = readBooks()
  const all = []
  for (const book of books) {
    if (book.error) continue
    for (const entry of book.entries) {
      all.push({ book: book.id, bookTitle: book.title, date: entry.date, label: entry.label, body: entry.body })
    }
  }
  all.sort((a, b) => b.date.localeCompare(a.date))
  const latest = all[0] || null
  return {
    count: all.length,
    latest: latest ? {
      book: latest.book,
      bookTitle: latest.bookTitle,
      date: latest.date,
      label: latest.label,
      snippet: plainFromMarkdown(latest.body).replace(/\s+/g, ' ').slice(0, 120),
    } : null,
  }
}

function backup(id, content) {
  const dir = paths().diaryBackups
  try {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const file = path.join(dir, `${id}-${stamp}-${Math.random().toString(36).slice(2, 6)}.md`)
    fs.writeFileSync(file, content, 'utf8')
    pruneBackups(dir)
    return file
  } catch {
    return ''
  }
}

function pruneBackups(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const file of files.slice(30)) {
      try { fs.unlinkSync(path.join(dir, file.name)) } catch {}
    }
  } catch {}
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

function ensureFresh(meta, expectedMtime) {
  if (expectedMtime === undefined || expectedMtime === null || expectedMtime === '') return
  const expected = Number(expectedMtime)
  if (!Number.isFinite(expected)) return
  if (meta.exists && Math.abs(meta.mtime - expected) > 1.5) {
    throw new ConsoleError('这本刚被改过（可能是鲸自己又在写）。先刷新再保存，别把新写的那段盖掉。', 409)
  }
  if (!meta.exists && expected > 0) {
    throw new ConsoleError('这本的路径刚变过。先刷新再保存。', 409)
  }
}

function validateBody(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n')
  if (text.length > 60000) throw new ConsoleError('一页最多 6 万字，这一段太长了', 400)
  return text.trim()
}

export function saveEntry(id, index, body, expectedMtime) {
  const cfg = bookConfig(id)
  const file = bookPath(id)
  const meta = statOf(file)
  if (!meta.exists) throw new ConsoleError(`还没有 \`${cfg.file}\`，先补一页`, 404)
  ensureFresh(meta, expectedMtime)
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = parseDiary(raw)
  const pos = Number(index)
  const entry = parsed.entries.find((x) => x.index === pos)
  if (!entry) throw new ConsoleError('找不到这一页，可能刚被改过，刷新看看', 404)

  const text = validateBody(body)
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)
  const prefix = lines.slice(0, entry.bodyStart)
  const suffix = lines.slice(entry.end)
  const bodyLines = text ? text.split('\n') : []
  const next = [...prefix, '', ...bodyLines, '']
  if (suffix.length) {
    // suffix 以下一页的 ## 开头；上面已经补了一个空行
    next.push(...suffix)
  }
  const content = `${next.join(parsed.eol).replace(/\n{3,}$/g, '\n\n').replace(/\s+$/, '')}\n`

  const backupPath = backup(id, raw)
  atomicWrite(file, content)
  const book = readBook(id)
  logAudit({
    op: 'diary-save',
    status: 'ok',
    target: { kind: 'diary', book: id, date: entry.date, index: pos },
    summary: `改日记 ${entry.date}（${cfg.title}）`,
    before: { date: entry.date, label: entry.label, mtime: meta.mtime, text: plainFromMarkdown(entry.body).slice(0, 90) },
    after: { date: entry.date, label: entry.label, mtime: book.mtime, text: plainFromMarkdown(text).slice(0, 90) },
    undo: backupPath ? { kind: 'diary-file', book: id, backupPath, expectMtime: book.mtime, created: false } : null,
  })
  return { ...book, saved: true, backupPath }
}

export function appendEntry(id, { date, label = '', body = '' }, expectedMtime) {
  const cfg = bookConfig(id)
  const file = bookPath(id)
  const meta = statOf(file)
  ensureFresh(meta, expectedMtime)
  const day = String(date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ConsoleError('日期要写成 YYYY-MM-DD')
  const parsedDay = new Date(`${day}T00:00:00`)
  if (Number.isNaN(parsedDay.getTime())) throw new ConsoleError('这个日期不存在')
  const title = String(label || '').trim().slice(0, 40)
  const text = validateBody(body)

  const raw = meta.exists ? fs.readFileSync(file, 'utf8') : cfg.seed
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const head = raw.replace(/\s+$/, '')
  const section = `## ${day}${title ? `（${title}）` : ''}`
  const content = `${head}${head ? `${eol}${eol}` : ''}${section}${eol}${eol}${text}${eol}`

  const backupPath = meta.exists ? backup(id, raw) : ''
  atomicWrite(file, content)
  const book = readBook(id)
  const idx = book.entries.length - 1
  const undo = backupPath
    ? { kind: 'diary-file', book: id, backupPath, expectMtime: book.mtime, created: false }
    : { kind: 'diary-file', book: id, backupPath: '', expectMtime: book.mtime, created: true }
  logAudit({
    op: 'diary-append',
    status: 'ok',
    target: { kind: 'diary', book: id, date: day, index: idx },
    summary: `补日记 ${day}（${cfg.title}）`,
    before: { existed: meta.exists, mtime: meta.mtime },
    after: { mtime: book.mtime, date: day, label: title },
    undo,
  })
  return { ...book, appended: true, backupPath }
}

/** 撤销一次日记写入：把备份盖回去。由 core 的撤销引擎调用。 */
export async function restoreDiaryBackup(recipe) {
  const id = String(recipe.book || '')
  const cfg = bookConfig(id)
  const file = bookPath(id)
  const meta = statOf(file)

  if (meta.exists && recipe.expectMtime !== undefined && Math.abs(meta.mtime - Number(recipe.expectMtime)) > 1.5) {
    throw new ConsoleError('这本日记在撤销前又被改过，不能把旧备份盖上去。先刷新看看。', 409)
  }

  if (recipe.created) {
    if (meta.exists) fs.unlinkSync(file)
    return { ...readBook(id), restored: true, removed: true }
  }

  const backupPath = path.resolve(String(recipe.backupPath || ''))
  const backupRoot = path.resolve(paths().diaryBackups)
  const rel = path.relative(backupRoot, backupPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ConsoleError('备份路径不在日记备份目录里，拒绝恢复', 400)
  }
  let content
  try { content = fs.readFileSync(backupPath, 'utf8') } catch (error) {
    throw new ConsoleError(`读不到备份：${error.message}`, 404)
  }
  if (meta.exists) backup(id, fs.readFileSync(file, 'utf8'))
  atomicWrite(file, content)
  return { ...readBook(id), restored: true }
}

/** 把 markdown 压成一段人话，用于「收进 QQ 记忆」的预填和概览摘要。 */
export function plainFromMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
