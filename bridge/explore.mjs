// 拾光 · 探索闭环（v1 手动版）
// 只读抓取 B 站公开数据，生成 1~2 条有原文依据的印象，写进 taste / self-memory。
// 所有数值来自 socialV2.explore，默认关闭定时调度。
import { createHash } from 'node:crypto';
// 广度种子是「意图」而不是分类：抽中哪个都只是暂定证据，不等于预设兴趣。
export const BREADTH_SEEDS = Object.freeze([
  { topic: '现实旧建筑', forbid: /我的世界|Minecraft|迷你世界|泰拉瑞亚|方块|游戏/ },
  { topic: '建筑漫游', forbid: /我的世界|Minecraft|迷你世界|泰拉瑞亚|方块|游戏/ },
  { topic: '街头小吃' },
  { topic: '菜市场' },
  { topic: '阳台植物' },
  { topic: '城市观鸟' },
  { topic: '老电影修复' },
  { topic: '手工木工' },
  { topic: '地理冷知识' },
  { topic: '家常菜' },
]);

// 内容形式过滤：与选题无关，任何时候都排除。
const FORM_EXCLUDE = /带货|开箱|优惠券|广告|推广链接|返利|下单链接/;

export const EXPLORE_DEFAULTS = Object.freeze({
  enabled: false,          // 定时调度默认关闭
  idleHours: 6,
  minCuriosity: 0.55,
  minAutonomy: 0.5,
  quietHours: ['01:00', '09:00'],
  timezone: 'Asia/Shanghai',
  maxPerDay: 2,
  maxCallsPerRun: 3,
  maxPagesPerRun: 2,
  maxCharsPerRun: 15000,
  maxCostPerDay: 0.05,
});

export function exploreConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...EXPLORE_DEFAULTS, ...Object.fromEntries(Object.entries(src).filter(([k]) => k in EXPLORE_DEFAULTS)) };
  for (const [key, min, max] of [['maxPerDay',1,20],['maxCallsPerRun',1,3],['maxPagesPerRun',1,10],['maxCharsPerRun',100,15000],['idleHours',0,168],['maxCostPerDay',0,100],['minCuriosity',0,1],['minAutonomy',0,1]]) {
    const value = Number(out[key]); out[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : EXPLORE_DEFAULTS[key];
    if (['maxPerDay','maxCallsPerRun','maxPagesPerRun','maxCharsPerRun'].includes(key)) out[key] = Math.floor(out[key]);
  }
  out.enabled = src.enabled === true;
  try { new Intl.DateTimeFormat('en', {timeZone:out.timezone}); } catch { out.timezone = EXPLORE_DEFAULTS.timezone; }
  if (!Array.isArray(out.quietHours) || out.quietHours.length !== 2 || out.quietHours.some(v=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))) out.quietHours = [...EXPLORE_DEFAULTS.quietHours];
  return out;
}

const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export function pickTopic({ taste = null, random = Math.random, avoidTopics = [] } = {}) {
  const avoid = new Set((avoidTopics || []).map(String));
  const topics = (Array.isArray(taste?.topics) ? taste.topics : []).filter((x) => !avoid.has(String(x.topic)));
  if (topics.length) {
    const pool = [...topics].sort((a, b) => b.strength - a.strength).slice(0, 5);
    const total = pool.reduce((a, t) => a + t.strength, 0) || 1;
    let r = random() * total;
    for (const t of pool) { r -= t.strength; if (r <= 0) return { topic: t.topic, basis: 'taste' }; }
    return { topic: pool[0].topic, basis: 'taste' };
  }
  // 档案为空：从「意图」种子池里随机。这是起点，不是预设爱好。
  const seeds = BREADTH_SEEDS.filter((s) => !avoid.has(String(s.topic)));
  const poolSeeds = seeds.length ? seeds : BREADTH_SEEDS;
  const seed = poolSeeds[Math.floor(random() * poolSeeds.length) % poolSeeds.length];
  return { topic: seed.topic, basis: 'breadth-seed', seed };
}

export function searchUrl(keyword) {
  return `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1`;
}

