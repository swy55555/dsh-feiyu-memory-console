# 交给 Agent 的完整首次安装指令（0.11.2）

下面整段可直接复制给能够操作本机文件和终端的 Agent。路径必须根据实际环境确定；不要把示例 E 盘当作所有用户的默认配置。已有安装应执行升级，不要重新初始化。

---

请帮我安装 **回响 / 心迹 0.11.2**，包括 `dsh-feiyu-memory-console` 控制台、心迹 QQ 桥接、DSH 预设/MCP 注册以及 memvec 记忆服务。不要额外安装 DSH Soul 或 dsh-fish-memory。

官方发布页：<https://github.com/swy55555/dsh-feiyu-memory-console/releases/tag/v0.11.2>

请先读这个版本的 README、INSTALL.md、manual/USER_GUIDE.md、docs/TECHNICAL_MANUAL.md、DISCLAIMER.md 和 ACKNOWLEDGEMENTS.md，然后实施安装。按实际结果报告，不要只给我计划，不要把页面能打开等同于全部功能安装成功。

## 一、先检查本机环境

1. 查明系统、Node（要求 24+）、npm、Python（3.10+）及 DSH 版本；定位 DSH 实际使用的数据根目录、活动 Profile（例如 desktop 或 web）、宿主端口与启动方式。
2. 查明是否已有回响、心迹、QQ 桥接、memvec 数据库、Python 环境、目录联接或进程。已有安装先备份并检查升级兼容性；不要直接对已有桥接运行首次初始化，不要删除原数据库或拿空库替换。
3. 保留现有数据位置。数据若在 E 盘，就继续使用 E 盘；不要降级 DSH，不要把 Electron 用户数据目录擅自迁移或改成目录联接。
4. 确认 DSH 已有可用聊天模型，以及可选的视觉模型。读取 provider/model 标识即可，不要打印 API key、Cookie、管理令牌或完整配置文件。
5. 确认我是否已准备并登录 SnowLuma / 兼容 OneBot。不要把本插件安装包当成 QQ 客户端；需要手动登录时告诉我具体操作，不要索取 QQ 密码或验证码。
6. 无法从已有环境确定的安装路径、管理员 QQ、允许的私聊/群或预算，请集中问我。不要猜账号，不要默认允许所有群，不要自行购买或订阅服务。

## 二、下载并核对发布包

1. 从上面的 0.11.2 Release 下载 `dsh-feiyu-memory-console-0.11.2.tgz` 和 `SHA256SUMS-0.11.2.txt`，计算 SHA-256 并逐字比对；不匹配就停止使用该包。
2. 解压到稳定、可写的插件代码目录。确认目录根部有 package.json、lib、bridge、bin、memvec 和 INSTALL.md；不要误把解压外层目录当作插件根目录。
3. 这次安装使用同一版本的代码和文档。不要用 0.11.1 包尝试空目录首次安装，也不要从作者电脑或聊天附件复制私人配置补洞。

## 三、首次初始化心迹桥接

下面是 Windows PowerShell 命令模板。执行前按实际情况填好四个变量；不是让你照抄我的盘符。

```powershell
$env:DSH_HOME = 'E:\dsh-home'
$pluginDir = 'E:\dsh\plugin\feiyu-memory-console'
$bridgeDir = Join-Path $env:DSH_HOME 'qq-bridge'
$dshProfile = 'desktop'

Set-Location $pluginDir
node bin/init-bridge.mjs --target $bridgeDir --check
node bin/init-bridge.mjs --target $bridgeDir --apply

Set-Location $bridgeDir
npm ci --no-audit --no-fund
node src/bridge.js --check --dependencies
```

每步检查退出码，有失败就查明原因再继续。初始化器只接受空目录；遇到已有文件或代码改动不要强制覆盖。依赖安装的 postinstall 会修补 SDK 的本地导入路径，这是发布包提供的步骤；不要复制别的机器的 node_modules 绕过锁文件。

已有安装请改用插件目录下的 `node bridge/install-all.mjs --target <现有桥接路径> --check`，核对兼容和备份后再 `--apply`。不得默认使用 `--replace-legacy`。升级不覆盖已有 config.json、package.json、预设和数据。

## 四、注册到正在使用的 DSH Profile

```powershell
Set-Location $bridgeDir
node scripts/setup-dsh.mjs $dshProfile --plugin $pluginDir --check
node scripts/setup-dsh.mjs $dshProfile --plugin $pluginDir --apply
```

该步骤应注册回响、qq-mode-console、qq-agent-presets 三个 bundle，生成 qq-chat、qq-chat-v2、qq-memory 预设，并配置三个 MCP。出现路径占用时先辨明已有安装归属，不要删除其他插件。保留 `.setup-backups` 中的备份和 manifest。

