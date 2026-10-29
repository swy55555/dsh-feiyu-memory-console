# 梗库说明

## 它是什么

`memes.db` 是桥接用的本地梗解释库，SQLite 单文件，表 `memes`：

| 字段 | 内容 |
|---|---|
| `title` | 梗名，也是精确匹配的键 |
| `slug` | 稳定标识，用于 `meme:<slug>` 记忆 |
| `tags` | 标签，决定话题匹配和过滤（政治/攻击类） |
| `usage` | 怎么用，注入提示词时只取这一段 |
| `origin` | 出处：视频、UP 主、社区帖子等 |
| `other` | 补充信息 |
| `summary` | 完整解释 |

`meta` 表记录 `built_at` 和 `count`。当前本地库为 **6668 条**，`built_at=2026-10-26 19:07:22`。

## 从哪来

这批数据来自开源项目 **[in1t1a1/astrbot_plugin_memewiki](https://github.com/in1t1a1/astrbot_plugin_memewiki)**（MIT）随包分发的 `data/memes.db` 快照，共 6668 条，不是本项目原创，也不随本插件安装包分发（体积和第三方版权原因）。

该项目的词条内容来自 **[cnmeme.wiki](https://cnmeme.wiki)** 的公开只读 API；词条版权归 cnmeme.wiki 及原作者，界面/数据里保留了 `origin` 来源链接。更新词库时应遵守站点规则（限速 0.35 秒/次、429 退避），不要高频抓取。

使用、再分发或商用前，请核对上述上游项目和 cnmeme.wiki 的规则；本项目只提供读取和检索工具，不对词条内容的版权、准确性或时效性作担保。

## 桥接怎么用

1. 对方明确问「XX 是什么梗」：精确/模糊查一条，取 `usage` 和 `origin`，注入提示词，要求自然接、不背百科。
2. 主动玩梗：按最近消息的话题词和 `tags` 匹配，挑 1–2 个候选，只给 `usage`。
3. 过滤：`tags` 含政治类始终跳过；攻击/嘲讽类只在心情值低于 `attackMoodBelow` 时出现；色情/敏感类跳过。
4. 用过的梗写一条低重要度记忆：`fact_key=meme:<slug>`，`tags` 带「梗」和场景。

## 替换/更新

1. 备份 `~/.dsh/qq-bridge/data/memes.db`；
2. 准备同表、同字段的 SQLite（至少 `title/slug/tags/usage/origin`）；
3. 替换文件，桥接按修改时间自动重载；不用重启，等下一轮。

## 关闭

`~/.dsh/qq-bridge/state/meme-play.json`：

```json
{"enabled": false}
```

只关主动、保留被动解释：`"proactive": false`。
