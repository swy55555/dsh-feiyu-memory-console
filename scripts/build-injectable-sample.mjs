// 构建带相关性门槛的评估集：三个标签分开。
// linkageAvailable  边界前有可用兴趣/关联
// relevanceGateHit  生产门槛判定与当前消息相关（决定是否注入）
// hasAnswerInMemory 记忆里是否有可支撑答案（启发式，需人工复核）
// 只调用本地 /api/eval/build-prompt，不调用模型、不触发 QQ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const BRIDGE = path.join(HOME, 'qq-bridge');
const STATE = path.join(BRIDGE, 'state');
const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'config.json'), 'utf8'));
const token = (cfg.consoleToken || fs.readFileSync(path.join(STATE, 'console-token'), 'utf8')).trim();
const port = cfg.consolePort || 3100;

const raw = JSON.parse(fs.readFileSync(path.join(HOME, 'feiyu-memory-console', 'episodes.json'), 'utf8'));
const episodes = (Array.isArray(raw) ? raw : raw.items || raw.episodes || [])
  .filter((e) => e.chatKey && String(e.chatKey).startsWith('private:'))
  .sort((a, b) => a.at - b.at);

const taste = JSON.parse(fs.readFileSync(path.join(STATE, 'taste.json'), 'utf8')).topics || [];
const selfMemory = JSON.parse(fs.readFileSync(path.join(STATE, 'self-memory.json'), 'utf8')).items || [];
const stamps = [...taste.map((x) => x.updatedAt || x.createdAt || 0), ...selfMemory.map((x) => x.at || 0)].filter(Boolean);
const earliestMemory = Math.min(...stamps);

function bigrams(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

async function buildPrompt(text, inject, boundaryAt) {
  const res = await fetch(`http://127.0.0.1:${port}/api/eval/build-prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ text, inject, boundaryAt }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'build failed');
  return data;
}

const items = [];
for (const e of episodes.filter((x) => x.at > earliestMemory)) {
  const text = String(e.summary || e.quote || '').slice(0, 200);
  if (!text) continue;
  const boundary = e.at;
  const off = await buildPrompt(text, false, boundary);
  const on = await buildPrompt(text, true, boundary);
  const gate = on.linkage || null;
  const grams = bigrams(text);
  // 启发式：与边界前记忆重合 >= 0.35 才算“可能有答案”；需人工复核。
  const hasAnswer = taste.some((t) => jaccard(grams, bigrams(t.topic)) >= 0.35)
    || selfMemory.some((m) => (Number(m.at) || 0) < boundary && jaccard(grams, bigrams(m.text)) >= 0.35);
  items.push({
    id: e.id,
    at: e.at,
    promptText: text,
    memoryBoundaryAt: boundary,
    linkageAvailable: Boolean(gate?.available),
    relevanceGateHit: Boolean(gate?.hit),
    gateReason: gate?.reason || 'unknown',
    hasAnswerInMemory: hasAnswer,
    injected: on.chars > off.chars,
    baselinePrompt: off.prompt,
    injectionPrompt: on.prompt,
    baselineChars: off.chars,
    injectionChars: on.chars,
    injectionDelta: on.chars - off.chars,
    assemblyOn: on.assembly,
  });
}

const effect = items.filter((x) => x.relevanceGateHit && x.hasAnswerInMemory);
const personalization = items.filter((x) => x.relevanceGateHit && !x.hasAnswerInMemory);
const control = items.filter((x) => !x.relevanceGateHit);

const out = {
  version: 2,
  frozenAt: Date.now(),
  note: '相关性门槛后的评估集；三个标签分开；hasAnswerInMemory 为启发式，需人工复核',
  earliestMemory,
  counts: {
    candidates: items.length,
    available: items.filter((x) => x.linkageAvailable).length,
    gateHit: items.filter((x) => x.relevanceGateHit).length,
    injected: items.filter((x) => x.injected).length,
    hasAnswer: items.filter((x) => x.hasAnswerInMemory).length,
    effectSet: effect.length,
    personalizationSet: personalization.length,
    controlSet: control.length,
  },
  sets: {
    effect: effect.map((x) => x.id),
    personalization: personalization.map((x) => x.id),
    control: control.map((x) => x.id),
  },
  items,
};
fs.writeFileSync(path.join(ROOT, 'docs', 'eval', 'eval-injectable.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(out.counts));
console.log('gates', JSON.stringify(items.reduce((a, x) => { a[x.gateReason] = (a[x.gateReason] || 0) + 1; return a; }, {})));
