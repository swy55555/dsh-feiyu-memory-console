# D 阶段评估：目录与仓库说明

评估依赖两个仓库，缺一不可：

## 1. 生产桥接仓库

```
C:\Users\sunwy\.dsh\qq-bridge\
  src\bridge-v09.js          POST /api/eval/build-prompt（生产装配器，构建两臂 prompt）
  src\linkage-gate.mjs       相关性门槛（生产装配与离线构建共用）
  scripts\test-linkage-gate.mjs
  scripts\test-trace-assembly.mjs
```

## 2. 插件仓库（本仓库）

```
docs\eval\
  EVAL-PROTOCOL.md           评估协议
  eval-sample.json           30 条覆盖率基线（冻结）
  eval-fixture.json          基线两臂 prompt + hasAnswerInMemory + snapshotHash
  eval-snapshot.json         记忆快照（sha256 校验）
  eval-injectable.json       门槛后的可注入集（三个标签）
  eval-preflight.json        最近一次预检报告
scripts\
  build-eval-sample.mjs      生成覆盖率基线
  build-eval-fixture.mjs     用生产装配器构建两臂 prompt
  build-injectable-sample.mjs 门槛后重建可注入集
  eval-paired.mjs            评估框架（默认 --preflight；--run 需样本非空且 EVAL_ENABLE=1）
```

## 3. 运行顺序

```bash
# 1) 覆盖率基线（已有）
node scripts/build-eval-sample.mjs

# 2) 冻结两臂 prompt（调用本地桥接，不调模型）
node scripts/build-eval-fixture.mjs

# 3) 门槛后重建可注入集（调用本地桥接，不调模型）
node scripts/build-injectable-sample.mjs

# 4) 预检（只读 fixture/snapshot，写预检报告）
node scripts/eval-paired.mjs --preflight
```

## 4. 边界

- 只有 `effect` 或 `personalization` 非空时，`--run` 才可能执行；
- 当前两者都是 0（22 条全被门槛拦住），`--run` 会直接拒绝并保证 0 次模型调用；
- 模型通道尚未接入，`--run` 的最后一个分支也会主动停下。