// 教学/备考类内容：探索不是学习课程，抽到就换一个候选。
const TEACHING_RE = /高考|中考|赋分|刷题|真题|押题|课程|网课|教材|辅导|知识点|考点|升学|志愿|提分|名师|冲刺|复习/;

export function isTeachingContent({ title = '', description = '' } = {}) {
  return TEACHING_RE.test(`${title} ${description}`);
}

// 按选题意图过滤：种子自带 forbid（例如“现实旧建筑”排除 Minecraft），
// 内容形式过滤（带货/开箱）永远生效；做饭、手工这类教程不排除。
export function matchesIntent(candidate, seed = null) {
  const text = `${candidate?.title || ''} ${candidate?.description || ''}`;
  if (FORM_EXCLUDE.test(text)) return false;
  if (seed?.forbid && seed.forbid.test(text)) return false;
  return true;
}

export function pickCandidates(results, { seed = null, limit = 3 } = {}) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && r.bvid && !isTeachingContent(r) && matchesIntent(r, seed))
    .sort((a, b) => b.play - a.play)
    .slice(0, Math.max(1, limit));
}

// ── WBI 签名（读 AI 字幕需要）────────────────────────────────────────
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

export function mixinKey(imgKey, subKey) {
  const orig = `${imgKey || ''}${subKey || ''}`;
  return MIXIN_TAB.map((i) => orig[i] || '').join('').slice(0, 32);
}

export function wbiQuery(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  const signed = { ...params, wts };
  const query = Object.keys(signed)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(signed[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const rid = createHash('md5').update(query + mixinKey(imgKey, subKey)).digest('hex');
  return `${query}&w_rid=${rid}`;
}

export function playerUrl({ bvid, cid, imgKey, subKey }) {
  return `https://api.bilibili.com/x/player/wbi/v2?${wbiQuery({ bvid, cid }, imgKey, subKey)}`;
}

export function parseSubtitleBody(json) {
  const body = json?.body;
  if (!Array.isArray(body)) return '';
  return body.map((row) => clean(row?.content)).filter(Boolean).join('\n');
}

export function subtitleRefs(playerJson) {
  const list = playerJson?.data?.subtitle?.subtitles;
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => ({ url: String(row?.subtitle_url || ''), lan: String(row?.lan || '') }))
    .filter((row) => row.url)
    .map((row) => ({ ...row, url: row.url.startsWith('//') ? `https:${row.url}` : row.url }));
}

export function viewUrl(bvid) {
  return `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
}

export function parseSearchResults(json, { minPlay = 1000 } = {}) {
  const list = json?.data?.result;
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => ({
      bvid: String(row.bvid || ''),
      title: clean(row.title),
      author: clean(row.author),
      description: clean(row.description),
      play: Number(row.play) || 0,
    }))
    .filter((r) => r.bvid && r.title && r.play >= minPlay)
    .slice(0, 10);
}

export function parseVideoView(json) {
  const d = json?.data;
  if (!d || !d.bvid) return null;
  return {
    bvid: String(d.bvid),
    title: clean(d.title),
    desc: clean(d.desc).slice(0, 1200),
    author: clean(d.owner?.name),
    url: `https://www.bilibili.com/video/${d.bvid}`,
  };
}

export function impressionPrompt({ topic, title, desc }) {
  return `你是她自己的记录员，不是聊天对象。下面是一条她刚看到的视频信息，请从里面提炼 1~2 条具体印象。
只输出 JSON：{"impressions":[{"text":"一句具体的话，最多60字","quote":"从下面的标题或简介里逐字复制的片段","kind":"fact|impression"}]}
规则：
- quote 必须是原文里连续出现的一段，不能改写；找不到依据就不要输出。
- kind=fact 只用于视频里明确陈述的客观信息；个人感受、猜测一律 impression。
- 不要写“我”的感受，不要评价她，不要提 AI；只说这条内容本身。
- 最多 2 条；没有值得记的就输出 {"impressions":[]}。
话题：${topic}
标题：${title}
简介：${desc}`;
}

