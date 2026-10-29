# v0.9.0 升级与回退

本版需同时更新插件、QQ 桥接运行时和独立 memvec 服务。保留原数据库及配置；不会自动回填历史漏记、开启跨聊天共享或打开空闲联想试验。

## 适用范围

用于已有 DSH/QQ 桥接环境，基础 SDK、账号和服务环境需自行准备。安装器按已知源码哈希或有效回执识别版本；未知或自定义桥接会拒绝覆盖。首次安装与通用操作见 `manual/USER_GUIDE-0.9.0.md`；本次功能变化见 `docs/continuity.md` 与 `docs/usage-and-association.md`。

## 1. 下载与核验

从 [v0.9.0 Release](https://github.com/swy55555/dsh-feiyu-memory-console/releases/tag/v0.9.0) 下载同版本 `.tgz` 或 `-source.zip`，以及升级指南、手册和 `SHA256SUMS-0.9.0.txt`。核对示例：

```powershell
Get-FileHash -Algorithm SHA256 .\dsh-feiyu-memory-console-0.9.0.tgz
```

将结果与校验文件对应行比较。不要混用预览版安装器和正式版源码；不要覆盖已经公开的旧版本附件。

## 2. 停止服务并备份

在维护窗口停止 DSH、QQ 桥接及其守护进程、独立 memvec。退出 DSH 不一定停止其他两个服务，确认实际端口与对应进程，不按名字结束所有 node/Python。

备份旧插件源码、memvec 实际运行的 server.py、数据库及其 WAL/SHM、桥接 src/config/state/owner-contact.json、控制台数据目录和公开日记。SQLite 在线备份也可用于数据库；运行时只复制单个 .db 不能保证一致性。保存 `.runtime-backups` 和 `state/runtime-bundle.json`。

## 3. 更新插件与桥接

按当前 DSH 的本地插件方式安装新包或更新实际链接目录。在新版本解压目录执行：

```powershell
npm run doctor
node bridge/install-all.mjs --target "D:\your-dsh\qq-bridge" --check
node bridge/install-all.mjs --target "D:\your-dsh\qq-bridge" --apply
```

示例路径替换为实际桥接目录。`--check` 不写入；compatible 表示可以安装，already-installed 表示运行时内容一致。拒绝覆盖时先检查自定义修改，不能把 `--replace-legacy` 当作普通升级步骤；该高级选项意味着接受整份运行时替换。

本版统一管理 17 个模块：mind-workspace.mjs、response-patterns.mjs、continuity.mjs、feature-token-ledger.mjs、feature-model-prices.mjs、usage-features.mjs、bridge.js、human-context.mjs、emotion.js、emotion-appraisal.mjs、turn-traces.mjs、emotion-context.mjs、appraisal-budget.mjs、daily-memory.js、fact-review.mjs、idle-association.mjs、memory-coverage.mjs。它们必须作为同一包安装。备份位于桥接 `.runtime-backups/`，回执位于 `state/runtime-bundle.json`。

## 4. 更新实际 memvec 服务

若使用本包 `npm run start:memvec`，运行的是本包 memvec/server.py。若独立服务运行 `~/.dsh/memvec/server.py` 或自定义目录，先备份旧文件，再把本包对应文件复制到实际目录；数据库路径保持原样。

**不要执行 sync:memvec 来升级服务。** 该脚本是把本机服务源码同步回开发仓库，方向相反，可能覆盖新代码。

启动后 schema 自动增加事实元数据及 `memory_review_pages` 等所需表，保存分批核对进度；不会批量重写已有个人事实。旧记录按需核对。

## 5. 启动与验收

启动 memvec、DSH 和桥接，刷新控制台：

1. 网页后端版本显示 0.9.0，总览的数据库路径与服务检查正常。
2. `http://127.0.0.1:9881/stats` 返回 ok，capabilities 包含 paged-fact-review、unified-fact-review 与 confirmation-relation-groups。
3. QQ 连接恢复，原事实、队列和设置仍在；不能用新空库代替旧数据验证。
4. 整理页出现消息处理状态入口，确认/恢复操作能显示分批进度。
5. 在允许的测试聊天中自行核对两条不同对象的偏好是否都能保留；在线效果仍依赖实际模型。

程序性验证可在隔离环境执行 `npm test` 和六个浏览器测试（主界面、上下文、花费与联想、当前心绪、界面升级、心绪中枢），不需要向 QQ 发测试消息。

## 行为与用量变化

- 整理器声明完成后另开一次无工具调用对照原话，通常每批共两次请求；失败、遗漏和不确定继续保留消息。
- 确认与恢复每批检查八条，继续覆盖同一聊天同一主体的全部有效事实。每批可能调用模型，历史越多用量越大；网页可停止后续批次。
- API 调用方收到 pending=true 时需继续请求，不能视为已确认。reviewOnly=true 用于检查阶段，readyToApply=true 后另行提交；旧客户端需要适配。
- 保留总额度、群聊额度、暂停状态与用户开关。旧 groupPolicy=signals 现在等同 semantic，可能处理更多普通群消息；默认 addressed 仍只处理 @/回复。
- 新配置空闲联想默认关闭，已有开关保留；跨聊天共享不会由此次升级扩大。

## 回退

先停止桥接，再使用**本次安装所用的 v0.9.0 包**执行：

```powershell
node bridge/install-all.mjs --target "D:\your-dsh\qq-bridge" --undo
```

该命令恢复本次管理的运行时文件及原回执，不替你停止服务，不回退插件、memvec 源码或数据库。安装后有文件修改或备份不一致时会拒绝覆盖。

恢复旧插件和 memvec 源码需使用自己的备份。回退数据库会丢失备份后的新内容，因此先另存当前完整数据再决定是否数据回滚。程序降级不应自动覆盖当前数据库。由预览版升级后撤销，首先回到升级前预览版；继续撤销更早版本需对应版本的安装器。

## 当前心绪补充

本版新增 `continuity.mjs`，运行时共 15 个模块；私有状态为桥接 `state/continuity.json`，请随原有状态一起备份。安装不会自动开启 `socialV2.continuity.enabled`。在“当前心绪”页开启后才处理新的主人私聊消息，不回填历史。

本版操作、费用、容量和模拟边界见 `docs/continuity.md`。同版 Markdown/PDF 完整手册已纳入新功能的操作步骤和边界。回退前关闭连续事件理解并备份；旧版不读取新状态文件，不必删除该文件。

## 从预览版升级

v0.8.12-preview.1 及本地 preview.2、preview.3 可以直接升级到本版，无需先安装中间版本。连续事件理解开关保留；尚未配置则默认关闭。认识期限按实际有效证据时间核算，不会因升级重新开始计时。

确认弹窗默认“确认这条，并保留全部已有记忆”；明确矛盾与不确定分别显示。只有明确矛盾可以被替换，现有记忆不会在安装时自动批量确认或更改。

## v0.9.0 验收

1. 网页右上角、运行时回执与 memvec `/stats` 均应显示 0.9.0；memvec capabilities 应包含 `auto-confirm-guard`。
2. 当前心绪可切换可视化/文字列表，空闲联想及主观感受开关已移到这里，原配置保留。
3. 长期记忆 → 待确认提供自动核对。新安装默认关闭，启用后 DSH 运行时每分钟处理一条候选或一批历史；关闭网页不会停止，关闭开关才停止后续提交。
4. 备份 `feiyu-memory-console/candidate-auto.json` 和操作审计；自动确认可在操作记录撤销。回退代码不会自动撤销已经确认的记忆。
5. 旧情绪状态无需重置，缺少日常感受字段时按空值迁移；不重算旧聊天情绪。

## 从 0.8.14 更新

本版修复后台新会话的事件快照接收。完整更新插件、桥接与 memvec 以保持版本一致；候选自动核对的已有开关、记录与退避时间保留，失败记录会到期重试，不需要删除。升级不重播旧 QQ 回复，也不重置情绪。

## 从 0.8.15 / 0.8.15+usage.1 更新到 0.9.0

新增两个桥接模块，由统一安装器同步。新增 `socialV2.mind.enabled` 默认 true；`socialV2.mind.learningEnabled` 默认 false，不改变既有连续事件理解开关。关闭本轮筛选可恢复原有参考组合，学习记录不会自动删除。学习启用但连续事件理解关闭时不会积累或使用倾向。

新增状态文件 `state/response-patterns.json` 需备份；本轮关注仅存内存。已核对的费用侧文件 `token-usage.jsonl.attribution.json` 原样保留，安装包不含任何人的核对结果或原话。

升级验收增加：打开当前心绪，确认心绪中枢能读取，学习开关保持预期；下一条主人私聊后查看本轮参考。入选不保证模型实际采用。网页刷新不产生模型费用。

回退时使用 0.9.0 安装器的 --undo 恢复旧运行时和回执；新增模块若原来不存在会移除，既有状态不自动删除。旧版忽略新配置和反馈文件。独立 memvec 和插件按备份同步回退。
