// 主动接梗/玩梗：从本地 6668 条梗库里挑候选，写进提示词；用过的梗记一笔到 memvec。
// 只做“可选建议”，用不用由模型判断；不解释出处，避免百科腔。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_CONFIG = {
  enabled: true,
  group: true,
  private: true,
  proactive: true,
  attackMoodBelow: 0.1,
  limit: 2,
};

const POLITICS = /政治|时政|国际|新闻|政府|体制|党派|选举|外交|领导人/;
const SENSITIVE = /色情|成人|裸|性暗示|约炮/;
const ATTACK = /攻击|骂|嘲讽|阴阳|怼|撕|恶意|地狱|诅咒/;
const STOP = new Set(['我们', '你们', '他们', '今天', '这个', '那个', '什么', '就是', '可以', '没有', '不是', '一个', '感觉', '真的', '现在', '还是', '怎么', '因为', '所以']);

let _cache = { path: '', mtime: 0, rows: [] };

export function loadMemePlayConfig(stateDir) {
  try {
    const file = `${stateDir}/meme-play.json`;
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, ''));
    return { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function rows(dbPath) {
  try {
    const st = fs.statSync(dbPath);
    if (_cache.path === dbPath && _cache.mtime === st.mtimeMs) return _cache.rows;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const list = db.prepare('SELECT title,slug,tags,usage,origin FROM memes').all()
      .map((r) => ({ ...r, title: String(r.title || '').trim(), tags: String(r.tags || ''), usage: String(r.usage || '') }))
      .filter((r) => r.title);
    db.close();
    _cache = { path: dbPath, mtime: st.mtimeMs, rows: list };
    return list;
  } catch {
    return [];
  }
}

function terms(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  for (const run of t.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOP.has(bg)) out.add(bg);
    }
  }
  return out;
}

function allowed(row, mood, cfg) {
  const tags = row.tags;
  const hay = `${row.title} ${tags} ${row.usage}`;
  if (POLITICS.test(hay) || SENSITIVE.test(hay)) return false;
  if (ATTACK.test(tags) && Number(mood) >= Number(cfg.attackMoodBelow ?? 0.1)) return false;
  return true;
}

/** 从最近几条消息里挑 1–2 个候选；没有自然贴合的就返回空。 */
export function pickMemeCandidates({ dbPath, texts = [], moodValence = 0, config = DEFAULT_CONFIG, usedTitles = [], limit = 2 }) {
  if (!config?.enabled) return [];
  const rowsList = rows(dbPath);
  if (!rowsList.length) return [];
  const all = texts.join('\n');
  const qs = terms(all);
  if (!qs.size) return [];
  const used = new Set(usedTitles);
  const scored = [];
  for (const row of rowsList) {
    if (!allowed(row, moodValence, config)) continue;
    let score = 0;
    let strong = 0;
    const title = row.title;
    if (all.includes(title)) { score += 8; strong += 1; }
    if (used.has(title)) score += 2;
    const tagText = row.tags.toLowerCase();
    const usageText = row.usage.toLowerCase();
    for (const q of qs) {
      if (q.length < 2) continue;
      if (tagText.includes(q)) { score += 2; strong += 1; }
      else if (usageText.includes(q)) score += 1;
    }
    if (strong > 0) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);
  const out = [];
  const seen = new Set();
  for (const { row } of scored) {
    if (seen.has(row.title)) continue;
    seen.add(row.title);
    out.push(row);
    if (out.length >= Math.max(1, Math.min(2, Number(limit) || 2))) break;
  }
  return out;
}

export function renderMemeBlock(candidates, usedTitles = []) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return '';
  const clip = (s, n) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    return v.length > n ? v.slice(0, n) + '…' : v;
  };
  const lines = list.map((m) => `- 「${m.title}」（${clip(m.tags, 40)}）：${clip(m.usage, 160)}`).join('\n');
  const usedLine = usedTitles.length ? `\n她以前用过：${usedTitles.slice(0, 4).join('、')}。` : '';
  return `【可选梗·自然才用】\n${lines}${usedLine}\n规则：最多接一个；和当前话题不贴就完全别用；不要解释梗的出处，除非对方明确问；别每句都塞梗。`;
}

export async function recordMemeUse({ memvecUrl = 'http://127.0.0.1:9881', scope, title, slug, usage, tags = '', kind = '' }) {
  if (!scope || !title) return false;
  const scene = kind === 'group' ? '群聊' : '私聊';
  const body = {
    text: `我用过梗「${title}」：${String(usage || '').replace(/\s+/g, ' ').slice(0, 120)}`,
    tags: `梗,${scene}${tags ? ',' + String(tags).split(/[、,，]/).slice(0, 3).join(',') : ''}`,
    scope,
    importance: 0.2,
    confidence: 0.8,
    confirmed: true,
    tier: 'normal',
    fact_key: `meme:${slug || title}`,
    source_text: String(usage || '').slice(0, 600),
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${String(memvecUrl).replace(/\/$/, '')}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    return true;
  } catch {
    return false;
  }
}

/** 从她自己的梗记忆里提以前用过的梗名。 */
export function usedTitlesFromMemories(results = []) {
  const out = [];
  for (const r of results) {
    const m = /梗「(.+?)」/.exec(String(r?.text || ''));
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}
