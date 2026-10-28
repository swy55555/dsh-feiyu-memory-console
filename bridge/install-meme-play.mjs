// 给 QQ 桥接接入“主动玩梗”。只做三件事：放模块、挂提示词、记录用过的梗。
// 用法：
//   node bridge/install-meme-play.mjs --check
//   node bridge/install-meme-play.mjs --apply
//   node bridge/install-meme-play.mjs --undo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const target = path.resolve(valueOf('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));
const bridgeFile = path.join(target, 'src', 'bridge.js');
const moduleFile = path.join(target, 'src', 'meme-play.js');
const configFile = path.join(target, 'state', 'meme-play.json');
const receiptFile = path.join(target, 'state', 'meme-play-install.json');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function backupName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${bridgeFile}.bak-meme-play-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function status(src) {
  const hasImport = src.includes("from './meme-play.js'");
  const hasWrapper = src.includes('withMemePlayContext');
  const hasHook = src.includes('noteMemeUse(key, msg)');
  return { hasImport, hasWrapper, hasHook, installed: hasImport && hasWrapper && hasHook };
}

const src = read(bridgeFile);
if (!src) die(`找不到桥接文件：${bridgeFile}`);

if (flag('--check')) {
  const st = status(src);
  if (st.installed) {
    console.log('already-installed');
  } else {
    console.log(JSON.stringify({ target, ...st, module: fs.existsSync(moduleFile) }, null, 2));
  }
  process.exit(0);
}

if (flag('--undo')) {
  let receipt = {};
  try { receipt = JSON.parse(read(receiptFile) || '{}'); } catch {}
  if (!receipt.backup || !fs.existsSync(receipt.backup)) die('没有可用的安装回执/备份');
  fs.copyFileSync(receipt.backup, bridgeFile);
  fs.rmSync(receiptFile, { force: true });
  console.log(`restored ${receipt.backup}`);
  process.exit(0);
}

if (!flag('--apply')) die('用法：--check / --apply / --undo（可加 --target <桥接目录>）');

const st = status(src);
if (st.installed) {
  console.log('already-installed');
  process.exit(0);
}
if (st.hasImport || st.hasWrapper) die('桥接已经是半接入状态，请先 --undo 或手动检查');

const backup = backupName();
fs.copyFileSync(bridgeFile, backup);
const importAnchor = "import { applyEmotionEvent, appraise, emotionPromptLine, emotionSummary, emptyEmotion, normalizeEmotion, suggestChatPersonalityDrift, suggestPersonalityDrift, tickEmotion } from './emotion.js';";
if (!src.includes(importAnchor)) die('找不到 emotion import，桥接版本不兼容');
let next = src.replace(importAnchor, importAnchor + "\nimport { loadMemePlayConfig, pickMemeCandidates, renderMemeBlock, recordMemeUse, usedTitlesFromMemories } from './meme-play.js';", 1);
next = next.replace(/\r\n/g, '\n');

const headOld = "  async function runHeadlessPrompt(prompt, timeoutMs = 90000) {";
if (next.includes(headOld)) {
  next = next.replace(headOld, "  async function runHeadlessPrompt(prompt, timeoutMs = 90000, images = []) {", 1);
  next = next.replace(
    "      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });",
    "      const content = [{ type: 'text', text: prompt }, ...(Array.isArray(images) ? images : [])];\n      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });",
  );
}

const marker = '  // 2026-10-26：自动回忆。';
if (!next.includes(marker)) die('找不到 withMemeContext 结束标记，桥接版本不兼容');

const block = fs.readFileSync(path.join(HERE, 'meme-play-block.js'), 'utf8');
next = next.replace(marker, block + marker, 1);

const call = 'promptText = withMemeContext(key, promptText);';
if (!next.includes(call)) die('找不到 withMemeContext 调用点');
next = next.split(call).join(call + '\n    promptText = await withMemePlayContext(key, promptText);');

const sent = '          await onebotSend(kind, id, msg, useReply, useAt);\n          sent.push(msg);';
if (!next.includes(sent)) die('找不到发送点，桥接版本不兼容');
next = next.replace(sent, sent + '\n          try { noteMemeUse(key, msg); } catch {}', 1);

fs.writeFileSync(bridgeFile, next, 'utf8');
fs.copyFileSync(path.join(HERE, 'meme-play.js'), moduleFile);
if (!fs.existsSync(configFile)) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    enabled: true, group: true, private: true, proactive: true, attackMoodBelow: 0.1, limit: 2,
  }, null, 2) + '\n', 'utf8');
}
fs.writeFileSync(receiptFile, JSON.stringify({ backup, installedAt: new Date().toISOString(), target }, null, 2) + '\n', 'utf8');
console.log(`installed: ${bridgeFile}`);
console.log(`backup: ${backup}`);
