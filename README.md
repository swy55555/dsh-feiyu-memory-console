# 可塑性记忆

一个用于查看和维护 QQ 角色记忆的 DSH 插件。

它把长期记忆、轻量记忆、整理队列、日记、性格、情绪和情景记忆放在同一个本地控制台里，并提供修改、审计和撤销能力。所有数据都保存在本机。

- 版本：0.7.1
- 许可证：MIT
- 运行环境：DSH 桌面版 2.x（Node.js 24+）

---

## 目录

- [简介](#简介)
- [架构](#架构)
- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [数据目录](#数据目录)
- [安全说明](#安全说明)
- [开发](#开发)
- [测试](#测试)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 简介

这个插件不生成记忆，也不替角色说话。它负责三件事：

1. 展示角色当前记得什么、哪些正在遗忘。
2. 允许用户修改记忆、日记、性格和情绪相关参数。
3. 提供审计和撤销，避免误操作直接覆盖数据。

控制台只读取本机文件，并通过本机 HTTP 服务操作数据，不向外部服务器发送内容。

---

## 架构

完整 QQ 模式：

```text
DSH 插件
  ├─→ memvec        127.0.0.1:9881   记忆库、向量检索、遗忘曲线
  └─→ QQ 桥接       127.0.0.1:3100   QQ 收发、整理、性格、情绪、日记
          └─→ SnowLuma（OneBot v11 网关）
                  └─→ QQ
```

插件不直接连接 SnowLuma，也不接触 QQ 登录凭证。它只与本机桥接通信。

没有桥接时，插件会降级为只读控制台：

- 可用：长期记忆、记忆图、语义搜索、公开日记
- 不可用或只读：整理队列、性格、情绪、私密日记

---

## 功能

| 模块 | 说明 |
|---|---|
| 总览 | 记忆总量、各聊天分布、最近记忆、待整理队列、日记入口、称呼设置 |
| 长期记忆 | 按聊天/状态/层级筛选，搜索，新增，修改重要度，确认候选，归档，删除，导出 |
| 记忆图 | 展示记忆之间的关联，支持缩放、平移、按聊天/状态过滤、暂停刷新、加载更多 |
| 语义搜索 | 使用本地向量检索，不调用外部模型 |
| 轻量记忆 | 查看和修改进行中的话题、未说出口的想法、群友印象 |
| 整理队列 | 查看队列，手动提炼单个聊天，调整每日/群聊额度，暂停自动整理 |
| 日记 | 公开本可读、可改、可补；私密本加密，需要密码解锁 |
| 性格 | 查看/编辑维度、底色、边界，从角色卡起草，按聊天微调，撤销最近变化 |
| 情绪 | 核心情绪、心情、长期底色三层，情绪盘、触发链、微调审计 |
| 情景记忆 | 记录事件、解释、情绪、行动、结果，支持补结果和删除 |

所有写操作都会写入审计日志。记忆删除、日记修改和衰减操作都支持撤销。

---

## 环境要求

| 组件 | 是否必须 | 说明 |
|---|---|---|
| DSH 桌面版 2.x | 是 | 需要 Node.js 24+ |
| memvec | 是 | 默认 `127.0.0.1:9881` |
| QQ 桥接 | 完整功能需要 | 默认 `127.0.0.1:3100`，不在插件包内 |
| SnowLuma | 完整功能需要 | OneBot v11 网关，第三方软件 |
| QQ 账号 | 完整功能需要 | 用户自行登录 SnowLuma |

### 关于 memvec

插件包内附带了 `memvec/` 源码，但**不包含**：

- `memories.db`
- `hfcache/`（约 90MB 的 embedding 模型）
- 日志
- 本地启动脚本

首次运行需要安装 Python 依赖，并下载模型。详细步骤见 `memvec/README.md`。

### 关于桥接和 SnowLuma

QQ 桥接和 SnowLuma 都不在插件包内。

- SnowLuma：安装并登录 QQ，开启 OneBot v11 的 HTTP/WS
- QQ 桥接：配置 SnowLuma 地址、访问令牌、管理员 QQ 和白名单

不要分享 `snowluma.accessToken`、`state/console-token` 或包含白名单的 `config.json`。

---

## 安装

### 发布版

在 DSH 插件安装中安装：

```text
dsh-feiyu-memory-console
```

或将 npm 包解压到 `~/.dsh/plugins/` 后，按 profile 的惯例 link。

### 本地开发

在 DSH 中进入 **设置 → 插件 → 安装**，填写：

```text
link:C:\Users\<用户名>\.dsh\plugins\dsh-feiyu-memory-console
```

安装完成后重启一次 DSH。设置左侧栏会出现「可塑性记忆」。

更新插件后也需要重启 DSH：页面资源每次请求时读取，但宿主路由在启动时加载。

### 本地预览

不安装到 DSH 也可以预览前端：

```powershell
node bin/preview.mjs
```

访问 `http://127.0.0.1:3999`。

---

## 配置

### 称呼

默认称呼为“老大”，可在总览页修改。

```json
{
  "socialV2": {
    "ownerTitle": "老大"
  }
}
```

修改后动态人设块和日记提示词会使用新称呼；角色卡原文不会改变。

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

- `maxCallsPerDay: 0` 表示不限制每日批次数
- `queueMax: 0` 表示不限制单聊天队列长度
- `groupPolicy` 可选 `addressed`、`signals`、`off`

### 情绪

```json
{
  "socialV2": {
    "emotion": {
      "enabled": true,
      "drift": {
        "enabled": true,
        "mode": "apply",
        "minSamples": 40,
        "minDays": 3,
        "cooldownDays": 7,
        "maxDelta": 1,
        "maxDims": 2
      },
      "chatDrift": {
        "enabled": true,
        "owner": false,
        "groups": false
      },
      "weights": {
        "owner": 1.1,
        "group": 1,
        "private": 0.8
      },
      "episodeRecall": {
        "enabled": true,
        "maxItems": 2
      },
      "appraisalModel": {
        "enabled": false,
        "maxPerDay": 3
      }
    }
  }
}
```

- `drift.mode`: `apply` 自动应用，`suggest` 只记录建议
- `weights`: 群聊/私聊/管理员对“当前情绪”的影响权重，范围 0.2–3；只改情绪幅度，不改长期人格
- `appraisalModel.enabled`: 默认关闭，开启后会额外调用模型
- `episodeRecall.enabled`: 关闭可减少每轮提示词长度

### 日记自动收

```json
{
  "socialV2": {
    "diary": {
      "autoImport": {
        "enabled": false
      }
    }
  }
}
```

开启后，每天自动把公开日记收进记忆库一次；私密日记永远不会自动收。

### memvec 环境变量

```text
MEMVEC_OWNER_STRENGTH_DAYS=180
MEMVEC_OTHER_STRENGTH_DAYS=2
MEMVEC_STRENGTH_CAP_DAYS=365
MEMVEC_DB_PATH=<自定义数据库路径>
MEMVEC_CACHE_PATH=<自定义模型缓存路径>
```

---

## 使用

### 总览

查看记忆总量、各聊天分布、最近记忆、待整理队列和日记入口。

「她怎么称呼你」用于修改角色对用户的称呼。

### 长期记忆

支持按聊天、状态、层级筛选，也可以使用语义搜索。

可以确认候选记忆、修改重要度、归档、删除、恢复和导出。

### 记忆图

- 圆点：一条记忆
- 大小：重要度
- 颜色：所属聊天
- 实线：明确关联或同一条事实
- 细线：语义相近
- 虚线/半透明：快遗忘或待确认

点击节点会跳转到对应的长期记忆。

### 整理队列

桥接每 15 秒检查一次队列。单个聊天累计 12 条消息，或安静 90 秒后，会触发一次提炼。

可以在「整理」页：

- 修改每日上限和群聊上限
- 暂停/继续自动整理
- 对单个聊天手动提炼

暂停后不会接收新消息，已有队列保留，手动提炼仍可用。

### 日记

公开日记位于 `~/.dsh/whale-diary.md`，默认每天 23:30 自动生成。

如果电脑在 23:30 时未开机，下次启动会尝试补写最近 3 天的日记；也可以在日记页手动触发补写。

公开日记可以「收进 QQ 记忆」，生成一条普通长期记忆。自动收默认关闭。

私密日记使用加密存储，解锁后可查看和补页，暂不支持编辑。密码由桥接生成，控制台只保存哈希。

管理员可以在私聊中询问角色密码。角色会根据当天情绪决定是否告知：

- 只有管理员私聊可调用
- 每天最多告知一次
- 情绪不佳时可以拒绝

私密日记为软加密：防止随手查看和文件被单独复制，但不能防止本机管理员读取桥接密码本。

### 性格

性格状态保存在 `persona.json`。

支持：

- 查看当前值、底色、边界和变化记录
- 从角色卡起草维度
- 编辑维度名称、底色、边界
- 按聊天微调当前状态
- 撤销最近一次变化

按聊天微调只影响该聊天的当前值，不改变全局底色。

### 情绪

情绪分为三层：

- 现在：核心情绪（valence / arousal）
- 今天：心情，慢 EMA
- 长期：底色，来自性格层

情绪更新使用规则 appraisal，不产生 LLM token；每 5 分钟向心情和底色回落。

情绪页支持：

- 开启/关闭长期情绪微调
- 切换直接应用 / 只建议
- 采纳、拒绝、撤销微调建议
- 按聊天自动微调
- 是否将相关事件加入提示词
- 模型复核（默认关闭）
- 重置情绪和气候

长期情绪微调只统计管理员私聊样本，并受样本量、观察天数、冷却时间和单次幅度限制。

### 情景记忆

`episodes.json` 记录高重要性事件：

```text
事件 / 解释 / 情绪 / 行动 / 结果 / 重要性
```

重要性大于等于 0.6 时保存全文，否则只保存摘要。

系统会根据机器人回复和下一条消息自动回填行动与结果；也可以在界面中手动补结果或删除。

---

## 数据目录

| 数据 | 路径 |
|---|---|
| 长期记忆 | `~/.dsh/memvec/memories.db` |
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

---

## 安全说明

- 只监听本机回环地址，仅允许 `127.0.0.1` 和 `::1`
- 写操作要求 `x-feiyu-console: 1` 请求头和同源校验
- 不使用外部 CDN，前端无框架依赖
- 日记写入前备份，并使用 mtime 乐观锁
- 审计和撤销会校验数据是否在操作后被修改
- 私密日记使用 AES-256-GCM 加密
- 私密日记不会自动进入 QQ 记忆

需要注意：

- 私密日记密码明文保存在桥接的受限文件中，管理员可以读取
- 私密日记是软加密，不用于对抗本机管理员
- 不要分享 SnowLuma access token、桥接 console token 或包含白名单的配置文件

---

## 开发

```powershell
# 本地预览
node bin/preview.mjs

# 同步 memvec 源码
node scripts/sync-memvec.mjs
node scripts/sync-memvec.mjs --check

# 插件测试
node test/features.test.mjs
node test/host.test.mjs
node test/diary.test.mjs
node test/audit.test.mjs

# UI 测试，需要浏览器 CDP 9223
node test/ui.test.mjs
```

桥接自身的测试位于 `qq-bridge` 目录，不包含在插件包中。

---

## 测试

当前测试覆盖：

- 插件路由、页面和写保护
- 性格、情绪、情景记忆 API
- 日记解析、修改、补页、备份和乐观锁
- 审计和撤销
- 记忆图、整理额度和私密日记密码接口
- 浏览器端总览、长期记忆、语义搜索、增删、轻量记忆和整理页

UI 测试需要先启动浏览器调试端口：

```powershell
chrome --headless=new --remote-debugging-port=9223 http://127.0.0.1:3999/
```

---

## 已知限制

- 插件包不包含 QQ 桥接、SnowLuma 和 QQ 账号
- 没有桥接时只能使用只读功能
- 私密日记目前只支持查看和补页，不支持编辑
- 记忆图最多加载 800 条，跨页不绘制边
- 情绪 appraisal 基于规则，对反讽和复杂上下文可能误判
- 模型复核默认关闭，开启后会产生额外调用
- 情景记忆的行动和结果是启发式回填，不是完整因果模型
- 没有移动端专门布局
- UI 自动化测试需要手动启动 CDP

---

## 许可证

MIT
