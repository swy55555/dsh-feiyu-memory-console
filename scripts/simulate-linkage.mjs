// 沙盒模拟：刷 B 站形成“新话题样本”，再模拟聊天验证门槛与注入。
// 不写生产 taste/self-memory，不调用模型，不触发 QQ。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const BRIDGE = path.join(HOME, 'qq-bridge');
const STATE = path.join(BRIDGE, 'state');
const SIM_DIR = path.join(HOME, 'eval', 'sim');
const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'config.json'), 'utf8'));
const token = (cfg.consoleToken || fs.readFileSync(path.join(STATE, 'console-token'), 'utf8')).trim();
const port = cfg.consolePort || 3100;
fs.mkdirSync(SIM_DIR, { recursive: true });

const explore = await import(pathToFileURL(path.join(BRIDGE, 'src', 'explore.mjs')).href);

const hashFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const beforeTaste = hashFile(path.join(STATE, 'taste.json'));
const beforeSelf = hashFile(path.join(STATE, 'self-memory.json'));

const existing = (JSON.parse(fs.readFileSync(path.join(STATE, 'taste.json'), 'utf8')).topics || []).map((t) => t.topic);
const seedTopics = ['咖啡', '天文摄影', '植物养护'].filter((t) => !existing.some((e) => e.includes(t) || t.includes(e)));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
async function navKeys() {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } });
  const j = await res.json();
  const img = j?.data?.wbi_img?.img_url || '';
  const sub = j?.data?.wbi_img?.sub_url || '';
  const key = (u) => String(u).split('/').pop().split('.')[0];
  return { imgKey: key(img), subKey: key(sub) };
}

async function searchVideos(keyword, keys) {
  const query = explore.wbiQuery({ search_type: 'video', keyword, page: 1 }, keys.imgKey, keys.subKey);
  const res = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
  });
  const json = await res.json();
  return explore.parseSearchResults(json, { minPlay: 1000 }).slice(0, 2);
}

const keys = await navKeys();
const sandboxTaste = [];
for (const topic of seedTopics) {
  let rows = [];
  try { rows = await searchVideos(topic, keys); } catch (e) { console.error('search failed', topic, e.message); }
  const evidence = rows.map((r) => ({
    url: r.url || `https://www.bilibili.com/video/${r.bvid}`,
    excerpt: String(r.title || '').slice(0, 60),
    author: r.author || '',
    at: Date.now(),
  }));
  if (!evidence.length) continue;
  sandboxTaste.push({ id: topic, topic, strength: 0.2, evidence, createdAt: Date.now(), updatedAt: Date.now(), lastSeenAt: Date.now(), source: 'sim-bilibili' });
}
fs.writeFileSync(path.join(SIM_DIR, 'sandbox-taste.json'), `${JSON.stringify({ topics: sandboxTaste }, null, 2)}\n`, 'utf8');

const templates = [
  (t) => `最近在看${t}，有什么入门建议吗`,
  (t) => `我想试试${t}，但怕坚持不下来`,
  (t) => `你觉得${t}值得花时间吗`,
];
const messages = [];
for (const s of sandboxTaste) for (const f of templates) messages.push({ topic: s.topic, text: f(s.topic) });

async function build(text, inject, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/eval/build-prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ text, inject, ...opts, taste: sandboxTaste, selfMemory: [], boundaryAt: Date.now() + 1000 }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'build failed');
  return data;
}

const results = [];
for (const m of messages) {
  const off = await build(m.text, false);
  const on = await build(m.text, true);
  results.push({
    topic: m.topic,
    text: m.text,
    gate: on.linkage,
    injected: on.chars > off.chars,
    delta: on.chars - off.chars,
    sample: String(on.prompt).split('【拾光证据（只读，来源可核）】')[1]?.split('【')[0]?.trim().slice(0, 120) || '',
  });
}

const afterTaste = hashFile(path.join(STATE, 'taste.json'));
const afterSelf = hashFile(path.join(STATE, 'self-memory.json'));

// 可选：模拟回复（会真实调用模型，默认不跑）
if (process.argv.includes('--respond')) {
  const noRecall = process.argv.includes('--no-recall');
  const noContinuity = noRecall || process.argv.includes('--no-continuity');
  const opts = noRecall ? { noContinuity: true, noWorkspace: true, noMemory: true } : (noContinuity ? { noContinuity: true } : {});
  const suffix = noRecall ? '-norecall' : (noContinuity ? '-nocont' : '');
  const prompts = [];
  for (const r of results) {
    const off = await build(r.text, false, opts);
    const on = await build(r.text, true, opts);
    prompts.push({ topic: r.topic, text: r.text, off: off.prompt, on: on.prompt });
  }
  const conditions = [];
  const responses = [];
  let seed = 20261102;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < prompts.length; i += 1) {
    const p = prompts[i];
    const order = rnd() < 0.5 ? ['off', 'on'] : ['on', 'off'];
    const pairId = `pair-${String(i + 1).padStart(2, '0')}`;
    const got = {};
    for (const arm of order) {
      const res = await fetch(`http://127.0.0.1:${port}/api/eval/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify({ prompt: arm === 'off' ? p.off : p.on }),
      });
      const data = await res.json();
      got[arm] = data.ok ? data.text : `（失败：${data.error}）`;
    }
    const slotA = got[order[0]];
    const slotB = got[order[1]];
    conditions.push({ pairId, topic: p.topic, message: p.text, order });
    responses.push({ pairId, topic: p.topic, message: p.text, A: slotA, B: slotB });
    console.log(` ${pairId} ${p.topic} · ${p.text.slice(0, 14)} · A ${String(slotA).length} 字 / B ${String(slotB).length} 字`);
  }
  fs.writeFileSync(path.join(SIM_DIR, `conditions${suffix}.json`), `${JSON.stringify({ at: Date.now(), conditions }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(SIM_DIR, `responses${suffix}.json`), `${JSON.stringify({ at: Date.now(), responses }, null, 2)}\n`, 'utf8');
  const sheet = ['# 沙盒盲评（A/B 匿名）', '', '| pair | 话题 | 消息 | A | B |', '|---|---|---|---|---|',
    ...responses.map((r) => `| ${r.pairId} | ${r.topic} | ${r.message.replace(/\|/g, '/')} | （见本地 responses.json） | （见本地） |`)].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs', 'eval', 'sim-blind-sheet.md'), `${sheet}\n`, 'utf8');
  console.log(`responses -> ${path.join(SIM_DIR, `responses${suffix}.json`)}`);
}

const report = {
  version: 1,
  at: Date.now(),
  topics: sandboxTaste.map((t) => ({ topic: t.topic, evidence: t.evidence.length, sampleUrl: t.evidence[0]?.url })),
  messages: results.length,
  hits: results.filter((r) => r.injected).length,
  productionUnchanged: { taste: beforeTaste === afterTaste, selfMemory: beforeSelf === afterSelf },
  results,
};
fs.writeFileSync(path.join(ROOT, 'docs', 'eval', 'sim-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('sandbox topics', sandboxTaste.map((t) => `${t.topic}(${t.evidence.length})`).join(', '));
console.log('messages', results.length, 'injected', report.hits);
for (const r of results) console.log(' ', r.injected ? 'HIT ' : 'skip', r.topic, '|', r.text.slice(0, 18), '| reason', r.gate?.reason, '| delta', r.delta);
console.log('production unchanged:', JSON.stringify(report.productionUnchanged));
