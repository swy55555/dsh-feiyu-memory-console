// 给 QQ 桥接接入“群聊/别人私聊的高情绪事件，回头找管理员说”。
// 用法：--check / --apply / --undo，可加 --target <桥接目录>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const val = (x, d) => { const i = args.indexOf(x); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = path.resolve(val('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));
const file = path.join(target, 'src', 'bridge.js');
const receipt = path.join(target, 'state', 'emotion-spillover-install.json');
const die = (m) => { console.error(m); process.exit(1); };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const src = read(file);
if (!src) die(`找不到桥接文件：${file}`);
const installed = src.includes('maybeQueueSpillover');

if (has('--check')) {
  console.log(installed ? 'already-installed' : JSON.stringify({ target, installed: false }, null, 2));
  process.exit(0);
}
if (has('--undo')) {
  let r = {};
  try { r = JSON.parse(read(receipt) || '{}'); } catch {}
  if (!r.backup || !fs.existsSync(r.backup)) die('没有可用的安装回执/备份');
  fs.copyFileSync(r.backup, file);
  fs.rmSync(receipt, { force: true });
  console.log(`restored ${r.backup}`);
  process.exit(0);
}
if (!has('--apply')) die('用法：--check / --apply / --undo（可加 --target <桥接目录>）');
if (installed) { console.log('already-installed'); process.exit(0); }

let next = src.replace(/\r\n/g, '\n');
const need = [
  '  function noteEmotion({',
  "    saveEmotionState();\n    void refineEmotionWithModel({ source, text: body, directed, weight, kind, key }, ap);",
  "    if (waitMs < conf.idleHours * 3600 * 1000) return;\n    if (isConversationBusyV2(key, st)) return;",
  "    if (reason === 'ownerIdle' || reason === 'ownerSulk') {",
];
for (const n of need) if (!next.includes(n)) die('桥接版本不兼容，找不到标记：' + n.slice(0, 40));

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const backupFile = `${file}.bak-spillover-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
fs.copyFileSync(file, backupFile);

const helpers = `  const SPILLOVER_FILE = path.join(STATE_DIR, 'emotion-spillover.json');
  let activeSpillover = null;

  function spilloverCfg() {
    const raw = cfg.socialV2?.emotion?.spillover || {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      enabled: raw.enabled !== false,
      minIntensity: Math.max(0, Math.min(1, num(raw.minIntensity, 0.55))),
      minAbsPolarity: Math.max(0, Math.min(1, num(raw.minAbsPolarity, 0.35))),
      maxPerDay: Math.max(1, Math.min(12, Math.round(num(raw.maxPerDay, 4)))),
      cooldownMinutes: Math.max(1, Math.min(720, Math.round(num(raw.cooldownMinutes, 45)))),
    };
  }

  function readSpillover() {
    try {
      const v = readJsonSafe(SPILLOVER_FILE, null);
      return v && Array.isArray(v.items) ? v : { day: '', count: 0, items: [] };
    } catch { return { day: '', count: 0, items: [] }; }
  }

  function saveSpillover(v) {
    try { atomicWriteJson(SPILLOVER_FILE, v); } catch (error) { log('[spillover] 保存失败:', error?.message ?? error); }
  }

  function maybeQueueSpillover({ source, key, text, ap }) {
    const conf = spilloverCfg();
    if (!conf.enabled) return;
    const ownerKey = cfg.ownerQQ ? 'private:' + String(cfg.ownerQQ) : '';
    if (!key || key === ownerKey || source === 'owner') return;
    const intensity = Number(ap?.intensity || 0);
    const polarity = Number(ap?.polarity || 0);
    if (intensity < conf.minIntensity && Math.abs(polarity) < conf.minAbsPolarity) return;
    const now = Date.now();
    const day = localDayKey(new Date());
    const state = readSpillover();
    if (state.day !== day) { state.day = day; state.count = 0; }
    if (state.count >= conf.maxPerDay) return;
    const last = state.items[state.items.length - 1];
    if (last && now - Number(last.at || 0) < conf.cooldownMinutes * 60000) return;
    state.count += 1;
    state.items.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(now),
      key, source, text: String(text || '').slice(0, 200),
      valence: Number(emotionState?.state?.valence ?? 0),
      intensity, polarity, at: now,
    });
    state.items = state.items.slice(-6);
    saveSpillover(state);
    log('[spillover] 记下 ' + key + ' 的高情绪事件，等老大空下来再说');
  }

  function takeSpillover() {
    const state = readSpillover();
    const item = state.items.shift();
    if (!item) return null;
    saveSpillover(state);
    return item;
  }

`;
next = next.replace('  function noteEmotion({', helpers + '  function noteEmotion({', 1);
next = next.replace("    saveEmotionState();\n    void refineEmotionWithModel({ source, text: body, directed, weight, kind, key }, ap);",
  "    saveEmotionState();\n    maybeQueueSpillover({ source, key, text: body, ap });\n    void refineEmotionWithModel({ source, text: body, directed, weight, kind, key }, ap);", 1);

const checkOld = "    if (waitMs < conf.idleHours * 3600 * 1000) return;\n    if (isConversationBusyV2(key, st)) return;";
const checkNew = `    if (waitMs >= 10 * 60 * 1000 && !isConversationBusyV2(key, st)) {
      const sp = takeSpillover();
      if (sp) {
        oc.count += 1;
        oc.lastAt = Date.now();
        saveSocialV2State();
        activeSpillover = sp;
        log('[ownerContact] 找 ' + key + ' 说 ' + sp.key + ' 的事（' + (sp.polarity < 0 ? '诉苦' : '分享') + '）');
        void sendWakePromptV2(key, 'emotionSpillover')
          .catch((error) => log('[ownerContact] 情绪分享唤醒异常 ' + key + ':', error?.message ?? error))
          .finally(() => { activeSpillover = null; });
        return;
      }
    }
` + checkOld;
next = next.replace(checkOld, checkNew, 1);

const wakeOld = "    if (reason === 'ownerIdle' || reason === 'ownerSulk') {";
const wakeNew = `    if (reason === 'emotionSpillover' && activeSpillover) {
      const sp = activeSpillover;
      const where = String(sp.key).startsWith('group:') ? '群里' : '另一个私聊';
      const feel = sp.polarity < 0 ? '心里有点堵，想跟老大说' : '挺开心的，想第一时间跟老大分享';
      return base + '【想跟老大说的事】' + key + '\\n你刚才在' + where + '碰到一件事：' + String(sp.text || '').slice(0, 160) + '\\n' + feel + '。主动找老大讲这件事：先说发生了什么，再说你的感受，像真人聊天，不要汇报、不要提“情绪系统/数值”、不要把对方原话整段搬过去。如果老大在忙或不想聊，就收住。';
    }
` + wakeOld;
next = next.replace(wakeOld, wakeNew, 1);

fs.writeFileSync(file, next, 'utf8');
fs.mkdirSync(path.dirname(receipt), { recursive: true });
fs.writeFileSync(receipt, JSON.stringify({ backup: backupFile, installedAt: new Date().toISOString(), target }, null, 2) + '\n', 'utf8');
console.log(`installed: ${file}`);
console.log(`backup: ${backupFile}`);
