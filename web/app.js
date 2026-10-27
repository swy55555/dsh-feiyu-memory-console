// 可塑性记忆 · 控制台前端
//
// 没有框架，没有构建。一个文件，读三个本地数据源。
// 所有来自记忆正文的文本一律走 textContent / createTextNode，不拼 innerHTML。

const BASE = location.pathname
  .replace(/\/index\.html$/, '')
  .replace(/\/+$/, '')
const API = (p) => `${BASE}/api${p}`
const MEMVEC = '127.0.0.1:9881'

// ---------------------------------------------------------------- 小工具

const $ = (sel, root = document) => root.querySelector(sel)

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'html') node.innerHTML = value
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value)
    else if (key === 'on' && typeof value === 'object') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler)
    } else if (key === 'attrs' && typeof value === 'object') {
      for (const [attr, v] of Object.entries(value)) if (v !== undefined && v !== null) node.setAttribute(attr, String(v))
    } else if (key in node) node[key] = value
    else node.setAttribute(key, String(value))
  }
  append(node, kids)
  return node
}

function append(node, kids) {
  for (const kid of kids) {
    if (kid === undefined || kid === null || kid === false) continue
    if (Array.isArray(kid)) append(node, kid)
    else if (kid instanceof Node) node.appendChild(kid)
    else node.appendChild(document.createTextNode(String(kid)))
  }
}

function frag(...kids) {
  const f = document.createDocumentFragment()
  append(f, kids)
  return f
}

const pad = (n) => String(n).padStart(2, '0')

function fmtWhen(ms) {
  if (!ms) return '没记时间'
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return '没记时间'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（未来）`
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const now = new Date()
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dateKey(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtDate(ms) {
  if (!ms) return '—'
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function clamp01(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ---------------------------------------------------------------- 图标

const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.2 4.2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.6-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.6L20 16"/><path d="M20 20v-4h-4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.2 4.2L19 7"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8Z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4"/><path d="M6 5h11l-2.2 4L17 13H6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 6.5 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7"/><path d="M10 11v5M14 11v5"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8v5h5"/><path d="M5.5 13A7.5 7.5 0 1 0 7 6.5L4 9"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5H5V6h5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
  whale: '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M7 37.5c0-1.6 1.2-2.9 2.8-2.9 2.6 0 4.7-1.4 6.3-3.7C20 24.5 25 20.5 32 20.5c8.7 0 15.2 5.2 17.7 12.9l6.2-5.1c1.2-1 2.8-.1 2.6 1.4l-1.3 9.1c-.4 2.6-2.3 4.6-4.9 5.2-8.3 1.9-17.3.4-24.3-4.4-3.4-2.3-6.1-5.4-7.9-9.1-1.9 1.4-4.1 2.2-6.5 2.2-2 0-3.6-1.6-3.6-3.6Z"/><circle cx="38.5" cy="27.5" r="1.7" fill="var(--bg, #07141b)"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55" d="M14 50c6 5 20 6 30 0"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v18H6.5A2.5 2.5 0 0 1 4 18.5v-13Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v18h4.5A2.5 2.5 0 0 0 20 18.5v-13Z"/></svg>',
  wave: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 34c7-8 14-8 21 0s14 8 21 0 10-8 10-8"/><path d="M6 46c7-8 14-8 21 0s14 8 21 0 10-8 10-8"/></svg>',
}

const icon = (name) => el('span', { html: ICONS[name] || '', style: { display: 'flex' } })
const mark = () => el('div', { class: 'mark', html: ICONS.whale.replace('<svg ', '<svg width="46" height="46" ') })

// ---------------------------------------------------------------- 状态

const S = {
  tab: 'overview',
  overview: null,
  loading: 0,
  labels: {},
  capabilities: null,
  bridgeCaps: null,
  library: {
    scope: 'all',
    status: 'active',
    tier: 'all',
    q: '',
    sort: 'recent',
    rows: [],
    total: 0,
    counts: {},
    scopes: [],
    loaded: false,
    seq: 0,
    focusId: '',
    diaryDates: {},
  },
  semantic: null,
  semanticQuery: '',
  light: { scopes: null, key: '', data: null, seq: 0 },
  diary: { books: null, book: 'public', index: -1, showIntro: false, dates: {}, days: {}, wantDate: '', seq: 0, token: '', autoImport: false },
  upkeep: { queue: null, preview: null },
  persona: null,
  personaLoading: false,
  personaAvailable: null,
  personaEdit: null,
  emotion: null,
  emotionEpisodes: null,
  emotionLoading: false,
  emotionTimer: 0,
  chatProfiles: null,
  chatScope: '',
  graph: {
    data: null, loading: false, running: false, raf: 0, timer: 0,
    nodes: [], links: [], positions: new Map(), flashes: new Map(),
    hover: null, canvas: null, ctx: null, w: 0, h: 0, alpha: 0, dpr: 1,
    scale: 1, tx: 0, ty: 0, dragging: false, dragX: 0, dragY: 0, filter: 'all', scope: 'all', paused: false,
    etag: null, total: 0, loadingMore: false,
  },
  theme: localStorage.getItem('feiyu-theme') || 'dark',
}

let mainEl = null
let libRefs = null
let searchTimer = null
let tipSeq = 0

// ---------------------------------------------------------------- 网络

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${API(path)}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' ? { 'x-feiyu-console': '1' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = {}
  try { data = await res.json() } catch {}
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function setLoading(delta) {
  S.loading = Math.max(0, S.loading + delta)
  let bar = $('#loading-bar')
  if (S.loading > 0 && !bar) {
    bar = el('div', { id: 'loading-bar', class: 'loading-bar' })
    document.body.appendChild(bar)
  } else if (S.loading === 0 && bar) {
    bar.remove()
  }
}

async function withBusy(fn) {
  setLoading(1)
  try { return await fn() } finally { setLoading(-1) }
}

// ---------------------------------------------------------------- 提示

function toast(message, kind = '') {
  const box = $('#toasts')
  const node = el('div', { class: `toast ${kind}`, text: message })
  box.appendChild(node)
  setTimeout(() => node.remove(), kind === 'error' ? 5200 : 3200)
}

// ---------------------------------------------------------------- 弹窗

function openModal({ title, desc, fields = [], submit = '保存', danger = false, cancel = '取消', footerLeft = null }) {
  return new Promise((resolve) => {
    const root = $('#modal-root')
    root.innerHTML = ''
    const backdrop = el('div', { class: 'modal-backdrop' })
    const form = el('form', { class: 'modal', novalidate: true })
    const errorLine = el('div', { class: 'field error', style: { display: 'none', margin: '0 0 8px' } })

    form.appendChild(el('h3', { text: title }))
    if (desc) form.appendChild(el('p', { class: 'desc', text: desc }))

    const controls = new Map()

    for (const field of fields) {
      const id = `f-${Math.random().toString(36).slice(2)}`
      const wrap = el('div', { class: 'field' })
      if (field.type !== 'hidden') {
        wrap.appendChild(el('label', { for: id, text: field.label || field.name }))
      }
      let control
      if (field.type === 'textarea') {
        control = el('textarea', {
          id, class: 'textarea', value: field.value ?? '', placeholder: field.placeholder || '',
          rows: field.rows || 4, maxlength: field.maxlength || 2000, name: field.name,
        })
      } else if (field.type === 'select') {
        control = el('select', { id, class: 'select', name: field.name })
        for (const opt of field.options || []) {
          control.appendChild(el('option', { value: opt.value, text: opt.label }))
        }
        control.value = field.value ?? (field.options || [])[0]?.value ?? ''
      } else if (field.type === 'range') {
        const out = el('span', { class: 'num', text: String(field.value ?? 0.7) })
        control = el('input', {
          id, class: 'input', type: 'range', name: field.name,
          min: field.min ?? 0, max: field.max ?? 1, step: field.step ?? 0.05,
          value: field.value ?? 0.7,
          on: { input: () => { out.textContent = Number(control.value).toFixed(2) } },
        })
        wrap.appendChild(el('div', { class: 'row', style: { marginTop: '6px' } }, control, out))
        control = control
        controls.set(field.name, () => Number(control.value))
        form.appendChild(wrap)
        wrap.dataset.range = '1'
        continue
      } else {
        control = el('input', {
          id, class: 'input', type: field.type || 'text', name: field.name,
          value: field.value ?? '', placeholder: field.placeholder || '',
          minlength: field.minlength, maxlength: field.maxlength || 2000,
          autocomplete: 'off',
        })
      }
      control.name = field.name
      controls.set(field.name, () => control.value)
      wrap.appendChild(control)
      if (field.help) wrap.appendChild(el('div', { class: 'help', text: field.help }))
      form.appendChild(wrap)
    }

    form.appendChild(errorLine)

    const actions = el('div', { class: 'modal-actions' })
    if (footerLeft) actions.appendChild(el('div', { class: 'left' }, footerLeft))
    const cancelBtn = el('button', { class: 'btn ghost', type: 'button', text: cancel })
    const submitBtn = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'submit', text: submit })
    actions.append(cancelBtn, submitBtn)
    form.appendChild(actions)

    const close = (value) => {
      document.removeEventListener('keydown', onKey)
      backdrop.remove()
      resolve(value)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(null) }
    }
    document.addEventListener('keydown', onKey)
    cancelBtn.addEventListener('click', () => close(null))
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(null) })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const values = {}
      for (const field of fields) {
        const read = controls.get(field.name)
        let value = read ? read() : ''
        if (typeof value === 'string') value = value.trim()
        if (field.required && (value === '' || value === null)) {
          errorLine.textContent = `「${field.label || field.name}」还没填`
          errorLine.style.display = 'block'
          return
        }
        values[field.name] = value
      }
      close(values)
    })

    backdrop.appendChild(form)
    root.appendChild(backdrop)
    setTimeout(() => {
      const first = form.querySelector('input:not([type=range]), textarea, select')
      first?.focus()
    }, 30)
  })
}

async function confirmDialog({ title, desc, ok = '确定', danger = false }) {
  const result = await openModal({ title, desc, submit: ok, danger, fields: [] })
  return result !== null
}

async function promptText({ title, desc, label = '内容', value = '', placeholder = '', multiline = false, maxlength = 500, submit = '保存' }) {
  const result = await openModal({
    title, desc, submit,
    fields: [{ name: 'text', label, type: multiline ? 'textarea' : 'text', value, placeholder, maxlength, required: true }],
  })
  return result ? result.text : null
}

// ---------------------------------------------------------------- 外壳

function applyTheme() {
  document.documentElement.dataset.theme = S.theme
  localStorage.setItem('feiyu-theme', S.theme)
}

function mountShell() {
  const app = $('#app')
  app.innerHTML = ''
  app.appendChild(buildTopbar())
  app.appendChild(buildTabs())
  mainEl = el('main', { id: 'view' })
  app.appendChild(mainEl)
}

function buildTopbar() {
  const health = el('div', { class: 'health', id: 'health' })
  const themeBtn = el('button', {
    class: 'icon-btn', title: '换个明暗', 'aria-label': '换个明暗',
    html: S.theme === 'dark'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8.2 8.2 0 1 0 20 14.5Z"/></svg>',
    on: { click: () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; applyTheme(); mountShell(); route(true) } },
  })

  return el('header', { class: 'topbar' },
    el('div', { class: 'brand' }, mark(),
      el('div', null,
        el('h1', { text: '可塑性记忆' }),
        el('p', { text: '她记得的，都在这里。' }),
      ),
    ),
    health,
    el('div', { class: 'top-actions' },
      el('button', { class: 'btn', title: '重新读一遍', on: { click: () => refreshAll() } }, icon('refresh'), '刷新'),
      el('button', { class: 'btn primary', on: { click: () => openAdd('') } }, icon('plus'), '记一条'),
      themeBtn,
    ),
  )
}

function buildTabs() {
  const tabs = [
    { id: 'overview', label: '总览' },
    { id: 'graph', label: '记忆图', count: S.graph.data?.count },
    { id: 'persona', label: '性格', count: S.persona?.pending },
    { id: 'emotion', label: '情绪' },
    { id: 'library', label: '长期记忆', count: S.overview?.active },
    { id: 'light', label: '轻量记忆', count: S.overview?.light?.total },
    { id: 'diary', label: '日记', count: S.overview?.diary?.count },
    { id: 'upkeep', label: '整理', count: S.overview?.queue?.total },
  ]
  const bar = el('nav', { class: 'tabs', 'aria-label': '分区' })
  for (const tab of tabs) {
    if (tab.id === 'persona' && S.personaAvailable === false) continue
    bar.appendChild(el('button', {
      class: `tab ${S.tab === tab.id ? 'active' : ''}`,
      dataset: { tab: tab.id },
      on: { click: () => go(tab.id) },
    }, tab.label, (tab.id === 'overview' || tab.id === 'emotion') ? null : el('span', { class: 'n', text: tab.count == null ? '…' : String(tab.count) })))
  }
  return bar
}

function libraryTabCount() {
  if (S.tab !== 'library') return S.overview?.active
  if (S.semantic) return S.semantic.length
  return S.library.loaded ? S.library.total : S.overview?.active
}

function hasCap(name) {
  return !S.capabilities || S.capabilities.has(name)
}

function hasBridgeCap(name) {
  return !S.bridgeCaps || S.bridgeCaps.size === 0 || S.bridgeCaps.has(name)
}

function updateTabs() {
  const bar = $('.tabs')
  if (!bar) return
  const counts = { overview: null, graph: S.graph.data?.count ?? null, persona: S.persona?.pending ?? null, library: libraryTabCount(), light: S.overview?.light?.total, diary: S.overview?.diary?.count, upkeep: S.overview?.queue?.total }
  for (const btn of bar.querySelectorAll('.tab')) {
    const id = btn.dataset.tab
    const active = id === S.tab
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-current', active ? 'page' : 'false')
    if ((id === 'persona' && !hasCap('persona')) || (id === 'emotion' && (!hasCap('emotion') || !hasBridgeCap('emotion'))) || (id === 'graph' && !hasCap('graph'))) btn.style.display = 'none'
    const n = btn.querySelector('.n')
    if (n && counts[id] !== undefined && counts[id] !== null) n.textContent = String(counts[id])
  }
}

function tabActive(id) {
  return S.tab === id
}

function updateHealth() {
  const box = $('#health')
  if (!box) return
  box.replaceChildren()
  const h = S.overview?.health
  if (!h) return
  const dot = (ok, label, title, warn = false) => el('span', { class: `dot ${ok ? (warn ? 'warn' : 'ok') : 'bad'}`, title: title || '' , text: label })
  box.appendChild(dot(!!h.memvec?.ok, '记忆库', h.memvec?.ok ? `127.0.0.1:9881 · ${h.memvec.total} 条` : h.memvec?.error))
  box.appendChild(dot(!!h.bridge?.ok, '桥接', h.bridge?.ok ? `${h.bridge.role || '大肥鱼'} · ${h.bridge.mode || ''}` : h.bridge?.error))
  if (h.bridge?.snowluma) {
    box.appendChild(dot(!!h.bridge.snowluma.good, 'QQ', h.bridge.snowluma.good ? 'SnowLuma 心跳正常' : (h.bridge.snowluma.hint || '心跳不正常')))
  }
}

// ---------------------------------------------------------------- 路由

function go(tab, { replace = false } = {}) {
  const target = `#/${tab}`
  if (replace) history.replaceState(null, '', target)
  else if (location.hash !== target) { location.hash = target; return }
  route(true)
}

