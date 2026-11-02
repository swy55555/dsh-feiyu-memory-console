# 安装、升级与工程运维

适用：0.11.1。本文件面向部署者。功能、费用和操作见 [用户手册](manual/USER_GUIDE.md)，机制见 [技术手册](docs/TECHNICAL_MANUAL.md)。本项目不包含 DSH、QQ 登录环境和模型服务，不是一键搭建全部环境的安装器。

## 1. 环境与边界

| 部件 | 要求与检查 |
| --- | --- |
| Node.js | 24 或更新，依赖 `node:sqlite`；运行 `node --version` |
| Python | 3.10 或更新；memvec 需要 numpy、fastembed，依赖见 `memvec/requirements.txt` |
| DSH | 支持当前本地插件接口；发布验证不覆盖任意历史版本 |
| QQ 接入 | 自行配置 SnowLuma / OneBot、账号和允许范围 |
| 基础桥接 | 已有受支持的 QQ 桥接目录及其基础适配模块；本包更新其运行时，不独立打包所有 QQ 基础实现 |
| 模型 | DSH 内已配置可用聊天模型及正确权限 |
| 浏览器测试 | 需要 Playwright 和浏览器；运行插件本身不要求安装它们 |

常用端口是 DSH 3080、桥接管理 3100、memvec 9881；QQ 接入的 HTTP 与 WebSocket 端口以自己的配置为准，不能假定所有安装都相同。服务默认应保持本机使用。

## 2. 先确定代码与数据路径

以下是示例，不会替你迁移或覆盖现有数据：

```powershell
$env:DSH_HOME = 'E:\dsh-home'
$env:FEIYU_BRIDGE_DIR = 'E:\dsh-home\qq-bridge'
$env:FEIYU_MEMVEC_DB = 'E:\dsh-home\memvec\memories.db'
$env:MEMVEC_DB_PATH = $env:FEIYU_MEMVEC_DB
$env:FEIYU_PYTHON = 'E:\your-python-env\Scripts\python.exe'
Set-Location 'E:\dsh\plugin\feiyu-memory-console'
node bin/doctor.mjs
```

这些环境变量只对当前终端和随后启动的子进程生效。图形桌面宿主、守护程序和计划任务需要在各自启动环境中设置；修改当前终端不会改变已经运行的 DSH。

| 配置 | 用途 |
| --- | --- |
| `DSH_HOME` | 默认根目录，未设置为用户主目录下 `.dsh` |
| `FEIYU_BRIDGE_DIR` | 控制台所读取的桥接目录 |
| `FEIYU_MEMVEC_DB` / `MEMVEC_DB_PATH` | 控制台／服务数据库路径，应指向同一真实文件 |
| `FEIYU_MEMVEC_URL` | 控制台访问的记忆服务地址 |
| `FEIYU_PYTHON` | 明确指定已有 Python 环境 |
| `MEMVEC_CACHE_PATH` | 向量模型缓存位置 |
| `MEMVEC_API_TOKEN_FILE` | 记忆服务令牌文件位置，默认数据库旁 `api-token` |
| `MEMVEC_API_TOKEN` | 可选直接提供令牌，32–256 位允许字符；不要打印或提交 |
| `FEIYU_DIARY_DIR` | 控制台日记目录覆盖项；还需核对桥接写入位置 |

目录联接可以导致多条路径指向同一数据。核对真实目标，不要仅比较盘符。不要移动整个 Electron 用户数据目录来代替插件数据迁移；宿主可能要求其中某些位置必须是真实目录。

## 3. 安装包与插件注册

从对应 Release 下载 `.tgz` 或源码 ZIP，验证 SHA-256。源码 ZIP 用于开发／检查；`.tgz` 是插件包，不包含账号配置、真实记忆、模型缓存和运行环境。

按当前 DSH 版本支持的本地插件安装方式加载包或解压目录。必须能读到根 `package.json` 并注册插件；仅把文件拷入一个随意目录不保证宿主自动加载。DSH NEXT 的 UI 与 Profile 安装方式可能随版本变化，按宿主实际入口操作。

加载后访问本机 `/dsh-feiyu-memory/`。独立预览可用 `npm start`，但预览不等于 QQ、DSH 模型会话及桥接已配置。

## 4. memvec 与鉴权

新环境需要在你选择的 Python 环境中准备 `memvec/requirements.txt` 依赖。已有可用环境应复用，升级插件不要求无条件重装依赖。

```powershell
# 仅新环境需要；不要在未知环境中盲目执行
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r memvec\requirements.txt
$env:FEIYU_PYTHON = (Resolve-Path '.\.venv\Scripts\python.exe').Path
node bin/start-memvec.mjs
```

启动可能首次下载向量模型。服务与所有客户端必须使用同一令牌配置；无令牌收到 401 不能被误判为服务损坏。需要检查接口时，在内存中读取令牌并作为 `x-memvec-token` 请求头发送，不把令牌放 URL 或截图。

