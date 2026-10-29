// 可塑性记忆 · 浏览器半边
//
// 设置左侧栏多一项「可塑性记忆」。里面直接嵌控制台页面，
// 这样页面和独立预览是同一份代码，不用维护两套 UI。

window.__ModuleLoader__.load({
  id: 'dsh-feiyu-memory-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const inject = ['slots']

    const linkStyle = {
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary, #8fa8c8)',
      textDecoration: 'none',
      borderBottom: '1px solid rgba(128,128,128,.35)',
      paddingBottom: 1,
    }

    function detectTheme() {
      try {
        const explicit = document.documentElement.dataset.theme
        if (explicit === 'light' || explicit === 'dark') return explicit
        const bg = getComputedStyle(document.body).backgroundColor || ''
        const nums = bg.match(/\d+/g)
        if (!nums || nums.length < 3) return 'dark'
        const [r, g, b] = nums.map(Number)
        return (r + g + b) / 3 < 140 ? 'dark' : 'light'
      } catch {
        return 'dark'
      }
    }

    function Panel() {
      const [stats, setStats] = React.useState(null)
      const [note, setNote] = React.useState('')
      const [theme, setTheme] = React.useState(() => detectTheme())

      React.useEffect(() => {
        let alive = true
        const read = () => {
          fetch('/dsh-feiyu-memory/api/overview', { cache: 'no-store' })
            .then((r) => r.json())
            .then((data) => {
              if (!alive) return
              if (data && data.ok) { setStats(data); setNote('') }
              else setNote((data && data.error) || '读不到记忆')
            })
            .catch(() => { if (alive) setNote('控制台只允许本机访问；远程请用 SSH 隧道') })
          if (alive) setTheme(detectTheme())
        }
        read()
        const timer = setInterval(read, 30000)
        const observer = new MutationObserver(() => { if (alive) setTheme(detectTheme()) })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
        return () => { alive = false; clearInterval(timer); observer.disconnect() }
      }, [])

      const summary = note || (stats
        ? `${stats.active ?? 0} 条活着 · ${stats.candidate ?? 0} 条待确认 · ${stats.light?.total ?? 0} 条临时记忆 · ${stats.diary?.count ?? 0} 页日记`
        : '正在读…')

      return h('div', { style: { padding: '2px 0 8px', minWidth: 0 } },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '2px 0 10px' },
        },
          h('span', { style: { fontSize: 14, fontWeight: 600, letterSpacing: '.04em' } }, '心迹 · 可塑性记忆'),
          h('span', { style: { fontSize: 12, color: note ? 'var(--dsw-alias-label-error, #d97777)' : 'var(--dsw-alias-label-tertiary, #8a8a8a)' } }, summary),
          h('span', { style: { flex: 1 } }),
          h('a', {
            href: '/',
            target: '_top',
            rel: 'noreferrer',
            style: linkStyle,
          }, '返回 DSH'),
        ),
        h('iframe', {
          src: `/dsh-feiyu-memory/?embed=1&theme=${theme}`,
          title: '心迹控制台',
          loading: 'lazy',
          style: {
            display: 'block',
            width: '100%',
            height: 'min(58vh, 660px)',
            minHeight: 420,
            border: '0',
            borderRadius: 14,
            background: theme === 'dark' ? '#07141b' : '#f3eee5',
          },
        }),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'feiyu-memory',
            order: 52,
            label: () => '心迹 · 可塑性记忆',
          },
          Panel,
        ),
      )
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
