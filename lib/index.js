// 大肥鱼的记忆 · DSH 宿主半边
//
// 只做两件事：
//   1. 把 /dsh-feiyu-memory 挂到 DSH 的 webServer 上（页面 + API 都在里面）；
//   2. 用户开启后，每分钟处理一条主人私聊候选；保守核对，不替换已有事实。

import {startCandidateAuto} from './core.js'
import { createApiHandler } from './api.js'

export const name = 'feiyu-memory-console'
export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() => startCandidateAuto())
  const handler = createApiHandler({ mountPrefix: true })
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-feiyu-memory',
      handler,
    }),
  )
}