```powershell
$memvecToken = (Get-Content -LiteralPath 'E:\dsh-home\memvec\api-token' -Raw).Trim()
Invoke-RestMethod 'http://127.0.0.1:9881/stats' -Headers @{ 'x-memvec-token' = $memvecToken }
Remove-Variable memvecToken
```

启动器会检查数据库路径冲突。发现旧库时先备份与核对，不要为了绕过提示创建另一个空库。

## 5. 心迹运行时安装与升级

```powershell
node bridge/install-all.mjs --target 'E:\dsh-home\qq-bridge' --check
node bridge/install-all.mjs --target 'E:\dsh-home\qq-bridge' --apply
```

`--check` 比较目标；`--apply` 写入受支持的运行时并保存备份。未知或人工修改过的文件应拒绝覆盖，先比较差异；不要默认加 `--replace-legacy`。安装器更新运行时，不替你准备完整 QQ 登录、守护程序和所有配置。

修改后的模块须在桥接重启后生效，插件宿主也可能需要重启。先确认没有正在发送或需要保留的任务；停止对应守护程序，避免旧进程自动拉起或两个实例竞争端口。只处理已确认的目标 PID／启动项，不按 `node.exe` 等通用名字批量结束进程。

## 6. 配置项与关闭策略

桥接配置在目标目录 `config.json`。保留自己的 `ownerQQ`、SnowLuma 地址与令牌、DSH 地址和模型配置、允许对象与群列表、管理端口和令牌。不要把示例账号当作生产值；空白名单的行为受现有配置影响，应显式核对允许范围。

以下是配置片段，应合并到原配置，不能替换整个文件。界面有相应开关时优先使用界面；手动编辑后重启并读回核对。

```json
{
  "socialV2": {
    "explore": { "enabled": false },
    "narrative": { "enabled": false, "schedule": false },
    "initiative": {
      "enabled": false, "dryRun": true,
      "allowExplore": false, "allowContact": false,
      "contactSend": false, "allowShared": false
    },
    "opennessDrift": { "enabled": false },
    "selfReference": { "enabled": false },
    "continuity": { "enabled": false },
    "association": { "idleEnabled": false, "idleAffectEnabled": false }
  }
}
```

这是关闭这些指定功能的片段，不是“全系统零调用”模板。日常记忆、情绪判断、日记等还有自己的开关；课堂启用状态保存在课堂状态中，应从年轮关闭。彻底停用需停止桥接和守护程序；禁用控制台插件不会自动停止独立服务。

## 7. 备份、迁移与回退

备份应覆盖数据库及一致性要求、桥接配置与 state、控制台数据、日记、所需密钥和启动配置。停止写入方后复制，或使用 SQLite 备份接口；不要遗漏正在使用的 WAL。

迁移先复制并核对，再调整启动环境与路径，最后逐个启动并确认读取的是原数据。不删除唯一原件，不因出现 C 盘旧路径就判断迁移失败。`FEIYU_MEMVEC_DB`、桥接来源访问路径和实际服务须一致。

代码回退可使用安装器已有备份及 `--undo`，先检查对应安装记录。代码回退不自动回退数据库 schema 或个人状态，也不是数据丢失的通用修复方式。用户已经迁移到 E 盘时，应沿用经过核对的新根目录，不默认搬回旧位置。

## 8. 排障与验证

| 现象 | 优先检查 |
| --- | --- |
| `workspaceController unavailable` | DSH 宿主工作区服务和启动日志，不先删除记忆或降级 |
| `Expected a real directory` | 宿主指定目录是否为链接及其真实目录要求 |
| 页面有数据、模型没有记忆 | 作用域、召回状态、上下文投递及桥接连接 |
| 401 / 403 | 令牌、Host、回环地址、写请求头与来源，不关闭鉴权规避 |
| 升级没变化 | 插件加载副本、运行时目标、进程是否真正重启 |
| 数据突然变空 | 根目录、数据库真实路径、环境变量和过滤条件 |

运行基础检查：`npm test`、`git diff --check`。`npm run check:engine` 检查当前目录的直接运行依赖；在未合并基础 QQ 桥接的源码包中会报告缺失，不能把它当作已部署验收通过。安装后应在真实目标运行 `node src/bridge.js --check`，此检查不发消息。

本版需沿用的基础模块包括 `memory-audit.mjs`、`private-diary.js`、`diary.js`、`preset-prompt.js`、`dsh-client.js`、`md-to-plain.js`、`v2-wait.js`、`qq-model-view.js`、`safe-fetch.js`、`send-voice-lib.js`、`snowluma-conn.js`、`forward.js`、`model-prices.js`、`sticker-lib.js`。未知基础版本需单独适配，不能创建空文件绕过检查。

浏览器测试依赖已有 Playwright 与浏览器；可以用 `FEIYU_PLAYWRIGHT_PATH`、`FEIYU_BROWSER_CHANNEL=msedge` 指定现有环境。新增发布边界检查为 `node --test test/release-hardening.test.mjs`；打包前运行 `npm run check:release`。

不要在生产状态下运行未知模拟脚本。`build-eval-sample` 与 `build-eval-fixture` 会读取私人数据，产物只留在数据根目录的 `private-evaluation`，不得提交或打包。
