// 本地预览：把控制台单独开在 3999，改前端不用重启 DSH。
//   node bin/preview.mjs
// 只监听 127.0.0.1。

import http from 'node:http'
import { createApiHandler } from '../lib/api.js'

const port = Number(process.env.FEIYU_PREVIEW_PORT || process.env.PORT || 3999)
const handler = createApiHandler({ mountPrefix: false })

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error('[preview]', error)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`大肥鱼的记忆 · 预览在 http://127.0.0.1:${port}`)
  console.log('数据源：~/.dsh/memvec/memories.db + ~/.dsh/qq-bridge/state/*.json')
  console.log('Ctrl+C 停。')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
