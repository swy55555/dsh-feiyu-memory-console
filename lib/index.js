// 大肥鱼的记忆 · DSH 宿主半边
//
// 宿主职责：
//   1. 把 /dsh-feiyu-memory 挂到 DSH 的 webServer 上（页面 + API 都在里面）；
//   2. 用户开启后，每分钟处理一条主人私聊候选；保守核对，不替换已有事实。
//   3. 为无工具后台会话隔离设置模型，不改宿主全局默认。

import {selectBackgroundModel} from './background-model.js'
import {startCandidateAuto} from './core.js'
import { createApiHandler } from './api.js'

export const name = 'feiyu-memory-console'
export const inject = ['webServer']

export function apply(ctx) {
  // DSH's Cordis uses a service-name map, not {required, optional} metadata.
  // Keep the console available while the background services are unavailable.
  let backgroundContext
  ctx.inject(['sessionController','llm'], child => {
    backgroundContext = child
    child.effect(() => () => { backgroundContext = undefined })
  })
  ctx.effect(() => startCandidateAuto())
  const handler = createApiHandler({ mountPrefix: true, selectBackgroundModel: body => {
    if (!backgroundContext) throw Error('后台模型服务尚未就绪')
    return selectBackgroundModel(backgroundContext,body)
  } })
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-feiyu-memory',
      handler,
    }),
  )
}