确认宿主启动环境的 DSH_HOME 与终端一致。如果桥接不在默认 `<DSH_HOME>/qq-bridge`，为宿主和相关服务设置一致的 FEIYU_BRIDGE_DIR。终端临时设置不会改变已经运行的桌面程序。

需要重启时仅重启明确识别的 DSH 实例与目标桥接；先保存工作，不要按 node.exe 批量结束进程。重启后检查回响入口、三个预设和三个 MCP 的实际加载结果；检查报错和宿主版本兼容，不要只根据脚本退出码宣称宿主就绪。

## 五、配置 QQ、模型与默认行为

在桥接 config.json 中合并设置，保留初始化生成的管理令牌，不要在回复中展示它：

- DSH 的实际 baseUrl、模型 provider/model；不照抄开发者模型名，不擅自启用远程 DSH。
- SnowLuma 的实际 HTTP/WS 地址与访问令牌。先确认端口用途，不能把 WebSocket 端口当作 HTTP API。
- ownerQQ 为我确认的管理员；allow.private/allow.groups 只添加我授权的测试范围，allowAllWhenEmpty 保持 false。
- 主动联系、自动探索、定时叙事/日记、情绪复盘和模型学习先保持关闭；语音、音乐、额外素材能力没有相应环境时也保持关闭。
- 检查管理端口是否占用，保持管理接口仅本机访问。不要为了排错关闭鉴权或公开监听到公网。

先以前台 `node src/bridge.js` 启动，确认日志和依赖正常；再按我的实际启动习惯配置进程管理。不要启动两个桥接实例，也不要擅自自动部署或控制 SnowLuma 登录程序。

## 六、安装 memvec 并核对数据位置

1. 复用已有可用 Python 环境，或在明确选择的位置新建专用 venv，安装插件 `memvec/requirements.txt`。不要污染系统 Python；首次下载向量模型需要网络、磁盘和时间，应明确告知。
2. 设置 FEIYU_PYTHON；FEIYU_MEMVEC_DB 与 MEMVEC_DB_PATH 指向同一个真实数据库，FEIYU_MEMVEC_URL 与服务监听一致。模型缓存和令牌文件也要有明确位置。
3. 按 INSTALL.md 运行 `node bin/start-memvec.mjs`。已有数据库先核对来源和备份，不要遇到错误就另建空库。启动器报路径冲突要排查，不能跳过。
4. 确认桥接、控制台和 Python 服务使用一致的 memvec 鉴权配置。检查接口时令牌只在内存中作为请求头使用；不要放 URL、日志、截图或最终回复。
5. 从宿主打开回响页面，确认它看到的是正确桥接与数据库，不是另一个默认目录。运行插件 `node bin/doctor.mjs` 并解释尚未满足的项。

## 七、分阶段验收

请区分以下结果，不能把模拟测试当作真实验收：

1. **文件/依赖**：心迹 `--check --dependencies` 无缺失；初始化、预设和 MCP 文件齐全。
2. **宿主**：回响页面可访问，三个预设和 MCP 已实际加载，无 workspaceController/service-unavailable 等错误。
3. **QQ**：请我在授权的白名单测试会话发一条无敏感内容的消息，确认接收、调用模型、回复、来源与费用记录；不要主动给未授权联系人发测试消息。
4. **权限**：验证空白名单或不允许的对象不会被转发；缺少/错误管理或会话令牌会被拒绝。不要临时关闭权限检查使测试通过。
5. **记忆**：用明确标记的合成测试内容保存、查询并核对来源；展示测试结果后只清理这次创建的测试记录，不碰原记忆。
6. **关闭与费用**：确认关闭的主动行为保持关闭，暂停后不再新发起相关任务；说明模型、向量下载及可选外部服务的费用来源。价格以我的供应商实际计费为准，不承诺免费或固定金额。
7. **重启**：在同一数据根目录重启指定服务，确认配置、入口和测试记录持久化，无重复进程或端口冲突。

最后给我安装报告：版本、插件代码路径、桥接路径、数据根目录、数据库/缓存/令牌文件位置（仅路径）、活动 Profile、运行端口、启停方式、默认关闭项、备份位置、已通过的检查与未完成的检查。告诉我如何打开页面、开始聊天、关闭主动行为、停止服务，以及如何保留数据升级或回退。若卡在外部账号、网络或宿主版本，请明确指出，不要把部分成功写成全部完成。

---

本指令不包含任何人的账号、令牌、真实记忆或付费服务授权。具体部署步骤以同版本 [INSTALL](../INSTALL.md) 为准。
