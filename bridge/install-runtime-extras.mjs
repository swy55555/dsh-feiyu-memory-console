// 给 QQ 桥接补齐 0.8.2/0.8.3 的运行时能力：
//   - 跨聊天记忆共享（withMemoryContext）
//   - memoryShare 配置热更新
//   - 群目录同步（groups.json，群名/退群）
//   - token 账本区分「可塑性记忆」和「黑话学习」
// 用法：node bridge/install-runtime-extras.mjs --target <桥接目录> --check|--apply|--undo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const val = (x, d) => { const i = args.indexOf(x); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = path.resolve(val('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));
const file = path.join(target, 'src', 'bridge.js');
const humanContextFile = path.join(target, 'src', 'human-context.mjs');
const receipt = path.join(target, 'state', 'runtime-extras.json');
const die = (m) => { console.error(m); process.exit(1); };

if (!fs.existsSync(file)) die(`找不到桥接文件：${file}`);
let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const markers = {
  share: 'const shareCfg = cfg.socialV2?.memoryShare',
  config: '// memoryShare：跨聊天记忆共享开关',
  groups: 'async function syncGroupDirectory()',
  tokens: "'internal:可塑性记忆'",
};
const bodyNoGlobal = "body: JSON.stringify({ query, scope: memoryScope(key), min_score: 0.4, k: Number(cfg.socialV2?.memoryRecall?.topK ?? 3) }),";
const bodyOldGlobal = "body: JSON.stringify({ query, scope: memoryScope(key), min_score: 0.4, k: Number(cfg.socialV2?.memoryRecall?.topK ?? 3), include_global: cfg.socialV2?.memoryShare?.enabled !== false }),";
const bodyNewGlobal = "body: JSON.stringify({ query, scope: memoryScope(key), min_score: 0.4, k: Number(cfg.socialV2?.memoryRecall?.topK ?? 3), include_global: false }),";
const composeOld = "compose(priority.results, [...(j.results || []), ...sharedRows]);";
const composeNew = "compose(priority.results, [...(j.results || []), ...sharedRows.map((r) => ({ ...r, shared: true }))]);";
const missing = Object.entries(markers).filter(([, m]) => !src.includes(m)).map(([k]) => k);
if (src.includes(bodyNoGlobal) || src.includes(bodyOldGlobal)) missing.push('global-scope');
if (src.includes('if (shareCfg.enabled !== false) {')) missing.push('opt-in');
if (src.includes(composeOld)) missing.push('shared-flag');
let humanContextSource = '';
try { humanContextSource = fs.readFileSync(humanContextFile, 'utf8'); } catch {}
if (humanContextSource.includes("if (scope !== key && scope !== 'global') continue;")) missing.push('human-context');
if (has('--check')) {
  console.log(missing.length ? JSON.stringify({ target, installed: false, missing }, null, 2) : 'already-installed');
  process.exit(0);
}
if (has('--undo')) {
  let r = {};
  try { r = JSON.parse(fs.readFileSync(receipt, 'utf8')); } catch {}
  if (!r.backup || !fs.existsSync(r.backup)) die('没有可用的安装回执/备份');
  fs.copyFileSync(r.backup, file);
  if (r.humanContextBackup && fs.existsSync(r.humanContextBackup)) fs.copyFileSync(r.humanContextBackup, humanContextFile);
  fs.rmSync(receipt, { force: true });
  console.log(`restored ${r.backup}`);
  process.exit(0);
}
if (!has('--apply')) die('用法：--check / --apply / --undo（可加 --target <桥接目录>）');
if (!missing.length) { console.log('already-installed'); process.exit(0); }

const backup = `${file}.bak-runtime-extras-${Date.now()}.js`;
fs.copyFileSync(file, backup);
let humanContextBackup = '';
if (fs.existsSync(humanContextFile)) {
  humanContextBackup = `${humanContextFile}.bak-runtime-extras-${Date.now()}.mjs`;
  fs.copyFileSync(humanContextFile, humanContextBackup);
}
let next = src;

// 1) 配置热更新：memoryShare
if (!next.includes(markers.config)) {
  const anchor = '          // sticker：表情包体系参数归一化';
  if (!next.includes(anchor)) die('桥接版本不兼容：找不到配置合并锚点');
  const block = `          // memoryShare：跨聊天记忆共享开关
          if (body.memoryShare && typeof body.memoryShare === 'object') {
            merged.memoryShare = { ...(current.memoryShare ?? {}), ...body.memoryShare };
            if (merged.memoryShare.enabled !== undefined) merged.memoryShare.enabled = merged.memoryShare.enabled === true;
            if (merged.memoryShare.topK !== undefined) merged.memoryShare.topK = Math.min(3, Math.max(1, Math.round(Number(merged.memoryShare.topK) || 2)));
            if (merged.memoryShare.minScore !== undefined) merged.memoryShare.minScore = Math.min(0.9, Math.max(0.2, Number(merged.memoryShare.minScore) || 0.45));
          }
`;
  next = next.replace(anchor, block + anchor, 1);
}