function route(force = false) {
  const raw = location.hash.replace(/^#\/?/, '') || 'overview'
  const [tab, query] = raw.split('?')
  const params = new URLSearchParams(query || '')
  if (tab === 'library' && params.get('scope')) {
    S.library.scope = params.get('scope')
    S.library.status = params.get('status') || S.library.status
  }
  if (tab === 'light' && params.get('key')) S.light.key = params.get('key')
  if (tab === 'diary') {
    if (params.get('book') === 'private' || params.get('book') === 'public') S.diary.book = params.get('book')
    if (params.get('date')) { S.diary.wantDate = params.get('date'); S.diary.showIntro = false }
  }
  if (!['overview', 'graph', 'persona', 'emotion', 'library', 'light', 'diary', 'upkeep'].includes(tab)) { go('overview', { replace: true }); return }
  if (tab !== S.tab || force) {
    const changed = tab !== S.tab
    S.tab = tab
    updateTabs()
    paintCurrent()
    if (changed) window.scrollTo({ top: 0, behavior: 'auto' })
  }
  updateTabs()
}

function paintCurrent() {
  if (!mainEl) return
  if (S.tab !== 'graph') stopGraphLoop()
  if (S.tab !== 'emotion' && S.emotionTimer) { clearInterval(S.emotionTimer); S.emotionTimer = 0 }
  mainEl.replaceChildren()
  const missing = S.capabilities ? ['queue-limit', 'persona', 'emotion', 'graph'].filter((cap) => !S.capabilities.has(cap)) : []
  if (missing.length) {
    mainEl.appendChild(el('div', {
      class: 'note',
      style: { margin: '0 0 14px', padding: '10px 14px', border: '1px solid var(--line-strong)', borderRadius: '10px' },
      text: '插件后端还是旧版本：重启一次 DSH 后，「额度保存 / 性格页 / 情绪页 / 记忆图」才会出现。页面本身已经是最新的。',
    }))
  }
  const bridgeMissing = S.bridgeCaps && S.bridgeCaps.size
    ? ['persona-chat', 'diary-vault', 'emotion', 'queue-limit'].filter((cap) => !S.bridgeCaps.has(cap))
    : []
  if (bridgeMissing.length) {
    mainEl.appendChild(el('div', {
      class: 'note',
      style: { margin: '0 0 14px', padding: '10px 14px', border: '1px solid var(--line-strong)', borderRadius: '10px' },
      text: `桥接版本偏旧：${bridgeMissing.join(' / ')} 这些功能可能不可用。升级桥接后刷新即可；不影响看已同步的记忆。`,
    }))
  }
  if (S.tab === 'overview') mainEl.appendChild(renderOverview())
  else if (S.tab === 'graph') { mainEl.appendChild(renderGraphTab()); startGraphLoop() }
  else if (S.tab === 'persona') { mainEl.appendChild(renderPersona()); if (!S.persona && !S.personaLoading) void loadPersona(); if (S.chatProfiles === null) void loadChatProfiles() }
  else if (S.tab === 'emotion') { mainEl.appendChild(renderEmotion()); if (!S.emotion && !S.emotionLoading) void loadEmotion() }
  else if (S.tab === 'library') mainEl.appendChild(renderLibrary())
  else if (S.tab === 'light') mainEl.appendChild(renderLight())
  else if (S.tab === 'diary') mainEl.appendChild(renderDiary())
  else mainEl.appendChild(renderUpkeep())
  updateTabs()
  updateHealth()
}

// ---------------------------------------------------------------- 数据刷新

async function refreshOverview({ paint = true } = {}) {
  const data = await withBusy(() => api('/overview'))
  S.overview = data
  S.labels = data.labels || {}
  S.capabilities = new Set(Array.isArray(data.health?.capabilities) ? data.health.capabilities : [])
  S.bridgeCaps = new Set(Array.isArray(data.health?.bridge?.capabilities) ? data.health.bridge.capabilities : [])
  updateHealth()
  updateTabs()
  if (paint && S.tab === 'overview') {
    const y = window.scrollY
    mainEl.replaceChildren(renderOverview())
    window.scrollTo({ top: y })
  }
}

async function refreshAll() {
  try {
    await refreshOverview({ paint: false })
    if (S.tab === 'library') { S.library.loaded = false; await loadLibrary() }
    else if (S.tab === 'persona') { S.persona = null; await loadPersona() }
    else if (S.tab === 'light') { S.light.scopes = null; await loadLightScopes(true) }
    else if (S.tab === 'diary') { S.diary.books = null; S.diary.loaded = false; S.diary.days = {}; paintCurrent() }
    else if (S.tab === 'upkeep') { S.upkeep.preview = null; S.upkeep.queue = null; paintCurrent() }
    paintCurrent()
    toast('已经读到最新的了', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function afterChange() {
  try {
    await refreshOverview({ paint: false })
    if (S.tab === 'library') await loadLibrary()
    else if (S.tab === 'light' && S.light.key) await loadLight(S.light.key)
    else if (S.tab === 'diary') { S.diary.days = {}; S.diary.books = null; S.diary.loaded = false; paintCurrent() }
    else if (S.tab === 'upkeep') { S.upkeep.preview = null; paintCurrent() }
    if (S.tab === 'overview') paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

// ---------------------------------------------------------------- 总览

function statCard(n, k, s, cls = '') {
  return el('div', { class: `stat ${cls}` },
    el('div', { class: 'n', text: String(n ?? 0) }),
    el('div', { class: 'k', text: k }),
    s ? el('div', { class: 's', text: s }) : null,
  )
}

function scopeBars(byStatus, total) {
  const order = ['active', 'candidate', 'superseded', 'deleted', 'archived', 'completed']
  const bar = el('div', { class: 'bar' })
  if (!total) return bar
  for (const status of order) {
    const n = Number(byStatus[status] || 0)
    if (!n) continue
    bar.appendChild(el('i', { class: `b-${status}`, style: { width: `${(n / total) * 100}%` }, title: `${statusLabel(status)} ${n}` }))
  }
  return bar
}

function statusLabel(status) {
  return { active: '活着', candidate: '待确认', superseded: '被取代', deleted: '已删', archived: '已归档', completed: '已完成' }[status] || status
}

function tierLabel(tier) {
  return { core: '核心', task: '待办', normal: '普通' }[tier] || tier
}

function renderOverview() {
  const o = S.overview
  if (!o) return el('div', { class: 'empty', text: '还没读到数据…' })

  const heroText = o.candidate > 0
    ? frag('她记得 ', el('em', { text: String(o.active) }), ' 件事，还有 ', el('em', { text: String(o.candidate) }), ' 件拿不准，等你点个头。')
    : frag('她记得 ', el('em', { text: String(o.active) }), ' 件事，都还清清楚楚。')

  const hero = el('section', { class: 'hero' },
    el('div', { class: 'kicker', text: 'memory console' }),
    el('h2', null, heroText),
    el('p', { text: '这条鱼会淡忘 —— 不常被想起来的，会慢慢沉下去。这里能看见哪些还浮着、哪些快沉了，也能亲手把重要的那条捞回来。' }),
  )

  const stats = el('section', { class: 'stats' },
    statCard(o.active, '还活着', `一共 ${o.total} 条记录`, 'accent'),
    statCard(o.candidate, '等你确认', o.candidate ? '拿不准的会先搁着' : '没有悬着的事', o.candidate ? 'amber' : ''),
    statCard(o.fadingCount ?? 0, '正在淡出', '鲜活度低于 35%', (o.fadingCount ?? 0) ? 'rose' : ''),
    statCard((o.core || 0) + (o.task || 0), '核心与待办', `${o.core || 0} 核心 · ${o.task || 0} 待办`, 'green'),
  )

  const scopeCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '记忆放在哪儿' }), el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: '点一下就能翻那一格' })),
    o.scopes.length
      ? el('div', { class: 'scope-list' }, o.scopes.map((s) => el('div', {
          class: 'scope-line',
          role: 'button',
          tabindex: '0',
          on: { click: () => { S.library.scope = s.scope; S.library.status = 'active'; S.library.loaded = false; go('library') }, keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.library.scope = s.scope; S.library.loaded = false; go('library') } } },
        },
        el('div', null,
          el('div', { class: 'name', text: s.label }),
          el('div', { class: 'meta', text: `${s.active || 0} 条活着${s.candidate ? ` · ${s.candidate} 条待确认` : ''}` }),
        ),
        el('div', { class: 'count', text: String(s.total) }),
        scopeBars(s.byStatus, s.total),
      )))
      : el('div', { class: 'empty', text: '记忆库还是空的。' }),
  )

  const recentCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '最近记下的' }), el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: '最新的六条' })),
    o.recent.length
      ? el('div', { class: 'mini-list' }, o.recent.map((r) => el('div', {
          class: 'mini',
          role: 'button',
          tabindex: '0',
          on: { click: () => focusMemory(r), keydown: (e) => { if (e.key === 'Enter') focusMemory(r) } },
        },
        el('span', { class: 'd', text: fmtWhen(r.createdAt) }),
        el('span', { class: 't', text: r.text }),
        el('span', { class: 'r', text: `${Math.round((r.recall || 0) * 100)}%` }),
      )))
      : el('div', { class: 'empty', text: '还没有记下什么。' }),
  )

  const fadingCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '快要淡忘的' }), el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: '不常被想起的那些' })),
    o.fading.length
      ? el('div', { class: 'mini-list' }, o.fading.map((r) => el('div', {
          class: 'mini',
          role: 'button',
          tabindex: '0',
          on: { click: () => focusMemory(r), keydown: (e) => { if (e.key === 'Enter') focusMemory(r) } },
        },
        el('span', { class: 'd', text: fmtWhen(r.lastAccess) }),
        el('span', { class: 't', text: r.text }),
        el('span', { class: 'r', text: `${Math.round((r.recall || 0) * 100)}%` }),
      )))
      : el('div', { class: 'empty' }, el('div', { html: ICONS.wave }), '都还鲜活着，没有快沉的。'),
  )

  const qMax = Number(o.queue?.maxCalls ?? 40)
  const qCalls = Number(o.queue?.okCalls ?? o.queue?.calls ?? 0)
  const qCapped = qMax > 0 && qCalls >= qMax
  const queueCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '还没整理的聊天' })),
    el('div', { class: 'row', style: { gap: '18px' } },
      el('div', null, el('div', { class: 'stat-n', style: { font: '500 24px/1.2 var(--serif)', color: 'var(--amber)' }, text: String(o.queue?.total ?? 0) }), el('div', { class: 'muted small', text: '条消息排队等着被提炼' })),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm', on: { click: () => go('upkeep') } }, '去整理', icon('chevron')),
    ),
    qCapped
      ? el('p', { class: 'note', style: { marginBottom: 0 } }, '今天已经用满 ', el('b', { text: `${qCalls}/${qMax}` }), ' 批提炼额度，明天才会继续。')
      : el('p', { class: 'note', style: { marginBottom: 0 } }, qMax > 0 ? `今天已提炼 ${qCalls}/${qMax} 批；桥接每隔一会儿会挑一个聊天静悄悄整理。` : `今天已提炼 ${qCalls} 批，不限次数；桥接每隔一会儿会挑一个聊天整理。`),
  )

  const diaryCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '最近写的一页' }), el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: o.diary?.count ? `共 ${o.diary.count} 页` : '' })),
    o.diary?.latest
      ? el('div', { class: 'diary-mini', role: 'button', tabindex: '0', on: { click: () => openDiaryAt(o.diary.latest.date, o.diary.latest.book), keydown: (e) => { if (e.key === 'Enter') openDiaryAt(o.diary.latest.date, o.diary.latest.book) } } },
          el('div', { class: 'row', style: { gap: '8px' } },
            el('span', { class: 'pill', text: o.diary.latest.book === 'private' ? '私密' : '给他看' }),
            el('span', { class: 'muted small', text: o.diary.latest.date }),
            o.diary.latest.label ? el('span', { class: 'muted small', text: o.diary.latest.label }) : null,
          ),
          el('p', { class: 'diary-mini-text', text: o.diary.latest.snippet || '（这一页还没写字）' }),
          el('span', { class: 'link small' }, '翻这一页 →'),
        )
      : el('div', { class: 'empty', text: '还没有日记。' }),
  )

  const titleCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '她怎么称呼你' })),
    el('p', { class: 'note', style: { margin: '0 0 8px' } }, '只影响她叫你时的称呼，不改角色卡和其他设定；保存后桥接立刻生效。'),
    el('div', { class: 'row' },
      el('input', { id: 'owner-title', class: 'input', value: o.ownerTitle || '老大', maxlength: 12, style: { width: '160px' } }),
      el('button', { class: 'btn sm primary', on: { click: () => saveOwnerTitle() } }, '保存'),
    ),
  )

  return frag(
    hero,
    stats,
    el('div', { class: 'overview-grid' },
      el('div', { class: 'panel-stack' }, scopeCard, recentCard),
      el('div', { class: 'panel-stack' }, fadingCard, queueCard, diaryCard, titleCard),
    ),
  )
}

async function saveOwnerTitle() {
  const input = document.getElementById('owner-title')
  const title = String(input?.value || '').trim().slice(0, 12) || '老大'
  try {
    const data = await api('/owner-title', { method: 'POST', body: { title } })
    if (S.overview) S.overview.ownerTitle = data.ownerTitle
    toast(`以后她叫你「${data.ownerTitle}」`, 'ok')
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

function focusMemory(row, { query = false } = {}) {
  S.library.scope = row.scope
  S.library.status = row.status === 'active' ? 'active' : row.status
  S.library.q = query ? String(row.text || '').slice(0, 24) : ''
  S.library.tier = 'all'
  S.library.sort = 'recent'
  S.library.loaded = false
  S.library.focusId = row.id
  S.semantic = null
  go('library')
}

// ---------------------------------------------------------------- 长期记忆

function libraryStatusCount(status) {
  if (status === 'all') return Number(S.overview?.total ?? 0)
  return Number(S.overview?.counts?.[status] ?? S.library.counts?.[status] ?? 0)
}

function libraryScopeCount(scope, status) {
  const row = (S.overview?.scopes || []).find((s) => s.scope === scope)
  if (!row) return 0
  if (status === 'all') return Number(row.total || 0)
  return Number(row.byStatus?.[status] || 0)
}

function reloadLibraryWith(patch = {}) {
  Object.assign(S.library, patch)
  S.library.loaded = false
  S.semantic = null
  if (S.tab === 'library') paintCurrent()
}

function renderLibrary() {
  const f = S.library
  const rail = el('aside', { class: 'rail' }, el('div', { class: 'h3', text: '按聊天' }),
    railItem('all', `全部`, libraryStatusCount(f.status), f.scope === 'all'),
    (S.overview?.scopes || []).map((s) => railItem(s.scope, s.label, libraryScopeCount(s.scope, f.status), f.scope === s.scope, s.scope)),
  )

  const search = el('div', { class: 'search' }, el('span', { html: ICONS.search }),
    el('input', {
      class: 'input', type: 'search', placeholder: '在记忆里找几个字…', value: f.q, 'aria-label': '文字筛选',
      on: {
        input: (event) => {
          f.q = event.target.value
          S.semantic = null
          clearTimeout(searchTimer)
          searchTimer = setTimeout(() => { f.loaded = false; loadLibrary() }, 320)
        },
      },
    }),
  )

  const seg = el('div', { class: 'segmented' })
  for (const [value, label] of [['active', '活着'], ['candidate', '待确认'], ['superseded', '被取代'], ['deleted', '已删'], ['archived', '已归档'], ['all', '全部']]) {
    seg.appendChild(el('button', {
      class: f.status === value ? 'active' : '', type: 'button', text: label,
      on: { click: () => reloadLibraryWith({ status: value }) },
    }))
  }

  const tierSel = el('select', {
    class: 'select', style: { width: 'auto', minWidth: '96px' }, 'aria-label': '层级',
    on: { change: (e) => reloadLibraryWith({ tier: e.target.value }) },
  },
  ...[['all', '所有层级'], ['normal', '普通'], ['core', '核心'], ['task', '待办']].map(([v, l]) => el('option', { value: v, text: l, selected: f.tier === v })),
  )

  const sortSel = el('select', {
    class: 'select', style: { width: 'auto', minWidth: '104px' }, 'aria-label': '排序',
    on: { change: (e) => reloadLibraryWith({ sort: e.target.value }) },
  },
  ...[['recent', '最新记下'], ['oldest', '最早记下'], ['importance', '更重要'], ['recall', '最后想起']].map(([v, l]) => el('option', { value: v, text: l, selected: f.sort === v })),
  )

  const toolbar = el('div', { class: 'toolbar' },
    search,
    el('button', { class: 'btn', title: '用向量语义找，不只是字面', on: { click: () => runSemantic() } }, '语义找'),
    seg,
    tierSel,
    sortSel,
  )

  const list = el('div', { class: 'mem-list' })
  const countLine = el('div', { class: 'row small muted', style: { padding: '0 4px' } })
  const semHead = el('div')
  libRefs = { list, countLine, semHead }

  const addBtn = el('button', { class: 'btn block', style: { marginTop: '8px' }, on: { click: () => openAdd(f.scope) } }, icon('plus'), '往这一格记一条')
  rail.appendChild(addBtn)

  const main = el('div', { class: 'library-main' }, toolbar, semHead, countLine, list)
  const wrap = el('div', { class: 'library' }, rail, main)

  if (!f.loaded) {
    loadLibrary()
  } else {
    paintLibraryList()
  }

  return wrap
}

function railItem(scope, label, count, active, editScope = '') {
  const row = el('div', { class: `rail-item ${active ? 'active' : ''}`, role: 'button', tabindex: '0' },
    el('span', { class: 'nm', text: label }),
    el('span', { class: 'ct', text: String(count ?? 0) }),
  )
  row.addEventListener('click', () => reloadLibraryWith({ scope }))
  row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click() } })
  if (editScope) {
    const edit = el('button', { class: 'icon-btn edit-label', title: '给这个聊天起个名字', style: { width: '22px', height: '22px' }, html: ICONS.pencil })
    edit.addEventListener('click', (event) => { event.stopPropagation(); renameScope(editScope, label) })
    row.appendChild(edit)
  }
  return row
}

