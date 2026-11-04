// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools', 'systemPrompt']

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

// ── 「全开 + 防身」（2026-10-25）─────────────────────────────────────────────
// 背景：桥接放开了 allowAllWhenEmpty（任何人都能私聊她）。
// 于是需要按**会话**区分权限：管理员私聊可以碰 B 站/空间，陌生人只能聊天。
// 判断链：guard 的 exec.agent.session.id → 桥接 state/sessions.json 反查出
// 会话 key（private:xxx / group:xxx）→ 和 config.json 的 ownerQQ 比对。
// 读文件带 3 秒缓存，避免每条工具调用都读盘。
const BRIDGE_ROOT = process.env.FEIYU_BRIDGE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** SnowLuma MCP 工具的命名空间前缀（exec.name 是带前缀的全名）。 */
const MCP_SNOWLUMA_PREFIX = 'mcp__snowluma__'

/** 陌生会话里允许的工具：只有聊天、读取、记忆、状态这类，没有对外动作。 */
const STRANGER_ALLOWED_TOOLS = new Set([
  'ask_user_question',
  'todo_write',
  // fishtalk（说人话）：读文风包 / 发前查一遍——纯本地、不发任何东西出去，
  // 所以任何会话都给；喂语料（feed）会写本地语料，放到群/好友那一档。
  'fishtalk_pack',
  'fishtalk_check',
  // 发消息 / 回复（含看图、看历史、已读、唤醒设置）
  'qq_send_message',
  'qq_reply',
  'qq_send_burst',
  'qq_send_group_message',
  'qq_send_private_message',
  'qq_mark_read',
  'qq_wait_for_messages',
  'qq_get_prompt',
  'qq_social_state',
  'qq_status',
  'qq_get_unread_messages',
  'qq_get_recent_messages',
  'qq_get_message_detail',
  'qq_get_message_images',
  'qq_get_forward_msg',
  'qq_get_my_recent_messages',
  'qq_get_active_members',
  // 只读：成员列表（预设第 6 条要用它拿 QQ 号设 speakerIds）与自带头像参考（第 9 条）。
  // 之前两个都不在任何一档白名单里，群/好友会话按提示词一调就会被 guard 拒；两者都不对外发东西。
  'qq_get_group_members',
  'qq_get_self_image',
  'qq_memory_query',
  'qq_memory_append',
  'qq_memory_remove',
  'qq_memory_clear',
  'qq_persona_note',
  // 2026-11-01 自查：qq_slang_query / qq_slang_submit 在 MCP 里**从未注册**
  // （slang 学习走桥接内部模块，config.slang.enabled 也是 false），留在白名单里只会
  // 让人以为这两个能力可用。删掉；将来真加了工具再一起加回来。
  'qq_report_feedback',
  'qq_set_wake_config',
  // 给老大留言（只写不读；读队列只有管理员私聊能调 qq_read_owner_inbox，陌生人分支不放行）
  'qq_leave_message',
  // 表情包只读（能看、能存备注，但不许发出去）
  'qq_list_stickers',
  'qq_get_sticker_image',
  'qq_sticker_note',
])

// 白名单群里额外放开的能力：语音、表情包（含偷图）、发空间。
// 不给 B 站（那些是账号级写操作，只在管理员私聊里用）。
const GROUP_EXTRA_TOOLS = new Set([
  'qq_say',
  'qq_send_voice',
  'qq_list_voices',
  'qq_send_sticker',
  'qq_collect_sticker',
  'qq_sticker_note',
  'qq_send_poke',
  'qq_send_qzone',
  'qq_vmem_add',
  'qq_vmem_search',
  'qq_pick_image',
  // fishtalk：把群里读到的真人发言喂进语料（只写本地语料，不发东西出去）
  'fishtalk_feed',
])

let bridgeCacheAt = 0
let bridgeOwnerKey = null
let bridgeSessions = {}
// 好友私聊（白名单里的非 owner）额外放开：表情包 + 语音（不含 B 站/空间）
const FRIEND_EXTRA_TOOLS = new Set([
  'qq_say',
  'qq_send_voice',
  'qq_list_voices',
  'qq_send_sticker',
  'qq_collect_sticker',
  'qq_sticker_note',
  'qq_send_poke',
  'qq_pick_image',
  'fishtalk_feed',
])

let bridgeGroups = new Set()
let bridgePrivates = new Set()
/** 只在第一次“映射不到会话”时打一条告警，避免每条工具调用都刷日志。 */
let unknownSessionWarned = false

function refreshBridgeState() {
  if (Date.now() - bridgeCacheAt < 3000) return
  bridgeCacheAt = Date.now()
  try {
    const c = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'config.json'), 'utf8'))
    bridgeOwnerKey = c.ownerQQ ? `private:${String(c.ownerQQ)}` : null
    bridgeGroups = new Set((c.allow?.groups ?? []).map(String))
    bridgePrivates = new Set((c.allow?.private ?? []).map(String))
  } catch {
    bridgeOwnerKey = null
    bridgeGroups = new Set()
    bridgePrivates = new Set()
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'state', 'sessions.json'), 'utf8'))
    bridgeSessions = j.sessions || {}
  } catch {
    bridgeSessions = {}
  }
}