// 2) 跨聊天共享检索
if (next.includes(bodyOldGlobal)) next = next.replace(bodyOldGlobal, bodyNewGlobal);
if (next.includes(composeOld)) next = next.replace(composeOld, composeNew);
if (next.includes(bodyNoGlobal)) next = next.replace(bodyNoGlobal, bodyNewGlobal);
next = next.replace('if (shareCfg.enabled !== false) {', 'if (shareCfg.enabled === true) {');
if (!next.includes(markers.share)) {
  const old = `      const j = await res.json();
      if (human) return summaryBlock + sessionBlock + compose(priority.results, j.results);
      const unique = new Map();
      for (const r of [...(priority.results || []), ...(j.results || [])]) if (!unique.has(r.id)) unique.set(r.id, r);
      const rows = [...unique.values()].filter((r) => Number(r.score) >= 0.4);
      if (!rows.length) return summaryBlock + sessionBlock + promptText;
      log(\`memory recall injected: \${rows.length} 条\`);
      return summaryBlock + sessionBlock + recallBlock(rows) + promptText;`;
  if (!next.includes(old)) die('桥接版本不兼容：找不到记忆召回锚点');
  const block = `      const j = await res.json();
      // 跨聊天共享：只取非当前聊天、且管理员私聊隐私已过滤的记忆。
      const shareCfg = cfg.socialV2?.memoryShare || {};
      let sharedRows = [];
      if (shareCfg.enabled === true) {
        try {
          const sr = await memoryRequest('/search', {
            query,
            scope: memoryScope(key),
            shared: true,
            exclude_scope: memoryScope(key),
            k: Math.max(1, Math.min(3, Number(shareCfg.topK) || 2)),
            min_score: Math.max(0.2, Number(shareCfg.minScore) || 0.45),
          }, 1200);
          sharedRows = Array.isArray(sr.results) ? sr.results : [];
        } catch {}
      }
      if (human) return summaryBlock + sessionBlock + compose(priority.results, [...(j.results || []), ...sharedRows.map((r) => ({ ...r, shared: true }))]);
      const unique = new Map();
      for (const r of [...(priority.results || []), ...(j.results || [])]) if (!unique.has(r.id)) unique.set(r.id, r);
      const rows = [...unique.values()].filter((r) => Number(r.score) >= 0.4);
      const currentIds = new Set(rows.map((r) => r.id));
      const shared = sharedRows.filter((r) => !currentIds.has(r.id));
      const sharedBlock = shared.length
        ? '【别处记住的（已过滤隐私）】\\n' + shared.map((r) => '- ' + String(r.text || '').slice(0, 160)).join('\\n') + '\\n'
        : '';
      if (!rows.length && !shared.length) return summaryBlock + sessionBlock + promptText;
      log(\`memory recall injected: \${rows.length} 条\` + (shared.length ? \` + 共享 \${shared.length} 条\` : ''));
      return summaryBlock + sessionBlock + sharedBlock + recallBlock(rows) + promptText;`;
  next = next.replace(old, block, 1);
}

// 3) 群目录同步
if (!next.includes(markers.groups)) {
  const anchor = '  const ownerContactTimer = setInterval(() => { void checkOwnerContact(); void checkBedtime(); }, 5 * 60 * 1000);';
  if (!next.includes(anchor)) die('桥接版本不兼容：找不到 ownerContactTimer 锚点');
  const block = `  async function syncGroupDirectory() {
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\\/+$/, '');
      const res = await fetch(httpUrl + '/get_group_list', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') return;
      const groups = (Array.isArray(body.data) ? body.data : [])
        .map((g) => ({ id: String(g.group_id || ''), name: String(g.group_name || '') }))
        .filter((g) => /^\\d+$/.test(g.id));
      atomicWriteJson(path.join(STATE_DIR, 'groups.json'), { at: Date.now(), groups });
    } catch (error) {
      log('[groups] 同步群名失败:', error?.message ?? error);
    }
  }
  setTimeout(() => { void syncGroupDirectory(); }, 5000);
  const groupDirTimer = setInterval(() => { void syncGroupDirectory(); }, 2 * 60 * 1000);
  groupDirTimer.unref?.();

`;
  next = next.replace(anchor, block + anchor, 1);
}

// 4) token 归属：可塑性记忆 / 黑话学习
if (!next.includes(markers.tokens)) {
  const oldPlugin = `    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:插件'
        : undefined)`;
  const oldSlang = `    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)`;
  const block = `    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (slangLearnerSessionId && sessionId === slangLearnerSessionId
        ? 'internal:黑话学习'
        : learnerSessions.has(sessionId)
          ? 'internal:可塑性记忆'
          : undefined)`;
  if (next.includes(oldPlugin)) next = next.replace(oldPlugin, block, 1);
  else if (next.includes(oldSlang)) next = next.replace(oldSlang, block, 1);
  else die('桥接版本不兼容：找不到 token 归属锚点');
}

if (humanContextSource.includes("if (scope !== key && scope !== 'global') continue;")) {
  const patched = humanContextSource.replace(
    "      if (scope !== key && scope !== 'global') continue;",
    "      if (!r.shared && scope !== key && scope !== 'global') continue;",
  );
  fs.writeFileSync(humanContextFile, patched, 'utf8');
}
fs.writeFileSync(file, next, 'utf8');
fs.mkdirSync(path.dirname(receipt), { recursive: true });
fs.writeFileSync(receipt, JSON.stringify({ backup, humanContextBackup, installedAt: new Date().toISOString(), target }, null, 2) + '\n', 'utf8');
console.log(`installed: ${file}`);
console.log(`backup: ${backup}`);
