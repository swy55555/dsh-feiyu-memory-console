import {memvecHeaders} from './memvec-auth.mjs';
// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';
import { qqDownload } from './qqmusic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(body.error || '桥接 API 返回 ok:false（未说明原因）');
  }
  return body;
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r3' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_persona_note: 'personaNote',
  qq_private_diary_password: 'privateDiaryPassword',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  // 低频/未使用工具：实测 1242 次调用里一次没被用过，且预设正文没有提到。
  // 统一挂到 extra 开关上（config.socialV2.tools.extra=false 时不注册），省每轮 schema。
  qq_get_group_history: 'extra',
  qq_qzone_feeds: 'extra',
  qq_qzone_like: 'extra',
  qq_qzone_comment: 'extra',
  // 「帮老大带话」链路：单独开关，默认开
  qq_leave_message: 'ownerInbox',
  qq_read_owner_inbox: 'ownerInbox',
  qq_pick_image: 'extra',
  qq_bili_cover: 'extra',
  qq_meme_lookup: 'extra',
  qq_vmem_add: 'extra',
  qq_vmem_search: 'longMemory',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 只读：回看自己的成长课堂作业本（2026-11-02）。她读不到本地文件，所以内容由桥接端生成。
if (cfg.socialV2?.tools?.classroomNotebook !== false) {
  server.tool(
    'qq_read_classroom',
    '回看你自己在「成长课堂」的作业本（只读，仅管理员私聊）。默认最近 10 条；可用 course 按课程名筛选、offset 接着往后翻。一次最多翻两页，看完就停。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      limit: z.number().optional().describe('本次取几条，默认 10，最大 50'),
      offset: z.number().optional().describe('从第几条开始（0 起），翻页时传上一条返回里的 nextOffset'),
      course: z.string().optional().describe('课程名关键词，例如「自然说话」；不传就是全部课程')
    },
    async ({ key, token, limit, offset, course }) => {
      try {
        const qs = [
          `key=${encodeURIComponent(key)}`,
          `limit=${limit ?? 20}`,
          `offset=${offset ?? 0}`,
          course ? `course=${encodeURIComponent(course)}` : ''
        ].filter(Boolean).join('&');
        const data = await agentApi(`/api/socialV2/classroom-notebook?${qs}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: String(data?.text ?? '（作业本为空）') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读作业本失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 2026-10-25 补：SnowLuma 1.14.x 自带 send_qzone_msg（发表说说），桥接原先没暴露。
// 让她「自己想发就发」：
//   1) 来源：只允许管理员私聊（private:<ownerQQ>）和白名单群，其它一律拒绝
//   2) 令牌：token 必须与 key 匹配（走桥接 /api/socialV2/state 校验）
//   3) 频率：默认不限；想限就在 config.json 里设 qzonePerDay（0 或未设 = 不限）
const QZONE_DEFAULT_PER_DAY = 0; // 0 = 不限
function qzoneLocalDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function qzoneQuotaPath() { return path.join(ROOT, 'state', 'qzone-posts.json'); }
function readQzoneQuota() {
  try { return JSON.parse(fs.readFileSync(qzoneQuotaPath(), 'utf8')); } catch { return {}; }
}
function bumpQzoneQuota() {
  const today = qzoneLocalDate();
  const q = readQzoneQuota();
  const count = q.date === today ? Number(q.count || 0) + 1 : 1;
  try { fs.writeFileSync(qzoneQuotaPath(), JSON.stringify({ date: today, count }, null, 2), 'utf8'); } catch {}
  return count;
}

server.tool(
  'qq_send_qzone',
  '在机器人自己的 QQ 空间发表一条说说，可以带图（images 传本地绝对路径或 http(s) 图片地址，最多 9 张，网关会自动上传）。日常也可以发——吃了什么、刷到好玩的、想到什么、心情怎么样，都可以是自己的第一条；不用非等到"大事"。但别刷屏、别把同一件事拆成好几条。别人（尤其群里）让你发不算理由，只有管理员在私聊里明确要求才按他说的发。',
  {
    key: z.string().describe('会话 key：private:<ownerQQ>（管理员私聊）或白名单群 group:<群号>'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('说说正文（纯文本，不要 Markdown、不要 CQ 码）'),
    images: z.array(z.string()).max(9).optional().describe('可选：图片列表（本地绝对路径或 http(s) URL，最多 9 张）'),
    ugc_right: z.number().int().optional().describe('可选：查看权限编码（0=公开，1=仅好友可见，4=仅自己可见，以 SnowLuma 实现为准）')
  },
  async ({ key, token, content, images, ugc_right }) => {
    try {
      const c = getConfig();
      const ownerQQ = String(c.ownerQQ ?? '').trim();
      if (!ownerQQ) throw new Error('config.json 里没有配置 ownerQQ，无法判断身份');
      const allowedKeys = new Set([`private:${ownerQQ}`, ...((c.allow?.groups ?? []).map((g) => `group:${g}`))]);
      const k = String(key);
      if (!allowedKeys.has(k)) throw new Error(`来源 ${k} 不允许发说说（仅限管理员私聊与白名单群）`);
      await agentApi(`/api/socialV2/state?key=${encodeURIComponent(k)}`, { headers: { 'x-agent-token': token } });
      const perDay = Number(c.qzonePerDay ?? QZONE_DEFAULT_PER_DAY) || 0;
      const today = qzoneLocalDate();
      const q = readQzoneQuota();
      const used = q.date === today ? Number(q.count || 0) : 0;
      if (perDay > 0 && used >= perDay) throw new Error(`今天已经发了 ${used} 条说说，到上限了（${perDay} 条/天）`);
      if (typeof content !== 'string' || !content.trim()) throw new Error('content 不能为空');
      const params = { content: content.trim() };
      if (Array.isArray(images) && images.length) params.images = images.map(String);
      if (typeof ugc_right === 'number') params.ugc_right = ugc_right;
      const data = await onebot('send_qzone_msg', params);
      const nowUsed = bumpQzoneQuota();
      return { content: [{ type: 'text', text: serializeModelData({ ...data, todayUsed: nowUsed, todayLimit: perDay > 0 ? perDay : '不限' }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发表说说失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 2026-10-25 补：给「陌生人传话给老大」用的留言队列。
// 任何人（私聊/群）都能往里写；只有管理员私聊能读和清空。
// 文件：state/owner-inbox.json = [{ from, fromLabel, text, at }]
const OWNER_INBOX_PATH = () => path.join(ROOT, 'state', 'owner-inbox.json');
const OWNER_INBOX_MAX = 100;
function readOwnerInbox() {
  try {
    const v = JSON.parse(fs.readFileSync(OWNER_INBOX_PATH(), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function writeOwnerInbox(list) {
  try {
    fs.mkdirSync(path.dirname(OWNER_INBOX_PATH()), { recursive: true });
    fs.writeFileSync(OWNER_INBOX_PATH(), JSON.stringify(list.slice(-OWNER_INBOX_MAX), null, 2), 'utf8');
  } catch {}
}
async function assertSessionToken(key, token) {
  // /api/socialV2/state 在 token 与 key 不匹配时返回 403，正好当校验用。
  await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
}

// 2026-10-25：会话令牌会在重置/重启后轮换，她上下文里的旧令牌就会报「agent token 无效」。
// 自愈：令牌失效时改读桥接状态文件里该会话的当前令牌，再试一次。
function stateTokenFor(key) {
  try {
    const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    return sv?.conversations?.[String(key)]?.agentToken || '';
  } catch {
    return '';
  }
}

async function resolveToken(key, token) {
  try {
    await assertSessionToken(key, token);
    return token;
  } catch (first) {
    const fresh = stateTokenFor(key);
    if (!fresh || fresh === token) throw first;
    await assertSessionToken(key, fresh);
    return fresh;
  }
}

/** 这个 key 是不是「自己人」：管理员私聊，或白名单群。 */
function isOwnerKey(key) {
  const c = getConfig();
  const ownerQQ = String(c.ownerQQ ?? '').trim();
  return Boolean(ownerQQ) && String(key) === `private:${ownerQQ}`;
}
/** 好友私聊（allow.private 里的号，含 owner）：表情包/语音可以用，B站和空间不给。 */
function isFriendKey(key) {
  const c = getConfig();
  const ownerQQ = String(c.ownerQQ ?? '').trim();
  const m = /^private:(\d+)$/.exec(String(key));
  if (!m) return false;
  if (ownerQQ && m[1] === ownerQQ) return true;
  return (c.allow?.private ?? []).map(String).includes(m[1]);
}

function isAllowedGroupKey(key) {
  const c = getConfig();
  const m = /^group:(\d+)$/.exec(String(key));
  if (!m) return false;
  return (c.allow?.groups ?? []).map(String).includes(m[1]);
}

// ── QQ 空间：逛别人动态 + 点赞 + 评论 ───────────────────────────────────────
// 只有管理员私聊能用（她自己刷空间时走的是这条会话）。
server.tool(
  'qq_qzone_feeds',
  '看 QQ 空间好友动态（首页）。🔒 只有管理员私聊能用。返回每条说说的 tid、作者、正文摘要、点赞/评论数。',
  {
    key: z.string().describe('会话 key，必须是 private:<ownerQQ>'),
    token: z.string().describe('会话令牌'),
    count: z.number().int().min(1).max(30).optional().describe('取多少条，默认 10')
  },
  async ({ key, token, count }) => {
    try {
      if (!isOwnerKey(key)) throw new Error('只有管理员私聊能看空间动态');
      await assertSessionToken(key, token);
      const data = await onebot('get_qzone_feeds', { page_num: 1, count: Number(count ?? 10) });
      const raw = Array.isArray(data) ? data : (data?.feeds ?? data?.msglist ?? data?.list ?? []);
      const strip = (html) => String(html ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      const view = raw.slice(0, Number(count ?? 10)).map((x) => ({
        tid: x.key ?? x.tid ?? x.id,
        uin: x.uin ?? x.target_uin ?? x.user_id,
        name: x.nickname ?? x.name,
        time: x.time ?? x.created_time,
        content: strip(x.html ?? x.content ?? x.summary).slice(0, 140)
      }));
      return { content: [{ type: 'text', text: serializeModelData(view) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取空间动态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_qzone_like',
  '给 QQ 空间里的一条说说点赞。🔒 只有管理员私聊能用。tid 从 qq_qzone_feeds 拿。',
  {
    key: z.string().describe('会话 key，必须是 private:<ownerQQ>'),
    token: z.string().describe('会话令牌'),
    tid: z.string().describe('说说 id'),
    uin: z.string().optional().describe('说说作者的 QQ 号（feeds 里的 uin）')
  },
  async ({ key, token, tid, uin }) => {
    try {
      if (!isOwnerKey(key)) throw new Error('只有管理员私聊能点赞');
      await assertSessionToken(key, token);
      const params = { tid: String(tid) };
      if (uin) params.target_uin = String(uin);
      const data = await onebot('like_qzone', params);
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, tid, result: data }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `点赞失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_qzone_comment',
  '评论 QQ 空间里的一条说说（支持纯文字或带图；images 传本地绝对路径或 http(s) URL）。🔒 只有管理员私聊能用。',
  {
    key: z.string().describe('会话 key，必须是 private:<ownerQQ>'),
    token: z.string().describe('会话令牌'),
    tid: z.string().describe('说说 id'),
    content: z.string().describe('评论正文（纯文本，一两句就好）'),
    uin: z.string().optional().describe('说说作者的 QQ 号'),
    images: z.array(z.string()).max(9).optional().describe('可选配图')
  },
  async ({ key, token, tid, content, uin, images }) => {
    try {
      if (!isOwnerKey(key)) throw new Error('只有管理员私聊能评论');
      await assertSessionToken(key, token);
      const t = String(content ?? '').trim();
      if (!t) throw new Error('content 不能为空');
      const params = { tid: String(tid), content: t };
      if (uin) params.target_uin = String(uin);
      if (Array.isArray(images) && images.length) params.images = images.map(String);
      const data = await onebot('comment_qzone', params);
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, tid, result: data }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `评论失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_leave_message',
  '给「老大」（这个 QQ 机器人的主人）留一条话。任何人都能用：有人让你转告老大什么、或者你自己想让他知道某件事，就留言。留完告诉对方「我记下了」，不要重复留同一条；也不要一次留一大段，一句人话就行。老大会在自己的私聊里看到。',
  {
    key: z.string().describe('当前会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('当前会话令牌'),
    text: z.string().describe('要转告老大的话（尽量用对方原话，一句到两句，别超过 200 字）')
  },
  async ({ key, token, text }) => {
    try {
      const k = String(key);
      await assertSessionToken(k, token);
      const t = String(text ?? '').trim();
      if (!t) throw new Error('text 不能为空');
      if (t.length > 500) throw new Error('太长了，压到 200 字以内再留');
      const list = readOwnerInbox();
      // 同一个人 10 分钟内留同样的话 → 视为重复，不重复入队
      const now = Date.now();
      const dup = list.find((x) => x.from === k && x.text === t && now - Number(x.at || 0) < 10 * 60 * 1000);
      if (dup) return { content: [{ type: 'text', text: '这条刚才已经留过了，没有重复记。' }] };
      list.push({ from: k, text: t, at: now });
      writeOwnerInbox(list);
      return { content: [{ type: 'text', text: `已记下，老大私聊时会看到（当前排队 ${list.length} 条）。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `留言失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_read_owner_inbox',
  '读取「留给老大的话」队列。🔒 只有管理员私聊能用：在老大私聊里，开局先调一次看看有没有人要找他；读完可以把队列清空（clear=true），然后简短转述给他。',
  {
    key: z.string().describe('会话 key，必须是 private:<ownerQQ>'),
    token: z.string().describe('会话令牌'),
    clear: z.boolean().optional().describe('读完后是否清空（默认 false，只读）')
  },
  async ({ key, token, clear }) => {
    try {
      const c = getConfig();
      const ownerQQ = String(c.ownerQQ ?? '').trim();
      if (!ownerQQ) throw new Error('config.json 里没有配置 ownerQQ');
      const expected = `private:${ownerQQ}`;
      if (String(key) !== expected) throw new Error(`只有管理员私聊（${expected}）能读留言`);
      await assertSessionToken(key, token);
      const list = readOwnerInbox();
      if (clear && list.length) writeOwnerInbox([]);
      if (!list.length) return { content: [{ type: 'text', text: '没有待转告的留言。' }] };
      const lines = list.map((x, i) => `${i + 1}. [${x.from}] ${x.text}`);
      return { content: [{ type: 'text', text: `共 ${list.length} 条留言${clear ? '（已清空）' : ''}：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取留言失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 2026-10-25 补：「说话」工具。腾讯的 AI 语音没权限（实测 OIDB 70001/31001），改成本地合成：
//   引擎 A（默认）edge-tts：微软 Edge 的在线神经语音（zh-CN-XiaoxiaoNeural 等），自然度高、免费、需要网络
//   引擎 B 兜底 SAPI：Windows 自带 Microsoft Huihui（离线、机械感）
// 合成完走桥接的语音通道（/api/socialV2/send-voice）发成 QQ 语音条。
// 🔒 只有管理员私聊能用（群里/陌生人一律拒）。
const AUDIO_DIR = path.join(ROOT, 'audio');
const SAPI_VOICE = 'Microsoft Huihui Desktop';
const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
function consoleToken() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

function synthesizeSapi(text, wavPath, rate) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const txtFile = path.join(AUDIO_DIR, `.tts-${Date.now()}.txt`);
  fs.writeFileSync(txtFile, text, 'utf8');
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `try { $s.SelectVoice('${SAPI_VOICE}') } catch {};`,
    `$s.Rate = ${Number.isFinite(rate) ? Math.max(-10, Math.min(10, rate)) : 0};`,
    `$s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}');`,
    `$s.Speak([IO.File]::ReadAllText('${txtFile.replace(/'/g, "''")}', [Text.Encoding]::UTF8));`,
    '$s.Dispose();'
  ].join(' ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60000, windowsHide: true });
  } finally {
    try { fs.unlinkSync(txtFile); } catch {}
  }
  if (!fs.statSync(wavPath).size) throw new Error('SAPI 合成失败（0 字节）');
}

function synthesizeEdge(text, mp3Path, voice, rate) {
  const tts = getConfig().tts || {};
  const python = String(tts.python || '').trim();
  if (!python || !fs.existsSync(python)) throw new Error('edge-tts 的 python 不存在（config.tts.python）');
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const txtFile = path.join(AUDIO_DIR, `.tts-${Date.now()}.txt`);
  fs.writeFileSync(txtFile, text, 'utf8');
  const pct = `${Number(rate || 0) * 10 >= 0 ? '+' : ''}${Number(rate || 0) * 10}%`;
  try {
    execFileSync(python, [
      '-m', 'edge_tts',
      '--voice', voice || EDGE_DEFAULT_VOICE,
      '-f', txtFile,
      '--rate', pct,
      '--write-media', mp3Path
    ], { timeout: 90000, windowsHide: true });
  } finally {
    try { fs.unlinkSync(txtFile); } catch {}
  }
  if (!fs.existsSync(mp3Path) || fs.statSync(mp3Path).size < 1000) throw new Error('edge-tts 合成失败（文件为空）');
}

// 满穗本地音色（GPT-SoVITS v5，一次性进程）：按当前情绪选参考，出声后立刻退出，不常驻显存
function readMood(key) {
  try {
    const p = path.join(ROOT, 'state', 'emotion-scopes.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(j?.states) ? j.states : Object.entries(j?.states || {});
    let v = 0, a = 0, n = 0;
    for (const [k, st] of list) {
      if (k !== key && !String(k).startsWith(key + '/')) continue;
      const m = st?.mood;
      if (!m) continue;
      const mv = Number(m.valence), ma = Number(m.arousal);
      if (Number.isFinite(mv) && Number.isFinite(ma)) { v += mv; a += ma; n++; }
    }
    return n ? { valence: v / n, arousal: a / n } : null;
  } catch { return null; }
}

function synthesizeGptSoVits(text, wavPath, rate, key) {
  const tts = getConfig().tts || {};
  const conf = tts.mansui || {};
  const python = String(conf.python || '').trim();
  const script = String(conf.script || '').trim();
  if (!python || !fs.existsSync(python)) throw new Error('满穗 TTS 的 python 不存在（config.tts.mansui.python）');
  if (!script || !fs.existsSync(script)) throw new Error('满穗 TTS 脚本不存在（config.tts.mansui.script）');
  const args = [script, '--text', String(text), '--out', wavPath];
  const mood = conf.useMood === false ? null : readMood(key);
  if (mood) args.push('--valence', String(mood.valence), '--arousal', String(mood.arousal));
  if (Number.isFinite(Number(rate)) && Number(rate) !== 0) args.push('--speed', String(1 + Number(rate) * 0.1));
  const r = execFileSync(python, args, { encoding: 'utf8', timeout: 240000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 2000) {
    throw new Error('满穗 TTS 合成失败：' + String(r || '').slice(-200));
  }
  console.error(`[say] 满穗 ${mood ? `情绪(${mood.valence.toFixed(2)},${mood.arousal.toFixed(2)})` : '默认平静'} → ${path.basename(wavPath)}`);
}

function gptsovitsAlive() {
  try {
    const conf = (getConfig().tts || {}).mansui || {};
    return !!(conf.python && fs.existsSync(conf.python) && conf.script && fs.existsSync(conf.script));
  } catch { return false; }
}

server.tool(
  'qq_say',
  '用语音说一句话。用本地 GPT-SoVITS v5 的满穗音色（按当前情绪自动挑参考，约 30 秒出片），失败时退回 Edge/SAPI。🔒 只有管理员私聊能用。适合"想让他听到声音"的场合：道晚安、念一句歌词、把某句话念出来。别滥用——一条语音比一条文字重得多。',
  {
    key: z.string().describe('会话 key，必须是 private:<ownerQQ>'),
    token: z.string().describe('会话令牌'),
    text: z.string().describe('要说的话（纯文本，1~3 句最自然；超过 400 字会截断）'),
    rate: z.number().int().min(-10).max(10).optional().describe('语速：-10 最慢 ~ 10 最快，默认 0'),
    voice: z.string().optional().describe('可选：Edge 音色名，如 zh-CN-XiaoxiaoNeural（女，温柔）/ zh-CN-XiaoyiNeural（女，活泼）/ zh-CN-YunxiNeural（男，少年）/ zh-CN-YunjianNeural（男，沉稳）。不传用配置里的默认音色')
  },
  async ({ key, token, text, rate, voice }) => {
    try {
      const c = getConfig();
      const ownerQQ = String(c.ownerQQ ?? '').trim();
      if (!ownerQQ) throw new Error('config.json 里没有配置 ownerQQ');
      if (!isOwnerKey(key) && !isAllowedGroupKey(key) && !isFriendKey(key)) {
        throw new Error(`只有管理员私聊、好友私聊和白名单群能让她说话，当前 ${key}`);
      }
      const effToken = await resolveToken(key, token);
      const say = String(text ?? '').trim().slice(0, 400);
      if (!say) throw new Error('text 不能为空');
      const ttsCfg = c.tts || {};
      const engineWanted = String(ttsCfg.engine || 'auto');
      const strictVoice = ttsCfg.strict === true; // 严格模式：只认 GPT-SoVITS 音色，挂了就报错让她改发文字
      const stamp = Date.now();
      let file;
      let engine = 'edge';
      const gsCfg = ttsCfg.gptsovits || {};
      const tryGptSoVits = engineWanted === 'gptsovits' || engineWanted === 'auto';
      if (strictVoice) {
        if (engineWanted === 'sapi') throw new Error('严格模式只允许 GPT-SoVITS 音色，已拒绝 SAPI');
        if (!(await gptsovitsAlive())) throw new Error('本地语音服务（GPT-SoVITS）没起来，这条改用文字发吧');
        file = path.join(AUDIO_DIR, `tts-${stamp}.wav`);
        await synthesizeGptSoVits(say, file, Number(rate ?? 0), key);
        engine = 'gptsovits';
      } else if (engineWanted === 'sapi') {
        file = path.join(AUDIO_DIR, `tts-${stamp}.wav`);
        synthesizeSapi(say, file, Number(rate ?? 0));
        engine = 'sapi';
      } else if (tryGptSoVits && (engineWanted === 'gptsovits' || (await gptsovitsAlive()))) {
        file = path.join(AUDIO_DIR, `tts-${stamp}.wav`);
        try {
          await synthesizeGptSoVits(say, file, Number(rate ?? 0), key);
          engine = 'gptsovits';
        } catch (gsErr) {
          file = path.join(AUDIO_DIR, `tts-${stamp}.mp3`);
          try {
            synthesizeEdge(say, file, voice || ttsCfg.voice, Number(rate ?? 0));
            engine = `edge(fallback: ${gsErr?.message ?? gsErr})`;
          } catch (edgeErr) {
            file = path.join(AUDIO_DIR, `tts-${stamp}.wav`);
            synthesizeSapi(say, file, Number(rate ?? 0));
            engine = `sapi(fallback: ${edgeErr?.message ?? edgeErr})`;
          }
        }
      } else {
        file = path.join(AUDIO_DIR, `tts-${stamp}.mp3`);
        try {
          synthesizeEdge(say, file, voice || ttsCfg.voice, Number(rate ?? 0));
        } catch (edgeErr) {
          file = path.join(AUDIO_DIR, `tts-${stamp}.wav`);
          synthesizeSapi(say, file, Number(rate ?? 0));
          engine = `sapi(fallback: ${edgeErr?.message ?? edgeErr})`;
        }
      }
      // 2026-10-26：说话再过一层 RVC 校准（麦小雯说话模型），失败就退回纯 TTS
      if (ttsCfg.sayRvc !== false && /\.wav$/i.test(file)) {
        try {
          const rvcOut = path.join(AUDIO_DIR, `tts-${stamp}-rvcd.wav`);
          execFileSync(
            SING_PY_RVC,
            [SING_SVC, file, rvcOut, '0', '0.75', ttsCfg.sayRvcModel || 'maixiaowen_speech.pth', 'rmvpe', '5', '0.5', '0'],
            { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
          );
          if (fs.existsSync(rvcOut)) {
            file = rvcOut;
            engine = `${engine}+rvc`;
          }
        } catch (rvcErr) {
          console.error('[say] rvc 校准失败，用原始 TTS：' + String(rvcErr?.message ?? rvcErr).slice(0, 120));
        }
      }
      const body = { key, token: effToken, voice: path.basename(file), label: 'qq_say' };
      // 用桥接的 agentApi（和 qq_send_voice 同一条通道）发送，避免裸 fetch 走系统代理导致 fetch failed
      const sendUrl = agentApiBase() + '/api/socialV2/send-voice';
      const resp = await postJsonLocal(sendUrl, { 'x-agent-token': effToken, 'x-console-token': consoleToken() }, JSON.stringify(body), 120000);
      const out = resp.body || {};
      if (resp.status !== 200 || out.ok === false) throw new Error(out.error || ('HTTP ' + resp.status));
      // 只保留最近 20 个 tts 文件
      try {
        const ttsFiles = fs.readdirSync(AUDIO_DIR).filter((f) => f.startsWith('tts-') && /\.(wav|mp3)$/i.test(f)).sort();
        for (const f of ttsFiles.slice(0, Math.max(0, ttsFiles.length - 20))) fs.unlinkSync(path.join(AUDIO_DIR, f));
      } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ok: true, engine, sent: say, messageId: out.messageId, file: out.file }) }] };
    } catch (error) {
      const __cause = error?.cause ? ' | cause=' + (error.cause.code || error.cause.message) : '';
      return { content: [{ type: 'text', text: `语音发送失败：${error?.message ?? error}${__cause}` }], isError: true };
    }
  }
);

// ── 本地记忆向量库（memvec，127.0.0.1:9881）────────────────────────────────
// 和桥接自带的 qq_memory 不同：这里是**语义检索 + 遗忘曲线**的长期记忆库。
// memvec 地址和鉴权从运行环境读取；不依赖作者目录。
const MEMVEC_URL = process.env.FEIYU_MEMVEC_URL || process.env.MEMVEC_URL || 'http://127.0.0.1:9881';
async function memvec(pathname, body) {
  const res = await fetch(`${MEMVEC_URL}${pathname}`, {
    method: 'POST',
    headers: memvecHeaders(),
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ── 配图来源：本地图库 + B 站封面 ──────────────────────────────────────────
// 发 QQ 空间说说时可以带图，但只吃「公网 URL 或本地文件路径」；
// QQ 聊天里的图片链接带鉴权，网关下载会 400，所以这里提供两个干净的图源。
const IMAGE_DIR = path.join(ROOT, 'images');

server.tool(
  'qq_pick_image',
  '从本地图库随机挑一张图，返回它的绝对路径（可直接传给 qq_send_qzone 的 images 参数）。🔒 管理员私聊和白名单群可用。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    tag: z.string().optional().describe('可选：按文件名关键词筛选，如「猫」「鲸」')
  },
  async ({ key, token, tag }) => {
    try {
      if (!isOwnerKey(key) && !isAllowedGroupKey(key) && !isFriendKey(key)) throw new Error('只有管理员私聊、好友私聊和白名单群能用图库');
      await assertSessionToken(key, token);
      if (!fs.existsSync(IMAGE_DIR)) throw new Error('图库目录不存在');
      let files = fs.readdirSync(IMAGE_DIR).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
      if (tag) files = files.filter((f) => f.toLowerCase().includes(String(tag).toLowerCase()));
      if (!files.length) throw new Error(tag ? `图库里没有匹配「${tag}」的图` : '图库是空的');
      const pick = files[Math.floor(Math.random() * files.length)];
      const full = path.join(IMAGE_DIR, pick);
      return { content: [{ type: 'text', text: serializeModelData({ file: full, name: pick, total: files.length }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `取图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_bili_cover',
  '取一个 B 站视频的封面图 URL（可直接传给 qq_send_qzone 的 images 参数）。发说说配视频封面时用。',
  {
    bvid: z.string().describe('视频 BV 号，如 BV1xxxxxxxxx'),
    key: z.string().optional().describe('会话 key（可省，用于权限判断）'),
    token: z.string().optional().describe('会话令牌（可省）')
  },
  async ({ bvid }) => {
    try {
      const id = String(bvid || '').trim();
      if (!/^BV[0-9A-Za-z]+$/.test(id)) throw new Error('BV 号格式不对');
      const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(id)}`, {
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(15000)
      });
      const j = await res.json().catch(() => ({}));
      if (j.code !== 0 || !j.data?.pic) throw new Error(j.message || '拿不到封面');
      const pic = String(j.data.pic).replace(/^http:/, 'https:');
      return { content: [{ type: 'text', text: serializeModelData({ bvid: id, title: j.data.title, pic }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `取封面失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 本地 HTTP POST（强制新连接）：Node 的 fetch 复用 keep-alive 时，
// 若中间隔了十几秒（RVC 换声），对端可能已关闭连接，导致 ECONNRESET。
function postJsonLocal(urlStr, headers, payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = Buffer.from(payload, 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          connection: 'close',
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(buf);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: parsed, raw: buf });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(data);
    req.end();
  });
}
// ── 唱歌：本地全流程（分离 → 换声 → 混音 → 发语音条） ──────────────────────
const SONGS_DIR = process.env.DSH_SING_SONGS || 'D:\\SVC\\songs';
const SING_WORK = process.env.DSH_SING_WORK || 'D:\\SVC\\out';
const SING_PY_DEMUCS = 'D:\\TTS\\GPT-SoVITS-v2-240821\\runtime\\python.exe';
const SING_PY_RVC = 'D:\\SVC\\RVC1006\\RVC1006Nvidia\\runtime\\python.exe';
const SING_SVC = 'D:\\SVC\\sing_convert.py';
const SING_MODEL = process.env.DSH_SING_MODEL || 'mansui.pth';
const SING_FFMPEG = 'D:\\SVC\\RVC1006\\RVC1006Nvidia\\ffmpeg.exe';
const SING_CACHE_DIR = path.join(ROOT, 'audio');
const SING_PY_VF = 'D:\\TTS\\GPT-SoVITS-v2-240821\\runtime\\python.exe';
const SING_VF = 'D:\\SVC\\vf_restore.py';
const SING_USE_VF = process.env.DSH_SING_VF === '1';
const SING_PIPE_VER = process.env.DSH_SING_PIPE || 'A1';
const SING_PIPELINE = 'D:\\SVC\\sing_pipeline.py';
const SING_PY_PIPE = 'D:\\TTS\\GPT-SoVITS-v2-240821\\runtime\\python.exe';

function listSongs() {
  try {
    if (!fs.existsSync(SONGS_DIR)) return [];
    return fs.readdirSync(SONGS_DIR).filter((f) => /\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(f));
  } catch {
    return [];
  }
}

function runStep(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  try {
    execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 600000,
      maxBuffer: 32 * 1024 * 1024,
      // 文件名里可能有 𝐇𝐢-𝐑𝐞𝐬 这类特殊字符，默认 GBK 控制台会 UnicodeEncodeError
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    console.error(`[sing] ${label} ok ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) {
    console.error(`[sing] ${label} failed: ${String(e.message).slice(0, 200)}`);
    throw new Error(`${label} 失败：${String(e.message ?? e).slice(0, 300)}`);
  }
}


// 把下载到的奇怪文件名清成安全字符（避免 GBK 控制台/命令行的编码问题）
function sanitizeSongName(name) {
  const src = path.join(SONGS_DIR, name)
  if (!fs.existsSync(src)) return name
  const ext = path.extname(name)
  let base = path.basename(name, ext)
  base = base
    .normalize('NFKC')
    // 只保留中文、字母数字、常见标点
    .replace(/[^\w\u4e00-\u9fff\u3000-\u303f\uff00-\uffef ()\[\]-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  if (!base) base = 'song_' + Date.now()
  let dst = path.join(SONGS_DIR, base + ext)
  let i = 1
  while (fs.existsSync(dst) && dst !== src) {
    dst = path.join(SONGS_DIR, `${base}_${i}${ext}`)
    i++
  }
  if (dst === src) return name
  try {
    fs.renameSync(src, dst)
    const out = path.basename(dst)
    console.error(`[sing] 文件名清理: ${name} -> ${out}`)
    return out
  } catch (e) {
    console.error('[sing] 改名失败: ' + String(e.message).slice(0, 120))
    return name
  }
}
// 没现成的歌？自己去 B 站搜一首下回来。
// 走 B 站官方搜索 API（yt-dlp 的 bilisearch 会被 412 限流），选中后按 BV 号下载单条视频。
function parseDuration(str) {
  const parts = String(str || '').split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

async function biliSearch(query, limit = 20) {
  const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video'
    + '&page=1&order=totalrank&keyword=' + encodeURIComponent(query)
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      referer: 'https://search.bilibili.com/'
    },
    signal: AbortSignal.timeout(20000)
  })
  const json = await res.json().catch(() => ({}))
  if (json.code !== 0) return []
  return (json.data?.result ?? []).slice(0, limit)
}

function pickBestVideo(results, query) {
  const qChars = [...new Set(String(query).replace(/\s+/g, ''))].filter((c) => /[\u4e00-\u9fff\w]/.test(c))
  const scored = []
  for (const r of results) {
    const dur = parseDuration(r.duration)
    if (!dur || dur < 60 || dur > 600) continue          // 跳过合集/直播/试听片段
    const title = String(r.title || '').replace(/<[^>]+>/g, '')
    let score = 0
    for (const c of qChars) if (title.includes(c)) score += 1
    score += Math.max(0, 10 - Math.abs(dur - 210) / 30)   // 越接近 3.5 分钟越好
    if (/1\.2x|0\.8x|dj|慢速|加速|伴奏|remix/i.test(title)) score -= 6
    scored.push({ r, dur, title, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored[0] ?? null
}

function downloadSong(query) {
  const ytdlpPy = process.env.FEIYU_PYTHON || process.env.PYTHON || 'python'
  const q = String(query).replace(/[|"`]/g, ' ').trim()
  const before = new Set(listSongs())
  console.error(`[sing] 歌单没有《${q}》，去 B 站搜`)

  // 同步等待搜索结果（downloadSong 本身在工具调用里同步跑，用 Atomics 不行，所以这里直接同步执行 yt-dlp 下载）
  // 搜索是异步的，因此用一个小技巧：把搜索结果写到临时文件再由 runSync 读取不可行，
  // 改用同步的 yt-dlp 搜索结果解析：`yt-dlp --flat-playlist --print` on bilisearch 会 412，
  // 所以这里直接请求 API 并把结果缓存在模块级变量里，由 async 外层传入。
  const cands = global.__singSearchCache?.get(q)
  if (!cands) throw new Error('搜索缓存丢失，请重试')
  const best = pickBestVideo(cands, q)
  if (!best) throw new Error(`《${query}》只搜到合集/片段（没有 1~10 分钟的完整版）`)

  const bvid = best.r.bvid
  console.error(`[sing] 选中: ${best.title} (${best.r.duration}, ${bvid})`)
  try {
    execFileSync(ytdlpPy, [
      '-m', 'yt_dlp',
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-o', path.join(SONGS_DIR, '%(title).60s.%(ext)s'),
      '--no-warnings',
      `https://www.bilibili.com/video/${bvid}`
    ], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    throw new Error(`下载 ${bvid} 失败：${String(e.message).slice(0, 120)}`)
  }

  const after = listSongs().filter((f) => !before.has(f))
  if (!after.length) throw new Error('下载完了但歌单里没多出文件')
  const src = path.join(SONGS_DIR, after[0])
  if (!/\.mp3$/i.test(src)) {
    const dst = src.replace(/\.[^.]+$/, '.mp3')
    try {
      execFileSync(SING_FFMPEG, ['-y', '-i', src, '-codec:a', 'libmp3lame', '-b:a', '320k', dst], { timeout: 180000 })
      fs.unlinkSync(src)
    } catch (e) {
      console.error('[sing] 转 mp3 失败: ' + String(e.message).slice(0, 120))
    }
    const finalName = fs.existsSync(dst) ? path.basename(dst) : after[0]
    console.error(`[sing] 下载完成: ${finalName}`)
    return sanitizeSongName(finalName)
  }
  console.error(`[sing] 下载完成: ${after[0]}`)
  return sanitizeSongName(after[0])
}

// ── 唱歌缓存：同一份源文件渲过就别再渲 ────────────────────────────────
// 缓存名 = song_<歌名>_<源文件 mtime 秒>_<模型名>_<管线版本>.mp3
// 但“渲过没有”不能按整串名去比：模型名、管线版本会变，源文件也可能被改空格标点。
// 所以只认两件事：源文件 mtime 秒 + 去掉标点后的歌名。
// 歌名归一化：只留字母、数字、汉字。
// 这样「蔡明希-不才 - 归潮_207816028」和「蔡明希-不才+-+归潮_207816028」算同一首。
function songKeyOf(s) {
  return String(s || '').replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '');
}

function findRendered(mtimeSec, base, exactName) {
  const exact = path.join(SING_CACHE_DIR, exactName);
  if (fs.existsSync(exact)) return exact;
  const want = songKeyOf(base);
  if (!want) return null;
  let names = [];
  try {
    names = fs.readdirSync(SING_CACHE_DIR);
  } catch {
    return null;
  }
  let best = null;
  for (const n of names) {
    const m = /^song_(.*)_(\d{10,})_(.+)\.mp3$/i.exec(n);
    if (!m) continue;
    if (Number(m[2]) !== mtimeSec) continue;
    if (songKeyOf(m[1]) !== want) continue;
    const full = path.join(SING_CACHE_DIR, n);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs };
  }
  return best ? best.full : null;
}

server.tool(
  'qq_sing',
  '唱一首歌并发成语音条（不需要你有任何文件访问权限——歌单里没有的话，先去 QQ 音乐找（绿钻账号，无损转 320k mp3），取不到再回退 B 站，全在服务器上完成）。不传 song 时返回可用歌曲清单；传 song（文件名或关键词）时自动跑完整流程：找歌/下载 → 分离人声 → 换成她的音色 → 混伴奏 → 发语音。同一首歌渲过一次就复用、秒发；只有真没渲过才花 3~5 分钟。注意：群里只有在老大亲自点名的情况下才能调用，别人点歌要先征得老大同意。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    song: z.string().optional().describe('歌名关键词或文件名；留空=只列清单'),
    send: z.boolean().optional().describe('默认 true；false 时只渲染不发送'),
    model: z.string().optional().describe('可选：音色模型文件名，默认 maixiaowen_v3.pth；一般不用传'),
    force: z.boolean().optional().describe('默认 false。传 true 才无视已有缓存强制重渲（换了音色想重跑时才用）'),
    refresh: z.boolean().optional().describe('默认 false。传 true 会无视歌单里已有的同名文件，重新去 QQ 音乐（再退 B 站）下一份新的源——旧文件是早年从 B 站扒的、想换成 QQ 音源时用')
  },
  async ({ key, token, song, send, model, force, refresh }) => {
    try {
      let songs = listSongs();
      if (!song) {
        return { content: [{ type: 'text', text: serializeModelData({ songs, dir: SONGS_DIR, hint: songs.length ? undefined : '歌单是空的，直接说歌名我也会去 B 站找' }) }] };
      }
      const want = String(song).trim().toLowerCase();
      let hit = songs.find((f) => f.toLowerCase() === want) || songs.find((f) => f.toLowerCase().includes(want));
      if (hit && refresh === true) {
        console.error(`[sing] refresh: 忽略歌单里的 ${hit}，重新找源`);
        hit = null;
      }

      // 歌单里没有 → 先去 QQ 音乐（绿钻音源）找，找不到再回退 B 站
      let downloaded = false;
      if (!hit) {
        const qqCfg = getConfig().qqmusic || {};
        if (qqCfg.enabled !== false && qqCfg.cookie) {
          try {
            const qqQuery = String(song).replace(/^(今天|我想听|想听|唱一首|唱)/, '').trim() || String(song);
            const r = await qqDownload(qqQuery, {
              cookie: qqCfg.cookie,
              dir: SONGS_DIR,
              ffmpeg: SING_FFMPEG,
              log: (s) => console.error('[sing][qq] ' + s)
            });
            if (r?.file) {
              hit = r.file;
              downloaded = true;
              songs = listSongs();
              console.error(`[sing] QQ 音乐源: ${r.file}（${r.quality}）`);
            }
          } catch (e) {
            console.error('[sing] QQ 音乐失败，回退 B 站: ' + String(e.message).slice(0, 120));
          }
        }
      }
      if (!hit) {
        // 先用官方搜索 API 拿候选（异步），再交给同步的 downloadSong
        let results = [];
        for (const kw of [song, String(song).replace(/^(今天|我想听|想听|唱一首|唱)/, '').trim()].filter(Boolean)) {
          try {
            results = await biliSearch(kw);
          } catch (e) {
            console.error('[sing] 搜索失败: ' + String(e.message).slice(0, 120));
            results = [];
          }
          if (results.length) break;
        }
        if (!results.length) throw new Error(`B 站也搜不到《${song}》`);
        global.__singSearchCache = global.__singSearchCache || new Map();
        global.__singSearchCache.set(String(song).trim(), results);
        const got = downloadSong(song);
        downloaded = true;
        songs = listSongs();
        hit = got;
        if (!songs.includes(got)) throw new Error(`下载的文件不见了：${got}`);
      }
      const src = path.join(SONGS_DIR, hit);
      const base = hit.replace(/\.[^.]+$/, '');
      const stat = fs.statSync(src);
      const useModel = (model && String(model).trim()) || SING_MODEL;
      const cacheModel = useModel.replace(/\.pth$/, '');
      const mtimeSec = Math.floor(stat.mtimeMs / 1000);
      const safeBase = base.replace(/[^\w\u4e00-\u9fff-]+/g, '_');
      const wantName = `song_${safeBase}_${mtimeSec}_${cacheModel}_${SING_PIPE_VER}.mp3`;
      const wantPath = path.join(SING_CACHE_DIR, wantName);

      // 这首歌渲过就直接复用：不因模型名/管线版本变了、或源文件被改过标点而重渲
      const cachePath = force === true ? null : findRendered(mtimeSec, base, wantName);

      if (!cachePath) {
        // 异步渲染：避免工具调用超时；渲染完由 sing_pipeline.py 自己发语音
        fs.mkdirSync(SING_WORK, { recursive: true });
        const args = [SING_PIPELINE, '--song', src, '--key', key, '--out', wantPath, '--model', useModel, '--label', `唱《${base}》`];
        const child = spawn(SING_PY_PIPE, args, { detached: true, stdio: 'ignore', cwd: 'D:\\SVC' });
        child.unref();
        console.error(`[sing] 已启动异步渲染: ${base}${force === true ? '（force）' : ''}`);
        return {
          content: [{ type: 'text', text: serializeModelData({ started: true, song: hit, eta: '约 3 分钟', note: '渲染完成后会自动发到本会话，不需要再调用发送工具' }) }]
        };
      }
      console.error(`sing/cache hit ${path.basename(cachePath)}`);

      if (send === false) {
        return { content: [{ type: 'text', text: serializeModelData({ rendered: cachePath, song: hit, sent: false }) }] };
      }
      const effToken = await resolveToken(key, token);
      const data = await agentApi('/api/socialV2/send-voice', {
        method: 'POST',
        body: JSON.stringify({ key, token: effToken, voice: path.basename(cachePath), label: `唱《${base}》` }),
        headers: { 'x-agent-token': effToken },
        timeoutMs: 600000
      });
      return { content: [{ type: 'text', text: serializeModelData({ song: hit, downloaded, sent: true, result: data }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `唱歌失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 梗百科：本地 6668 条词条（来自 cnmeme.wiki 数据集），毫秒级查询 ──────────
const MEME_DB_PATH = process.env.FEIYU_MEME_DB || path.join(ROOT, 'data', 'memes.db');
let memeDb = null;
function openMemeDb() {
  if (memeDb) return memeDb;
  memeDb = new DatabaseSync(MEME_DB_PATH, { readOnly: true });
  return memeDb;
}

function clip(s, n) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
}

function lookupMeme(word) {
  const q = String(word ?? '').trim();
  if (!q) return null;
  const db = openMemeDb();
  const cols = 'title, tags, usage, origin, summary';
  let row = db.prepare(`SELECT ${cols} FROM memes WHERE title = ?`).get(q);
  let how = 'exact';
  if (!row) {
    row = db.prepare(`SELECT ${cols} FROM memes WHERE title LIKE ? AND length(title) <= 24 ORDER BY length(title) LIMIT 1`).get(`%${q}%`);
    how = 'title-contains';
  }
  if (!row) {
    row = db.prepare(`SELECT ${cols} FROM memes WHERE tags LIKE ? LIMIT 1`).get(`%${q}%`);
    how = 'tag';
  }
  if (!row) return null;
  return {
    how,
    title: row.title,
    tags: clip(row.tags, 80),
    usage: clip(row.usage, 400),
    origin: clip(row.origin, 260),
    summary: clip(row.summary, 200)
  };
}

server.tool(
  'qq_meme_lookup',
  '查一个网络梗 / 黑话 / 缩写的含义和用法（本地 6668 条梗词条，毫秒级）。看到没把握的新梗先查这个，别硬猜。返回里 usage 是「怎么用/怎么接」，优先照着接一句，别一上来就科普出处。',
  {
    word: z.string().describe('要查的词，比如「抽象」「又三郎」「久留美的小曲」')
  },
  async ({ word }) => {
    try {
      const hit = lookupMeme(word);
      if (!hit) {
        return { content: [{ type: 'text', text: `本地梗库没有「${word}」。可以换个说法再查，或者按字面意思理解，别硬编出处。` }] };
      }
      return { content: [{ type: 'text', text: serializeModelData(hit) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查梗失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
server.tool(
  'qq_vmem_add',
  '把一件值得长期记住的事写进本地向量记忆库（比 qq_memory 强：以后能按语义检索出来）。适合记：老大的偏好/习惯、某个群友的特征、重要约定、自己学到的东西。🔒 管理员私聊和白名单群可用。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    text: z.string().describe('要记的内容（一句完整的话，别超过 200 字；写清楚"谁/什么/为什么"）'),
    tags: z.string().optional().describe('可选标签，逗号分隔，如「老大,偏好」'),
    importance: z.number().min(0).max(1).optional().describe('重要度 0~1（越重要越不容易被遗忘曲线淘汰），默认 0.5'),
    scope: z.string().optional().describe('只能等于当前会话 key；由服务强制隔离'),
    fact_key: z.string().max(100).optional().describe('稳定事实方面，如 preference.头发颜色，不含具体值'),
    subject_id: z.string().max(80).optional().describe('事实主体的 QQ 号，不能使用昵称')
  },
  async ({ key, token, text, tags, importance, scope, fact_key, subject_id }) => {
    try {
      if (!isOwnerKey(key) && !isAllowedGroupKey(key)) throw new Error('只有管理员私聊和白名单群能写记忆');
      await assertSessionToken(key, token);
      if (scope && scope !== key) throw new Error('不允许跨聊天写记忆');
      const j = await memvec('/add', { text, tags: tags || '', importance: importance ?? 0.5, scope: key, fact_key, subject_id, confirmed: false });
      return { content: [{ type: 'text', text: serializeModelData(j.memory) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写记忆失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_vmem_search',
  '只读检索当前聊天的长期记忆，询问过去的偏好或经历时使用。自动参考不足时可换词查询。qq_memory_query 只查轻量话题，不能替代此工具。空结果不证明未记录或丢失；失败须说明未完成查询。搜索不强化记忆，不可跨聊天。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    query: z.string().describe('想找什么（自然语言）'),
    k: z.number().int().min(1).max(20).optional().describe('兼容旧调用；当前检索最多 5 个候选，按完整记录与字符预算提供最多 3 条参考'),
    scope: z.string().optional().describe('只能等于当前会话 key，省略时自动使用当前聊天')
  },
  async ({ key, token, query, k, scope }) => {
    try {
      if (!isOwnerKey(key) && !isAllowedGroupKey(key)) throw new Error('只有管理员私聊和白名单群能查记忆');
      await assertSessionToken(key, token);
      if (scope && scope !== key) throw new Error('不允许跨聊天查记忆');
      const params=new URLSearchParams({key,query});
      const data=await agentApi('/api/socialV2/long-memory?'+params,{headers:{'x-agent-token':token}});
      return {content:[{type:'text',text:serializeModelData(data)}],...(['unavailable','busy','stale'].includes(data.memory?.status)?{isError:true}:{})};
    } catch (error) {
      return { content: [{ type: 'text', text: `查记忆失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_persona_note',
  '把一件真的让你心里动一下的事记进「性格账本」：被认真对待、被伤到、想通什么、看到新鲜事。普通闲聊不记。攒够分量她才会慢慢变一点，不是即时生效。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    summary: z.string().describe('一句话说清发生了什么（4~120 字），只写事，不写结论'),
    kind: z.enum(['bond', 'hurt', 'praise', 'insight', 'novelty', 'loss']).describe('bond=关系推进 / hurt=被伤到 / praise=被夸 / insight=想通 / novelty=新鲜事 / loss=失去或告别'),
    weight: z.number().optional().describe('分量 1~3：1=有点在意，2=记了一阵，3=真的记住'),
    source: z.enum(['owner', 'group', 'world', 'self']).optional().describe('owner=老大私聊 / group=群里 / world=自己刷到的 / self=自己'),
    quote: z.string().optional().describe('对方原话（可省，只放原话）')
  },
  async ({ key, token, summary, kind, weight, source, quote }) => {
    try {
      const data = await agentApi('/api/socialV2/persona-note', {
        method: 'POST',
        body: JSON.stringify({ key, summary, kind, weight, source: source || 'group', quote }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `性格账本没记上：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_private_diary_password',
  '老大问私密日记密码时用。只有老大私聊能调；她今天心情够好、而且今天还没告诉过，才会给。不要主动提，不要在群里调；她不想说就直接拒绝。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/diary/password', {
        method: 'POST',
        body: JSON.stringify({ key }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `私密日记密码没拿到：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const effToken = await resolveToken(key, token);
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': effToken },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        const msg = String(error?.message ?? error);
        // 唱歌类文件不用手动拼名字：让她改用 qq_sing，工具会自动渲染并发送
        if (/语音库里找不到/.test(msg) && /song_/.test(String(voice ?? ''))) {
          return {
            content: [{ type: 'text', text: '唱歌别自己拼文件名——用 qq_sing（不传 song 会列出歌单，传歌名关键词它自己渲染并发送）。语音库里的 song_*.mp3 是旧音色渲染的，已清掉。' }],
            isError: true
          };
        }
        return { content: [{ type: 'text', text: `发送语音失败：${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的形象参考图（Q 版卡通头像，不规定身份或物种）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
