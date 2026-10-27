// 大肥鱼的记忆 · DSH 宿主半边
//
// 只做两件事：
//   1. 把 /dsh-feiyu-memory 挂到 DSH 的 webServer 上（页面 + API 都在里面）；
//   2. 什么都不改 —— 不碰设置命名空间，不碰会话，不碰模型。

import { createApiHandler } from './api.js'

export const name = 'feiyu-memory-console'
export const inject = ['webServer']

export function apply(ctx) {
  const handler = createApiHandler({ mountPrefix: true })
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-feiyu-memory',
      handler,
    }),
  )
}
