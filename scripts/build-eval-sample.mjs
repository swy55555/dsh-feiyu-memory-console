// D 阶段样本构建：分层、冻结时间边界、只使用该轮之前已存在的记忆。
// 输出 state/eval-sample.json，不调用模型。
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const EPISODES = path.join(HOME, 'feiyu-memory-console', 'episodes.json');
const BRIDGE_STATE = path.join(HOME, 'qq-bridge', 'state');
const EVAL_DIR = path.join(BRIDGE_STATE, 'private-evaluation');
fs.mkdirSync(EVAL_DIR, {recursive:true});
const OUT = path.join(EVAL_DIR, 'eval-sample.json');
const DAY = 86400000;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

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

const raw = readJson(EPISODES, null);
const episodes = (Array.isArray(raw) ? raw : raw?.items || raw?.episodes || [])
  .filter((e) => e && e.at && e.chatKey && String(e.chatKey).startsWith('private:'))
  .sort((a, b) => a.at - b.at);

const taste = readJson(path.join(BRIDGE_STATE, 'taste.json'), { items: [] });
const selfMemory = readJson(path.join(BRIDGE_STATE, 'self-memory.json'), { items: [] });
const lowConfTexts = [
  ...(taste.items || []).filter((t) => Number(t.strength) < 0.42).map((t) => String(t.topic || '')),
  ...(selfMemory.items || []).filter((m) => ['unknown', 'unverified'].includes(m.verified)).map((m) => String(m.text || '')),
].filter(Boolean);
const lowConfGrams = lowConfTexts.map((t) => bigrams(t));

const texts = episodes.map((e) => ({ e, grams: bigrams(e.summary || e.quote || '') }));

function classify(index) {
  const { e, grams } = texts[index];
  const lowConf = lowConfGrams.some((g) => jaccard(grams, g) >= 0.25);
  if (lowConf) return 'low-confidence';
  const earlier = texts.slice(0, index).filter((x) => x.e.chatKey === e.chatKey && x.e.at <= e.at - DAY);
  const crossDay = earlier.some((x) => jaccard(grams, x.grams) >= 0.25);
  return crossDay ? 'cross-day' : 'fresh';
}

const strata = { 'cross-day': [], fresh: [], 'low-confidence': [] };
for (let i = 0; i < texts.length; i += 1) {
  const e = texts[i].e;
  const stratum = classify(i);
  strata[stratum].push({
    id: e.id,
    at: e.at,
    chatKey: e.chatKey,
    stratum,
    promptText: String(e.summary || e.quote || '').slice(0, 200),
    memoryBoundaryAt: e.at,
    emotion: e.emotion?.label || '',
  });
}

function pickEvenly(list, n) {
  if (list.length <= n) return [...list];
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(list[Math.floor((i * (list.length - 1)) / (n - 1 || 1))]);
  return out;
}

const picked = [];
const seen = new Set();
// 只对有数据的层分层；当前 low-confidence 池为空，所以按两层的 15/15 抽。
const active = Object.keys(strata).filter((k) => strata[k].length > 0);
const per = Math.floor(30 / active.length);
for (const key of active) {
  for (const item of pickEvenly(strata[key], per)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    picked.push(item);
  }
}
for (const key of active) {
  for (const item of strata[key]) {
    if (picked.length >= 30) break;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    picked.push(item);
  }
}

const sample = {
  version: 1,
  frozenAt: Date.now(),
  note: '分层配对试点；每轮只允许使用 memoryBoundaryAt 之前的记忆；30 条只做方向性结论',
  poolCounts: Object.fromEntries(Object.entries(strata).map(([k, v]) => [k, v.length])),
  counts: picked.reduce((acc, x) => { acc[x.stratum] = (acc[x.stratum] || 0) + 1; return acc; }, {}),
  items: picked.sort((a, b) => a.at - b.at).slice(0, 30),
};
fs.writeFileSync(OUT, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
console.log('pool', episodes.length, 'strata', JSON.stringify(sample.poolCounts));
console.log('picked', sample.items.length, JSON.stringify(sample.counts), '->', OUT);
for (const it of sample.items) console.log(' ', it.stratum.padEnd(14), new Date(it.at).toISOString().slice(0, 16), it.promptText.slice(0, 24));