function keyOfSession(sid) {
  const id = String(sid)
  for (const [k, v] of Object.entries(bridgeSessions)) if (String(v) === id) return k
  return null
}

/** 这条 DSH 会话对应的 QQ 会话 key（不是 QQ 会话则返回 null）。 */
function sessionKeyOf(exec) {
  const sid = exec?.agent?.session?.id
  if (!sid) return null
  refreshBridgeState()
  return keyOfSession(sid)
}

function isOwnerKey(key) {
  return Boolean(bridgeOwnerKey) && key === bridgeOwnerKey
}

/**
 * 群里点歌要老大点头：看这个会话「最近一条别人发的消息」是不是老大发的。
 * 桥接的 recentMessages 里带 isOwner（自己发的 isSelf=true，跳过）。
 */
let singCheckAt = 0
let singOwnerCache = new Map()
function ownerTriggeredLast(key) {
  if (Date.now() - singCheckAt > 2000) {
    singCheckAt = Date.now()
    singOwnerCache = new Map()
  }
  if (singOwnerCache.has(key)) return singOwnerCache.get(key)
  let ok = false
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'state', 'social-v2.json'), 'utf8'))
    const ms = j.conversations?.[key]?.recentMessages ?? []
    const now = Date.now()
    let seen = 0
    // 往回扫最多 40 条别人的消息、15 分钟内的：只要有一条是老大发的、且提到「唱/歌」，就算他点头了。
    // 之前窗口太小（8 条 / 3 分钟），群消息一密就漏；也修过「只认最后一条被插话抢走」的问题。
    for (let i = ms.length - 1; i >= 0 && seen < 40; i--) {
      const m = ms[i]
      if (!m || m.isSelf) continue
      seen++
      if (m.isOwner !== true) continue
      const ageMs = now - Number(m.time || 0)
      const text = String(m.plain || m.text || '')
      if (ageMs <= 15 * 60 * 1000 && /唱|歌/.test(text)) {
        ok = true
        break
      }
    }
  } catch {}
  singOwnerCache.set(key, ok)
  return ok
}

function isFriendKey(key) {
  const m = /^private:(\d+)$/.exec(String(key))
  if (!m) return false
  if (bridgeOwnerKey && key === bridgeOwnerKey) return false
  return bridgePrivates.has(m[1])
}

function isWhitelistedGroupKey(key) {
  const m = /^group:(\d+)$/.exec(String(key))
  return Boolean(m) && bridgeGroups.has(m[1])
}

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // QQ uses scoped Xinji memory, not Soul's project/profile learning store.
  'learning_search', 'learning_get', 'learning_propose',
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
// 独立 B 站工具停用；拾光通过桥接执行只读探索。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  'remember',
  // fishtalk：去 B 站分区自动学语料（走网络）/ 深度蒸馏要烧模型，按「B 站操作只在管理员私聊」的
  // 口径处理，只给管理员私聊和内部调度会话。
  'fishtalk_learn',
  'fishtalk_deep',
  // ⚠️ 下面三个在 STRANGER/GROUP/FRIEND 那几档里，但**管理员私聊走的是这条 SAFE_EXACT 分支**
  // （owner 分支不查 STRANGER_ALLOWED_TOOLS），不在这里再列一遍的话，跟老大私聊时反而调不动。
  'fishtalk_pack',
  'fishtalk_check',
  'fishtalk_feed',
])

