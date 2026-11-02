# 设计依据与参数说明

这份文档解释：**为什么这样设计、每个数字从哪来、哪些只是工程选择**。

先说明边界：回响不是人脑仿真，没有用人类自传体记忆或人格数据做参数拟合，也没有证据表明它拥有意识或真实情感。下面引用研究，是为了说明方向上的启发，不是宣称“科学证明它像人”。

---

## 一、记忆：为什么会淡

### 采用的形式

```
R = 1 / (1 + t / S)
```

- `R`：可用程度（0–1），不是事实正确率；
- `t`：距写入或最近一次有效加固的天数；
- `S`：稳定度（天），由内容类型和重要性决定。

`t = S` 时 R = 50%，`t = 3S` 时 R ≈ 25%。

### 依据

| 研究 | 结论 | 本项目的用法 |
|---|---|---|
| Ebbinghaus (1885) | 遗忘最初快、后来慢 | 采用“先快后慢”的曲线形状 |
| Wixted & Ebbesen (1991) | 多种遗忘数据更符合幂函数，而非指数 | 选双曲/幂律形式，不选指数衰减 |
| Anderson & Schooler (1991) | 记忆强度反映环境中的使用概率 | `R` 与最近访问时间挂钩 |
| Pavlik & Anderson (2005) | 间隔练习影响保持 | 加固量与 `gap / S` 成正比 |
| Cepeda et al. (2006) | 分散练习优于集中 | 同一事实反复出现才加固 |
| Ye et al. (2022), FSRS | 稳定度随成功复习增长，但有上限 | `S` 上限 365 天 |
| Park et al. (2023), Generative Agents | 记忆流 + 反思 + 检索可支持可信行为 | 经历、摘要、反思分层 |
| Packer et al. (2023), MemGPT | 分层记忆与上下文管理 | 短期/长期/摘要分层 |

### 参数

| 参数 | 值 | 性质 |
|---|---|---|
| 基础稳定度 | 经历 3 天 / 普通 7 天 / 偏好习惯 30 天 | 工程分类 |
| 初始稳定度 | `S = base × (0.5 + importance)` | 工程公式 |
| 加固倍率 | `1.15 + 0.35 × min(1, gap/S)`，上限 1.5 | 受间隔效应启发 |
| 加固条件 | 不同来源消息、更晚的原消息时间、距上次 ≥1 天 | 防重复自证 |
| 可归档 | `R < 0.12` 且 >14 天且重要性 <0.8 | 管理策略 |
| 迁移保护 | 14 天内不自动归档 | 数据安全 |

**重要**：3 / 7 / 30 天不是“人类记忆天数”，只是本项目的默认档位。换一套数字，机制仍然成立。

---

## 二、兴趣与探索：为什么需要证据

### 设计

- 一条视频只能把兴趣记为“暂定”（约 0.2）；
- 两条**独立来源**（不同视频或作者）才升到 0.42；
- 探索同一话题连看两轮再换；
- 跳过最近 4 轮用过的话题和已看过的视频；
- 安静时段不探索，按预算而非固定次数。

### 依据

| 研究 | 结论 | 用法 |
|---|---|---|
| Larson, Rottinghaus & Borgen (2002) | 兴趣与五因素相关约 0.2–0.4 | 兴趣是弱证据，不直接等于性格 |
| Loewenstein (1994) | 好奇来自“信息缺口” | 探索选题从已知话题的边缘扩展 |
| Berlyne (1960) | 新异与不确定驱动探索 | 新话题与熟悉话题交替 |

### 参数

| 参数 | 值 | 性质 |
|---|---|---|
| 每日预算 | 0.5 元 | 费用上限，不是认知参数 |
| 冷却 | 30 分钟 | 防连续抓取 |
| 聚焦 | 同一话题 2 轮 | 模拟“追一个兴趣” |
| 升级门槛 | 2 条独立来源 | 防一条视频定终身 |

---

## 三、驱力与主动：为什么不是定时器

### 设计

四类驱力：自主、胜任、联结、好奇。决策层每 15 分钟评估一次，候选包括探索、联系、回看、反思、一起看；按分数、冷却、安静时段、理由门槛择一。