async function renameScope(scope, current) {
  const name = await promptText({
    title: '给它起个名字',
    desc: '只改这里怎么显示，不动桥接和记忆库里的任何东西。留空就恢复默认。',
    label: '显示名',
    value: S.labels[scope] || '',
    placeholder: current,
    maxlength: 40,
  })
  if (name === null) return
  try {
    const data = await withBusy(() => api('/labels', { method: 'POST', body: { scope, label: name } }))
    S.labels = data.labels
    await refreshOverview({ paint: false })
    S.library.loaded = false
    paintCurrent()
    toast(name ? '名字改好了' : '恢复默认了', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function loadLibrary({ append = false } = {}) {
  const f = S.library
  const seq = ++f.seq
  const params = new URLSearchParams({
    scope: f.scope, status: f.status, tier: f.tier, q: f.q, sort: f.sort,
    limit: '60', offset: append ? String(f.rows.length) : '0',
  })
  try {
    const data = await withBusy(() => api(`/library?${params}`))
    if (seq !== f.seq) return
    f.rows = append ? f.rows.concat(data.rows) : data.rows
    f.total = data.total
    f.counts = data.counts
    f.scopes = data.scopes
    f.diaryDates = data.diaryDates || {}
    f.loaded = true
    paintLibraryList()
    updateTabs()
  } catch (error) {
    if (seq !== f.seq) return
    toast(error.message, 'error')
    if (libRefs) libRefs.list.replaceChildren(el('div', { class: 'empty', text: error.message }))
  }
}

function paintLibraryList() {
  if (!libRefs) return
  const f = S.library
  libRefs.semHead.replaceChildren()
  libRefs.countLine.replaceChildren()

  if (S.semantic) {
    libRefs.semHead.appendChild(el('div', { class: 'semantic-head' },
      el('span', null, '语义找：', el('b', { text: S.semanticQuery })),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', on: { click: () => { S.semantic = null; S.semanticQuery = ''; paintLibraryList(); updateTabs() } } }, icon('close'), '退出'),
    ))
    libRefs.countLine.appendChild(el('span', { text: `找到 ${S.semantic.length} 条最像的` }))
    libRefs.list.replaceChildren(...(S.semantic.length
      ? S.semantic.map((r) => memRow(r, { semantic: true }))
      : [el('div', { class: 'empty' }, el('div', { html: ICONS.wave }), '没有很像的。换个说法试试？')]))
    return
  }

  libRefs.countLine.appendChild(el('span', {
    text: `这里 ${f.total} 条 · 已显示 ${f.rows.length} 条${f.q ? ` · 含「${f.q}」` : ''}`,
  }))
  libRefs.countLine.appendChild(el('span', { class: 'spacer' }))

  if (!f.rows.length) {
    libRefs.list.replaceChildren(el('div', { class: 'empty' }, el('div', { html: ICONS.wave }), '这一格是空的。'))
    return
  }

  const nodes = f.rows.map((r) => memRow(r))
  if (f.rows.length < f.total) {
    nodes.push(el('div', { class: 'load-more' },
      el('button', { class: 'btn', onClick: undefined, on: { click: () => loadLibrary({ append: true }) } }, `再往下看 ${Math.min(60, f.total - f.rows.length)} 条`),
    ))
  }
  libRefs.list.replaceChildren(...nodes)

  if (f.focusId) {
    const target = libRefs.list.querySelector(`[data-id="${CSS.escape(f.focusId)}"]`)
    if (target) {
      target.classList.add('expanded')
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    f.focusId = ''
  }
}

function ring(value, label = '鲜活度') {
  const v = clamp01(value)
  const r = 15
  const c = 2 * Math.PI * r
  const color = v >= 0.66 ? 'var(--green)' : v >= 0.33 ? 'var(--amber)' : 'var(--rose)'
  return el('div', { class: 'ring', title: `${label} ${Math.round(v * 100)}%` },
    el('div', {
      html: `<svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
        <circle cx="19" cy="19" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>
        <circle cx="19" cy="19" r="${r}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - v)).toFixed(2)}"/>
      </svg>`,
    }),
    el('span', { class: 'ring-label', text: String(Math.round(v * 100)) }),
  )
}

function actionBtn(name, title, fn, cls = '') {
  return el('button', { class: `icon-btn ${cls}`, title, 'aria-label': title, html: ICONS[name], on: { click: (e) => { e.stopPropagation(); fn() } } })
}

function memRow(row, { semantic = false } = {}) {
  const card = el('article', { class: `mem ${row.status === 'deleted' ? 'faded' : ''}`, dataset: { id: row.id } })
  const scope = S.overview?.scopes?.find((s) => s.scope === row.scope)
  const scopeLabel = scope?.label || row.scope

  const when = el('div', { class: 'when' },
    el('span', { class: 'date', text: fmtWhen(row.createdAt) }),
    el('span', { text: fmtDate(row.createdAt) }),
  )

  const text = el('p', { class: 'text', text: row.text })
  const body = el('div', { class: 'body' }, text)

  const meta = el('div', { class: 'meta' })
  meta.appendChild(el('span', { class: `pill ${row.status}`, text: statusLabel(row.status) }))
  meta.appendChild(el('span', { class: `pill ${scope?.kind || ''}`, text: scopeLabel }))
  const day = dateKey(row.sourceTime || row.createdAt)
  const dayBooks = S.library.diaryDates?.[day]
  if (dayBooks?.length) {
    meta.appendChild(el('button', {
      class: 'pill diary-link', type: 'button', title: `这一天写过日记：${day}`,
      on: { click: (event) => { event.stopPropagation(); openDiaryAt(day, dayBooks.includes('public') ? 'public' : dayBooks[0]) } },
    }, icon('book'), '日记'))
  }
  if (String(row.sourceId || '').startsWith('diary:')) {
    meta.appendChild(el('span', { class: 'pill', text: '来自日记' }))
  }
  if (row.tier !== 'normal') meta.appendChild(el('span', { class: `pill ${row.tier}`, text: tierLabel(row.tier) }))
  meta.appendChild(el('span', { class: 'kv', text: `重要度 ${Math.round((row.importance || 0) * 100)}%` }))
  if (row.accessCount) meta.appendChild(el('span', { class: 'kv', text: `被想起 ${row.accessCount} 次` }))
  if (row.factKey) meta.appendChild(el('span', { class: 'kv', text: `事实键 ${row.factKey}` }))
  if (row.subjectId) meta.appendChild(el('span', { class: 'kv', text: `说话人 QQ ${row.subjectId}` }))
  if (row.sourceTime) meta.appendChild(el('span', { class: 'kv', text: `原话 ${fmtWhen(row.sourceTime)}` }))
  if (row.supersededBy) meta.appendChild(el('span', { class: 'kv', text: `被更新的那条取代` }))
  if (semantic && Number.isFinite(row.sim)) meta.appendChild(el('span', { class: 'kv score', text: `相似 ${(row.sim * 100).toFixed(0)}% · 综合 ${(row.score * 100).toFixed(0)}%` }))
  body.appendChild(meta)

  if (row.text && row.text.length > 150) {
    body.appendChild(el('button', {
      class: 'btn sm ghost', style: { padding: '2px 0', marginTop: '2px' }, text: '展开全文',
      on: { click: (event) => { event.stopPropagation(); card.classList.toggle('expanded'); event.currentTarget.textContent = card.classList.contains('expanded') ? '收起' : '展开全文' } },
    }))
  }

  const actions = el('div', { class: 'actions' })
  if (row.status === 'candidate') {
    actions.appendChild(actionBtn('check', '确认这条是真的', () => act('confirm', { id: row.id, scope: row.scope }, { success: '确认了，这回她真的记住了' })))
  }
  if (row.tier === 'task' && row.status === 'active') {
    actions.appendChild(actionBtn('flag', '这条待办做完了', () => act('finish', { id: row.id, scope: row.scope }, { success: '待办标记完成' })))
  }
  if (row.status === 'active' && row.tier !== 'core') {
    actions.appendChild(actionBtn('star', '标成核心：以后不会淡', () => act('meta', { id: row.id, tier: 'core' }, { success: '标成核心了，它不会淡' })))
  }
  if (['deleted', 'archived'].includes(row.status)) {
    actions.appendChild(actionBtn('restore', '恢复这条', () => act('restore', { id: row.id }, { success: '捞回来了' })))
  }
  if (['active', 'candidate'].includes(row.status)) {
    if (row.scope !== 'global') actions.appendChild(actionBtn('pencil', '改正文', () => editMemory(row)))
    actions.appendChild(actionBtn('layers', '改层级和重要度', () => editMeta(row)))
    actions.appendChild(actionBtn('trash', '删掉（软删，还能恢复）', () => removeMemory(row), 'danger'))
  }

  const side = el('div', { class: 'side' }, ring(row.recall || 0), actions)

  card.append(when, body, side)
  card.addEventListener('click', (event) => {
    if (event.target.closest('button')) return
    card.classList.toggle('expanded')
  })

  return card
}

async function runSemantic(query) {
  const q = String(query ?? S.library.q ?? '').trim()
  if (!q) { toast('先写一句要找什么', 'error'); return }
  try {
    const data = await withBusy(() => api('/search', { method: 'POST', body: { scope: S.library.scope, query: q, k: 30 } }))
    S.semanticQuery = q
    S.semantic = data.results || []
    paintLibraryList()
    updateTabs()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function act(op, payload, { success } = {}) {
  try {
    await withBusy(() => api('/action', { method: 'POST', body: { op, ...payload } }))
    toast(success || '改好了', 'ok')
    S.semantic = null
    await afterChange()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function removeMemory(row) {
  const ok = await confirmDialog({
    title: '删掉这条记忆？',
    desc: `「${row.text.slice(0, 80)}${row.text.length > 80 ? '…' : ''}」\n\n只是软删：她不会再想起它，但东西还在「已删」里，随时能恢复。`,
    ok: '删掉',
    danger: true,
  })
  if (!ok) return
  await act('delete', { id: row.id, scope: row.scope }, { success: '删掉了，去「已删」还能找回来' })
}

async function editMemory(row) {
  const result = await openModal({
    title: '改这条记忆',
    desc: '改完会重新算一遍向量。旧的那条会被标成「被取代」，不会直接消失。',
    submit: '改好',
    fields: [{ name: 'text', label: '正文', type: 'textarea', value: row.text, maxlength: 500, rows: 6, required: true, help: `${row.text.length} / 500 字` }],
  })
  if (!result) return
  if (result.text === row.text) { toast('跟原来一模一样，不用改', 'error'); return }
  await act('edit', { id: row.id, text: result.text }, { success: '改好了' })
}

async function editMeta(row) {
  const result = await openModal({
    title: '这条有多重？',
    desc: '核心不会淡忘；待办做完可以在这里点完成；重要度会影响被想起来的概率。',
    submit: '保存',
    fields: [
      { name: 'tier', label: '层级', type: 'select', value: row.tier, options: [{ value: 'normal', label: '普通 —— 会慢慢淡' }, { value: 'core', label: '核心 —— 一直记得' }, { value: 'task', label: '待办 —— 做完为止' }] },
      { name: 'importance', label: '重要度', type: 'range', value: row.importance ?? 0.5, min: 0, max: 1, step: 0.05 },
    ],
  })
  if (!result) return
  await act('meta', { id: row.id, tier: result.tier, importance: result.importance }, { success: '记下了' })
}

async function openAdd(presetScope = '') {
  const chatScopes = (S.overview?.scopes || []).filter((s) => s.scope !== 'global')
  const ownerScope = S.overview?.ownerQQ ? `private:${S.overview.ownerQQ}` : ''
  if (ownerScope && !chatScopes.some((s) => s.scope === ownerScope)) {
    chatScopes.unshift({ scope: ownerScope, label: '老大的私聊' })
  }
  if (!chatScopes.length) { toast('还没有任何一个私聊或群，先在 QQ 里聊一句再来记', 'error'); return }
  const scopes = chatScopes.map((s) => ({ value: s.scope, label: s.label }))
  const fallback = presetScope && presetScope !== 'global' && chatScopes.some((s) => s.scope === presetScope) ? presetScope : chatScopes[0].scope
  const result = await openModal({
    title: '亲手记一条',
    desc: '这一条是你说给她听的，不受每天配额和开关影响。',
    submit: '记下',
    fields: [
      { name: 'scope', label: '记到哪', type: 'select', value: fallback, options: scopes },
      { name: 'text', label: '内容', type: 'textarea', maxlength: 500, rows: 5, required: true, placeholder: '比如：老大喜欢在凌晨四点调东西，别催他睡…' },
      { name: 'tier', label: '层级', type: 'select', value: 'normal', options: [{ value: 'normal', label: '普通 —— 会慢慢淡' }, { value: 'core', label: '核心 —— 一直记得' }, { value: 'task', label: '待办 —— 做完为止' }] },
      { name: 'importance', label: '重要度', type: 'range', value: 0.7, min: 0, max: 1, step: 0.05 },
      { name: 'factKey', label: '事实键（可选）', type: 'text', placeholder: '她.身高 —— 同一个键只留最新一条', maxlength: 100 },
      { name: 'subjectId', label: '说话人 QQ（可选）', type: 'text', placeholder: '只有这一条属于某个具体的人时才填', maxlength: 30 },
    ],
  })
  if (!result) return
  await act('add', result, { success: '记下了' })
}

// ---------------------------------------------------------------- 轻量记忆

function renderLight() {
  const wrap = el('div')
  if (!S.light.key) {
    if (!S.light.scopes) {
      loadLightScopes()
      wrap.appendChild(el('div', { class: 'empty', text: '正在数她脑子里还挂着几件事…' }))
      return wrap
    }
    wrap.appendChild(lightHome(S.light.scopes))
    return wrap
  }
  if (!S.light.data || S.light.data.key !== S.light.key) {
    loadLight(S.light.key)
    wrap.appendChild(el('div', { class: 'empty', text: '正在捞这一格的临时记忆…' }))
    return wrap
  }
  wrap.appendChild(lightDetail(S.light.data))
  return wrap
}

async function loadLightScopes(force = false) {
  try {
    const data = await withBusy(() => api('/light/scopes'))
    S.light.scopes = data
    if (S.tab === 'light' && !S.light.key) paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
    if (S.tab === 'light') mainEl.replaceChildren(el('div', { class: 'empty', text: error.message }))
  }
}

function lightHome(data) {
  const rows = data.rows || []
  const used = rows.filter((r) => r.total > 0)
  return frag(
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '轻量记忆' }),
      el('span', { class: 'muted small', text: '聊天时随手挂着的：进行中的话题、想说还没说的话、对群友的印象。' }),
    ),
    el('p', { class: 'note', style: { margin: '0 0 14px' } }, '这些是临时上下文，聊完就散。真正的长期记忆在', el('b', { text: '「长期记忆」' }), '里。'),
    data.paused ? el('div', { class: 'semantic-head', style: { marginBottom: '12px' } }, '桥接现在是暂停状态，轻量记忆暂时不会更新。') : null,
    el('div', { class: 'light-grid' },
      rows.map((r) => el('button', {
        class: 'conv-card', type: 'button',
        on: { click: () => { S.light.key = r.key; location.hash = `#/light?key=${encodeURIComponent(r.key)}`; route(true) } },
      },
      el('div', { class: 'top' }, el('span', { class: `pill ${r.kind}`, text: r.kind === 'owner' ? '老大' : r.kind === 'group' ? '群' : '私聊' }), el('span', { class: 'nm', text: r.label })),
      el('div', { class: 'counts' },
        el('span', null, '话题 ', el('b', { text: String(r.counts.activeTopics) })),
        el('span', null, '没说 ', el('b', { text: String(r.counts.pendingThoughts) })),
        el('span', null, '印象 ', el('b', { text: String(r.counts.memberImpressions) })),
      ),
      r.lastActionAt ? el('div', { class: 'muted small', style: { marginTop: '7px' }, text: `上次说话 ${fmtWhen(r.lastActionAt)}` }) : null,
      )),
      used.length === 0 ? el('div', { class: 'empty' }, el('div', { html: ICONS.wave }), '还没有哪一格挂着东西，去聊两句吧。') : null,
    ),
  )
}

async function loadLight(key) {
  const seq = ++S.light.seq
  try {
    const data = await withBusy(() => api(`/light?key=${encodeURIComponent(key)}`))
    if (seq !== S.light.seq) return
    S.light.data = data
    if (S.tab === 'light') paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
    if (S.tab === 'light') mainEl.replaceChildren(el('div', { class: 'empty', text: error.message }))
  }
}

function lightDetail(data) {
  const back = el('button', { class: 'btn sm ghost', on: { click: () => { S.light.key = ''; S.light.data = null; history.replaceState(null, '', '#/light'); route(true) } } }, '← 全部聊天')

  const head = el('div', { class: 'light-head' }, back,
    el('h2', { text: data.label }),
    el('span', { class: 'pill', text: data.paused ? '桥接暂停中' : '桥接在线' }),
    el('span', { class: 'muted small', text: `共 ${data.counts.activeTopics + data.counts.pendingThoughts + data.counts.memberImpressions} 条` }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn sm', on: { click: () => addLight('activeTopic') } }, icon('plus'), '加个话题'),
    el('button', { class: 'btn sm', on: { click: () => addLight('pendingThought') } }, icon('plus'), '加句没说的'),
    el('button', { class: 'btn sm', on: { click: () => addLight('memberImpression') } }, icon('plus'), '加个印象'),
    el('button', { class: 'btn sm danger', on: { click: () => clearLight() } }, '清空这一格'),
  )

  const topics = el('section', { class: 'light-section' },
    el('div', { class: 'section-head' }, el('h3', { class: 'h3', text: `进行中的话题 · ${data.activeTopics.length}` })),
    data.activeTopics.length
      ? data.activeTopics.map((t) => lightTopic(t))
      : el('div', { class: 'empty', text: '这会儿没在聊什么。' }),
  )

  const thoughts = el('section', { class: 'light-section' },
    el('div', { class: 'section-head' }, el('h3', { class: 'h3', text: `想说但还没说的 · ${data.pendingThoughts.length}` })),
    data.pendingThoughts.length
      ? data.pendingThoughts.map((t) => lightThought(t))
      : el('div', { class: 'empty', text: '没有憋着没说的话。' }),
  )

  const imps = data.memberImpressions || {}
  const names = Object.keys(imps)
  const impressions = el('section', { class: 'light-section' },
    el('div', { class: 'section-head' }, el('h3', { class: 'h3', text: `对群友的印象 · ${names.length}` })),
    names.length
      ? names.map((name) => lightImpression(name, imps[name]))
      : el('div', { class: 'empty', text: '还没记住谁。' }),
  )

  return frag(head, topics, thoughts, impressions)
}

function lightTopic(t) {
  return el('div', { class: 'light-item' },
    el('div', null,
      el('div', { class: 'txt', text: t.text }),
      el('div', { class: 'sub' },
        t.pendingQuestion ? el('span', { text: `还没问出口：${t.pendingQuestion}` }) : null,
        Array.isArray(t.participants) && t.participants.length ? el('span', { text: `参与：${t.participants.join('、')}` }) : null,
        t.lastMentionAt ? el('span', { text: fmtWhen(t.lastMentionAt) }) : null,
      ),
    ),
    el('div', { class: 'acts' },
      actionBtn('pencil', '改这个话题', () => editLight('activeTopic', t)),
      actionBtn('trash', '删掉这个话题', () => removeLight('activeTopic', t), 'danger'),
    ),
  )
}

function lightThought(t) {
  return el('div', { class: 'light-item' },
    el('div', null,
      el('div', { class: 'txt', text: t.text }),
      el('div', { class: 'sub' },
        t.motivation ? el('span', { text: `动机：${t.motivation}` }) : null,
        t.expiresAt ? el('span', { text: `${fmtWhen(t.expiresAt)} 过期` }) : null,
      ),
    ),
    el('div', { class: 'acts' },
      actionBtn('pencil', '改这句话', () => editLight('pendingThought', t)),
      actionBtn('trash', '删掉这句话', () => removeLight('pendingThought', t), 'danger'),
    ),
  )
}

function lightImpression(name, data) {
  const traits = Array.isArray(data.traits) ? data.traits : []
  return el('div', { class: 'impression' },
    el('div', { class: 'head' },
      el('span', { class: 'name', text: name }),
      data.interactionCount ? el('span', { class: 'pill', text: `聊过 ${data.interactionCount} 次` }) : null,
      data.lastSeenAt ? el('span', { class: 'muted small', text: fmtWhen(data.lastSeenAt) }) : null,
      el('span', { class: 'acts' },
        actionBtn('pencil', '改这个印象', () => editLight('memberImpression', { name, ...data })),
        actionBtn('trash', '删掉这个印象', () => removeLight('memberImpression', { name }), 'danger'),
      ),
    ),
    traits.length ? el('div', { class: 'traits' }, traits.map((t) => el('span', { class: 'trait', text: t }))) : el('div', { class: 'muted small', text: '还没写下什么。' }),
  )
}

async function addLight(category) {
  const fields = category === 'memberImpression'
    ? [
        { name: 'target', label: '是谁', type: 'text', required: true, placeholder: '群友名字' },
        { name: 'content', label: '印象（用逗号分开几条）', type: 'textarea', required: true, placeholder: '爱熬夜，嘴硬' },
      ]
    : category === 'activeTopic'
      ? [
          { name: 'content', label: '话题', type: 'textarea', required: true },
          { name: 'pendingQuestion', label: '还没问出口的（可选）', type: 'text' },
          { name: 'participants', label: '参与者（可选，逗号分开）', type: 'text' },
        ]
      : [
          { name: 'content', label: '想说的话', type: 'textarea', required: true },
          { name: 'motivation', label: '为什么想说（可选）', type: 'text', placeholder: 'curiosity / sociability' },
        ]
  const result = await openModal({ title: '加一条轻量记忆', submit: '加上', fields })
  if (!result) return
  const extra = {}
  if (result.pendingQuestion) extra.pendingQuestion = result.pendingQuestion
  if (result.participants) extra.participants = result.participants.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  if (result.motivation) extra.motivation = result.motivation
  if (result.target) extra.target = result.target
  await lightAct('add', { key: S.light.key, category, content: result.content, extra })
}

async function editLight(category, item) {
  const fields = category === 'memberImpression'
    ? [
        { name: 'target', label: '是谁', type: 'text', value: item.name, required: true },
        { name: 'content', label: '印象（逗号分开）', type: 'textarea', value: (item.traits || []).join('，'), required: true },
        { name: 'interactionCount', label: '聊过几次', type: 'number', value: item.interactionCount ?? 0, min: 0 },
      ]
    : category === 'activeTopic'
      ? [
          { name: 'content', label: '话题', type: 'textarea', value: item.text, required: true },
          { name: 'pendingQuestion', label: '还没问出口的', type: 'text', value: item.pendingQuestion || '' },
          { name: 'participants', label: '参与者（逗号分开）', type: 'text', value: (item.participants || []).join('，') },
        ]
      : [
          { name: 'content', label: '想说的话', type: 'textarea', value: item.text, required: true },
          { name: 'motivation', label: '为什么想说', type: 'text', value: item.motivation || '' },
        ]
  const result = await openModal({ title: '改这条轻量记忆', submit: '改好', fields })
  if (!result) return
  if (category === 'memberImpression') {
    await lightAct('update', {
      key: S.light.key, category, target: item.name, oldContent: '', newContent: result.content,
      newExtra: { target: result.target, interactionCount: Number(result.interactionCount) || 0 },
    })
  } else {
    const newExtra = {}
    if (category === 'activeTopic') {
      if (result.pendingQuestion) newExtra.pendingQuestion = result.pendingQuestion
      if (result.participants) newExtra.participants = result.participants.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
    } else if (result.motivation) newExtra.motivation = result.motivation
    await lightAct('update', { key: S.light.key, category, oldContent: item.text, newContent: result.content, newExtra })
  }
}

async function removeLight(category, item) {
  const ok = await confirmDialog({
    title: '删掉这条？',
    desc: category === 'memberImpression' ? `对「${item.name}」的印象会被清掉。` : `「${item.text.slice(0, 80)}」`,
    ok: '删掉', danger: true,
  })
  if (!ok) return
  await lightAct('remove', {
    key: S.light.key, category,
    content: category === 'memberImpression' ? '' : item.text,
    target: category === 'memberImpression' ? item.name : '',
  })
}

async function clearLight() {
  const ok = await confirmDialog({
    title: '清空这一格的全部轻量记忆？',
    desc: '话题、没说的话、群友印象会一起清掉。长期记忆不受影响。',
    ok: '全清掉', danger: true,
  })
  if (!ok) return
  await lightAct('clear', { key: S.light.key, category: '' })
}

async function lightAct(op, payload) {
  try {
    const data = await withBusy(() => api('/light/action', { method: 'POST', body: { op, ...payload } }))
    S.light.data = data
    toast('改好了', 'ok')
    if (S.tab === 'light') paintCurrent()
    await refreshOverview({ paint: false })
  } catch (error) {
    toast(error.message, 'error')
  }
}

// 可塑性记忆 · 日记视图
// 这一整段追加在轻量记忆之后、整理之前。

function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function mdToText(text) {
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

function inlineNodes(text) {
  const out = []
  let rest = String(text || '')
  const patterns = [
    { re: /\*\*([^*]+)\*\*/, tag: 'strong' },
    { re: /`([^`]+)`/, tag: 'code' },
    { re: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/, link: true },
    { re: /\*([^*]+)\*/, tag: 'em' },
  ]
  while (rest) {
    let best = null
    for (const p of patterns) {
      const m = p.re.exec(rest)
      if (m && (!best || m.index < best.m.index)) best = { p, m }
    }
    if (!best) { out.push(document.createTextNode(rest)); break }
    if (best.m.index > 0) out.push(document.createTextNode(rest.slice(0, best.m.index)))
    if (best.p.link) {
      out.push(el('a', { href: best.m[2], target: '_blank', rel: 'noreferrer' }, best.m[1]))
    } else {
      out.push(el(best.p.tag, null, best.m[1]))
    }
    rest = rest.slice(best.m.index + best.m[0].length)
  }
  return out
}

function renderMarkdown(text) {
  const root = document.createDocumentFragment()
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }

    if (/^```/.test(line)) {
      const code = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1 }
      i += 1
      root.appendChild(el('pre', { class: 'md-code' }, el('code', null, code.join('\n'))))
      continue
    }

    if (/^####\s+/.test(line)) { root.appendChild(el('h4', { class: 'md-h4', text: line.replace(/^####\s+/, '') })); i += 1; continue }
    if (/^##\s+/.test(line)) { root.appendChild(el('h3', { class: 'md-h3', text: line.replace(/^##\s+/, '') })); i += 1; continue }
    if (/^#\s+/.test(line)) { root.appendChild(el('h2', { class: 'md-h2', text: line.replace(/^#\s+/, '') })); i += 1; continue }
    if (/^###\s+/.test(line)) { root.appendChild(el('h3', { class: 'md-h3', text: line.replace(/^###\s+/, '') })); i += 1; continue }
    if (/^---+\s*$/.test(line)) { root.appendChild(el('hr', { class: 'md-hr' })); i += 1; continue }

    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
      const table = el('table', { class: 'md-table' })
      const thead = el('thead')
      const hr = el('tr')
      for (const cell of cells(line)) hr.appendChild(el('th', null, inlineNodes(cell)))
      thead.appendChild(hr)
      table.appendChild(thead)
      const tbody = el('tbody')
      i += 2
      while (i < lines.length && /^\|/.test(lines[i])) {
        const tr = el('tr')
        for (const cell of cells(lines[i])) tr.appendChild(el('td', null, inlineNodes(cell)))
        tbody.appendChild(tr)
        i += 1
      }
      table.appendChild(tbody)
      root.appendChild(table)
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      root.appendChild(el('blockquote', { class: 'md-quote' }, inlineNodes(quote.join('\n'))))
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const list = el('ul', { class: 'md-ul' })
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        list.appendChild(el('li', null, inlineNodes(lines[i].replace(/^\s*[-*]\s+/, ''))))
        i += 1
      }
      root.appendChild(list)
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const list = el('ol', { class: 'md-ol' })
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        list.appendChild(el('li', null, inlineNodes(lines[i].replace(/^\s*\d+\.\s+/, ''))))
        i += 1
      }
      root.appendChild(list)
      continue
    }

    const para = []
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,4}\s|>|```|\s*[-*]\s|\s*\d+\.\s|\||---+\s*$)/.test(lines[i])
    ) { para.push(lines[i]); i += 1 }
    if (!para.length) { para.push(lines[i]); i += 1 }
    root.appendChild(el('p', { class: 'md-p' }, inlineNodes(para.join('\n'))))
  }
  return root
}

function openDiaryAt(date, book) {
  S.diary.book = book === 'private' ? 'private' : 'public'
  S.diary.wantDate = date
  S.diary.showIntro = false
  S.diary.index = -1
  const target = `#/diary?book=${S.diary.book}&date=${encodeURIComponent(date)}`
  if (location.hash === target) route(true)
  else { location.hash = target; route(true) }
}

async function loadDiary() {
  try {
    const token = S.diary.token || sessionStorage.getItem('feiyu-diary-token') || ''
    S.diary.token = token
    const data = await withBusy(() => api('/diary', { headers: token ? { 'x-diary-token': token } : {} }))
    S.diary.books = data.books
    S.diary.dates = data.dates || {}
    S.diary.autoImport = data.autoImport === true
    const priv = (data.books || []).find((b) => b.id === 'private')
    if (priv && priv.locked && token && data.books) {
      // token 过期/无效：清掉，重新显示锁
      S.diary.token = ''
      sessionStorage.removeItem('feiyu-diary-token')
    }
    if (S.tab === 'diary') paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
    if (S.tab === 'diary') mainEl.replaceChildren(el('div', { class: 'empty', text: error.message }))
  }
}

function diaryBook(id) {
  return (S.diary.books || []).find((b) => b.id === id) || (S.diary.books || [])[0]
}

function renderDiary() {
  if (!S.diary.books) {
    loadDiary()
    return el('div', { class: 'empty', text: '正在翻她的两本日记…' })
  }

  const book = diaryBook(S.diary.book)
  if (!book) return el('div', { class: 'empty', text: '还没有日记。' })
  const entries = book.entries || []

  if (S.diary.wantDate) {
    const found = entries.findIndex((x) => x.date === S.diary.wantDate)
    if (found >= 0) { S.diary.index = found; S.diary.showIntro = false }
    S.diary.wantDate = ''
  }
  if (!S.diary.showIntro && (S.diary.index < 0 || S.diary.index >= entries.length)) {
    S.diary.index = entries.length ? entries.length - 1 : -1
  }
  const entry = entries[S.diary.index]

  const switchRow = el('div', { class: 'book-switch' },
    (S.diary.books || []).map((b) => el('button', {
      class: `book-tab ${b.id === book.id ? 'active' : ''}`,
      type: 'button',
      on: { click: () => {
        S.diary.book = b.id
        S.diary.showIntro = false
        S.diary.index = b.entries.length ? b.entries.length - 1 : -1
        paintCurrent()
      } },
    },
    el('span', { text: b.title }),
    el('span', { class: 'n', text: String(b.entries.length) }),
    b.private ? el('span', { class: 'lock', text: '私密' }) : null,
    )),
  )

  const rail = el('aside', { class: 'diary-rail' },
    switchRow,
    el('div', { class: 'diary-rail-list' },
      book.intro ? el('button', {
        class: `diary-item intro ${S.diary.showIntro ? 'active' : ''}`,
        type: 'button',
        on: { click: () => { S.diary.showIntro = true; paintCurrent() } },
      },
      el('span', { class: 'd', text: '序' }),
      el('span', { class: 't', text: '写在前面' }),
      ) : null,
      [...entries].reverse().map((item) => el('button', {
        class: `diary-item ${!S.diary.showIntro && item.index === S.diary.index ? 'active' : ''}`,
        type: 'button',
        on: { click: () => { S.diary.index = item.index; S.diary.showIntro = false; paintCurrent() } },
      },
      el('span', { class: 'd', text: item.date }),
      el('span', { class: 't', text: item.label || '一页' }),
      el('span', { class: 's', text: mdToText(item.body).replace(/\s+/g, ' ').slice(0, 46) || '（空白）' }),
      )),
    ),
    el('button', { class: 'btn block', style: { marginTop: '8px' }, on: { click: () => appendDiaryEntry() } }, icon('plus'), '补一页'),
  )

  const body = el('section', { class: 'diary-main card' })
  if (book.error) body.appendChild(el('div', { class: 'semantic-head', style: { marginBottom: '12px' } }, book.error))
  if (book.private && book.locked) {
    if (!hasBridgeCap('diary-vault')) {
      body.append(
        el('div', { class: 'diary-head' }, el('div', { class: 'diary-date', text: '桥接版本太旧' })),
        el('p', { class: 'note' }, '当前桥接还不支持加密私密本。升级桥接后刷新；公开本不受影响。'),
      )
      return el('div', { class: 'diary-layout' }, rail, body)
    }
    body.append(
      el('div', { class: 'diary-head' },
        el('div', null, el('div', { class: 'diary-date', text: '私密本已加密' }), el('div', { class: 'muted small', text: '只有她知道密码；要不要告诉你，看她今天的心情。' })),
      ),
      el('p', { class: 'note' }, '密码不在控制台里，也不会写进系统提示词。问她「私密日记的密码是什么」，她可能给，也可能说今天不想说。'),
      el('div', { class: 'row', style: { marginTop: '10px' } },
        el('input', { id: 'diary-password', class: 'input', type: 'password', placeholder: '输入密码' }),
        el('button', { class: 'btn sm primary', on: { click: () => unlockPrivateDiaryUI() } }, '解锁'),
        el('button', { class: 'btn sm ghost', title: '重置后旧密码失效，新密码只能问肥鱼', on: { click: () => resetPrivateDiaryUI() } }, '重置密码'),
      ),
      el('p', { class: 'muted small', style: { marginTop: '8px' } }, '连续输错 3 次会锁 1 小时；解锁 30 分钟后自动重新上锁。'),
    )
    return el('div', { class: 'diary-layout' }, rail, body)
  }
  if (S.diary.showIntro) {
    body.append(
      el('div', { class: 'diary-head' },
        el('div', null, el('div', { class: 'diary-date', text: '写在前面' }), el('div', { class: 'muted small', text: book.subtitle })),
        el('span', { class: 'spacer' }),
      ),
      el('div', { class: 'md' }, renderMarkdown(book.intro)),
    )
    return el('div', { class: 'diary-layout' }, rail, body)
  }

  if (!entry) {
    body.append(el('div', { class: 'empty' }, el('div', { html: ICONS.wave }), '这一本还没有正文。', el('button', { class: 'btn', style: { marginTop: '10px' }, on: { click: () => appendDiaryEntry() } }, '写第一页')))
    return el('div', { class: 'diary-layout' }, rail, body)
  }

  const head = el('div', { class: 'diary-head' },
    el('div', null,
      el('div', { class: 'diary-date', text: entry.date }),
      el('div', { class: 'row', style: { gap: '7px' } },
        el('span', { class: `pill ${book.private ? 'deleted' : 'active'}`, text: book.private ? '私密' : '给他看' }),
        entry.label ? el('span', { class: 'muted small', text: entry.label }) : null,
        el('span', { class: 'muted small', text: `${entry.body.length} 字` }),
      ),
    ),
    el('span', { class: 'spacer' }),
    el('div', { class: 'row', style: { gap: '6px' } },
      book.private ? null : el('button', { class: 'btn sm', on: { click: () => editDiaryEntry(book, entry) } }, icon('pencil'), '编辑'),
      el('button', { class: 'btn sm', title: '把这一页压成一条普通长期记忆，QQ 聊天回忆能搜到；原文不会自动同步', on: { click: () => saveDiaryToMemory(book, entry) } }, '收进 QQ 记忆'),
      el('button', { class: 'btn sm ghost', title: '补最近 3 天里漏掉的日记', on: { click: () => catchupDiaryNow() } }, '补写漏掉的'),
      el('button', { class: 'btn sm ghost', title: '重新读文件', on: { click: () => { S.diary.books = null; paintCurrent() } } }, icon('refresh')),
    ),
  )

  body.append(head, el('label', { class: 'row', style: { margin: '0 0 4px' } },
    el('input', { type: 'checkbox', checked: S.diary.autoImport === true, on: { change: (event) => toggleDiaryAutoImport(event) } }),
    el('span', { class: 'muted small', text: '每天自动把「给他看」这本收进记忆' }),
  ), el('p', { class: 'note', style: { margin: '0 0 10px' } }, '开：每天写完公开日记后自动收 1 条（0 LLM token，normal，重要度 0.6，不覆盖旧条）；私密本永远手动。关：只在你点「收进 QQ 记忆」时收。'), el('p', { class: 'note', style: { margin: '0 0 10px' } }, '「收进 QQ 记忆」= 把这一页压成一条普通长期记忆，QQ 聊天里的回忆能搜到它；原文不会自动同步，日记以后再改，这条不会跟着变。电脑没开时，下次启动会补最近 3 天还能找到聊天材料的日记。'), el('div', { class: 'md diary-body' }, renderMarkdown(entry.body)))

  const dayBox = el('div', { class: 'day-memories', dataset: { diaryDay: entry.date } })
  body.appendChild(dayBox)
  paintDiaryDay(dayBox, entry.date)
  queueMicrotask(() => loadDiaryDay(entry.date))

  body.appendChild(el('div', { class: 'diary-foot' },
    el('span', { text: `${book.file} · ${fmtBytes(book.size)} · 最后写入 ${fmtWhen(book.mtime)}` }),
    el('span', { class: 'spacer' }),
    el('span', { text: '保存前会自动备份' }),
  ))

  return el('div', { class: 'diary-layout' }, rail, body)
}

function renderDayMemories(rows) {
  const wrap = el('div', { class: 'day-panel' })
  wrap.appendChild(el('div', { class: 'section-head' },
    el('h3', { class: 'h3', style: { margin: 0 }, text: `这一天，她还记得 ${rows.length} 条` }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'muted small', text: '来自 QQ 长期记忆' }),
  ))
  if (!rows.length) {
    wrap.appendChild(el('div', { class: 'empty', text: '这一天还没有长期记忆。' }))
    return wrap
  }
  for (const row of rows) {
    wrap.appendChild(el('div', { class: 'day-mem', role: 'button', tabindex: '0', on: {
      click: () => focusMemory(row, { query: true }),
      keydown: (e) => { if (e.key === 'Enter') focusMemory(row, { query: true }) },
    } },
    el('span', { class: `pill ${row.tier}`, text: tierLabel(row.tier) }),
    el('span', { class: 'day-mem-text', text: row.text }),
    el('span', { class: 'muted small', text: `${Math.round((row.recall || 0) * 100)}%` }),
    ))
  }
  return wrap
}

function paintDiaryDay(box, date) {
  const cached = S.diary.days[date]
  if (!cached) {
    box.replaceChildren(el('div', { class: 'empty small', text: '正在看这一天的记忆…' }))
    return
  }
  if (cached.error) box.replaceChildren(el('div', { class: 'empty small', text: cached.error }))
  else box.replaceChildren(renderDayMemories(cached.rows || []))
}

async function loadDiaryDay(date, force = false) {
  if (!date) return
  const cached = S.diary.days[date]
  if (cached && !force && Date.now() - cached.at < 30000) {
    const box = document.querySelector(`[data-diary-day="${CSS.escape(date)}"]`)
    if (box) paintDiaryDay(box, date)
    return
  }
  try {
    const data = await api(`/diary/day?date=${encodeURIComponent(date)}`)
    S.diary.days[date] = { at: Date.now(), rows: data.memories || [] }
  } catch (error) {
    S.diary.days[date] = { at: Date.now(), rows: [], error: error.message }
  }
  const box = document.querySelector(`[data-diary-day="${CSS.escape(date)}"]`)
  if (box) paintDiaryDay(box, date)
}

async function editDiaryEntry(book, entry) {
  const result = await openModal({
    title: `编辑 ${entry.date}`,
    desc: `改的是「${book.subtitle}」里的这一页。保存前会备份一份，别的页一个字不动。`,
    submit: '保存这一页',
    fields: [{ name: 'body', label: '这一页的 markdown', type: 'textarea', value: entry.body, rows: 18, maxlength: 60000 }],
  })
  if (!result) return
  try {
    const data = await withBusy(() => api('/diary/save', { method: 'POST', body: { book: book.id, index: entry.index, body: result.body, mtime: book.mtime } }))
    S.diary.books = S.diary.books.map((b) => (b.id === data.id ? data : b))
    S.diary.index = entry.index
    toast('这一页存好了，旧版本已备份', 'ok')
    await refreshOverview({ paint: false })
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
    if (/刚被改过/.test(error.message)) { S.diary.books = null; paintCurrent() }
  }
}

async function unlockPrivateDiaryUI() {
  const input = document.getElementById('diary-password')
  const password = String(input?.value || '')
  if (!password) { toast('先输入密码', 'error'); return }
  try {
    const data = await api('/diary/unlock', { method: 'POST', body: { password } })
    S.diary.token = data.token
    sessionStorage.setItem('feiyu-diary-token', data.token)
    await loadDiary()
    toast('解开了，30 分钟后自动重新上锁', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function resetPrivateDiaryUI() {
  if (!window.confirm('重置私密日记密码？旧密码会失效，新密码只能问肥鱼；日记内容不会丢。')) return
  try {
    await api('/diary/reset', { method: 'POST', body: {} })
    S.diary.token = ''
    sessionStorage.removeItem('feiyu-diary-token')
    await loadDiary()
    toast('已重置密码；新密码问肥鱼，她愿不愿意说是另一回事', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function appendDiaryEntry() {
  const book = diaryBook(S.diary.book)
  const result = await openModal({
    title: '补一页日记',
    desc: '会加在这本的最后。日期默认今天（本地时区）。',
    submit: '写上去',
    fields: [
      { name: 'date', label: '日期', type: 'text', value: todayLocal(), placeholder: 'YYYY-MM-DD', required: true },
      { name: 'label', label: '页名（可选）', type: 'text', placeholder: '比如：第一页、后半夜', maxlength: 40 },
      { name: 'body', label: '正文（markdown）', type: 'textarea', rows: 14, maxlength: 60000, placeholder: '### 今天\n\n…' },
    ],
  })
  if (!result) return
  try {
    const data = await withBusy(() => api('/diary/append', { method: 'POST', body: {
      book: book.id, date: result.date, label: result.label, body: result.body, mtime: book?.mtime || 0,
    }, headers: book?.private && S.diary.token ? { 'x-diary-token': S.diary.token } : {} }))
    if (book?.private) {
      await loadDiary()
      toast('补上了', 'ok')
      return
    }
    S.diary.books = S.diary.books.map((b) => (b.id === data.id ? data : b))
    S.diary.index = data.entries.length - 1
    S.diary.showIntro = false
    toast('补上了', 'ok')
    await refreshOverview({ paint: false })
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function toggleDiaryAutoImport(event) {
  const enabled = event.target.checked
  try {
    await api('/diary/auto-import', { method: 'POST', body: { enabled } })
    S.diary.autoImport = enabled
    toast(enabled ? '已开启：每天自动收公开日记（私密本仍手动）' : '已关闭自动收日记', 'ok')
  } catch (error) {
    event.target.checked = !enabled
    toast(error.message, 'error')
  }
}

async function catchupDiaryNow() {
  try {
    const data = await api('/diary/catchup', { method: 'POST', body: {} })
    S.diary.books = null
    paintCurrent()
    toast(data.ok ? '补写了一页漏掉的日记' : '没有可补的日记，或昨天的聊天材料已经滚掉了', data.ok ? 'ok' : 'error')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function saveDiaryToMemory(book, entry) {
  const chatScopes = (S.overview?.scopes || []).filter((s) => s.scope !== 'global')
  const ownerScope = S.overview?.ownerQQ ? `private:${S.overview.ownerQQ}` : ''
  if (ownerScope && !chatScopes.some((s) => s.scope === ownerScope)) chatScopes.unshift({ scope: ownerScope, label: '老大的私聊' })
  if (!chatScopes.length) { toast('还没有聊天可记，先在 QQ 里聊一句', 'error'); return }

  const text = mdToText(entry.body).slice(0, 500)
  const result = await openModal({
    title: '把这一页收进 QQ 记忆',
    desc: `${book.private ? '注意：这是私密本。收进去以后，QQ 聊天里她可能会想起来。\n\n' : ''}存进去的是一条普通长期记忆，QQ 那边的回忆能搜到它。原文不会自动同步；以后日记再改，这条不会跟着变。`,
    submit: '记进记忆库',
    fields: [
      { name: 'scope', label: '记到哪', type: 'select', value: chatScopes[0].scope, options: chatScopes.map((s) => ({ value: s.scope, label: s.label })) },
      { name: 'text', label: '记忆正文', type: 'textarea', value: text, maxlength: 500, rows: 7, required: true },
      { name: 'tier', label: '层级', type: 'select', value: 'normal', options: [{ value: 'normal', label: '普通 —— 会慢慢淡' }, { value: 'core', label: '核心 —— 一直记得' }] },
      { name: 'importance', label: '重要度', type: 'range', value: 0.7, min: 0, max: 1, step: 0.05 },
    ],
  })
  if (!result) return
  try {
    await withBusy(() => api('/action', { method: 'POST', body: {
      op: 'add', scope: result.scope, text: result.text, tier: result.tier, importance: result.importance,
      tags: '日记', sourceId: `diary:${book.id}:${entry.date}:${Date.now().toString(36)}`,
      sourceTime: new Date(`${entry.date}T12:00:00`).getTime() / 1000,
    } }))
    toast('收进记忆库了，QQ 那边能想起来了', 'ok')
    await refreshOverview({ paint: false })
    await loadDiaryDay(entry.date, true)
  } catch (error) {
    toast(error.message, 'error')
  }
}


// ---------------------------------------------------------------- 整理

function todoItem(n, title, desc, action) {
  return el('div', { class: 'todo-item' },
    el('div', { class: 'todo-num', text: String(n) }),
    el('div', { class: 'todo-body' },
      el('div', { class: 'todo-title', text: title }),
      el('div', { class: 'todo-desc', text: desc }),
    ),
    action || el('span', { class: 'todo-wait', text: '不用点' }),
  )
}

function goCandidate() {
  S.library.scope = 'all'
  S.library.status = 'candidate'
  S.library.q = ''
  S.library.tier = 'all'
  S.library.sort = 'recent'
  S.library.loaded = false
  S.semantic = null
  go('library')
}

async function editEpisode(ep) {
  const outcome = window.prompt('补一句当时的结果/对方反应（留空则清空）', ep.outcome || '')
  if (outcome === null) return
  try {
    await api('/episode/update', { method: 'POST', body: { id: ep.id, outcome } })
    await loadEmotion(true)
    toast('结果已更新', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function removeEpisode(ep) {
  if (!window.confirm('删除这条情景记忆？只删事件，不影响事实记忆。')) return
  try {
    await api('/episode/delete', { method: 'POST', body: { id: ep.id } })
    await loadEmotion(true)
    toast('已删除这条情景', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function toggleQueueEnabled() {
  const next = S.upkeep.queue?.enabled === false
  try {
    await api('/queue/enabled', { method: 'POST', body: { enabled: next } })
    if (S.upkeep.queue) S.upkeep.queue.enabled = next
    toast(next ? '已继续自动整理' : '已暂停自动整理（已有队列保留）', 'ok')
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function saveQueueQuota() {
  if (!hasCap('queue-limit')) {
    toast('重启一次 DSH 后才能保存', 'error')
    return
  }
  const input = document.getElementById('queue-max')
  const groupInput = document.getElementById('queue-group-max')
  const n = Math.max(0, Math.min(2000, Math.round(Number(input?.value) || 0)))
  const g = Math.max(0, Math.min(500, Math.round(Number(groupInput?.value) || 0)))
  if ((n === 0 || g === 0) && !window.confirm('0 = 不限次数。群聊刷屏时会一直追着整理，可能很费 token。确定吗？')) return
  try {
    const data = await api('/queue/limit', { method: 'POST', body: { maxCallsPerDay: n, groupMaxCallsPerDay: g } })
    S.upkeep.queue = data
    if (S.overview) S.overview.queue = data
    toast(`已保存：每天 ${n || '不限'} 批，群聊 ${g || '不限'} 批`, 'ok')
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

function renderUpkeep() {
  const o = S.overview
  const h = o?.health
  const wrap = el('div', { class: 'upkeep-grid' })
  const queue = o?.queue || { total: 0, calls: 0, okCalls: 0, maxCalls: 40, byScope: [] }
  const candidates = Number(o?.candidate || 0)
  const decayCount = Number(o?.decay?.count || 0)
  const calls = Number(queue.okCalls ?? queue.calls ?? 0)
  const maxCalls = Number(queue.maxCalls ?? 40)
  const unlimited = maxCalls <= 0
  const capReached = !unlimited && calls >= maxCalls
  const rounds = Math.max(1, Math.ceil(Number(queue.total || 0) / 12))
  const canFlush = Array.isArray(h?.capabilities) && h.capabilities.includes('queue-flush')
  const tasks = []

  if (candidates > 0) {
    tasks.push(todoItem(tasks.length + 1, '确认拿不准的记忆', `有 ${candidates} 条候选还没生效。确认后才会正式记住；不确认也不会丢，只是先搁着。`, el('button', { class: 'btn sm primary', on: { click: () => goCandidate() } }, '去确认')))
  }
  if (queue.total > 0) {
    const capText = unlimited
      ? `每天不限次数，今天已自动提炼 ${calls} 批。`
      : capReached
        ? `今天自动提炼额度已经用满（${calls}/${maxCalls}），明天 0 点自动继续。`
        : `今天自动提炼用了 ${calls}/${maxCalls} 次，剩下的会自动跑。`
    const queueLimitText = Number(queue.maxPerChat || 0) > 0 ? `每个聊天最多留 ${queue.maxPerChat} 条，满了就停着等提炼。` : '队列不设上限，消息不会被挤掉。'
    const manualHint = canFlush
      ? '平时不用点；想现在做，去下面的队列点「整理这格」。'
      : '「整理这格」要重启一次 DSH 后才出现；现在可以先等自动。'
    tasks.push(todoItem(tasks.length + 1, '等聊天被提炼', `还有 ${queue.total} 条消息排着，约 ${rounds} 轮（每轮最多 12 条）。${capText}${queueLimitText}${manualHint}`, el('button', { class: 'btn sm', on: { click: () => document.getElementById('queue-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) } }, '看明细')))
  }
  if (decayCount > 0) {
    tasks.push(todoItem(tasks.length + 1, '清理快淡忘的（可选）', `有 ${decayCount} 条到了归档线。归档不是删除，之后还能恢复；不想动可以不动。`, el('button', { class: 'btn sm', on: { click: () => previewDecay() } }, '先看看')))
  }

  const todoCard = el('section', { class: 'card pad todo-card', style: { gridColumn: '1 / -1' } },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '现在要做的' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: '按顺序来，不用一次做完' }),
    ),
    el('p', { class: 'note', style: { margin: '0 0 10px' } }, '整理不是清空，也不是点一下就全没：它把攒着的聊天分批提炼成记忆，一次最多 12 条；提炼出 0 条候选也正常，说明这批只是聊天、没有可记的事实。只有「待确认」需要你点头；队列会自动跑；衰减是可选的归档。'),
    el('div', { class: 'todo-list' }, tasks.length ? tasks : el('div', { class: 'empty', text: '现在没有需要你处理的。' })),
  )

  const healthNote = h?.memvec?.ok && h?.bridge?.ok
    ? '记忆库、桥接、QQ 都在线。这一块只在你怀疑出问题时看，平时不用管。'
    : '有服务没在跑。回忆/写入可能会失败，先看下面的红色项。'
  const healthCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '服务状态' })),
    el('p', { class: 'note', style: { margin: '0 0 10px' } }, healthNote),
    el('dl', { class: 'kv-grid' },
      el('dt', { text: '记忆库' }), el('dd', { text: h?.memvec?.ok ? `在线 · ${h.memvec.total} 条 · 平均强度 ${h.memvec.avg_strength_days ?? '—'} 天` : h?.memvec?.error || '—' }),
      el('dt', { text: '桥接' }), el('dd', { text: h?.bridge?.ok ? `${h.bridge.role || '大肥鱼'} · ${h.bridge.mode || '—'}${h.bridge.paused ? ' · 暂停中' : ''}` : h?.bridge?.error || '—' }),
      el('dt', { text: 'QQ' }), el('dd', { text: h?.bridge?.snowluma ? (h.bridge.snowluma.good ? '连接正常' : (h.bridge.snowluma.hint || '连接异常')) : '—' }),
      el('dt', { text: '数据库' }), el('dd', null, el('span', { class: 'mono', text: h?.db?.path || '—' }), h?.db?.ok ? el('span', { class: 'muted small', text: ` · ${fmtBytes(h.db.bytes)}` }) : null),
      el('dt', { text: '记忆服务' }), el('dd', { class: 'mono', text: MEMVEC }),
    ),
  )

  const decayDetails = el('details', { class: 'advanced' },
    el('summary', null, decayCount > 0 ? '高级：现在预览 / 清理' : '高级：查看规则'),
    el('p', { class: 'note' }, '太久没被想起、又不是核心/待办/高重要的记忆，会先归档（不是销毁）。在「长期记忆 → 已归档」里还能找到并恢复。'),
    decayCount > 0
      ? el('div', { class: 'row', style: { marginTop: '8px' } },
          el('button', { class: 'btn sm', on: { click: () => previewDecay() } }, '先看看会清掉谁'),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn sm danger', on: { click: () => runDecay() } }, '确认归档'),
        )
      : el('p', { class: 'note', style: { marginBottom: 0 } }, '现在没有到线的，不用动。'),
    el('div', { id: 'decay-box' }),
  )
  const decayCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '清理快淡忘的（可选）' }), el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: decayCount ? `${decayCount} 条到线` : '现在不用动' })),
    el('p', { class: 'note' }, '这一步不是必须的。它会归档「很久没被想起、又不重要」的记忆；归档不是删除，之后还能恢复。'),
    decayDetails,
  )

  const queueCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '还没提炼的聊天' }), el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: `${calls} 批今天 · ${unlimited ? '不限' : `上限 ${maxCalls}`} · 约 ${rounds} 轮` })),
    el('p', { class: 'note', style: { margin: '0 0 8px' } }, capReached
      ? `今天自动提炼额度用满（${calls}/${maxCalls}），明天 0 点自动继续。一次最多提炼 12 条，${queue.total} 条约 ${rounds} 轮；不是点一下全没，处理完才从队列消失。想现在做，点每一格右边的「整理这格」——手动不受今天额度限制。`
      : '桥接每 15 秒看一次；一个聊天攒够 12 条、或安静 90 秒，就交给模型提炼成候选记忆。一次最多 12 条，处理完才从队列消失；0 条候选也正常。平时不用点，想现在催一下再点「整理这格」。'),
    el('div', { class: 'row', style: { margin: '8px 0 10px' } },
      el('span', { class: 'muted small', text: '每天自动提炼上限' }),
      el('input', { id: 'queue-max', class: 'input', type: 'number', min: '0', max: '2000', value: String(maxCalls), style: { width: '96px' }, disabled: !hasCap('queue-limit') || !hasBridgeCap('queue-limit') }),
      el('span', { class: 'muted small', text: '0 = 不限' }),
      el('span', { class: 'muted small', text: '群聊每天上限' }),
      el('input', { id: 'queue-group-max', class: 'input', type: 'number', min: '0', max: '500', value: String(Number(queue.groupMaxCalls ?? 20)), style: { width: '80px' }, disabled: !hasCap('queue-limit') }),
      el('button', { class: 'btn sm primary', disabled: !hasCap('queue-limit'), on: { click: () => saveQueueQuota() } }, '保存'),
      el('span', { class: 'muted small', text: hasCap('queue-limit') ? '保存后立刻生效，不用重启' : '重启 DSH 后才能保存' }),
    ),
    el('div', { class: 'row', style: { margin: '0 0 8px' } },
      el('button', { class: 'btn sm', on: { click: () => toggleQueueEnabled() } }, queue.enabled === false ? '继续自动整理' : '暂停自动整理'),
      el('span', { class: 'muted small', text: '暂停后不再收新消息进队列；已有队列保留，手动「整理这格」仍可用' }),
    ),
    !canFlush ? el('p', { class: 'note', style: { margin: '0 0 8px' } }, '「整理这格」按钮要重启一次 DSH 后端才会出现；重启前可以先等自动提炼。') : null,
    el('div', { id: 'queue-box', class: 'queue-table' }, el('div', { class: 'empty', text: S.upkeep.queue ? '' : '正在读队列…' })),
  )

  const dataCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '备份 / 导出' })),
    el('p', { class: 'note' }, '导出一份 JSON：正文、状态、层级、鲜活度、来源时间都在里面。适合备份，或者你自己拿去分析。'),
    el('div', { class: 'row', style: { marginTop: '10px' } },
      el('a', { class: 'btn', href: `${BASE}/api/export`, download: 'feiyu-memories.json' }, '导出全部记忆'),
    ),
    el('p', { class: 'note', style: { marginBottom: 0 } }, '控制台只读本机文件，也只连 127.0.0.1 上的记忆服务和桥接。没有把任何一条记忆发到外面。'),
  )

  const auditCard = el('section', { class: 'card pad', style: { gridColumn: '1 / -1' } },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '最近改了什么' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: '每次写入都留了 before / after；能撤的这里可以直接撤' }),
      el('button', { class: 'btn sm ghost', title: '重新读审计日志', on: { click: () => loadAudit() } }, icon('refresh')),
    ),
    el('div', { id: 'audit-box', class: 'audit-list' }, el('div', { class: 'empty small', text: '正在读审计日志…' })),
    el('div', { id: 'audit-path', class: 'audit-path mono', text: '' }),
  )

  wrap.append(todoCard, healthCard, decayCard, queueCard, dataCard, auditCard)
  queueMicrotask(loadQueue)
  queueMicrotask(loadAudit)
  return wrap
}

async function flushQueue(row) {
  const ok = await confirmDialog({
    title: '现在手动整理这一格？',
    desc: `只处理「${row.label}」这一格，最多 12 条消息；新增的是候选记忆，之后还要确认。\n\n手动不受今天自动额度限制，但会花一次模型调用。如果这 12 条只是闲聊，提炼出 0 条候选也是正常的。`,
    ok: '开始整理',
  })
  if (!ok) return
  try {
    const data = await withBusy(() => api('/queue/flush', { method: 'POST', body: { key: row.key } }))
    const r = data.result || {}
    const left = Number((data.queue?.byScope || []).find((x) => x.key === row.key)?.count || 0)
    const tail = left ? `；这格还剩 ${left} 条` : '；这格清空了'
    if (r.ok) toast(`整理完 ${r.messages || 0} 条，新增 ${r.candidates || 0} 条候选${tail}${r.candidates ? '' : '（0 条候选说明这批只是聊天，没有可记的事实）'}`, 'ok')
    else if (r.reason === 'empty') toast('这一格现在没有可提炼的消息', 'error')
    else if (r.reason === 'busy') toast('它正在整理另一格，等一会儿再点', 'error')
    else if (r.reason === 'disabled') toast('桥接现在暂停或关闭了', 'error')
    else toast(r.error || r.reason || '这次没整理成', 'error')
    await refreshOverview({ paint: false })
    S.upkeep.queue = null
    paintCurrent()
  } catch (error) {
    if (String(error.message).includes('404')) toast('这个按钮要重启一次 DSH 才生效：后端路由还没加载', 'error')
    else toast(error.message, 'error')
  }
}

async function loadQueue() {
  try {
    const data = await withBusy(() => api('/queue'))
    S.upkeep.queue = data
    const box = $('#queue-box')
    if (!box) return
    box.replaceChildren()
    if (!data.byScope.length) {
      box.appendChild(el('div', { class: 'empty', text: '队列是空的，都整理完了。' }))
      return
    }
    const canFlush = Array.isArray(S.overview?.health?.capabilities) && S.overview.health.capabilities.includes('queue-flush')
    for (const row of data.byScope) {
      box.appendChild(el('div', { class: 'queue-item' },
        el('div', { class: 'head' },
          el('span', { class: 'pill', text: `${row.count} 条` }),
          el('span', { text: row.label }),
          el('span', { class: 'spacer' }),
          row.pausedUntil
            ? el('span', { class: 'pill deleted', text: '低产出暂停 7 天' })
            : el('span', { class: 'muted small', text: `产出 ${row.yieldCandidates || 0}/${row.yieldBatches || 0} 批` }),
          el('span', { class: 'muted small', text: row.lastAt ? `最后一条 ${fmtWhen(row.lastAt)}` : '' }),
          canFlush ? el('button', { class: 'btn sm', title: '会调用一次模型，最多处理 12 条', on: { click: () => flushQueue(row) } }, '整理这格') : null,
        ),
        el('div', { class: 'samples' }, row.samples.map((m) => el('div', { class: 'sample' },
          el('span', { text: m.sender || '—' }),
          el('span', { text: m.text }),
        ))),
      ))
    }
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function loadAudit() {
  const box = $('#audit-box')
  if (!box) return
  try {
    const data = await withBusy(() => api('/audit?limit=40'))
    if (!box.isConnected) return
    box.replaceChildren()
    const pathLine = $('#audit-path')
    if (pathLine) pathLine.textContent = data.path || ''
    if (!data.entries.length) {
      box.appendChild(el('div', { class: 'empty small', text: '还没有操作记录。' }))
      return
    }
    for (const entry of data.entries) {
      const row = el('div', { class: 'audit-row' },
        el('span', { class: 'audit-time', text: fmtWhen(Date.parse(entry.at)) }),
        el('span', { class: 'audit-op', text: entry.label || entry.op }),
        el('span', { class: 'audit-summary', text: entry.summary || '', title: entry.error || '' }),
      )
      if (entry.status === 'error') row.appendChild(el('span', { class: 'pill deleted', text: '失败' }))
      else if (entry.undone) row.appendChild(el('span', { class: 'pill archived', text: '已撤销' }))
      else if (entry.undoable) {
        row.appendChild(el('button', {
          class: 'btn sm ghost audit-undo', type: 'button',
          on: { click: () => undoEntry(entry) },
        }, '撤销'))
      } else {
        row.appendChild(el('span', { class: 'muted small', text: '不可撤销' }))
      }
      box.appendChild(row)
    }
  } catch (error) {
    if (box.isConnected) box.replaceChildren(el('div', { class: 'empty small', text: error.message }))
  }
}

async function undoEntry(entry) {
  const ok = await confirmDialog({
    title: '撤销这条操作？',
    desc: `撤销：${entry.summary}\n\n如果这条之后又被改过，会拒绝撤销，不会硬盖。`,
    ok: '撤销', danger: true,
  })
  if (!ok) return
  try {
    const data = await withBusy(() => api('/undo', { method: 'POST', body: { id: entry.id } }))
    toast(`已撤销：${data.summary}`, 'ok')
    await refreshOverview({ paint: false })
    if (S.tab === 'library') await loadLibrary()
    if (S.tab === 'diary') { S.diary.books = null; S.diary.days = {}; paintCurrent() }
    else await loadAudit()
  } catch (error) {
    toast(error.message, 'error')
    await loadAudit()
  }
}

async function previewDecay() {
  const box = $('#decay-box')
  if (box) box.replaceChildren(el('div', { class: 'empty', text: '正在算…' }))
  try {
    const data = await withBusy(() => api('/decay/preview'))
    S.upkeep.preview = data
    if (!box) return
    box.replaceChildren(el('div', { class: 'note', style: { marginTop: '10px' } }, `现在活着的 ${data.totalActive} 条里，这一轮会被归档的是 `, el('b', { text: String(data.count) }), ' 条。'))
    if (data.rows.length) {
      box.appendChild(el('div', { class: 'decay-list' }, data.rows.map((r) => el('div', { class: 'decay-row' },
        el('span', { text: r.text }),
        el('span', { class: 'num', text: `${Math.round((r.recall || 0) * 100)}%` }),
      ))))
    }
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function runDecay() {
  const count = S.upkeep.preview?.count ?? S.overview?.decay?.count ?? 0
  const ok = await confirmDialog({
    title: '现在跑一次衰减？',
    desc: `大概会归档 ${count} 条「太久没想起、又不重要」的记忆。归档不是删除，在「长期记忆 → 已归档」里还能找到并恢复。\n\n要跑吗？`,
    ok: '跑吧', danger: true,
  })
  if (!ok) return
  try {
    const data = await withBusy(() => api('/decay', { method: 'POST', body: { run: true } }))
    toast(`跑完了：归档 ${data.removed ?? 0} 条`, 'ok')
    S.upkeep.preview = null
    await afterChange()
  } catch (error) {
    toast(error.message, 'error')
  }
}

// ---------------------------------------------------------------- 性格

const PERSONA_DIMS = [
  ['warm', '温度'],
  ['initiative', '主动'],
  ['clingy', '黏人'],
  ['stability', '情绪稳定'],
  ['playful', '玩心'],
  ['proud', '嘴硬'],
]

function personaDims(data) {
  const spec = data?.persona?.spec?.dimensions
  if (Array.isArray(spec) && spec.length) return spec.map((d) => [d.key, d.label || d.key])
  return PERSONA_DIMS
}

async function loadPersona() {
  if (S.personaLoading) return
  S.personaLoading = true
  try {
    S.persona = await api('/persona')
  } catch (error) {
    S.persona = { error: error.message }
  } finally {
    S.personaLoading = false
    updateTabs()
    if (S.tab === 'persona') paintCurrent()
  }
}

function personaDeltaText(deltas, dims = PERSONA_DIMS) {
  const labels = Object.fromEntries(dims)
  const parts = Object.entries(deltas || {}).map(([k, v]) => `${labels[k] || k}${v > 0 ? '+' : ''}${v}`)
  return parts.join(' · ') || '只改了自述'
}

function personaEntryText(h) {
  const dims = personaDims(S.persona)
  const parts = []
  if (Object.keys(h?.deltas || {}).length) parts.push(personaDeltaText(h.deltas, dims))
  if (Object.keys(h?.baselineDeltas || {}).length) parts.push(`底色 ${personaDeltaText(h.baselineDeltas, dims)}`)
  return parts.join(' · ') || '只改了自述'
}

function renderPersona() {
  const data = S.persona
  if (!data) return el('div', { class: 'empty', text: '正在读她的性格…' })
  if (data.error) return el('div', { class: 'empty', text: `读不到性格状态：${data.error}` })
  const p = data.persona
  if (!p) {
    if (S.personaEdit) return renderPersonaEditor()
    return el('section', { class: 'card pad' },
      el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '还没有性格状态' })),
      el('p', { class: 'muted', text: '可以从当前角色卡起草一版维度：草案会先放进编辑框，你改完点保存才会真正写入。' }),
      el('button', { class: 'btn sm primary', disabled: !hasCap('persona'), on: { click: () => draftPersona() } }, '从角色卡起草'),
    )
  }
  const cur = p.current || {}
  const base = p.baseline || {}
  const origin = p.originBaseline || {}
  const limits = data.limits || {}
  const dims = personaDims(data)
  const specBands = Object.fromEntries((p.spec?.dimensions || []).map((d) => [d.key, d.band]))
  const moved = dims.filter(([key]) => Number(base[key] ?? 0) !== Number(origin[key] ?? base[key] ?? 0)).length
  const hero = el('section', { class: 'hero' },
    el('div', { class: 'kicker', text: 'persona drift' }),
    el('h2', null, frag('她现在的样子：', el('em', { text: String(dims.length) }), ' 个维度，', el('em', { text: String(p.history?.length || 0) }), ' 次变化。')),
    el('p', { text: moved ? `底色已经离开原点 ${moved} 个维度。` : '底色还没动过；动的是她在底色附近的状态。' }),
  )
  const bands = dims.map(([key]) => Number(specBands[key] ?? limits.bands?.[key] ?? limits.band ?? 22))
  const bandText = bands.length ? `${Math.min(...bands)}–${Math.max(...bands)}` : String(limits.band ?? 22)
  const stats = el('section', { class: 'stats' },
    statCard(data.pending ?? 0, '攒着的事', `权重 ${data.pendingWeight ?? 0} / ${limits.minWeight ?? 12}`, (data.pendingWeight ?? 0) >= (limits.minWeight ?? 12) ? 'amber' : ''),
    statCard(bandText, '底色边界', '每维不同', 'green'),
    statCard(p.history?.length ?? 0, '变过几次', p.lastChangeAt ? `上次 ${fmtWhen(p.lastChangeAt)}` : '还没变过', 'accent'),
  )
  const traitCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: `${dims.length} 个维度` }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', disabled: !hasCap('persona'), on: { click: () => draftPersona() } }, '从角色卡起草'),
      el('button', { class: 'btn sm', disabled: !hasCap('persona') || !(p.history?.length), on: { click: () => undoPersonaChange() } }, '撤销最近变化'),
      el('button', { class: 'btn sm', disabled: !hasCap('persona'), on: { click: () => startPersonaEdit() } }, '编辑维度'),
      el('span', { class: 'muted small', text: '竖线 = 底色，浅色带 = 边界' }),
    ),
    el('div', { class: 'traits' }, dims.map(([key, label]) => {
      const value = Math.max(0, Math.min(100, Number(cur[key]) || 0))
      const anchor = Math.max(0, Math.min(100, Number(base[key]) || 0))
      const original = Math.max(0, Math.min(100, Number(origin[key] ?? base[key]) || 0))
      const band = Math.max(0, Number(specBands[key] ?? limits.bands?.[key] ?? limits.band ?? 22) || 0)
      const lo = Math.max(0, anchor - band)
      const hi = Math.min(100, anchor + band)
      return el('div', { class: 'trait' },
        el('div', { class: 'trait-head' },
          el('span', { text: label }),
          el('span', { class: 'muted small', text: `${cur[key] ?? '—'} / 底色 ${base[key] ?? '—'}${original !== anchor ? `（原点 ${original}）` : ''}（${lo}~${hi}）` }),
        ),
        el('div', { class: 'trait-track' },
          el('span', { class: 'trait-band', style: { left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` } }),
          el('div', { class: 'trait-fill', style: { width: `${value}%` } }),
          el('span', { class: 'trait-anchor', style: { left: `${anchor}%` }, title: `底色 ${base[key]}` }),
        ),
      )
    })),
  )
  const narrativeCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '她最近的自述' })),
    el('p', { class: p.narrative ? '' : 'muted', text: p.narrative || '还没什么变化，还是老样子。' }),
  )
  const hist = Array.isArray(data.history) ? [...data.history].reverse() : []
  const histCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '变化记录' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: '最近五次' }),
    ),
    hist.length
      ? el('div', { class: 'mini-list' }, hist.map((h) => el('div', { class: 'mini' },
          el('span', { class: 'd', text: fmtWhen(h.at) }),
          el('span', { class: 't', text: h.narrative || personaEntryText(h) }),
          el('span', { class: 'r', text: personaEntryText(h) }),
        )))
      : el('div', { class: 'empty', text: '还没变过。等攒够有分量的事。' }),
  )
  return frag(S.personaEdit ? renderPersonaEditor() : null, hero, stats, el('div', { class: 'panel-stack' }, traitCard, renderChatPersonaCard(), narrativeCard, histCard))
}

async function loadChatProfiles() {
  try {
    const data = await api('/persona/chat')
    S.chatProfiles = data.profiles || {}
  } catch {
    S.chatProfiles = {}
  }
  if (S.tab === 'persona') paintCurrent()
}

function renderChatPersonaCard() {
  if (!hasBridgeCap('persona-chat')) return null
  const dims = personaDims(S.persona)
  const scopes = (S.overview?.scopes || []).map((s) => ({ key: s.scope, label: s.label || s.scope }))
  const known = new Set(scopes.map((s) => s.key))
  for (const key of Object.keys(S.labels || {})) {
    if (!known.has(key)) { scopes.push({ key, label: S.labels[key] || key }); known.add(key) }
  }
  if (!S.chatScope && scopes.length) S.chatScope = scopes[0].key
  const profile = S.chatProfiles?.[S.chatScope] || {}
  const deltas = profile.deltas || {}
  const head = el('div', { class: 'section-head' },
    el('h2', { class: 'h2', text: '按聊天微调' }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'muted small', text: '只改这个聊天里的当前状态，不动全局底色' }),
  )
  if (!scopes.length) {
    return el('section', { class: 'card pad' }, head, el('p', { class: 'note', style: { marginBottom: 0 } }, '还没有可选的聊天；等有记忆或队列后再来。'))
  }
  const select = el('select', {
    class: 'select', style: { minWidth: '220px' },
    on: { change: (event) => { S.chatScope = event.target.value; paintCurrent() } },
  }, scopes.map((s) => el('option', { value: s.key, text: s.label, selected: s.key === S.chatScope })))
  const rows = dims.map(([key, label]) => el('div', { class: 'row', style: { margin: '5px 0' } },
    el('span', { class: 'muted small', style: { width: '80px' }, text: label }),
    el('input', {
      class: 'input', type: 'number', min: '-20', max: '20', value: String(Number(deltas[key]) || 0),
      'data-chat-delta': key, style: { width: '84px' },
    }),
    el('span', { class: 'muted small', text: '偏移（-20 ~ +20）' }),
  ))
  const autoDeltas = profile.autoDeltas || {}
  const autoText = Object.entries(autoDeltas).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join('，')
  return el('section', { class: 'card pad' },
    head,
    el('p', { class: 'note', style: { margin: '0 0 8px' } }, '用途：同一个人格，在不同聊天里可以有不同侧重——比如私聊更黏、群里更收敛。只改这个聊天的当前状态，不改全局底色，也不影响其他聊天。'),
    el('div', { class: 'row', style: { margin: '8px 0' } }, select),
    el('div', null, rows),
    autoText ? el('p', { class: 'note', text: `自动微调（${profile.autoReason || '长期情绪'}）：${autoText}` }) : null,
    el('div', { class: 'row', style: { marginTop: '8px' } },
      el('input', { id: 'chat-persona-note', class: 'input', style: { flex: '1' }, placeholder: '在这个聊天里的备注（可空）', value: profile.note || '' }),
      el('button', { class: 'btn sm primary', on: { click: () => saveChatPersona() } }, '保存'),
      el('button', { class: 'btn sm ghost', on: { click: () => resetChatPersona() } }, '清除'),
    ),
    el('p', { class: 'note', style: { marginBottom: 0 } }, '偏移会叠加在全局当前值上，再按这个维度的边界夹住；不会改全局 baseline，也不会写进情绪统计。'),
  )
}

async function saveChatPersona() {
  const deltas = {}
  for (const input of document.querySelectorAll('[data-chat-delta]')) {
    const key = input.getAttribute('data-chat-delta')
    const v = Math.max(-20, Math.min(20, Math.round(Number(input.value) || 0)))
    if (v !== 0) deltas[key] = v
  }
  try {
    const data = await api('/persona/chat', {
      method: 'POST',
      body: { key: S.chatScope, deltas, note: document.getElementById('chat-persona-note')?.value || '' },
    })
    S.chatProfiles = data.profiles || {}
    toast('已保存这个聊天的微调', 'ok')
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function resetChatPersona() {
  try {
    const data = await api('/persona/chat', { method: 'POST', body: { key: S.chatScope, deltas: {}, note: '', clearAuto: true } })
    S.chatProfiles = data.profiles || {}
    toast('已清除这个聊天的微调', 'ok')
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function undoPersonaChange() {
  if (!window.confirm('撤销最近一次人格变化？会把当前值和底色恢复到变化前；之后又变过则不会执行。')) return
  try {
    await api('/persona/undo', { method: 'POST', body: {} })
    S.persona = null
    await loadPersona()
    toast('已撤销最近一次人格变化', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function draftPersona() {
  if (!hasCap('persona')) {
    toast('重启一次 DSH 后才能起草', 'error')
    return
  }
  try {
    const data = await api('/persona/draft', { method: 'POST', body: {} })
    const dims = data?.spec?.dimensions
    if (!Array.isArray(dims) || !dims.length) throw new Error('草案里没有有效维度')
    S.personaEdit = dims.map((d) => ({ ...d }))
    toast('草案已生成：改完点保存才会写入', 'ok')
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

function startPersonaEdit() {
  const p = S.persona?.persona
  if (!p) return
  S.personaEdit = (p.spec?.dimensions || []).map((d) => ({ ...d }))
  paintCurrent()
}

function renderPersonaEditor() {
  const rows = (S.personaEdit || []).map((d) => el('div', { class: 'row', style: { margin: '6px 0' } },
    el('span', { class: 'mono small', style: { width: '90px' }, text: d.key }),
    el('input', { class: 'input', style: { width: '110px' }, value: d.label, on: { input: (e) => { d.label = e.target.value } } }),
    el('span', { class: 'muted small', text: '底色' }),
    el('input', { class: 'input', type: 'number', min: '0', max: '100', style: { width: '72px' }, value: String(d.baseline), on: { input: (e) => { d.baseline = Number(e.target.value) } } }),
    el('span', { class: 'muted small', text: '边界' }),
    el('input', { class: 'input', type: 'number', min: '0', max: '40', style: { width: '72px' }, value: String(d.band), on: { input: (e) => { d.band = Number(e.target.value) } } }),
  ))
  return el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '编辑维度' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: '保存后桥接立刻重读，不用重启' }),
    ),
    el('p', { class: 'note' }, '底色是锚点，边界是每维最多能偏多少。改完会重置这几维的原点和当前值，历史记录保留。'),
    el('div', null, rows),
    el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn sm primary', on: { click: () => savePersonaSpec() } }, '保存'),
      el('button', { class: 'btn sm ghost', on: { click: () => { S.personaEdit = null; paintCurrent() } } }, '取消'),
    ),
  )
}

async function savePersonaSpec() {
  if (!hasCap('persona')) {
    toast('重启一次 DSH 后才能保存', 'error')
    return
  }
  try {
    await api('/persona/spec', { method: 'POST', body: { dimensions: S.personaEdit } })
    S.persona = null
    S.personaEdit = null
    await loadPersona()
    toast('性格维度已保存', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

// ---------------------------------------------------------------- 情绪

async function loadEmotion(quiet = false) {
  if (S.emotionLoading) return
  S.emotionLoading = true
  try {
    const [data, eps] = await Promise.all([api('/emotion'), api('/episodes?limit=10')])
    S.emotion = data
    S.emotionEpisodes = eps.items || []
    if (S.tab === 'emotion') {
      paintCurrent()
      startEmotionPolling()
    }
  } catch (error) {
    if (!quiet) toast(error.message, 'error')
  } finally {
    S.emotionLoading = false
  }
}

function startEmotionPolling() {
  if (S.emotionTimer) clearInterval(S.emotionTimer)
  S.emotionTimer = setInterval(() => {
    if (S.tab !== 'emotion') { clearInterval(S.emotionTimer); S.emotionTimer = 0; return }
    if (!S.emotionLoading) void loadEmotion(true)
  }, 15000)
}

function renderEmotion() {
  const data = S.emotion
  if (!data) return el('div', { class: 'empty', text: '正在读她的情绪…' })
  if (!data.emotion) {
    return el('section', { class: 'card pad' },
      el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '情绪层还没开始' })),
      el('p', { class: 'muted', text: '桥接启动后会创建 emotion.json；之后每来一条消息，情绪会按规则更新。不调用模型，不花 token。' }),
    )
  }
  const e = data.emotion
  const st = e.state || {}
  const mood = e.mood || {}
  const base = e.baseline || {}
  const label = String(st.label || '平静')
  const intensity = Math.max(0, Math.min(1, Number(st.intensity) || 0))
  const valence = Number(st.valence) || 0
  const arousal = Number(st.arousal) || 0
  const history = Array.isArray(e.history) ? e.history.slice(-120) : []
  const triggers = Array.isArray(e.triggers) ? e.triggers.slice(0, 10) : []
  const metrics = e.metrics || {}
  const climate = e.climate?.owner || {}
  const drifts = Array.isArray(e.drifts) ? e.drifts.slice(0, 5) : []
  const episodes = Array.isArray(S.emotionEpisodes) ? S.emotionEpisodes : []
  const weights = S.emotion?.weights || { owner: 1.1, group: 1, private: 0.8 }
  const spanDays = climate.since ? Math.max(0, (Date.now() - Number(climate.since)) / 86400000) : 0
  const sourceName = { owner: '老大', group: '群聊', private: '私聊', world: '外界' }

  const hero = el('section', { class: 'hero' },
    el('div', { class: 'kicker', text: 'emotion state' }),
    el('h2', null, frag('她现在：', el('em', { text: label }), `，强度 ${intensity.toFixed(2)}。`)),
    el('p', { text: `快变量是“现在”，心情是“今天”，底色是“长期”。情绪不会直接改人格。` }),
  )
  const stats = el('section', { class: 'stats' },
    statCard(label, '现在', `强度 ${intensity.toFixed(2)}`, intensity > 0.55 ? 'amber' : ''),
    statCard(String(mood.label || '平静'), '心情', `V ${Number(mood.valence || 0).toFixed(2)} · A ${Number(mood.arousal || 0).toFixed(2)}`, 'green'),
    statCard(`V ${Number(base.valence || 0).toFixed(2)}`, '底色', `A ${Number(base.arousal || 0).toFixed(2)}`, 'accent'),
  )

  const padCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '核心情绪盘' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: '横轴：难受 ↔ 舒服 · 纵轴：低唤醒 ↔ 高唤醒' }),
    ),
    el('canvas', { id: 'emotion-pad', class: 'emotion-pad' }),
    el('p', { class: 'note', style: { marginBottom: 0 } }, '点按环形模型（Russell）：valence/arousal 两维；轨迹是最近 120 个采样，点越大表示强度越高。'),
  )

  const triggersCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '最近触发' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: `共 ${Number(metrics.events || 0)} 次更新` }),
    ),
    triggers.length
      ? el('div', { class: 'mini-list' }, triggers.map((t) => el('div', { class: 'mini' },
          el('span', { class: 'd', text: fmtWhen(t.at) }),
          el('span', { class: 't', text: `${sourceName[t.source] || t.source || '—'}：${t.summary || '—'}` }),
          el('span', { class: 'r', text: `${t.label || '—'}  V${Number(t.deltaV || 0) >= 0 ? '+' : ''}${Number(t.deltaV || 0).toFixed(2)} / A${Number(t.deltaA || 0) >= 0 ? '+' : ''}${Number(t.deltaA || 0).toFixed(2)}` }),
        )))
      : el('div', { class: 'empty', text: '还没有触发。等她收到第一条有情绪的话。' }),
  )

  const episodeCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '最近事件' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: `${episodes.length} 条情景记忆` }),
    ),
    episodes.length
      ? el('div', { class: 'mini-list' }, episodes.map((ep) => el('div', { class: 'mini' },
          el('span', { class: 'd', text: fmtWhen(ep.at) }),
          el('span', { class: 't', text: `${ep.summary || '—'}${ep.action ? ` → ${ep.action}` : ''}${ep.outcome ? `（${ep.outcome}）` : ''}` }),
          el('span', { class: 'r', text: `${ep.emotion?.label || '—'} · ${ep.detail === 'full' ? '全文' : '摘要'} · 重要 ${Number(ep.importance || 0).toFixed(2)}` }),
          el('button', { class: 'btn sm ghost', on: { click: () => editEpisode(ep) } }, '补结果'),
          el('button', { class: 'btn sm ghost', on: { click: () => removeEpisode(ep) } }, '删除'),
        )))
      : el('div', { class: 'empty', text: '还没有到“值得记成情景”的事件。语气重、关系相关、或者明确要记住的话，会进这里。' }),
  )

  const metricsCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '回路仪表' })),
    el('dl', { class: 'kv-grid' },
      el('dt', { text: '正向 / 负向' }), el('dd', { text: `${Number(metrics.positive || 0)} / ${Number(metrics.negative || 0)}` }),
      el('dt', { text: '单次最大跳变' }), el('dd', { text: Number(metrics.maxJump || 0).toFixed(2) }),
      el('dt', { text: '最近更新' }), el('dd', { text: e.updatedAt ? fmtWhen(e.updatedAt) : '—' }),
      el('dt', { text: '采样点' }), el('dd', { text: String(history.length) }),
    ),
    el('p', { class: 'note', style: { marginBottom: 0 } }, '如果单次跳变经常 > 0.5，说明 appraisal 给得太重，应该降权；如果长期曲线贴着一个角不动，说明回路在自我强化。'),
  )

  const climateCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '长期气候 → 人格微调' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: e.lastDriftAt ? `上次微调 ${fmtWhen(e.lastDriftAt)}` : '还没微调过' }),
    ),
    el('dl', { class: 'kv-grid' },
      el('dt', { text: '老大样本' }), el('dd', { text: `${Number(climate.samples || 0)} 条 · ${spanDays.toFixed(1)} 天` }),
      el('dt', { text: '长期 V / A / S' }), el('dd', { text: `${Number(climate.valence || 0).toFixed(2)} / ${Number(climate.arousal || 0).toFixed(2)} / ${Number(climate.social || 0).toFixed(2)}` }),
      el('dt', { text: '触发条件' }), el('dd', { text: '≥40 条、≥3 天、偏离底色 0.18、7 天冷却' }),
    ),
    el('div', { class: 'row', style: { marginTop: '8px' } },
      el('label', { class: 'row' },
        el('input', {
          type: 'checkbox', checked: S.emotion?.driftEnabled !== false, disabled: !hasCap('emotion'),
          on: { change: (event) => toggleEmotionDrift(event) },
        }),
        el('span', { class: 'muted small', text: '允许长期情绪微调人格' }),
      ),
      el('select', {
        class: 'select', style: { width: '120px' }, disabled: !hasCap('emotion'),
        on: { change: (event) => setEmotionDriftMode(event) },
      },
      el('option', { value: 'apply', text: '直接应用', selected: S.emotion?.driftMode !== 'suggest' }),
      el('option', { value: 'suggest', text: '只建议不应用', selected: S.emotion?.driftMode === 'suggest' }),
      ),
      el('span', { class: 'muted small', text: '7 天冷却 · 单次 ±1 · 最多两维' }),
    ),
    el('label', { class: 'row', style: { marginTop: '6px' } },
      el('input', {
        type: 'checkbox', checked: S.emotion?.appraisalModelEnabled === true, disabled: !hasCap('emotion'),
        on: { change: (event) => toggleAppraisalModel(event) },
      }),
      el('span', { class: 'muted small', text: '模型复核高情绪消息（默认关，只对老大私聊，每天最多 3 次）' }),
    ),
    el('p', { class: 'note', style: { margin: '4px 0 0' } }, '开：长期情绪会改人格底色，影响之后所有聊天；关：只记录情绪，不改人格。模式「直接应用」会自动改；「只建议」只写建议，需要你点采纳。模型复核开：高情绪消息多一次模型调用（花 token）；关：全程规则，0 token。'),
    drifts.length
      ? el('div', { class: 'mini-list', style: { marginTop: '10px' } }, drifts.map((d) => el('div', { class: 'mini' },
          el('span', { class: 'd', text: fmtWhen(d.at) }),
          el('span', { class: 't', text: Object.entries(d.deltas || {}).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join('，') }),
          el('span', { class: 'r', text: d.reason || '' }),
          d.reverted
            ? el('span', { class: 'pill archived', text: '已撤销' })
            : d.rejected
              ? el('span', { class: 'pill archived', text: '已拒绝' })
              : d.applied === false
                ? el('span', { class: 'row' },
                    el('button', { class: 'btn sm primary', on: { click: () => acceptEmotionDrift(d.id) } }, '采纳'),
                    el('button', { class: 'btn sm ghost', on: { click: () => rejectEmotionDrift(d.id) } }, '拒绝'),
                  )
                : el('button', { class: 'btn sm ghost', on: { click: () => revertEmotionDrift() } }, '撤销'),
        )))
      : el('p', { class: 'note', style: { marginBottom: 0 } }, '长期情绪和底色还没拉开差距；拉开后会只动 1–2 个维度、每次 ±1，并写进性格变化记录。'),
  )

  const weightsCard = el('section', { class: 'card pad' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '情绪影响权重' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: '只改当前情绪幅度，不改长期人格' }),
    ),
    el('p', { class: 'note', style: { margin: '0 0 8px' } }, '管理员私聊默认 1.1，群聊 1，非管理员私聊 0.8。调高更容易被这类消息带动，调低更不容易。范围 0.2–3。'),
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
      ['owner', 'group', 'private'].map((kind) => el('label', { class: 'row', style: { gap: '6px' } },
        el('span', { class: 'muted small', text: kind === 'owner' ? '管理员' : kind === 'group' ? '群聊' : '朋友私聊' }),
        el('input', {
          id: `emotion-weight-${kind}`, class: 'input', type: 'number', min: '0.2', max: '3', step: '0.1',
          value: String(Number(weights[kind]) || 1), style: { width: '76px' },
        }),
      )),
      el('button', { class: 'btn sm primary', on: { click: () => saveEmotionWeights() } }, '保存'),
    ),
  )

  const optionsCard = el('section', { class: 'card pad' },    el('div', { class: 'section-head' }, el('h2', { class: 'h2', text: '选项与后果' })),
    el('label', { class: 'row', style: { margin: '8px 0 4px' } },
      el('input', {
        type: 'checkbox', checked: S.emotion?.chatDriftEnabled !== false, disabled: !hasCap('emotion'),
        on: { change: (event) => toggleChatDrift(event) },
      }),
      el('span', { class: 'muted small', text: '按聊天自动微调' }),
    ),
    el('p', { class: 'note', style: { margin: '0 0 10px' } }, '开：非管理员私聊会根据该聊天长期情绪，自动加一点 local offset（群聊仍默认关），7 天冷却、单次最多 ±2、累计 ±12。关：只有你手动填的偏移，不会自己变。'),
    el('label', { class: 'row', style: { margin: '8px 0 4px' } },
      el('input', {
        type: 'checkbox', checked: S.emotion?.episodeRecallEnabled !== false, disabled: !hasCap('emotion'),
        on: { change: (event) => toggleEpisodeRecall(event) },
      }),
      el('span', { class: 'muted small', text: '把相关事件带进提示词' }),
    ),
    el('p', { class: 'note', style: { marginBottom: 0 } }, '开：每轮可能多 100–200 token，她会更记得“那天发生过什么”。关：不注入事件，省 token，但情景记忆只在控制台里可见。'),
    el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn sm ghost', on: { click: () => resetEmotionState() } }, '重置情绪/气候'),
      el('span', { class: 'muted small', text: '把现在、心情、气候拉回底色；不删事件和审计' }),
    ),
  )

  requestAnimationFrame(() => drawEmotionPad(e))
  return frag(hero, stats, padCard, el('div', { class: 'panel-stack' }, climateCard, episodeCard, weightsCard, optionsCard, triggersCard, metricsCard))
}

async function toggleEmotionDrift(event) {
  const enabled = event.target.checked
  try {
    await api('/emotion/drift', { method: 'POST', body: { enabled } })
    S.emotion = { ...(S.emotion || {}), driftEnabled: enabled }
    toast(enabled ? '已开启：长期情绪可以微调人格' : '已关闭：长期情绪不再改人格', 'ok')
  } catch (error) {
    event.target.checked = !enabled
    toast(error.message, 'error')
  }
}

async function setEmotionDriftMode(event) {
  const mode = event.target.value === 'suggest' ? 'suggest' : 'apply'
  try {
    await api('/emotion/drift', { method: 'POST', body: { enabled: S.emotion?.driftEnabled !== false, mode } })
    S.emotion = { ...(S.emotion || {}), driftMode: mode }
    toast(mode === 'suggest' ? '已改成只建议：只记录，不改人格' : '已改成直接应用', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function saveEmotionWeights() {
  const weights = {}
  for (const kind of ['owner', 'group', 'private']) {
    const input = document.getElementById(`emotion-weight-${kind}`)
    weights[kind] = Math.max(0.2, Math.min(3, Number(input?.value) || 1))
  }
  try {
    const data = await api('/emotion/weights', { method: 'POST', body: { weights } })
    S.emotion = { ...(S.emotion || {}), weights: data.weights }
    toast('情绪权重已保存', 'ok')
    paintCurrent()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function toggleAppraisalModel(event) {
  const enabled = event.target.checked
  try {
    await api('/emotion/appraisal', { method: 'POST', body: { enabled } })
    S.emotion = { ...(S.emotion || {}), appraisalModelEnabled: enabled }
    toast(enabled ? '已开启模型复核（只在高情绪消息上）' : '已关闭模型复核', 'ok')
  } catch (error) {
    event.target.checked = !enabled
    toast(error.message, 'error')
  }
}

async function acceptEmotionDrift(id) {
  try {
    await api('/emotion/drift/accept', { method: 'POST', body: { id } })
    S.persona = null
    await loadEmotion(true)
    await loadPersona()
    toast('已采纳：这会写进人格底色，影响之后所有聊天；可以撤销', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function rejectEmotionDrift(id) {
  try {
    await api('/emotion/drift/reject', { method: 'POST', body: { id } })
    await loadEmotion(true)
    toast('已拒绝：只留记录，不改人格', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function resetEmotionState() {
  if (!window.confirm('把情绪、心情和长期气候重置到底色？不会删情景记忆和审计。')) return
  try {
    await api('/emotion/reset', { method: 'POST', body: {} })
    await loadEmotion(true)
    await loadPersona()
    toast('已重置情绪/气候', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function toggleChatDrift(event) {
  const enabled = event.target.checked
  try {
    await api('/emotion/chat-drift', { method: 'POST', body: { enabled } })
    S.emotion = { ...(S.emotion || {}), chatDriftEnabled: enabled }
    toast(enabled ? '已开启按聊天自动微调（群聊仍关）' : '已关闭按聊天自动微调', 'ok')
  } catch (error) {
    event.target.checked = !enabled
    toast(error.message, 'error')
  }
}

async function toggleEpisodeRecall(event) {
  const enabled = event.target.checked
  try {
    await api('/emotion/episode-recall', { method: 'POST', body: { enabled } })
    S.emotion = { ...(S.emotion || {}), episodeRecallEnabled: enabled }
    toast(enabled ? '已开启事件召回（每轮会多约 100–200 token）' : '已关闭事件召回', 'ok')
  } catch (error) {
    event.target.checked = !enabled
    toast(error.message, 'error')
  }
}

async function revertEmotionDrift() {
  try {
    await api('/emotion/drift/revert', { method: 'POST', body: {} })
    S.persona = null
    await loadEmotion(true)
    await loadPersona()
    toast('已撤销上一次微调', 'ok')
  } catch (error) {
    toast(error.message, 'error')
  }
}

function drawEmotionPad(e) {
  const canvas = document.getElementById('emotion-pad')
  if (!canvas) return
  const w = canvas.clientWidth || 640
  const h = 340
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const px = 34
  const plotW = w - px * 2
  const plotH = h - px * 2
  const x = (v) => px + ((Math.max(-1, Math.min(1, v)) + 1) / 2) * plotW
  const y = (a) => px + (1 - Math.max(0, Math.min(1, a))) * plotH
  ctx.strokeStyle = 'rgba(127,214,230,0.12)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const gx = px + (plotW * i) / 4
    const gy = px + (plotH * i) / 4
    ctx.beginPath(); ctx.moveTo(gx, px); ctx.lineTo(gx, px + plotH); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(px, gy); ctx.lineTo(px + plotW, gy); ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(127,214,230,0.35)'
  ctx.beginPath(); ctx.moveTo(px, y(0)); ctx.lineTo(px + plotW, y(0)); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(x(0), px); ctx.lineTo(x(0), px + plotH); ctx.stroke()
  ctx.fillStyle = 'rgba(200,225,232,0.55)'
  ctx.font = '11px system-ui, sans-serif'
  ctx.fillText('难受', px, h - 10)
  ctx.fillText('舒服', px + plotW - 28, h - 10)
  ctx.fillText('高唤醒', 2, px + 10)
  ctx.fillText('低唤醒', 2, px + plotH - 4)
  const prototypes = [
    ['平静', 0.1, 0.22], ['开心', 0.72, 0.62], ['安心', 0.52, 0.18], ['兴奋', 0.62, 0.85],
    ['亲近', 0.58, 0.38], ['害羞', 0.38, 0.56], ['难过', -0.62, 0.24], ['失落', -0.48, 0.12],
    ['不安', -0.38, 0.66], ['生气', -0.58, 0.82], ['委屈', -0.52, 0.44], ['疲惫', -0.22, 0.1],
  ]
  for (const [label, v, a] of prototypes) {
    ctx.fillStyle = 'rgba(200,225,232,0.22)'
    ctx.beginPath(); ctx.arc(x(v), y(a), 2, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = 'rgba(200,225,232,0.35)'
    ctx.fillText(label, x(v) + 5, y(a) + 3)
  }
  const history = Array.isArray(e.history) ? e.history.slice(-120) : []
  if (history.length > 1) {
    ctx.beginPath()
    history.forEach((p, i) => {
      const xx = x(Number(p.v) || 0)
      const yy = y(Number(p.a) || 0)
      if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy)
    })
    ctx.strokeStyle = 'rgba(182,167,240,0.55)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  const nowV = Number(e.state?.valence) || 0
  const nowA = Number(e.state?.arousal) || 0
  const intensity = Math.max(0, Math.min(1, Number(e.state?.intensity) || 0))
  ctx.beginPath(); ctx.arc(x(nowV), y(nowA), 5 + intensity * 6, 0, Math.PI * 2)
  ctx.fillStyle = '#7fd6e6'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = 'rgba(232,246,250,0.95)'
  ctx.font = '12px system-ui, sans-serif'
  ctx.fillText(String(e.state?.label || '现在'), x(nowV) + 12, y(nowA) - 10)
}

// ---------------------------------------------------------------- 记忆图

const GRAPH_COLORS = ['#7fd6e6', '#b6a7f0', '#f0c987', '#8fe3b0', '#f2a2a2', '#9fc7ff', '#e6a8d7', '#c9d18a']

function graphColor(scope) {
  const s = String(scope || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return GRAPH_COLORS[Math.abs(h) % GRAPH_COLORS.length]
}

function renderGraphTab() {
  const stage = el('div', { class: 'graph-stage' })
  const canvas = el('canvas', { class: 'graph-canvas' })
  const tip = el('div', { class: 'graph-tip', style: { display: 'none' } })
  stage.appendChild(canvas)
  stage.appendChild(tip)
  S.graph.canvas = canvas
  S.graph.tip = tip
  S.graph.stage = stage

  canvas.addEventListener('mousemove', (event) => {
    if (S.graph.dragging) {
      S.graph.tx += event.clientX - S.graph.dragX
      S.graph.ty += event.clientY - S.graph.dragY
      S.graph.dragX = event.clientX
      S.graph.dragY = event.clientY
      return
    }
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const wx = (x - S.graph.tx) / S.graph.scale
    const wy = (y - S.graph.ty) / S.graph.scale
    let best = null
    let bestD = (18 * 18) / (S.graph.scale * S.graph.scale || 1)
    for (const n of S.graph.nodes) {
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2
      if (d < bestD) { bestD = d; best = n }
    }
    S.graph.hover = best
    if (best) {
      const imp = Math.round((best.importance || 0) * 100)
      const rec = Math.round((best.recall || 0) * 100)
      const statusText = { active: '活着', candidate: '待确认', superseded: '被取代', archived: '已归档', completed: '已完成' }[best.status] || best.status
      tip.textContent = `${best.text}\n${best.scope} · 重要 ${imp}% · 回忆 ${rec}% · ${statusText}`
      tip.style.display = 'block'
      tip.style.left = `${Math.min(x + 14, S.graph.w - 250)}px`
      tip.style.top = `${Math.max(8, y + 14)}px`
    } else {
      tip.style.display = 'none'
    }
  })
  canvas.addEventListener('mouseleave', () => {
    S.graph.hover = null
    S.graph.dragging = false
    canvas.style.cursor = ''
    if (S.graph.tip) S.graph.tip.style.display = 'none'
  })
  canvas.addEventListener('click', () => {
    const n = S.graph.hover
    if (!n) return
    S.library.scope = n.scope
    S.library.status = n.status === 'active' ? 'active' : n.status
    S.library.tier = 'all'
    S.library.q = ''
    S.library.loaded = false
    go('library')
  })

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const mx = event.clientX - rect.left
    const my = event.clientY - rect.top
    const next = Math.max(0.4, Math.min(3, S.graph.scale * (event.deltaY < 0 ? 1.12 : 0.89)))
    const ratio = next / S.graph.scale
    S.graph.tx = mx - (mx - S.graph.tx) * ratio
    S.graph.ty = my - (my - S.graph.ty) * ratio
    S.graph.scale = next
  }, { passive: false })

  canvas.addEventListener('mousedown', (event) => {
    S.graph.dragging = true
    S.graph.dragX = event.clientX
    S.graph.dragY = event.clientY
    canvas.style.cursor = 'grabbing'
  })
  canvas.addEventListener('mouseup', () => {
    S.graph.dragging = false
    canvas.style.cursor = ''
  })

  if (!S.graph.data && !S.graph.loading) void loadGraph()
  const legendStats = el('span', { class: 'graph-stats' })
  S.graph.legendStats = legendStats

  return el('section', { class: 'card pad graph-card' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'h2', text: '记忆图' }),
      el('span', { class: 'spacer' }),
      el('select', {
        class: 'select', style: { width: '150px', marginRight: '8px' },
        on: { change: (event) => { S.graph.scope = event.target.value; buildGraphNodes(); S.graph.alpha = 1 } },
      },
      el('option', { value: 'all', text: '全部聊天', selected: S.graph.scope === 'all' }),
      (S.overview?.scopes || []).map((s) => el('option', { value: s.scope, text: s.label || s.scope, selected: S.graph.scope === s.scope })),
      ),
      el('select', {
        class: 'select', style: { width: '110px', marginRight: '8px' },
        on: { change: (event) => { S.graph.filter = event.target.value; buildGraphNodes(); S.graph.alpha = 1 } },
      },
      el('option', { value: 'all', text: '全部' }),
      el('option', { value: 'active', text: '只看活着' }),
      el('option', { value: 'fading', text: '只看快遗忘' }),
      el('option', { value: 'candidate', text: '只看候选' }),
      ),
      el('button', { class: 'btn sm', on: { click: () => { S.graph.scale = 1; S.graph.tx = 0; S.graph.ty = 0 } } }, '复位'),
      el('button', { class: 'btn sm', on: { click: () => toggleGraphPause() } }, S.graph.paused ? '继续刷新' : '暂停刷新'),
      el('button', { id: 'graph-more', class: 'btn sm', style: { display: S.graph.data?.hasMore ? '' : 'none' }, on: { click: () => loadGraph({ more: true }) } }, '加载更多'),
      el('span', { class: 'muted small', text: '滚轮缩放 · 拖动平移 · 每 5 秒刷新' }),
    ),
    el('div', { class: 'graph-legend' },
      el('span', { html: '<i></i>圆点 = 一条记忆；越大越重要；颜色 = 所属聊天' }),
      el('span', { html: '<i></i>实线 = 明确关联或同一条事实；细线 = 语义相近' }),
      el('span', { html: '<i></i>虚线 / 半透明 = 快遗忘或待确认' }),
      el('span', { html: '<i></i>点节点 → 跳到对应的长期记忆' }),
      legendStats,
    ),
    el('p', { class: 'note', style: { margin: '0 0 10px' } }, '这张图回答“她的记忆怎么连在一起”，不是时间线；连线多不代表关系好，只代表内容相近或被明确关联。'),
    stage,
  )
}

function updateGraphLegend() {
  const nodes = S.graph.data?.nodes || []
  const active = nodes.filter((n) => n.status === 'active')
  const fading = active.filter((n) => Number(n.recall) < 0.35).length
  const candidate = nodes.filter((n) => n.status === 'candidate').length
  const superseded = nodes.filter((n) => n.status === 'superseded' || n.status === 'archived').length
  if (S.graph.legendStats) S.graph.legendStats.textContent = `活着 ${active.length} · 快遗忘 ${fading} · 候选 ${candidate} · 已取代 ${superseded}`
}

function toggleGraphPause() {
  S.graph.paused = !S.graph.paused
  paintCurrent()
  toast(S.graph.paused ? '已暂停自动刷新；画面保留' : '已继续自动刷新', 'ok')
}

async function loadGraph({ quiet = false, more = false } = {}) {
  if (S.graph.loading || S.graph.loadingMore) return
  if (more) S.graph.loadingMore = true
  else S.graph.loading = true
  try {
    const loaded = S.graph.data?.nodes?.length || 0
    const limit = more ? Math.min(800, Math.max(220, loaded + 220)) : Math.min(800, Math.max(220, loaded))
    const offset = more ? loaded : 0
    const headers = {}
    if (!more && S.graph.etag) headers['If-None-Match'] = S.graph.etag
    const res = await fetch(API(`/graph?limit=${limit}&offset=${offset}&threshold=0.55&topK=3`), { headers, cache: 'no-store' })
    if (res.status === 304) {
      updateGraphLegend()
      return
    }
    let data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
    const prev = new Map((S.graph.data?.nodes || []).map((n) => [n.id, n]))
    const now = performance.now()
    if (prev.size) {
      for (const n of data.nodes) {
        const old = prev.get(n.id)
        if (!old || old.text !== n.text || old.status !== n.status || old.importance !== n.importance) {
          S.graph.flashes.set(n.id, now + 2600)
        }
      }
    }
    if (more && S.graph.data) {
      const seen = new Set(S.graph.data.nodes.map((n) => n.id))
      const linkSeen = new Set(S.graph.data.links.map((l) => `${l.a}|${l.b}|${l.kind}`))
      const nodes = [...S.graph.data.nodes, ...data.nodes.filter((n) => !seen.has(n.id))]
      const links = [...S.graph.data.links, ...data.links.filter((l) => !linkSeen.has(`${l.a}|${l.b}|${l.kind}`))]
      data = { ...data, nodes, links, count: nodes.length }
    }
    S.graph.etag = res.headers.get('etag') || S.graph.etag
    S.graph.total = Number(data.total || data.count || 0)
    S.graph.data = data
    updateTabs()
    updateGraphLegend()
    const moreBtn = document.getElementById('graph-more')
    if (moreBtn) moreBtn.style.display = data.hasMore ? '' : 'none'
    if (S.tab === 'graph') {
      buildGraphNodes()
      S.graph.alpha = 1
      if (!S.graph.running) startGraphLoop()
    }
  } catch (error) {
    if (!quiet) toast(error.message, 'error')
  } finally {
    S.graph.loading = false
    S.graph.loadingMore = false
  }
}

function buildGraphNodes() {
  const data = S.graph.data
  if (!data) { S.graph.nodes = []; S.graph.links = []; return }
  const old = S.graph.positions
  const cx = S.graph.w / 2
  const cy = S.graph.h / 2
  const filter = S.graph.filter || 'all'
  const filtered = (data.nodes || []).filter((n) => {
    if (S.graph.scope !== 'all' && n.scope !== S.graph.scope) return false
    if (filter === 'all') return true
    if (filter === 'fading') return n.status === 'active' && Number(n.recall) < 0.35
    return n.status === filter
  })
  const nodes = filtered.map((n) => {
    const p = old.get(n.id)
    const a = Math.random() * Math.PI * 2
    const r = 60 + Math.random() * 90
    const recall = Math.max(0, Math.min(1, Number(n.recall) || 0))
    const imp = Math.max(0, Math.min(1, Number(n.importance) || 0))
    const fading = n.status === 'active' && recall < 0.35
    const dead = n.status === 'superseded' || n.status === 'archived'
    return {
      ...n,
      recall,
      fading,
      x: p?.x ?? cx + Math.cos(a) * r,
      y: p?.y ?? cy + Math.sin(a) * r,
      vx: 0, vy: 0,
      r: (3 + imp * 7) * (fading ? 0.82 : 1),
      color: dead ? '#5a6a72' : graphColor(n.scope),
    }
  })
  const map = new Map(nodes.map((n) => [n.id, n]))
  const links = (data.links || [])
    .map((l) => ({ a: map.get(l.source), b: map.get(l.target), kind: l.kind, w: l.w }))
    .filter((l) => l.a && l.b)
  S.graph.nodes = nodes
  S.graph.links = links
}

function startGraphLoop() {
  const canvas = S.graph.canvas
  if (!canvas) return
  if (S.graph.running && S.graph.ctx) return
  stopGraphLoop()
  const rect = canvas.parentElement.getBoundingClientRect()
  S.graph.w = Math.max(320, Math.round(rect.width))
  S.graph.h = Math.max(360, Math.round(rect.height) || 520)
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(S.graph.w * dpr)
  canvas.height = Math.round(S.graph.h * dpr)
  canvas.style.width = `${S.graph.w}px`
  canvas.style.height = `${S.graph.h}px`
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  S.graph.ctx = ctx
  S.graph.running = true
  S.graph.alpha = 1
  buildGraphNodes()
  S.graph.timer = setInterval(() => { if (!S.graph.paused) void loadGraph({ quiet: true }) }, 5000)
  const frame = (t) => {
    if (!S.graph.running) return
    tickGraph()
    drawGraph(t)
    S.graph.raf = requestAnimationFrame(frame)
  }
  S.graph.raf = requestAnimationFrame(frame)
}

function stopGraphLoop() {
  S.graph.running = false
  if (S.graph.raf) cancelAnimationFrame(S.graph.raf)
  if (S.graph.timer) clearInterval(S.graph.timer)
  S.graph.raf = 0
  S.graph.timer = 0
  S.graph.ctx = null
}

function tickGraph() {
  const { nodes, links } = S.graph
  if (!nodes.length) return
  const w = S.graph.w
  const h = S.graph.h
  const cx = w / 2
  const cy = h / 2
  const alpha = S.graph.alpha
  if (alpha > 0.02) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 25) d2 = 25
        const d = Math.sqrt(d2)
        const f = (2600 * alpha) / d2
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx -= fx; a.vy -= fy
        b.vx += fx; b.vy += fy
      }
    }
    for (const l of links) {
      const a = l.a
      const b = l.b
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const target = l.kind === 'similar' ? 112 : 82
      const k = (l.kind === 'similar' ? Math.max(0.006, l.w * 0.02) : 0.03) * alpha
      const f = (d - target) * k
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx; a.vy += fy
      b.vx -= fx; b.vy -= fy
    }
    for (const n of nodes) {
      // 越容易被想起来，越靠中间；快遗忘的往外漂，像记忆沉到边缘
      const recall = Number.isFinite(n.recall) ? n.recall : 1
      const want = (0.22 + (1 - recall) * 0.78) * Math.min(w, h) * 0.45
      const dx = n.x - cx
      const dy = n.y - cy
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (dist - want) * 0.0024 * alpha
      n.vx -= (dx / dist) * f
      n.vy -= (dy / dist) * f
      n.vx *= 0.86
      n.vy *= 0.86
      n.x = Math.max(16, Math.min(w - 16, n.x + n.vx))
      n.y = Math.max(16, Math.min(h - 16, n.y + n.vy))
      S.graph.positions.set(n.id, { x: n.x, y: n.y })
    }
    S.graph.alpha *= 0.992
  }
}

function drawGraph(now) {
  const ctx = S.graph.ctx
  if (!ctx) return
  const { nodes, links, w, h } = S.graph
  ctx.clearRect(0, 0, w, h)
  ctx.save()
  ctx.translate(S.graph.tx, S.graph.ty)
  ctx.scale(S.graph.scale, S.graph.scale)
  for (const l of links) {
    if (l.kind === 'relation') {
      ctx.strokeStyle = 'rgba(182,167,240,0.55)'
      ctx.lineWidth = 1.2
    } else if (l.kind === 'fact') {
      ctx.strokeStyle = 'rgba(240,201,135,0.35)'
      ctx.lineWidth = 1
    } else {
      ctx.strokeStyle = `rgba(127,214,230,${0.05 + Math.max(0, Math.min(1, l.w)) * 0.12})`
      ctx.lineWidth = 0.7
    }
    ctx.beginPath()
    ctx.moveTo(l.a.x, l.a.y)
    ctx.lineTo(l.b.x, l.b.y)
    ctx.stroke()
  }
  for (const n of nodes) {
    const flash = S.graph.flashes.get(n.id) || 0
    const isFlash = now < flash
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fillStyle = n.color
    const opacity = n.status === 'candidate' ? 0.55
      : (n.status === 'superseded' || n.status === 'archived') ? 0.3
        : 0.25 + 0.65 * (Number.isFinite(n.recall) ? n.recall : 1)
    ctx.globalAlpha = opacity
    ctx.fill()
    ctx.globalAlpha = 1
    if (n.fading) {
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(240,201,135,0.75)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    } else if (n.status === 'candidate') {
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(182,167,240,0.7)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    } else if (n.status === 'superseded' || n.status === 'archived') {
      ctx.setLineDash([2, 4])
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(140,160,170,0.55)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (n.tier === 'core') {
      ctx.strokeStyle = 'rgba(240,201,135,0.8)'
      ctx.lineWidth = 1.4
      ctx.stroke()
    }
    if (isFlash) {
      const t = 1 - Math.max(0, flash - now) / 2600
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 6 + Math.sin(t * Math.PI) * 10, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - t)})`
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
    if (S.graph.hover && S.graph.hover.id === n.id) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.font = `${12 / S.graph.scale}px system-ui, sans-serif`
      ctx.fillStyle = 'rgba(232,246,250,0.95)'
      ctx.fillText(String(n.text || '').slice(0, 26), n.x + n.r + 5, n.y - n.r - 3)
    }
  }
  ctx.restore()
}

// ---------------------------------------------------------------- 启动

async function boot() {
  const bootParams = new URLSearchParams(location.search)
  const requestedTheme = bootParams.get('theme')
  if (requestedTheme === 'dark' || requestedTheme === 'light') S.theme = requestedTheme
  if (bootParams.get('embed') === '1') document.body.classList.add('embed')
  applyTheme()
  try { await api('/persona'); S.personaAvailable = true } catch { S.personaAvailable = false }
  mountShell()
  try {
    await refreshOverview({ paint: false })
  } catch (error) {
    mainEl.replaceChildren(el('div', { class: 'empty' },
      el('div', { html: ICONS.whale }),
      el('p', { text: '记忆没捞上来。' }),
      el('p', { class: 'muted small', text: error.message }),
      el('button', { class: 'btn', style: { marginTop: '8px' }, on: { click: () => boot() } }, '再试一次'),
    ))
    return
  }
  // 首屏就把图/性格的角标预取回来，别让它们先显示 0
  if (!S.graph.data && !S.graph.loading) void loadGraph({ quiet: true })
  if (!S.persona && !S.personaLoading) void loadPersona()
  route(true)
  window.addEventListener('hashchange', () => route())
}

boot()
