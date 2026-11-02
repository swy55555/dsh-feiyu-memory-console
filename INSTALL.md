# 安装与部署（0.11.0）

这份文档只讲安装。装完之后怎么用，见 [用户手册](manual/USER_GUIDE-0.11.0.md)。

> **这不是一键安装包。** 它不包含 DSH、QQ、SnowLuma、模型服务，也不替你把 QQ 登录好。

---

## 0. 前置条件

| 组件 | 要求 | 怎么确认 |
|---|---|---|
| Windows | 主要验证平台 | — |
| DSH | 支持本地插件的版本（已在 DSH NEXT 验证） | 能打开 `http://127.0.0.1:3080` |
| Node.js | **24 或更新** | `node -v` |
| Python | **3.10 或更新**，带 `venv` | `python --version` |
| QQ | 已登录的 QQNT | 能正常收发消息 |
| SnowLuma | 已启动并连上 OneBot | `http://127.0.0.1:3001` 可访问 |
| 模型服务 | 一个可用的聊天模型（DSH 内配置） | DSH 里能正常对话 |

端口占用：

| 端口 | 用途 |
|---|---|
| 3080 | DSH 和控制台页面 |
| 3100 | 心迹桥接 |
| 9881 | 独立记忆服务 memvec |
| 3001 | SnowLuma（默认） |

---

## 1. 目录规划

建议先把两个目录定下来：

```
插件目录      D:\dsh\plugins\dsh-feiyu-memory-console
心迹桥接目录      D:\dsh\qq-bridge
数据目录      %USERPROFILE%\.dsh
```

- **插件目录**：本仓库的代码；
- **心迹桥接目录**：运行时，由安装器写入；
- **数据目录**：记忆库、状态、配置，默认 `~/.dsh`，不要放进插件目录。

路径可以含空格，但命令里要加引号。

---

## 2. 安装插件

### 方式 A：DSH 插件页安装

1. 打开 DSH 设置 → 插件；
2. 选择“从本地安装”/“安装本地插件”；
3. 选中 `dsh-feiyu-memory-console-0.11.0.zip`，或解压后的插件目录；
4. 启用插件；
5. 重启 DSH。

### 方式 B：手动放置

把仓库目录放到 DSH 的插件目录（通常是 `%USERPROFILE%\.dsh\plugins\`），确保：

```
%USERPROFILE%\.dsh\plugins\dsh-feiyu-memory-console\package.json
```

存在，然后重启 DSH。

### 确认

打开：

```
http://127.0.0.1:3080/dsh-feiyu-memory/
```

右上角应显示 **v0.11.0**。页面打不开时先看 DSH 日志，不要重复安装。

---

## 3. 准备记忆服务（memvec）

### 3.1 建虚拟环境

```powershell
cd "D:\dsh\plugins\dsh-feiyu-memory-console"
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r memvec\requirements.txt
```

要求 Python ≥3.10。用 3.9 会在安装依赖时失败。

### 3.2 启动

```powershell
npm run start:memvec
```

或直接：

```powershell
.\.venv\Scripts\python.exe memvec\server.py
```

首次启动会下载向量模型（`bge-small-zh-v1.5`，通过 fastembed），需要网络；下载后缓存在本地。

### 3.3 确认

```powershell
Invoke-WebRequest http://127.0.0.1:9881/stats -UseBasicParsing
```

返回 JSON 即正常。数据库默认在 `%USERPROFILE%\.dsh\memvec\memories.db`。

> 已有数据库时，**不要**换成新路径启动，否则会出现空库。先备份。

---

## 4. 安装心迹桥接运行时

```powershell
cd "D:\dsh\plugins\dsh-feiyu-memory-console"
node bridge/install-all.mjs --target "D:\dsh\qq-bridge" --check
node bridge/install-all.mjs --target "D:\dsh\qq-bridge" --apply
```

- `--check` 只比较，不改文件；
- `--apply` 写入运行时，并保留备份；
- 遇到未知或改过的文件会拒绝覆盖，先人工比较，不要直接加 `--replace-legacy`。

安装完成后，心迹桥接目录里应有：

```
src\bridge.js
bridge-loop.cmd
config.json
state\
```

---

## 5. 必填配置

配置文件：`<心迹桥接目录>\config.json`。至少确认这些字段：

| 字段 | 说明 |
|---|---|
| `ownerQQ` | 你的 QQ 号（主人） |
| `snowluma.wsUrl` | SnowLuma OneBot WebSocket 地址 |
| `snowluma.httpUrl` | SnowLuma HTTP 地址 |
| `snowluma.accessToken` | SnowLuma 访问令牌（如启用） |
| `dsh.baseUrl` | DSH 地址，默认 `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH 访问令牌（如果启用） |
| `allow.private` | 允许的私聊对象 |
| `allow.groups` | 允许的群 |
| `consolePort` | 心迹桥接管理端口，默认 3100 |
| `consoleToken` | 控制台访问令牌，**不要外泄** |