export function parseImpressions(raw, { excerpt, topic }) {
  let value;
  try {
    value = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch { return []; }
  const list = Array.isArray(value?.impressions) ? value.impressions : [];
  const source = String(excerpt || '');
  return list
    .map((row) => ({
      text: String(row?.text || '').trim().slice(0, 60),
      quote: String(row?.quote || '').trim(),
      kind: row?.kind === 'fact' ? 'fact' : 'impression',
    }))
    .filter((row) => row.text && row.quote && row.quote.length >= 4 && source.includes(row.quote))
    .slice(0, 2)
    .map((row) => ({ ...row, topic }));
}

export function emptyExplore() {
  return { version: 1, runs: [], focus: null, updatedAt: Date.now() };
}

export function normalizeExplore(raw) {
  const out = emptyExplore();
  out.runs = Array.isArray(raw?.runs) ? raw.runs.slice(-200) : [];
  const f = raw?.focus;
  out.focus = f && typeof f.topic === 'string' && Number(f.runsLeft) > 0
    ? { topic: f.topic, runsLeft: Number(f.runsLeft), updatedAt: Number(f.updatedAt) || Date.now() }
    : null;
  out.updatedAt = Number(raw?.updatedAt) || Date.now();
  return out;
}

// 聚焦话题：同一话题连看几轮，再换新的。
export function nextFocus(focus, picked, focusRuns = 2) {
  const runs = Math.max(1, Number(focusRuns) || 2);
  if (picked?.basis === 'focus' && focus?.topic === picked.topic) {
    const left = Math.max(0, Number(focus.runsLeft) || 0) - 1;
    return left > 0 ? { ...focus, runsLeft: left, updatedAt: Date.now() } : null;
  }
  const topic = String(picked?.topic || '');
  return topic ? { topic, runsLeft: runs - 1, updatedAt: Date.now() } : null;
}

export function budgetState(runs, now = Date.now()) {
  const day = new Date(now).toLocaleDateString('en-CA');
  const today = (Array.isArray(runs) ? runs : []).filter((r) => new Date(Number(r.at) || 0).toLocaleDateString('en-CA') === day);
  return { runsToday: today.length, costToday: today.reduce((a, r) => a + (Number(r.cost) || 0), 0) };
}

export function recordRun(state, entry) {
  const s = normalizeExplore(state);
  s.runs = [...s.runs, { ...entry, at: Number(entry.at) || Date.now() }].slice(-200);
  s.updatedAt = Date.now();
  return s;
}

// 安静时段（按时区判断，支持跨午夜）。
export function inQuietHours(conf, now = Date.now()) {
  const zone = conf?.timezone || 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const cur = get('hour') * 60 + get('minute');
  const [sh, sm] = String(conf?.quietHours?.[0] || '01:00').split(':').map(Number);
  const [eh, em] = String(conf?.quietHours?.[1] || '09:00').split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

// canary 决策：只决定“现在该不该跑”，不执行；跳过后不补跑。
export function exploreDecision({ conf, budget, now = Date.now(), lastActivityAt = 0, goals = {}, busy = false, running = false } = {}) {
  if (!conf?.enabled) return { run: false, reason: 'disabled' };
  if (running) return { run: false, reason: 'already-running' };
  if (busy) return { run: false, reason: 'busy' };
  if (inQuietHours(conf, now)) return { run: false, reason: 'quiet-hours' };
  if ((budget?.runsToday || 0) >= (conf.maxPerDay || 0)) return { run: false, reason: 'daily-runs' };
  if ((budget?.costToday || 0) >= (conf.maxCostPerDay || 0)) return { run: false, reason: 'daily-cost' };
  const idleMs = lastActivityAt ? now - Number(lastActivityAt) : Number.POSITIVE_INFINITY;
  if (idleMs < (conf.idleHours || 0) * 3600000) return { run: false, reason: 'not-idle' };
  const curiosity = Number(goals?.curiosity || 0);
  const autonomy = Number(goals?.autonomy || 0);
  if (curiosity < conf.minCuriosity && autonomy < conf.minAutonomy) return { run: false, reason: 'goals-low' };
  return { run: true, reason: 'ok' };
}