### 依据

| 研究 | 结论 | 用法 |
|---|---|---|
| Deci & Ryan (2000), 自我决定理论 | 自主、胜任、联结是内在动机基础 | 四驱力的三个来源 |
| Loewenstein (1994) | 好奇由信息缺口驱动 | 好奇维度 + 探索 |
| Williams (2007), 排斥实验 | 被排除会降低归属与情绪 | 没回时轻微降温 |
| Baumeister & Leary (1995) | 归属需要是基本动机 | 联结权重较高 |

### 参数

| 参数 | 值 | 性质 |
|---|---|---|
| 主动阈值 | 0.45 | 工程阈值 |
| 冷却 | 探索 30 / 联系 60–120 / 回看 180 / 反思 240 分钟 | 打扰控制 |
| 安静时段 | 01:00–09:00 | 作息假设 |
| 联系理由 | 挂念 / 新证据 / 12 小时未说话 | 防“没话找话” |
| 没回降温 | 1h −0.02 / 4h −0.04 / 12h −0.05 / 24h −0.05；回复 +0.03 | 近似，不是测量 |

**注意**：没回降温是“轻微、可恢复、有下限”的设定，不鼓励用情绪施压。系统不会发“你怎么不理我”这类消息。

---

## 四、性格：为什么慢

### 设计

六维：温度、主动、黏人、情绪稳定、玩心、嘴硬。

探索倾向只影响“主动”一个维度，且要：

- ≥5 个话题；
- 每个话题 ≥2 条独立来源；
- 首尾跨度 ≥28 天；
- 两次达标间隔 ≥28 天；
- 每次 +1，累计 ≤3，可回滚。

### 依据

| 研究 | 结论 | 用法 |
|---|---|---|
| Roberts & DelVecchio (2000) | 成年人格排序稳定性约 0.6–0.7 | 性格是慢变量 |
| Bleidorn (2012) | 平均水平变化以十年计 | 不因几天行为改性格 |
| Roberts et al. (2017) | 人格干预平均效应量约 d≈0.2，需持续数周 | 慢通道按周/月设门槛 |
| Wrzus & Roberts (2017) | 反复行为改变自我概念，再影响特质 | 用行为证据而非单次自述 |
| Larson et al. (2002) | 兴趣与人格相关中等 | 兴趣只作弱证据 |
| McAdams & McLean (2013) | 叙事身份影响自我理解 | 叙事块逐句有出处 |

---

## 五、情绪：为什么只有一行

情绪采用“效价 + 唤醒 + 事件评价”的轻量模型：

- 事件 → 评价 → 情绪状态 → 语气；
- 只注入一行，避免每轮都在演情绪；
- 情绪不直接改事实记忆。

依据：

- Russell (1980)：情绪可用效价—唤醒二维描述；
- Scherer (2001)：情绪由多成分评价产生；
- Lazarus (1991)：认知评价影响情绪反应。

这是工程近似，不是情绪计算模型。

---

## 六、关联与联动：为什么用规则门

- 关联分：同来源 1.0、同事件 0.9、同话题 7 天内 0.35–0.50；
- 注入门：消息与兴趣/自我记忆的 bigram Jaccard ≥0.25，或短话题包含；
- 每轮最多 3 条，owner 私聊，带边界提示。

依据：

- Collins & Loftus (1975)：语义网络中的扩散激活；
- 规则门的作用是**保守**：宁可少注入，也不硬扯关系。

阈值 0.25 是工程选择，没有对应的人类常数。

---

## 七、参考实现与借鉴

| 工作 | 借鉴点 | 本项目没有做的 |
|---|---|---|
| Park et al. (2023), Generative Agents | 记忆流、反思、检索 | 没有完整的社会模拟 |
| Packer et al. (2023), MemGPT | 分层记忆、上下文管理 | 没有操作系统级虚拟上下文 |
| Shinn et al. (2023), Reflexion | 用文字反馈代替改权重 | 不做循环自评 |
| Madaan et al. (2023), Self-Refine | 迭代反馈可改善输出 | 为控成本不每轮迭代 |

---

## 八、参考文献

