const $ = (sel) => document.querySelector(sel)
const KEY_RE = /^(private|group):\d+$/
// 挂在 DSH 下时页面在 /dsh-feiyu-memory/ 前缀里，裸 /api 会打到根路径。
const BASE = location.pathname.replace(/\/[^/]*$/, '')
const apiUrl = (path) => `${BASE}${path}`
const state = { keys: [], key: '', ctx: null, traces: [], older: [], filter: '', timer: null, busy: false }

function toast(text, ms = 2400) {
  const box = $('#toast')
  box.textContent = text
  box.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { box.hidden = true }, ms)
}

async function api(path, init) {
  const res = await fetch(apiUrl(path), {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json', 'x-feiyu-console': '1' } : undefined,
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function fmt(ms, withDate = true) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  const pad = (v) => String(v).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${time}` : time
}

function dayKey(ms) {
  const d = new Date(Number(ms) || 0)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function dayLabel(ms) {
  const d = new Date(Number(ms) || 0)
  const today = new Date()
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, today)) return '今天'
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (same(d, y)) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'style' && v && typeof v === 'object') Object.assign(node.style, v)
    else if (k === 'on') for (const [e, fn] of Object.entries(v)) node.addEventListener(e, fn)
    else if (v !== undefined && v !== null) node.setAttribute(k, v)
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

function stat(label, value) {
  return el('div', { class: 'ctx-stat' }, el('span', { text: label }), el('b', { text: value }))
}

function renderChats() {
  const list = $('#chat-list')
  list.replaceChildren()
  const needle = state.filter.trim().toLowerCase()
  const rows = state.keys.filter((k) => !needle || k.label.toLowerCase().includes(needle) || k.key.includes(needle))
  if (!rows.length) {
    list.append(el('div', { class: 'muted', text: '没有匹配的聊天' }))
    return
  }
  for (const row of rows) {
    list.append(el('button', {
      class: `ctx-chat${row.key === state.key ? ' active' : ''}`,
      on: { click: () => selectKey(row.key) },
    }, el('b', { text: row.label }), el('span', { text: row.key })))
  }
}

async function loadKeys() {
  let rows = []
  try {
    const data = await api('/api/context/keys')
    rows = Array.isArray(data.keys) ? data.keys : []
  } catch {
    const data = await api('/api/overview')
    rows = (Array.isArray(data.scopes) ? data.scopes : []).map((r) => ({ key: r.scope, label: r.label, kind: r.kind }))
  }
  state.keys = rows
    .filter((r) => r && KEY_RE.test(String(r.key)))
    .map((r) => ({ key: String(r.key), label: r.label || r.key, kind: r.kind || '', active: Number(r.active) || 0 }))
  renderChats()
}

async function selectKey(key) {
  if (!KEY_RE.test(key)) return
  state.key = key
  state.older = []
  try { history.replaceState(null, '', `?key=${encodeURIComponent(key)}`) } catch {}
  renderChats()
  await load()
}

async function load(showToast = false) {
  if (!state.key || state.busy) return
  state.busy = true
  $('#refresh').disabled = true
  try {
    const [ctx, traceData] = await Promise.all([
      api(`/api/context?key=${encodeURIComponent(state.key)}`),
      api(`/api/context/traces?key=${encodeURIComponent(state.key)}&limit=20`).catch(() => ({ traces: [] })),
    ])
    state.ctx = ctx
    state.traces = Array.isArray(traceData.traces) ? traceData.traces : []
    renderHeader()
    renderStats()
    renderBudget()
    renderTraces()
    renderSummaries()
    renderMessages()
    if (showToast) toast('已刷新')
  } catch (error) {
    toast(error.message)
  } finally {
    state.busy = false
    $('#refresh').disabled = false
  }
}

function renderTraces() {
  const box = $('#traces')
  if (!box) return
  const traces = Array.isArray(state.traces) ? state.traces : []
  if (!traces.length) {
    box.replaceChildren(el('div', { class: 'muted small', text: '还没有记录。聊一轮后，这里会显示这轮检索到了什么、哪些真的进了提示词。' }))
    return
  }
  const replyText = {partial:'部分发送',queued:'等待模型',running:'处理中',sent:'已发送', 'send-failed':'发送失败',failed:'失败',error:'模型出错',aborted:'已中止','no-reply':'本轮未发送',unknown:'绑定不确定',command:'命令结束'}
  const reasonText = {'not-needed':'本轮无需记忆',disabled:'召回已关闭', ok: '正常', 'no-query': '本轮没有检索查询', 'no-memory': '没有召回记忆', error: '检索失败' }
  box.replaceChildren(...traces.slice().reverse().map((t) => {
    const injected = new Set((t.injected || []).map((r) => r.id))
    const candidates = Array.isArray(t.candidates) ? t.candidates : []
    const rows = candidates.map((r) => el('div', {
      class: 'muted small',
      style: { padding: '4px 0', borderTop: '1px solid var(--line)', opacity: injected.has(r.id) ? 1 : .55 },
    },
    el('b', { text: injected.has(r.id) ? '注入' : '候选' }),
    ' ',
    el('span', { text: `[${r.scope || '?'}] ${String(r.text || '').slice(0, 100)}` }),
    el('span', { text: ` · ${r.kind || 'search'} · 主体 ${r.subjectId || '未知'} · ${(r.reasons || []).join(' / ')}` }),
    t.traceId ? el('button', {class:'btn ghost', text:'本轮不相关', on:{click:async(event)=>{
      const button=event.currentTarget;button.disabled=true
      try { await api('/api/action',{method:'POST',body:JSON.stringify({op:'irrelevant',id:r.id,scope:r.scope,key:t.key,traceId:t.traceId})});toast('已记录本轮反馈，记忆保持原样') }
      catch(error) {toast(error.message)} finally {button.disabled=false}
    }}}) : null,
    ))
    return el('details', { style: { padding: '6px 0', borderTop: '1px solid var(--line)' } },
      el('summary', { style: { cursor: 'pointer' } },
        el('b', { text: fmt(t.at, false) }),
        el('span', { text: ` · ${reasonText[t.reason] || t.reason || '记录'} · 注入 ${(t.injected || []).length} / 候选 ${candidates.length} · ${Number(t.durationMs || 0)}ms` }),
      ),
      el('div', { style: { marginTop: '6px' } },
        el('div', { class: 'muted small', text: `回复：${replyText[t.reply?.status] || (t.reply?.ok ? '已发送' : '暂无绑定记录')} · ${Number(t.reply?.sent || 0)} 条 · 回合 ${t.reply?.turnId || '—'}` }),
        el('div', { class: 'muted small', text: '查询：' + String(t.query || '（空）') }),
        rows.length ? el('div', { style: { marginTop: '6px' } }, rows) : el('div', { class: 'muted small', text: '没有候选记录' }),
      ),
    )
  }))
}

function renderHeader() {
  const row = state.keys.find((k) => k.key === state.key)
  $('#chat-title').textContent = row?.label || state.key
  $('#chat-key').textContent = state.key
}

function renderStats() {
  const stats = state.ctx?.stats || {}
  $('#stat-row').replaceChildren(
    stat('原文条数', String(stats.messages ?? 0)),
    stat('摘要条数', String(stats.summaries ?? 0)),
    stat('最近一条', fmt(stats.last_at)),
    stat('最近摘要', fmt(stats.last_summary_end)),
  )
}

function bar(label, used, budget, note) {
  const ratio = budget > 0 ? Math.min(1, used / budget) : 0
  const fill = el('i')
  fill.style.width = `${Math.round(ratio * 100)}%`
  if (ratio >= 0.9) fill.className = 'warn'
  return el('div', { class: 'ctx-budget-row' },
    el('span', { text: label }),
    el('div', { class: 'ctx-bar' }, fill),
    el('span', { class: 'muted', text: note }))
}

function renderBudget() {
  const config = state.ctx?.config || {}
  const messagesChars = Number(config.messagesChars) || 6000
  const summaryChars = Number(config.summaryChars) || 2000
  const rotateTurns = Number(config.rotateTurns) || 40
  const keep = Number(config.rotateKeepMessages) || 12
  const messages = state.ctx?.messages || []
  const summaries = state.ctx?.summaries || []
  const usedMsg = messages.reduce((n, m) => n + String(m.text || '').length, 0)
  const usedSum = summaries.reduce((n, s) => n + String(s.text || '').length, 0)
  $('#budget-note').textContent = `轮换 ${rotateTurns} 轮 · 留 ${keep} 条尾巴`
  $('#budget').replaceChildren(
    bar('原文预算', usedMsg, messagesChars, `${messages.length} 条 · ${usedMsg}/${messagesChars} 字符`),
    bar('摘要预算', usedSum, summaryChars, `${summaries.length} 条 · ${usedSum}/${summaryChars} 字符`),
  )
}

function chip(text, tone = false) {
  return el('span', { class: `ctx-chip${tone ? ' tone' : ''}`, text })
}

function renderSummaries() {
  const box = $('#summaries')
  box.replaceChildren()
  const rows = state.ctx?.summaries || []
  $('#summary-meta').textContent = rows.length ? `共 ${rows.length} 条` : ''
  if (!rows.length) {
    box.append(el('div', { class: 'ctx-empty', text: '还没有摘要。会话达到轮换条件时会自动生成；也可以点右上角「生成摘要」手动补一次。' }))
    return
  }
  for (const row of rows) {
    let meta = {}
    try { meta = row.structured ? JSON.parse(row.structured) : {} } catch {}
    const chips = el('div', { class: 'ctx-chips' })
    for (const topic of Array.isArray(meta.topics) ? meta.topics.slice(0, 5) : []) chips.append(chip(`# ${topic}`))
    for (const loop of Array.isArray(meta.open_loops) ? meta.open_loops.slice(0, 3) : []) chips.append(chip(`没接完：${loop}`))
    for (const fact of Array.isArray(meta.facts) ? meta.facts.slice(0, 3) : []) chips.append(chip(`事实：${fact}`))
    if (meta.tone) chips.append(chip(`基调：${meta.tone}`, true))
    const del = el('button', { class: 'btn ghost', text: '删除' })
    del.onclick = async () => {
      if (!confirm('删除这条摘要？原文还在，不会丢消息。')) return
      try {
        await api('/api/context/summary/delete', { method: 'POST', body: JSON.stringify({ key: state.key, id: row.id }) })
        toast('已删除')
        await load()
      } catch (error) { toast(error.message) }
    }
    const kind = row.kind || 'summary'
    const value = row.value === undefined ? 1 : Number(row.value)
    let badge = null
    if (kind === 'coverage') badge = el('span', { class: 'ctx-chip', text: '仅覆盖（未调模型）' })
    else if (kind === 'low' || value < 0.5) badge = el('span', { class: 'ctx-chip', text: '低信息量（不进 prompt）' })
    box.append(el('div', { class: `ctx-summary${value < 0.5 ? ' dim' : ''}` },
      el('div', { class: 'ctx-summary-top' }, el('div', {}, el('time', { text: `${fmt(row.period_start)} → ${fmt(row.period_end)}` }), badge), del),
      el('p', { text: row.text || '（空摘要）' }),
      chips.childNodes.length ? chips : null))
  }
}

function currentMessages() {
  const seen = new Set()
  const rows = []
  for (const m of [...state.older, ...(state.ctx?.messages || [])]) {
    const id = m.id || `${m.at}:${m.text}`
    if (seen.has(id)) continue
    seen.add(id)
    rows.push(m)
  }
  rows.sort((a, b) => Number(a.at) - Number(b.at))
  return rows
}

function renderMessages() {
  const box = $('#messages')
  box.replaceChildren()
  const rows = currentMessages()
  $('#message-meta').textContent = rows.length ? `显示 ${rows.length} 条` : ''
  if (!rows.length) {
    box.append(el('div', { class: 'ctx-empty', text: '这个聊天还没有原文。桥接收到下一条 QQ 消息后，会写进 memvec。' }))
    $('#more').hidden = true
    return
  }
  let day = ''
  for (const row of rows) {
    const key = dayKey(row.at)
    if (key !== day) {
      day = key
      box.append(el('div', { class: 'ctx-day', text: dayLabel(row.at) }))
    }
    const self = row.is_self === 1 || row.is_self === true
    const who = self ? '我' : (row.sender || '某人')
    box.append(el('div', { class: `ctx-msg${self ? ' self' : ''}` },
      el('div', { class: 'ctx-ava', text: String(who).slice(0, 1) }),
      el('div', { class: 'ctx-bubble' },
        el('div', { class: 'ctx-meta' }, el('span', { text: who }), el('span', { text: fmt(row.at, false) })),
        el('div', { class: 'ctx-text', text: row.text || '' }))))
  }
  $('#more').hidden = rows.length < 30
}

async function loadMore() {
  const rows = currentMessages()
  if (!rows.length) return
  const beforeAt = Number(rows[0].at)
  $('#more').disabled = true
  try {
    const data = await api(`/api/context/messages?key=${encodeURIComponent(state.key)}&limit=50&beforeAt=${beforeAt}`)
    const older = (data.messages || []).filter((m) => Number(m.at) < beforeAt)
    if (!older.length) { toast('没有更早的原文了'); $('#more').hidden = true; return }
    state.older = [...older, ...state.older]
    renderMessages()
    renderBudget()
  } catch (error) {
    toast(error.message)
  } finally {
    $('#more').disabled = false
  }
}

async function summarize() {
  if (!state.key) return
  const btn = $('#summarize')
  btn.disabled = true
  const original = btn.textContent
  btn.textContent = '生成中…'
  try {
    const data = await api('/api/context/summarize', { method: 'POST', body: JSON.stringify({ key: state.key }) })
    const result = data.result || {}
    toast(result.ok ? `摘要完成：${result.messages || 0} 条` : `没有生成：${result.error || result.reason || '未知原因'}`)
    await load()
  } catch (error) {
    toast(error.message)
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
}

function startAuto() {
  if (state.timer) clearInterval(state.timer)
  state.timer = setInterval(() => {
    if ($('#auto').checked && document.visibilityState === 'visible') load()
  }, 15000)
}

async function init() {
  try {
    await loadKeys()
  } catch (error) {
    toast(`读不到聊天列表：${error.message}`)
  }
  const fromQuery = new URLSearchParams(location.search).get('key')
  const fromList = state.keys[0]?.key
  state.key = KEY_RE.test(fromQuery || '') ? fromQuery : (fromList || '')
  renderChats()
  if (!state.key) {
    $('#stat-row').replaceChildren()
    $('#budget-card').hidden = true
    $('#messages').append(el('div', { class: 'ctx-empty', text: '还没有可看的聊天。先在 QQ 里聊几句，或从左边选一个。' }))
    return
  }
  $('#budget-card').hidden = false
  await load()
  startAuto()
}

$('#filter').addEventListener('input', (e) => { state.filter = e.target.value; renderChats() })
$('#refresh').onclick = () => load(true)
$('#summarize').onclick = summarize
$('#more').onclick = loadMore
$('#auto').onchange = startAuto
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load() })

init().catch((error) => toast(error.message))