export function apply(ctx) {
  // Scoped context shadows only this global contribution; ordinary DSH keeps Soul.
  ctx.systemPrompt.context({name:'dsh-soul:memory',order:950,text:()=>''})
  ctx.systemPrompt.context({name:'qq-memory-routing',order:951,text:()=>
    '本 QQ 会话的长期记忆使用 qq_vmem_search；qq_memory_query 只查轻量话题/印象，近期聊天不是全库。等待或读取消息返回的 memoryReference 是当前消息的有限检索参考，当前原话优先。未查询、查询失败与无匹配必须区分；未匹配不证明记忆丢失，不声称翻遍全库。不调用 learning_search/learning_get/learning_propose；它们属于普通 DSH 的另一套记忆。'})
  ctx.systemPrompt.context({name:'qq-shiguang-evidence',order:952,text:()=>
    'web_search 只返回标题、网址与摘要，不能说已经翻阅文章、看过视频。主人私聊要读普通网页正文，用 qq_shiguang_read_web 留下拾光来源；按话题看 B 站用 qq_shiguang_explore 读取可用字幕。只有工具返回成功读取回执才能说读过，并区分是否保存了自我记忆。工具失败、没调用或只看到搜索摘要时，如实说仍未读到。'})
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  const unavailableRestrictNames = []
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/tools\.restrict\(\) names unknown global tool/.test(message)) {
        // restrict 会把完整全局工具表附在错误里。动态工具或离线 MCP
        // 不在当前注册表时只汇总名称，避免每个名称都把整张表写进 host stderr。
        unavailableRestrictNames.push(name)
        continue
      }
      console.error(`[qq-tool-restrict] restrict ${name} 失败：${message.split('; known global tools:')[0].slice(0, 300)}`)
    }
  }
  if (unavailableRestrictNames.length) {
    const sample = unavailableRestrictNames.slice(0, 12).join(', ')
    const rest = unavailableRestrictNames.length > 12 ? ` 等 ${unavailableRestrictNames.length} 个` : ''
    console.warn(`[qq-tool-restrict] 当前注册表未包含 ${unavailableRestrictNames.length} 个待隐藏工具（执行期白名单仍生效）：${sample}${rest}`)
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    const bare = name.startsWith(MCP_SNOWLUMA_PREFIX) ? name.slice(MCP_SNOWLUMA_PREFIX.length) : name

    // 2.0) 2026-10-25「全开 + 防身」：按会话身份分三档
    //   ① 管理员私聊（private:<ownerQQ>）→ 全开
    //   ② 白名单群（group:<allow.groups>）→ 聊天 + 语音/表情包/空间这些"对内"的能力，不给 B 站
    //   ③ 其它（陌生人私聊、非白名单群）→ 只能聊天
    //      判断依据：DSH 会话 id → 桥接 state/sessions.json 的会话 key。
    //      ⚠️ exec.name 带命名空间前缀（mcp__snowluma__qq_send_message），比对要剥前缀。
    if (/(?:^|__)bili_[a-z_]+$/.test(name) || bare === 'qq_bili_cover') return '独立 B 站工具已停用，请使用拾光';
    const sessionKey = sessionKeyOf(exec)
    if(name==='mcp__web-search-safe__web_fetch'&&(!sessionKey||isOwnerKey(sessionKey)))return '主人私聊读网页正文请使用 qq_shiguang_read_web，让拾光保留来源；无法确认会话身份时禁止抓取网页'
    // 2026-11-01 自查后收紧：解析不出会话身份（sessions.json 过期/被换掉/DSH 换了 session id）时，
    // 以前会直接落到下面的 SAFE_PREFIXES，等于**给任何会话全开** QQ 工具；现在按最保守档 fail-closed。
    if (!sessionKey) {
      if (
        STRANGER_ALLOWED_TOOLS.has(bare)
        || name.startsWith('mcp__web-search-safe__')
        || name.startsWith('mcp__snowluma-host__')
      ) return
      if (!unknownSessionWarned) {
        unknownSessionWarned = true
        console.error('[qq-tool-restrict] 无法把 DSH 会话映射到 QQ 会话（state/sessions.json 过期？）；已按陌生人档只放行聊天类工具')
      }
      return `无法确认这个会话的身份（state/sessions.json 里找不到），已按最保守档只放行聊天类工具：拒绝 "${bare}"`
    }
    if (sessionKey) {
      if (isOwnerKey(sessionKey)) {
        // ① 管理员私聊：走下面的通用白名单（MCP 前缀全放行）
      } else if (isFriendKey(sessionKey)) {
        // ②' 好友私聊：能发表情包、发语音、拍一拍，但 B 站/空间仍然只给老大
        if (STRANGER_ALLOWED_TOOLS.has(bare) || FRIEND_EXTRA_TOOLS.has(bare) || name.startsWith('mcp__web-search-safe__')) return
        return `好友会话不允许 "${bare}"（B 站、发空间这类只在管理员私聊里可用）`
      } else if (isWhitelistedGroupKey(sessionKey)) {
        // ② 白名单群
        // 唱歌例外：群里任何人都不能直接点歌，只有「最后一条消息是老大发的」才放行
        // （= 老大在群里 @ 她 / 亲自让她唱），其余一律拒绝。
        if (bare === 'qq_sing') {
          if (ownerTriggeredLast(sessionKey)) return
          return '这次不算老大点歌：如果他刚在群里说了「唱xx」但被消息刷过去了，让他再说一遍「@我 唱xx」就行；不是老大本人说的就不唱'
        }
        if (STRANGER_ALLOWED_TOOLS.has(bare) || GROUP_EXTRA_TOOLS.has(bare) || name.startsWith('mcp__web-search-safe__')) return
        return `群会话不允许 "${bare}"（B 站这类操作只在管理员私聊里可用）`
      } else {
        // ③ 陌生人
        if (STRANGER_ALLOWED_TOOLS.has(bare) || name.startsWith('mcp__web-search-safe__')) return
        return `陌生人会话只能聊天，已拒绝 "${bare}"（查 B 站、发空间这类事请找管理员）`
      }
    }

    if (SAFE_EXACT.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