1. Ebbinghaus, H. (1885). *Über das Gedächtnis*. Duncker & Humblot.
2. Wixted, J. T., & Ebbesen, E. B. (1991). On the form of forgetting. *Psychological Science*, 2(6), 409–415. https://doi.org/10.1111/j.1467-9280.1991.tb00175.x
3. Anderson, J. R., & Schooler, L. J. (1991). Reflections of the environment in memory. *Psychological Science*, 2(6), 396–408. https://doi.org/10.1111/j.1467-9280.1991.tb00174.x
4. Pavlik, P. I., & Anderson, J. R. (2005). Practice and forgetting effects on vocabulary memory. *Cognitive Science*, 29(4), 559–586. https://doi.org/10.1207/s15516709cog0000_14
5. Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). Distributed practice in verbal recall tasks. *Psychological Bulletin*, 132(3), 354–380. https://doi.org/10.1037/0033-2909.132.3.354
6. Ye, J., Su, J., & Cao, Y. (2022). A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition Scheduling. KDD '22. https://doi.org/10.1145/3534678.3539081
7. Deci, E. L., & Ryan, R. M. (2000). The "what" and "why" of goal pursuits. *Psychological Inquiry*, 11(4), 227–268.
8. Loewenstein, G. (1994). The psychology of curiosity. *Psychological Bulletin*, 116(1), 75–98.
9. Williams, K. D. (2007). Ostracism. *Annual Review of Psychology*, 58, 425–452.
10. Baumeister, R. F., & Leary, M. R. (1995). The need to belong. *Psychological Bulletin*, 117(3), 497–529.
11. Roberts, B. W., & DelVecchio, W. F. (2000). The rank-order consistency of personality traits from childhood to old age. *Psychological Bulletin*, 126(1), 3–25.
12. Bleidorn, W. (2012). Hitting the road to adulthood. *Journal of Personality*, 80(6), 1661–1696.
13. Roberts, B. W., Luo, J., Briley, D. A., Chow, P. I., Su, R., & Hill, P. L. (2017). A systematic review of personality trait change through intervention. *Psychological Bulletin*, 143(2), 117–141.
14. Wrzus, C., & Roberts, B. W. (2017). Processes of personality development in adulthood. *Personality and Social Psychology Review*, 21(3), 253–277.
15. Larson, L. M., Rottinghaus, P. J., & Borgen, F. H. (2002). Meta-analyses of Big Six interests and Big Five personality factors. *Journal of Vocational Behavior*, 61(2), 217–239.
16. McAdams, D. P., & McLean, K. C. (2013). Narrative identity. *Current Directions in Psychological Science*, 22(3), 233–238.
17. Russell, J. A. (1980). A circumplex model of affect. *Journal of Personality and Social Psychology*, 39(6), 1161–1178.
18. Scherer, K. R. (2001). Appraisal considered as a process of multilevel sequential checking. In *Appraisal Processes in Emotion*.
19. Lazarus, R. S. (1991). *Emotion and Adaptation*. Oxford University Press.
20. Collins, A. M., & Loftus, E. F. (1975). A spreading-activation theory of semantic processing. *Psychological Review*, 82(6), 407–428.
21. Park, J. S., et al. (2023). Generative Agents. UIST '23. https://arxiv.org/abs/2304.03442
22. Packer, C., et al. (2023). MemGPT. https://arxiv.org/abs/2310.08560
23. Shinn, N., et al. (2023). Reflexion. NeurIPS 2023. https://arxiv.org/abs/2303.11366
24. Madaan, A., et al. (2023). Self-Refine. NeurIPS 2023. https://arxiv.org/abs/2303.17651

---

## 九、验证边界

- 记忆：单元测试验证曲线单调、间隔加固、幂等迁移；没有人类数据拟合。
- 兴趣：验证“两条独立来源才升级”；没有验证它等于人的兴趣。
- 主动：模拟覆盖安静时段、冷却、额度；没有验证真实关系质量。
- 慢通道：只做规则验证与一次端到端试跑；没有长期效果数据。

如果这些边界不满足你的预期，应该把它当“有依据的工程实现”，而不是“被科学证明的仿人系统”。
