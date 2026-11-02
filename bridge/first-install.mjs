import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {templates, RUNTIME_VERSION} from './install-runtime-bundle.mjs';
import {inspectClosure} from './runtime-inspection.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function initializeBridge(target, {apply = false, pluginRoot = path.resolve(here, '..')} = {}) {
  const root = path.resolve(target), parent = path.dirname(root);
  if (root === parent) throw Error('不能安装到磁盘根目录');
  const manifestName = '.xinji-install.json';
  if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory())) throw Error('目标必须是真实目录');
  if (fs.existsSync(root) && fs.readdirSync(root).length) {
    const receiptPath = path.join(root, manifestName);
    if (!fs.existsSync(receiptPath)) throw Error('目标非空；首次安装不会覆盖现有桥接，请使用升级流程');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.version !== RUNTIME_VERSION) throw Error('已有不同版本，请使用升级流程');
    for (const [rel, expected] of Object.entries(receipt.files)) {
      const file = path.resolve(root, rel), relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) throw Error('已安装文件被修改或缺失：' + rel);
    }
    return {status: 'already-initialized', version: RUNTIME_VERSION, target: root, configPreserved: true};
  }
  const files = new Map();
  for (const [name, source] of Object.entries(templates)) if (source !== '@retired') files.set('src/' + name, fs.readFileSync(path.join(here, source)));
  function collect(dir, prefix = '') {
    for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
      if (ent.name === 'node_modules') continue;
      if (ent.isSymbolicLink()) throw Error('初始化模板不能包含链接');
      const rel = prefix + ent.name, file = path.join(dir, ent.name);
      if (ent.isDirectory()) collect(file, rel + '/'); else files.set(rel, fs.readFileSync(file));
    }
  }
  collect(path.join(here, 'bootstrap'));
  if (!files.has('package-lock.json')) throw Error('安装包缺少桥接依赖锁文件');
  const plan = {status: apply ? 'initialized' : 'ready', version: RUNTIME_VERSION, target: root, files: files.size, dependenciesInstalled: false, hostRegistered: false};
  if (!apply) return plan;
  fs.mkdirSync(parent, {recursive: true});
  const stage = fs.mkdtempSync(path.join(parent, '.xinji-stage-'));
  try {
    for (const [rel, bytes] of files) { const file = path.join(stage, rel); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes, {flag: 'wx'}); }
    const config = JSON.parse(files.get('config.example.json'));
    config.consoleToken = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(stage, 'config.json'), JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
    const report = inspectClosure(path.join(stage, 'src'));
    if (!report.ok) throw Error('运行时模板不完整：' + JSON.stringify(report));
    const backup = 'bundle-initial-' + crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(path.join(stage, '.runtime-backups', backup), {recursive: true});
    fs.mkdirSync(path.join(stage, 'state'));
    const records = Object.fromEntries(Object.entries(templates).map(([name, source]) => [name, {existed: false, beforeHash: null, afterHash: source === '@retired' ? null : hash(files.get('src/' + name))}]));
    fs.writeFileSync(path.join(stage, 'state/runtime-bundle.json'), JSON.stringify({version: RUNTIME_VERSION, backup, hadReceipt: false, files: records}, null, 2) + '\n');
    fs.writeFileSync(path.join(stage, manifestName), JSON.stringify({version: RUNTIME_VERSION, pluginRoot: path.resolve(pluginRoot), files: Object.fromEntries([...files].map(([rel, bytes]) => [rel, hash(bytes)]))}, null, 2) + '\n');
    // Recheck immediately before rename: never merge into a competing installation.
    if (fs.existsSync(root)) { if (fs.lstatSync(root).isSymbolicLink() || fs.readdirSync(root).length) throw Error('目标在安装期间变为非空'); fs.rmdirSync(root); }
    fs.renameSync(stage, root);
    return plan;
  } finally {
    const relative = path.relative(parent, stage);
    if (relative.startsWith('.xinji-stage-') && !relative.includes(path.sep) && fs.existsSync(stage)) fs.rmSync(stage, {recursive: true, force: true});
  }
}
