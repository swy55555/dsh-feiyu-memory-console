# 致谢

这个项目的起点和很多设计，不是一个人想出来的。

## 心绪中枢与具名贡献

心绪中枢参考小凌原创「心光」模块及相关设计，经本项目融合、删减与独立实现。本插件亦有 QQ 用户夜怀瑾、小甘心的贡献。

小凌是原心光模块的作者；夜怀瑾、小甘心为本插件贡献者，此处不推定其具体分工。本版没有直接打包原模块源码、依赖或状态文件；不是原模块的原样移植，也不代表原作者为本项目背书。

## 一起试出来的人

- 最早把「鱼的记忆」这个想法提出来、并且反复试用、提需求、报 bug 的朋友们；
- 在群里讨论上下文轮换、主动联系、催睡、记忆分层时给出具体场景和反例的群友；
- 愿意让角色用自己的真实聊天做测试、又帮忙检查输出是否像人的人。

除上面已具名的贡献者外，为了不替其他人公开身份，这里不逐一列名；如果本人愿意被具名，欢迎提 PR 或在 issue 里说一声，我再补上。

## 站在这些项目上

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) / DSH 插件与 Web 运行时；
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) 与 OneBot v11 协议；
- [BAAI bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) 与 [FastEmbed](https://github.com/qdrant/fastembed)；
- [force-graph](https://github.com/vasturiano/force-graph) 与 [d3-force](https://github.com/d3/d3-force)；
- [SQLite](https://sqlite.org/)。
- [astrbot_plugin_memewiki](https://github.com/in1t1a1/astrbot_plugin_memewiki)（MIT）：本地 6668 条梗库快照，词条内容源自 [cnmeme.wiki](https://cnmeme.wiki)。

## 思路上的参考

- MemGPT / Letta：分层上下文与长期记忆的调度；
- Generative Agents：记忆流、重要度与反思；
- mem0 等记忆层项目：写入、去重、检索的工程取舍；
- 各种“角色 bot 记得住人”的实践和踩坑帖。

这些参考只影响设计思路；本项目代码按 MIT 发布，不包含上述项目的代码。致谢也不代表它们为本项目背书。

## 特别说明

灵感来源很杂，可能有遗漏。如果你觉得某个项目或某个人应该出现在这里，直接说，我补。
