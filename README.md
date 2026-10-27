# 可塑性记忆

本地优先的 QQ 角色记忆控制台，DSH 插件形态。把长期记忆、原文与摘要、日记、性格和情绪放在一个页面里，能看、能改、能撤回；所有数据都在本机。

当前版本 **0.7.2-ctx** · [使用手册](manual/可塑性记忆-使用手册-0.7.2.pdf) · [memvec 技术说明](docs/memvec.md) · [更新日志](CHANGELOG.md) · [Release](https://github.com/swy55555/dsh-feiyu-memory-console/releases)

---

## 这是什么

角色在 QQ 里聊天时，需要一个“记得住、忘得掉、改得动”的记忆层。这个插件负责把这一层摊开：

- **长期记忆**：偏好、习惯、计划、经历，存在本地向量库，会衰减，可确认、纠正、归档。
- **原文与摘要**：每轮注入的最近消息和更早的摘要，让对话能接上，又不至于把整段历史塞进 prompt。
- **日记、性格、情绪、情景**：慢变量和快变量分开存，能调、能审计、能撤销。

它不生成记忆，也不替角色说话。QQ 收发由桥接负责，记忆检索由 memvec 负责；插件只做控制台。

## 界面

下面截图来自一个纯合成的演示库：人名、QQ 号、对话和记忆都是编的，不含任何真实数据。

### 总览

记忆总量、各聊天分布、最近记下的和快要忘的。

![总览页：记忆总量、聊天分布、最近记忆和待整理队列](docs/assets/overview.webp)

### 长期记忆

按聊天/状态/层级筛选，看来源、改重要度、确认候选。

![长期记忆页：筛选、搜索和记忆条目](docs/assets/library.webp)

### 记忆图

节点是记忆，大小是重要度，颜色是聊天，线是关联或语义相近。

![记忆图：节点、连线、按聊天过滤](docs/assets/graph.webp)

### 轻量记忆

进行中的话题、没说出口的话、对群友的印象。

![轻量记忆页：话题、没说的话、群友印象](docs/assets/light.webp)

### 整理

队列、每日额度、手动提炼和衰减入口。

![整理页：队列、额度、备份导出](docs/assets/upkeep.webp)

### 会话上下文

左边选聊天，右边看注入预算、摘要和原文。

![会话上下文页：注入预算、摘要和原文](docs/assets/context.webp)

### memvec 内部结构

![memvec 模块总览](docs/assets/memvec-modules.svg)

## 功能

| 模块 | 说明 |
|---|---|
| 总览 | 记忆总量、各聊天分布、最近记忆、待整理队列、日记入口、称呼设置 |
| 长期记忆 | 按聊天/状态/层级筛选，搜索，新增，改重要度，确认候选，归档，删除，导出 |
| 记忆图 | 记忆之间的关联，支持缩放、平移、按聊天/状态过滤、暂停刷新、加载更多 |
| 语义搜索 | 本地向量检索，不调用外部模型 |
| 轻量记忆 | 进行中的话题、没说出口的想法、群友印象 |
| 整理队列 | 查看队列，手动提炼单个聊天，调整每日/群聊额度，暂停自动整理 |
| 日记 | 公开本可读、可改、可补；私密本加密，需要密码解锁 |
| 性格 | 查看/编辑维度、底色、边界，从角色卡起草，按聊天微调，撤销最近变化 |
| 情绪 | 核心情绪、心情、长期底色三层，情绪盘、触发链、微调审计 |
| 情景记忆 | 事件、解释、情绪、行动、结果，支持补结果和删除 |
| 会话上下文 | 原文层与摘要层：看最近原文/摘要、手动生成、删除写坏的摘要 |

写操作都有审计。记忆删除、公开日记修改、候选确认支持撤销；衰减归档没有整批撤销入口。

## 快速开始

### 环境要求

| 组件 | 是否必须 | 说明 |
|---|---|---|
| DSH 桌面版 2.x | 是 | 需要 Node.js 24+ |
| memvec | 是 | 默认 `127.0.0.1:9881`，包内附源码 |
| QQ 桥接 | 完整功能需要 | 默认 `127.0.0.1:3100`，不在包内 |
| SnowLuma | 完整功能需要 | OneBot v11 网关，第三方软件 |
| QQ 账号 | 完整功能需要 | 自行登录 SnowLuma |

### 安装插件

在 DSH 的 **设置 → 插件 → 安装** 里选这个包，或本地开发时填：

```text
link:C:\Users\<用户名>\.dsh\plugins\dsh-feiyu-memory-console
```

装完重启一次 DSH，设置左侧栏会出现「可塑性记忆」。页面资源每次请求读取，但宿主路由在启动时加载，**更新插件后也要重启**。

### 启动 memvec

`memvec` 是独立 Python 服务，不在 DSH 里自动启动。包内只带源码，不含数据库、模型缓存和日志。

```powershell
cd <插件目录>
npm run doctor
# 用 doctor 显示的 Python 装依赖；虚拟环境可指定 FEIYU_PYTHON
python -m pip install -r memvec/requirements.txt
npm run start:memvec
```

检查：

```powershell
curl.exe http://127.0.0.1:9881/stats
```

返回 `{"ok":true,...}` 就正常。首次启动会下载 `BAAI/bge-small-zh-v1.5`（约 90MB），之后离线加载。

### 启动 QQ 桥接

桥接也是独立进程，不在包内：

```powershell
cd ~/.dsh/qq-bridge
node src/bridge.js
```

检查：

```powershell
curl.exe http://127.0.0.1:3100/api/status
```

### 打开控制台

- 已装 DSH：`http://127.0.0.1:3080/dsh-feiyu-memory/`，或侧栏「可塑性记忆」
- 没装 DSH：`node bin/preview.mjs`，访问 `http://127.0.0.1:3999`

### 常见红点

| 现象 | 原因 |
|---|---|
| 记忆库红 | memvec 9881 没启动 |
| 桥接红 | QQ 桥接 3100 没启动 |
| QQ 红 | 桥接连不上 SnowLuma，或 QQ 没登录 |
| 3999 打不开 | 预览进程没运行 |

## 配置

配置在 `~/.dsh/qq-bridge/config.json` 的 `socialV2` 下；改完重启桥接生效。

### 会话上下文

```json
{
  "socialV2": {
    "context": {
      "enabled": true,
      "messagesChars": 6000,
      "summaryChars": 2000,
      "rotateTurns": 40,
      "rotateKeepMessages": 12,
      "autoRotate": true,
      "summaryMinMessages": 8,
      "summaryRetryMinutes": 30
    }
  }
}
```

- `messagesChars` / `summaryChars`：每轮注入的原文 / 摘要字符上限。
- `rotateTurns`：多少轮后考虑轮换；`autoRotate: false` 只手动摘要，不退役会话。
- `rotateKeepMessages`：轮换时留给新会话的原文条数。
- `summaryRetryMinutes`：摘要失败后的重试间隔，避免反复烧 token。

完整说明见 [bridge/P0-CONTEXT.md](bridge/P0-CONTEXT.md)。

### 整理队列

```json
{
  "socialV2": {
    "dailyMemory": {
      "enabled": true,
      "maxCallsPerDay": 200,
      "queueMax": 5000,
      "groupPolicy": "addressed",
      "groupMaxCallsPerDay": 20
    }
  }
}
```

- `maxCallsPerDay: 0` 不限每日批次；`queueMax: 0` 不限单聊天队列。
- `groupPolicy`：`addressed` / `signals` / `off`。

### 情绪

```json
{
  "socialV2": {
    "emotion": {
      "enabled": true,
      "drift": { "enabled": true, "mode": "apply", "cooldownDays": 7, "maxDelta": 1, "maxDims": 2 },
      "chatDrift": { "enabled": true, "owner": false, "groups": false },
      "weights": { "owner": 1.1, "group": 1, "private": 0.8 },
      "episodeRecall": { "enabled": true, "maxItems": 2 },
      "appraisalModel": { "enabled": false, "maxPerDay": 3 }
    }
  }
}
```

- `drift.mode`：`apply` 自动应用，`suggest` 只记录建议。
- `weights`：只改情绪幅度，不改长期人格。
- 模型复核默认关闭；开启会产生额外调用。

### 主动联系（只对你）

在指定时间窗里，如果你太久没说话，她会主动来找你；超过更久，会先掉一点心情，再带小脾气地找你。默认是概率制：静默半小时后开始掷骰子，越久越容易来，但每次联系后计时重新开始。

```json
{
  "socialV2": {
    "ownerContact": {
      "enabled": true,
      "windowStart": "08:00",
      "windowEnd": "24:00",
      "idleHours": 0.5,
      "repeatHours": 0.5,
      "maxPerDay": 16,
      "sulkAfterHours": 2,
      "sulkCooldownHours": 6,
      "sulkMoodDrop": 0.22,
      "probabilityPerCheck": 0.15,
      "probabilityRamp": 0.15,
      "maxProbabilityPerCheck": 0.7
    }
  }
}
```

- `windowStart` / `windowEnd`：本地时间，`24:00` 表示当天结束；支持跨午夜（如 `20:00`–`02:00`）。
- `idleHours`：距上次联系（或你最后一条消息）多久，开始进入概率判定。
- `probabilityPerCheck` / `probabilityRamp`：每 5 分钟掷一次骰子；刚进入判定时每次 15%，之后每多 1 小时再加 15 个百分点，封顶 70%。联系成功后计时重置，下一次重新等。
- `repeatHours`：两次联系的最小间隔，防止刚说完又来；`maxPerDay` 是每日上限。
- `sulkAfterHours`：你静默超过这么久，先掉心情再发；`sulkCooldownHours` 控制闹脾气的冷却。
- `sulkMoodDrop`：每次闹脾气让愉悦度下降的幅度（0.05–0.5），会留下「他很久没来找我」的触发记录，但不会直接改长期人格。

也可以在控制台「情绪」页的「主动联系」卡片里改，不用手写 JSON。

### 催睡觉

到点提醒你睡觉；催了还不睡、还在聊，会掉心情并带小脾气。

```json
{
  "socialV2": {
    "bedtime": {
      "enabled": true,
      "time": "24:00",
      "graceMinutes": 15,
      "sulkAfterMinutes": 60,
      "maxNags": 2,
      "sulkCooldownHours": 20,
      "sulkMoodDrop": 0.2
    }
  }
}
```

- `time`：`24:00` 就是午夜；也支持 `23:30` 这种提前提醒。
- 到点先发一条催睡；`graceMinutes` 后没回也没睡，再催一次（总共最多 `maxNags` 条）。
- 如果你还在发消息、明显没睡，`sulkAfterMinutes` 后先掉心情，再带小脾气催一次。
- 如果你回了「晚安 / 睡了 / 去睡」这类，就不再催、也不闹。
- 只在到点后的 3 小时内生效，凌晨 3 点后不再追着催。

### memvec 环境变量

```text
MEMVEC_OWNER_STRENGTH_DAYS=180
MEMVEC_OTHER_STRENGTH_DAYS=2
MEMVEC_STRENGTH_CAP_DAYS=365
MEMVEC_DB_PATH=<自定义数据库路径>
MEMVEC_CACHE_PATH=<自定义模型缓存路径>
```

### 称呼

默认「老大」，可在总览页改。只改动态人设块和日记提示词，不改角色卡原文。

## 数据目录

| 数据 | 路径 |
|---|---|
| 长期记忆 | `~/.dsh/memvec/memories.db` |
| 原文与摘要 | 同一个 `~/.dsh/memvec/memories.db`（`messages` / `session_summaries` 表） |
| 轻量记忆 | `~/.dsh/qq-bridge/state/social-v2.json` |
| 整理队列 | `~/.dsh/qq-bridge/state/daily-memory-queue.json` |
| 公开日记 | `~/.dsh/whale-diary.md` |
| 私密日记 | `~/.dsh/feiyu-memory-console/private-diary.vault.json` |
| 私密密码 | `~/.dsh/qq-bridge/state/private-diary.secret.json` |
| 性格 | `~/.dsh/feiyu-memory-console/persona.json` |
| 情绪 | `~/.dsh/feiyu-memory-console/emotion.json` |
| 聊天微调 | `~/.dsh/feiyu-memory-console/chat-persona.json` |
| 情景记忆 | `~/.dsh/feiyu-memory-console/episodes.json` |
| 审计日志 | `~/.dsh/feiyu-memory-console/audit.jsonl` |
| 日记备份 | `~/.dsh/feiyu-memory-console/diary-backups/` |

备份记忆库只需要复制 `memories.db`。

## 安全说明

- 只监听 `127.0.0.1` / `::1`，没有外部入口。
- 写操作要求 `x-feiyu-console: 1` 请求头和同源校验。
- 前端无框架、无外部 CDN。
- 日记写入前备份，使用 mtime 乐观锁；审计和撤销会校验数据是否被后续修改。
- 私密日记 AES-256-GCM 加密，不会自动进入 QQ 记忆。

需要注意：私密日记密码明文保存在桥接的受限文件里，管理员可读；它是防随手翻的软加密，不用于对抗本机管理员。不要分享 SnowLuma token、桥接 console token 或含白名单的配置。

## 开发与测试

```powershell
# 本地预览
node bin/preview.mjs

# 同步 memvec 源码
node scripts/sync-memvec.mjs
node scripts/sync-memvec.mjs --check

# 全套测试
npm test

# 单独跑
node test/features.test.mjs
node test/host.test.mjs
node test/diary.test.mjs
node test/audit.test.mjs
node test/p0-context.test.mjs
python test/memvec_test.py
python test/p0-context-test.py

# 浏览器回归（需要 Playwright）
node test/browser.test.mjs
```

`npm test` 跑七组隔离测试：插件路由、性格/情绪/情景、日记、审计、真实本机 HTTP 集成、上下文工程、Python 记忆生命周期。Python 测试使用固定向量，不下载模型、不连 QQ。

## 已知限制

- 包内不含 QQ 桥接、SnowLuma 和 QQ 账号。
- 没有桥接时，整理队列、情绪演化、私密日记等桥接功能不可用。
- 私密日记只支持查看和补页，不支持编辑。
- 记忆图最多加载 800 条，跨页不绘制边。
- 情绪 appraisal 基于规则，对反讽和复杂上下文可能误判。
- 情景记忆的行动和结果是启发式回填，不是完整因果模型。
- 没有移动端专门布局。

## 文档

- [使用手册（PDF）](manual/可塑性记忆-使用手册-0.7.2.pdf)：逐页功能说明、配置和排查
- [memvec 技术说明](docs/memvec.md)：技术选型、数据模型、检索与遗忘公式、参考文献
- [上下文层说明](bridge/P0-CONTEXT.md)：原文、摘要、轮换和预算
- [更新日志](CHANGELOG.md) · [升级说明](UPGRADE.md)

## 许可证

MIT
