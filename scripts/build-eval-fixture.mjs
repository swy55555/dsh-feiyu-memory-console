// 冻结 D 阶段评估输入：用生产装配器构建两臂 prompt，并冻结记忆快照与 hasAnswerInMemory。
// 只调用本地桥接的 /api/eval/build-prompt（不调用模型、不触发 QQ）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const BRIDGE = path.join(HOME, 'qq-bridge');
const STATE = path.join(BRIDGE, 'state');
const EVAL_DIR = path.join(STATE, 'private-evaluation');
fs.mkdirSync(EVAL_DIR, {recursive:true});
const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'config.json'), 'utf8'));
const token = (cfg.consoleToken || fs.readFileSync(path.join(STATE, 'console-token'), 'utf8')).trim();
const port = cfg.consolePort || 3100;

const sample = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'eval-sample.json'), 'utf8'));

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const hash = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

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

const taste = readJson(path.join(STATE, 'taste.json'), { topics: [] });
const selfMemory = readJson(path.join(STATE, 'self-memory.json'), { items: [] });
const episodesRaw = readJson(path.join(HOME, 'feiyu-memory-console', 'episodes.json'), null);
const episodes = (Array.isArray(episodesRaw) ? episodesRaw : episodesRaw?.items || episodesRaw?.episodes || []);

const snapshot = {
  frozenAt: Date.now(),
  taste: (taste.topics || []).map((t) => ({ topic: t.topic, strength: t.strength })),
  selfMemory: (selfMemory.items || []).map((m) => ({ text: m.text, verified: m.verified, at: m.at })),
  episodes: episodes.map((e) => ({ at: e.at, chatKey: e.chatKey, text: String(e.summary || e.quote || '').slice(0, 120) })),
};
const snapshotHash = hash(snapshot);
fs.writeFileSync(path.join(EVAL_DIR, 'eval-snapshot.json'), `${JSON.stringify(snapshot)}\n`, 'utf8');

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
for (const item of sample.items) {
  const boundary = Number(item.memoryBoundaryAt) || item.at;
  const grams = bigrams(item.promptText);
  const priors = [];
  for (const t of snapshot.taste) {
    if (t.topic && jaccard(grams, bigrams(t.topic)) >= 0.25) priors.push({ kind: 'taste', text: t.topic });
  }
  for (const m of snapshot.selfMemory) {
    if ((Number(m.at) || 0) >= boundary) continue;
    if (m.text && jaccard(grams, bigrams(m.text)) >= 0.25) priors.push({ kind: 'self', text: m.text });
  }
  for (const e of snapshot.episodes) {
    if (e.chatKey !== item.chatKey || Number(e.at) >= boundary) continue;
    if (e.text && jaccard(grams, bigrams(e.text)) >= 0.3) priors.push({ kind: 'episode', text: e.text });
  }

  const off = await buildPrompt(item.promptText, false, boundary);
  const on = await buildPrompt(item.promptText, true, boundary);
  items.push({
    id: item.id,
    at: item.at,
    stratum: item.stratum,
    memoryBoundaryAt: boundary,
    promptText: item.promptText,
    hasAnswerInMemory: priors.length > 0,
    priorCount: priors.length,
    baselinePrompt: off.prompt,
    injectionPrompt: on.prompt,
    baselineChars: off.chars,
    injectionChars: on.chars,
    injectionDelta: on.chars - off.chars,
    assemblyOn: on.assembly,
    assemblyOff: off.assembly,
  });
}

const fixture = {
  version: 1,
  frozenAt: Date.now(),
  snapshotHash,
  note: '由生产装配器构建的两臂 prompt；记忆快照哈希固定；hasAnswerInMemory 为保守判定',
  items,
};
fs.writeFileSync(path.join(EVAL_DIR, 'eval-fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log('fixture items', items.length, 'hasAnswer', items.filter((x) => x.hasAnswerInMemory).length);
console.log('snapshotHash', snapshotHash.slice(0, 16));
for (const it of items.slice(0, 3)) console.log(' ', it.stratum, it.hasAnswerInMemory, it.injectionDelta, it.promptText.slice(0, 20));
