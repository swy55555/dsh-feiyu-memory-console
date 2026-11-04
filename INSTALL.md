# 安装、升级与工程运维

适用：0.11.4。本文件面向部署者。功能、费用和操作见 [用户手册](manual/USER_GUIDE.md)，机制见 [技术手册](docs/TECHNICAL_MANUAL.md)。本项目不包含 DSH、QQ 登录环境和模型服务，不是一键搭建全部环境的安装器。

从 0.11.2 升级到本版须额外阅读 [来源索引、配套文件升级与回退](docs/evidence-deployment.md)。安装包不会自动切换正在运行的服务或迁走原数据。

## 1. 环境与边界

| 部件 | 要求与检查 |
| --- | --- |
| Node.js | 24 或更新，依赖 `node:sqlite`；运行 `node --version` |
| Python | 3.10 或更新；memvec 需要 numpy、fastembed，依赖见 `memvec/requirements.txt` |
| DSH | 支持当前本地插件接口；发布验证不覆盖任意历史版本 |
| QQ 接入 | 自行配置 SnowLuma / OneBot、账号和允许范围 |
| 心迹桥接 | 0.11.2 起包含基础适配源码、三个 MCP、预设、npm 清单与锁文件，可初始化空目录；npm 依赖仍需联网安装 |
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

## 3. 首次安装：回响插件 + 心迹桥接

**新用户请使用 0.11.2 或更新的完整发布包。0.11.1 缺少首次安装所需的基础桥接文件。** 本版包含本项目运行时源码、依赖锁文件、QQ MCP、三个 Agent 预设、安全守卫及 DSH 注册脚本；不包含 DSH 软件、SnowLuma 登录环境、账号、模型额度、语音库和私人记忆。包内使用的上游代码保留原 MIT 许可；其他依赖与外部服务遵循各自条款。

从对应 Release 下载 `.tgz` 与 `SHA256SUMS-0.11.4.txt`，核对 SHA-256，解压后将 `package` 目录放在稳定位置。下面路径只是示例：**先确认实际 DSH_HOME 和活动 profile，不能照抄盘符，更不能把已有 E 盘数据迁回 C 盘。**

```powershell
$env:DSH_HOME = 'E:\dsh-home'
$pluginDir = 'E:\dsh\plugin\feiyu-memory-console'
$bridgeDir = Join-Path $env:DSH_HOME 'qq-bridge'
$dshProfile = 'desktop' # 必须核实，部分部署是 web
Set-Location $pluginDir
node bin/init-bridge.mjs --target $bridgeDir --check
node bin/init-bridge.mjs --target $bridgeDir --apply
Set-Location $bridgeDir
npm ci --no-audit --no-fund
node src/bridge.js --check --dependencies
node scripts/setup-dsh.mjs $dshProfile --plugin $pluginDir --check
node scripts/setup-dsh.mjs $dshProfile --plugin $pluginDir --apply
```

初始化仅接受空目录，生成独立管理令牌和关闭主动行为的配置，不读取其他桥接的账号或私人数据。重复初始化会验证原文件并保留配置；发现已有运行时或源码修改时拒绝覆盖，改走升级流程。`npm ci` 按锁文件安装依赖，其 postinstall 修补 SnowLuma SDK 的相对导入扩展名，仅修改这个桥接的 node_modules。

注册脚本只操作**已存在且明确指定**的 Profile：挂载回响、模式控制与预设三个 bundle，以及三个 MCP；保存变更前备份，保留不相关配置。不同安装占用的目录/链接会报错，需先人工核对。脚本不启动/重启 DSH，也不宣称宿主已加载成功。备份位置为桥接目录 `.setup-backups`，其中 manifest.json 记录每个被改文件的来源与备份。

接着配置桥接目录的 `config.json`：填入实际 DSH 地址、模型 provider/model、管理员 QQ、SnowLuma HTTP/WS 地址与令牌，只添加明确允许的私聊/群。空白名单默认不响应任何 QQ 消息。模型 ID 从自己的 DSH 模型目录选择，不能照抄开发者的模型名。不要在日志或聊天中展示完整令牌。

确认 DSH 启动环境也使用同一 DSH_HOME；桥接不在默认 `<DSH_HOME>/qq-bridge` 时还须给 DSH 宿主设置 FEIYU_BRIDGE_DIR。重启指定 DSH 实例后确认回响入口与 qq-chat / qq-chat-v2 / qq-memory 三个预设可见、三个 MCP 成功加载。只有桥接初始化不够，只有插件页面可见也不够。

```powershell
Set-Location $bridgeDir
node src/bridge.js
```

这条命令以前台方式运行桥接，关闭终端会停止；长期运行需另配你自己的进程管理方式。初次调试应先用前台读取错误，避免多个桥接争抢管理端口。自行启动并登录 SnowLuma，再用白名单内测试账号验证一轮收发。配置 memvec 见下一节；未装 Python 记忆服务不能宣称“记忆闭环已验收”。语音、音乐、表情库等可选能力须额外准备相应依赖或素材，不是空目录初始化会自动产生的内容。

可直接交给 Agent 的完整安装要求见 [首次安装指令](docs/AGENT_INSTALL.md)。控制台入口是 DSH 上的 `/dsh-feiyu-memory/`；`npm start` 只启动独立预览，不等于完成宿主注册、QQ 收发或记忆服务安装。

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

运行基础检查：`npm test`、`git diff --check`。`npm run check:engine` 递归检查当前源码中的运行依赖；0.11.4 的完整源码包应通过。安装并执行 npm ci 后，在真实目标运行 `node src/bridge.js --check --dependencies`，此检查不启动服务或发送消息。

0.11.2 已包含原先缺失的 14 个基础模块和 MCP 的间接依赖。检查器递归检查本地字面量导入；加 `--dependencies` 检查 npm 的 ESM 解析。检查通过不等于 QQ 登录、DSH 服务和模型调用成功。不要创建空文件绕过检查。

浏览器测试依赖已有 Playwright 与浏览器；可以用 `FEIYU_PLAYWRIGHT_PATH`、`FEIYU_BROWSER_CHANNEL=msedge` 指定现有环境。新增发布边界检查为 `node --test test/release-hardening.test.mjs`；打包前运行 `npm run check:release`。

不要在生产状态下运行未知模拟脚本。`build-eval-sample` 与 `build-eval-fixture` 会读取私人数据，产物只留在数据根目录的 `private-evaluation`，不得提交或打包。
