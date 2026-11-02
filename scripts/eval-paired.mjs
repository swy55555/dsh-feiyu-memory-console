// D 阶段评估框架（默认关闭）。
// 预检只读冻结 fixture / snapshot，不发起任何模型调用。
// 用法：
//   node scripts/eval-paired.mjs --preflight     （默认）
//   node scripts/eval-paired.mjs --run           （需要 EVAL_ENABLE=1 且样本非空；当前模型通道未接）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const EVAL_DIR = path.join(HOME, 'qq-bridge', 'state', 'private-evaluation');
const mode = process.argv.includes('--run') ? 'run' : 'preflight';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const PATHS = {
  snapshot: path.join(EVAL_DIR, 'eval-snapshot.json'),
  baseline: path.join(EVAL_DIR, 'eval-fixture.json'),
  injectable: path.join(EVAL_DIR, 'eval-injectable.json'),
  preflight: path.join(EVAL_DIR, 'eval-preflight.json'),
};

function fail(message, code = 1) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

// ---------- 1. 预检：只读、校验哈希/边界/标签 ----------
for (const [name, file] of Object.entries(PATHS)) {
  if (name !== 'preflight' && !fs.existsSync(file)) fail(`缺少 ${path.basename(file)}`);
}

const snapshot = readJson(PATHS.snapshot);
const baseline = readJson(PATHS.baseline);
const injectable = readJson(PATHS.injectable);

const snapshotHash = sha256(JSON.stringify(snapshot));
if (baseline.snapshotHash && baseline.snapshotHash !== snapshotHash) {
  fail(`snapshot 哈希不匹配：fixture=${baseline.snapshotHash.slice(0, 12)} 实际=${snapshotHash.slice(0, 12)}`);
}

const boundaryOk = (items) => items.every((x) => Number.isFinite(Number(x.memoryBoundaryAt)));
const baselineBoundary = boundaryOk(baseline.items || []);
const injectableBoundary = boundaryOk(injectable.items || []);

const items = injectable.items || [];
const effect = items.filter((x) => x.relevanceGateHit && x.hasAnswerInMemory);
const personalization = items.filter((x) => x.relevanceGateHit && !x.hasAnswerInMemory);
const control = items.filter((x) => !x.relevanceGateHit);
const baselineInjected = (baseline.items || []).filter((x) => Number(x.injectionDelta) > 0);

const report = {
  version: 1,
  mode,
  checkedAt: Date.now(),
  files: PATHS,
  snapshotHash,
  baseline: {
    items: (baseline.items || []).length,
    boundaryOk: baselineBoundary,
    injected: baselineInjected.length,
    hasAnswerInMemory: (baseline.items || []).filter((x) => x.hasAnswerInMemory).length,
  },
  injectable: {
    items: items.length,
    boundaryOk: injectableBoundary,
    available: items.filter((x) => x.linkageAvailable).length,
    gateHit: items.filter((x) => x.relevanceGateHit).length,
    hasAnswerInMemory: items.filter((x) => x.hasAnswerInMemory).length,
  },
  sets: { effect: effect.length, personalization: personalization.length, control: control.length },
  runsAllowed: effect.length + personalization.length > 0,
  note: '预检不发起模型调用；报告写入 <DSH_HOME>/qq-bridge/state/private-evaluation/eval-preflight.json',
};
fs.writeFileSync(PATHS.preflight, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`snapshot ${snapshotHash.slice(0, 12)} · 边界 baseline=${baselineBoundary} injectable=${injectableBoundary}`);
console.log(`覆盖率基线：${report.baseline.items} 条，实际注入 ${report.baseline.injected}，有答案 ${report.baseline.hasAnswerInMemory}`);
console.log(`可注入集：${report.injectable.items} 条，available ${report.injectable.available}，gateHit ${report.injectable.gateHit}`);
console.log(`集合：effect ${effect.length} / personalization ${personalization.length} / control ${control.length}`);
console.log(`有效样本 ${effect.length + personalization.length}；--run ${report.runsAllowed ? '允许（仍需模型通道）' : '拒绝'}`);

if (mode === 'run') {
  if (!report.runsAllowed) fail('effect 与 personalization 都为空，--run 拒绝（0 次模型调用）', 3);
  if (process.env.EVAL_ENABLE !== '1') fail('未设置 EVAL_ENABLE=1，--run 拒绝（0 次模型调用）', 3);
  fail('模型通道尚未接入；本轮 0 次调用', 4);
}
