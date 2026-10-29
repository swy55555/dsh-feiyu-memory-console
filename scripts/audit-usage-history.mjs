// Offline audit only. Writes a reviewable correction file, never edits the ledger.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

const legacyKeys = new Set(['internal:黑话学习', 'internal:插件', 'internal:可塑性记忆']);
const signatures = [
  ['slang_extract', '你是一个群聊黑话学习器。'],
  ['slang_research', '你是群聊黑话研究员。'],
  ['memory_extract', '你是无工具的记忆整理器。'],
  ['coverage_check', '你是独立的记忆遗漏检查员。'],
  ['fact_review', '你是记忆关系审核器，只分析下面的数据'],
  ['event_understanding', '你是无工具的对话事件整理器。'],
  ['idle_association', '你是角色的短程话题联想器，没有工具。'],
  ['image_description', '看这张聊天图片，用一两句话描述：'],
  ['diary', '你是「大肥鱼」，今天要写两页日记。'],
  ['persona_consolidation', '你是「大肥鱼」的自我整理器。下面是她最近经历的事，以及她现在的性格状态。'],
  ['persona_consolidation', '你是「她」的自我整理器。下面是她最近经历的事，以及她现在的性格状态。'],
  ['persona_draft', '你是角色人格设计师。读下面这张角色卡，为她起草一组「可慢变的性格维度」。'],
];
const envelopes = [
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  'This is an automatically generated checkpoint condensing an earlier span of the conversation',
];

export function classifyHistory(events, home) {
  const meta = events[0];
  const root = path.resolve(home, 'qq-bridge/state');
  const cwd = path.resolve(meta?.cwd || '.');
  const slang = cwd === path.join(root, 'slang-agent') && meta?.agentPreset === 'qq-chat';
  const memory = cwd === path.join(root, 'memory-agent') && meta?.agentPreset === 'qq-memory';
  if (!slang && !memory) return {reason:'会话来源不匹配，不能依据内容猜测'};
  const found = new Set();
  for (const event of events.filter(e => e.type === 'user/message')) {
    const parts = event.data?.message?.content ?? event.data?.content;
    if (!Array.isArray(parts)) return {reason:'原始消息结构无法核实'};
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (envelopes.some(prefix => text.startsWith(prefix))) continue;
    const feature = signatures.find(([, prefix]) => text.startsWith(prefix))?.[0];
    if (!feature) return {reason:'存在无法识别的调用模板，保留原统计'};
    found.add(feature);
  }
  const features = [...found];
  if (slang && features.length && features.every(f => f.startsWith('slang_'))) {
    return {key:'excluded:legacy-slang', excluded:true, features, reason:'旧黑话专用会话，全部业务提示为黑话提取或研究'};
  }
  if (memory && features.length === 1 && !features[0].startsWith('slang_')) {
    return {key:'internal:可塑性记忆:' + features[0], excluded:false, features, reason:'无工具后台会话，原始调用模板唯一匹配'};
  }
  return {reason:'混合功能或来源不一致，无法按整个会话可靠拆分'};
}

export function readSession(file) {
  let buffer = fs.readFileSync(file);
  const chunks = [];
  // Each append is a separate zstd frame; decoding only frame one loses all events.
  while (buffer.length) {
    const result = zlib.zstdDecompressSync(buffer, {info:true, maxOutputLength:64 * 1024 * 1024});
    if (!result.engine.bytesWritten) throw Error('zstd made no progress');
    chunks.push(result.buffer);
    buffer = buffer.subarray(result.engine.bytesWritten);
  }
  return Buffer.concat(chunks).toString('utf8').trim().split('\n').map(JSON.parse);
}

export function auditHistory(home) {
  const ledger = path.resolve(home, 'qq-bridge/state/token-usage.jsonl');
  const rows = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const keys = new Map(rows.filter(r => r.sid && r.key).map(r => [r.sid, r.key]));
  const wanted = new Map([...keys].filter(([, key]) => legacyKeys.has(key)));
  const files = new Map(), sessions = path.resolve(home, 'sessions');
  for (const dir of fs.readdirSync(sessions, {withFileTypes:true}).filter(d => d.isDirectory())) {
    for (const item of fs.readdirSync(path.join(sessions, dir.name), {withFileTypes:true})) {
      if (!item.isDirectory() || !wanted.has(item.name)) continue;
      // A duplicate ID is ambiguous; do not silently choose either session.
      files.set(item.name, files.has(item.name) ? null : path.join(sessions, dir.name, item.name, 'session.v4.jsonl.zstd'));
    }
  }
  const entries = {}, unresolved = [];
  for (const [sid, previousKey] of wanted) {
    const file = files.get(sid);
    try {
      if (!file) throw Error('missing or ambiguous source');
      const evidence = fs.readFileSync(file);
      const verdict = classifyHistory(readSession(file), home);
      if (!verdict.key) { unresolved.push({sid, previousKey, reason:verdict.reason}); continue; }
      entries[sid] = {previousKey, ...verdict, evidenceHash:crypto.createHash('sha256').update(evidence).digest('hex')};
    } catch { unresolved.push({sid, previousKey, reason:'原始会话缺失或无法完整读取'}); }
  }
  return {version:1, generatedAt:new Date().toISOString(), entries, unresolved};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), home = args[args.indexOf('--home') + 1], output = args[args.indexOf('--output') + 1];
  if (!args.includes('--home') || !args.includes('--output') || !home || !output) throw Error('Usage: node scripts/audit-usage-history.mjs --home DSH_HOME --output REVIEW.json');
  const result = auditHistory(home);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag:'wx', mode:0o600});
  console.log(JSON.stringify({reviewed:Object.keys(result.entries).length, excluded:Object.values(result.entries).filter(x => x.excluded).length, unresolved:result.unresolved.length}));
}
