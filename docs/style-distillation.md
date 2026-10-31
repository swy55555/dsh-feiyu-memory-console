# 旧文风蒸馏已停用

旧的自动蒸馏模块已移除，由默认关闭的[表达教师](expression-teacher.md)替代。旧规则不再进入提示词，旧数据保留为历史备份，旧费用仍可单独查看。

fish_talk 是 Nozzi2455 的独立 MIT 插件，保留原作者归属。本项目的可选 0.3.6 兼容适配仍可使用：

```powershell
node scripts/install-fishtalk-compat.mjs --target <fishtalk安装目录>
node scripts/install-fishtalk-compat.mjs --target <fishtalk安装目录> --apply
```

适配器按已检查的版本备份和更新，未知版本不覆盖。公共参考只返回明确公共来源（目前为 bili）中人工正面标记的少量样例，不返回私人聊天、未知来源或人设语料。原始语料和批注保留。工具按需使用，不要求每句话调用检查器，形式检查不能证明理解正确。手动 deep 仍仅分析允许的公共材料，不与教师自动重复执行。