最小示例（只列关键字段，其余保留默认）：

```json
{
  "ownerQQ": 123456789,
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3001",
    "accessToken": ""
  },
  "dsh": { "baseUrl": "http://127.0.0.1:3080" },
  "allow": {
    "private": { "123456789": true },
    "groups": {}
  },
  "consolePort": 3100,
  "consoleToken": "换成你自己的长随机串"
}
```

白名单不填且 `allowAllWhenEmpty=true` 时，任何私聊都会进来；**正式使用建议关掉这个开关**。

---

## 6. 启动顺序

```
memvec（9881） → DSH（3080） → SnowLuma（3001） → 心迹桥接（3100） → QQ
```

心迹桥接启动：

```powershell
cd "D:\dsh\qq-bridge"
bridge-loop.cmd
```

或双击随包提供的“启动心迹”快捷方式（`xinji-launcher.ps1 -Action Start`），它会按需启动缺失的服务。

---

## 7. 首次自检

打开控制台总览，确认三项：

- **记忆库**：能读到数据库；
- **桥接**：3100 在线；
- **QQ**：SnowLuma 已连接。

再发一条真实 QQ 私聊，确认：

1. 有回复；
2. 总览的“记录”有新增；
3. 回廊能看到这条原文；
4. 拾光里没有凭空出现的兴趣。

没有新增不一定是故障：普通闲聊可能没有可提取的事实。先看原文和处理记录，不要为了“有数据”降低确认门槛。

---

## 8. 升级

1. **备份**：插件目录、`~/.dsh/memvec`（含 WAL/SHM）、`~/.dsh/qq-bridge/state`、`~/.dsh/feiyu-memory-console`；
2. 停心迹桥接和 memvec；
3. 安装新插件包；
4. 复制新的 `memvec/server.py` 到实际服务目录（保留数据库路径）；
5. 运行 `node bridge/install-all.mjs --target ... --check`，再 `--apply`；
6. 启动 memvec、DSH、桥接；
7. 打开总览看版本号和数据路径是否一致。

升级不会自动开启付费功能，也不会重置已有人格与记忆。

### 回滚

保留旧插件目录、旧 `server.py`、旧心迹桥接运行时备份；按原路径恢复后重启。数据库如已迁移，回滚前先确认备份可用。

---

## 9. 卸载

1. 停心迹桥接、memvec、DSH；
2. 移除插件目录；
3. 删除或保留数据目录：`~/.dsh/memvec`、`~/.dsh/qq-bridge`、`~/.dsh/feiyu-memory-console`、`~/.dsh/eval`；
4. 如需彻底清理，再删 DSH 会话目录里对应项目。

卸载不会自动撤回已发送的 QQ 消息。

---

## 10. 常见故障

| 现象 | 先查什么 |
|---|---|
| 插件页 404 | DSH 没重启，或插件目录路径变了 |
| 版本还是旧号 | DSH 启动时读的是旧 package.json，重启 |
| 心迹桥接离线 | 3100 是否被占用；`bridge-loop.cmd` 是否在跑 |
| 401 未授权 | `consoleToken` 不一致；浏览器缓存了旧令牌 |
| memvec 起不来 | Python 版本、依赖、9881 占用、模型下载失败 |
| 模型下载卡住 | 代理/HF 网络；可先离线放置缓存 |
| QQ 不回 | SnowLuma 是否连上、白名单是否包含该对象 |
| 数据是空的 | 数据库路径不一致，检查 `~/.dsh/memvec` 与启动参数 |
| 中文乱码 | 用 UTF-8 保存配置；PowerShell 设 `chcp 65001` |

端口检查：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3080,3100,9881,3001
```

---

## 11. 安全

- `consoleToken`、`snowluma.accessToken`、模型密钥都不要提交到仓库或截图外发；
- 不要把 3080/3100/9881 暴露到公网；仅本机 `127.0.0.1`；
- 控制台令牌泄露时立即更换并重启桥接；
- 发布包不包含任何用户数据；如果你自己打包，先确认没有把 `state/`、`memories.db`、`persona.json` 打进去。

---

## 12. 安装检查清单

```
[ ] Node 24+，Python 3.10+
[ ] 插件目录存在 package.json，DSH 已重启
[ ] 3080 页面显示 v0.11.0
[ ] memvec 9881 返回 JSON
[ ] 心迹桥接 3100 在线
[ ] SnowLuma 3001 已连接
[ ] config.json 填了 ownerQQ 和白名单
[ ] consoleToken 已改成随机长串
[ ] 发一条 QQ 私聊，回廊有原文
[ ] 备份了 memvec 和 qq-bridge/state
```
