# 心迹 0.10.1 升级与回退

适用于已经运行 DSH、QQ/SnowLuma、QQ 桥接和独立记忆服务的环境。本包不是完整 QQ 客户端或 DSH 安装器。心迹接管入口和成长逻辑，通信与二代调度继续使用 QQ 兼容适配层。

## 1. 下载与核验

从 [v0.10.1 Release](https://github.com/swy55555/dsh-feiyu-memory-console/releases/tag/v0.10.1) 下载同版本 `.tgz` 或 `-source.zip`、手册、升级指南与 `SHA256SUMS-0.10.1.txt`。

```powershell
Get-FileHash -Algorithm SHA256 .\dsh-feiyu-memory-console-0.10.1.tgz
```

与校验清单核对。不要混用不同版本的插件、桥接和记忆服务。

## 2. 停止并备份

停止 DSH、QQ 桥接及其守护进程、独立记忆服务；确认实际监听端口与进程，不按名称批量结束所有 Node/Python。

备份插件目录、实际 memvec/server.py、SQLite 数据库及 WAL/SHM、桥接 src/public/config/state/roles/owner-contact.json、聊天预设源文件与生成文件、控制台数据目录、.runtime-backups 与 runtime-bundle.json。在线数据库应使用 SQLite backup；只复制正在运行的 .db 不可靠。不要用发布包替换个人配置和数据库。

## 3. 同步插件、桥接与记忆服务

按现有 DSH 本地插件方式更新实际链接的插件目录。在新包目录运行：

```powershell
npm run doctor
node bridge/install-all.mjs --target "D:\your-dsh\qq-bridge" --check
node bridge/install-all.mjs --target "D:\your-dsh\qq-bridge" --apply
```

安装器管理桥接运行时文件（以 --check 输出和回执为准）；已知且需要清理的 QQ MCP 另纳入同一备份/回执。未知或自行修改过的文件会拒绝覆盖，先人工比较，不要默认加 --replace-legacy。重复安装内容一致时不会重写。

将本包 memvec/server.py 复制到实际独立服务目录，保留数据库路径；使用包内 start:memvec 的环境则直接运行包内服务。不要用 sync:memvec 升级服务，它的方向是从本机服务同步回开发源码。

记忆服务增量创建原话回执、关系分页和两两关系回执表。新确认仍检查原话支持、主体、置信度、有效期、完整历史及最终版本；不因缓存放宽条件。旧缓存不能证明新依赖时保守重审一次。

## 4. 同步自然表达规则

```powershell
node scripts/install-conversation-style.mjs --target "D:\your-dsh\qq-bridge"
node scripts/install-conversation-style.mjs --target "D:\your-dsh\qq-bridge" --apply
```

默认只检查；--apply 备份两代预设，替换已知文风块并调用桥接构建器同步生成物，不改变工具、权限、模型设置。支持原二代“反 AI 味”块和已迁移文风块；原一代无独立块时追加。未知自定义二代模板拒绝自动替换，请对照 bridge/conversation-style.md 手工合并。旧身份与私人经历不随文风恢复。

后台分析与课程草案使用受限预设。更新已知后台指令时先检查，再应用；自定义模板会拒绝覆盖：

```powershell
node scripts/install-background-instructions.mjs --target "D:\your-dsh\qq-bridge"
node scripts/install-background-instructions.mjs --target "D:\your-dsh\qq-bridge" --apply
```

独立 fishtalk 插件不是本发布包的组成部分；如你使用它，本包提供可选兼容脚本供核对，保留该插件语料，不打包发布者语料或私聊。

## 5. 自我参考按需启用

升级保留现有配置，不自动放弃其他安装者的角色卡。需要可成长自我参考时，在桥接 config.json 现有 socialV2 中合并 selfReference.enabled=true，并确保 continuity.enabled=true、ownerQQ 和私聊白名单正确；不要整份替换配置。

```json
{"socialV2":{"selfReference":{"enabled":true},"continuity":{"enabled":true}}}
```

启用后旧角色卡不再注入；从本机现有性格状态迁入六维而不重置。文字参考初始可为空，通过新的有效私聊逐渐形成；不会自动读取历史聊天生成人格，也不包含发布者的自我参考。六维和文字参考只在允许的同一主人私聊使用。关闭自我参考可回到旧机制；旧角色选择若已经改动，需要明确选回自己的旧角色。

## 6. 启动与验收

启动记忆服务、DSH 和桥接。重新启动 DSH 刷新预设与 MCP 工具清单。检查：

1. 3080 控制台、3100 桥接管理和记忆服务均显示 0.10.1，心迹入口检查成功。
2. 白名单、二代工具、玩梗入口与 QQ 在线状态正常；停用黑话工具不再出现。
3. 自我参考启用时，性格页能看到原六维、文字参考、依据和修正入口；未启用时继续使用旧性格模式。
4. 花费页可以分别调整后台档位；新候选首次审核计入“确认联合复核”，后续分页仅核关系；缓存命中不调用模型。
5. 在本人允许的私聊发送一条测试消息，核对接收、回复与心绪来源。不要仅根据端口在线断言聊天正常。

桥接启用访问令牌时需使用本机带令牌的入口；不要把访问令牌公开。人格与指令页跳转到实际性格页；旧卡仍用于兼容模式的用户可维护自己已有 roles 文件，本版不提供旧卡编辑器。

## 7. 回退

停止服务后，用本包安装器 --undo 恢复本次桥接变更，并按备份恢复插件与实际 server.py。文风脚本的备份在桥接 .runtime-backups/style-*，files.json 记录原路径；恢复源文件后用原构建器重新生成预设。不要用旧数据库覆盖升级后新聊天。

SQLite 新回执表可留存，旧代码会忽略。原黑话专属数据只停用、不自动物理删除；玩梗库与表情库保留。具体界面操作见 [0.10.1 用户手册](manual/USER_GUIDE-0.10.1.md)。


## 8. 本版迁移、默认开关与限制

首次启动新记忆服务会备份旧稳定度到数据库迁移表，并按内容规则初始化；事实正文、原话、来源时间和有效期保留。迁移后14天暂停规则建议归档，用户明确确认的主动归档仍可执行。读库、检索和后台重复合并不加固。回退代码不会自动恢复旧稳定度；需要恢复时按迁移表逐条核对，不能用旧数据库覆盖新聊天。

成长课堂默认关闭，自动候选审核和现有费用开关按原配置保留；不会为了发布而打开付费模块。省心整理全部条目可勾选，按建议处理和主动归档分开；归档不参与正常检索，不等于确认记住。所有候选自动变成可检索经历的新版流程尚未实现。

整体心境和对象关系分开保存；跨聊天可检索信息要经过隐私过滤。请在共享范围页核对自己的授权，不将升级理解为允许分享全部私聊。旧情绪状态采用保守迁移，保留备份供核对。


## 可选审核范围

本版保留默认全量审核，也提供显式开启的相关范围模式：审核选入的同方面事实和少量语义近邻，可能漏掉范围外冲突。页面显示的“审核通过”仅指当前选定范围；原话、有效期和版本检查仍保留。详见[配置与限制](docs/review-scope.md)。此模式不等于所有候选自动生效。
