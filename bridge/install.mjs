import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const patches = JSON.parse(fs.readFileSync(path.join(here, 'patches.json'), 'utf8'));
const previousPatches = JSON.parse(fs.readFileSync(path.join(here, 'previous-patches.json'), 'utf8'));

export function patchSource(input) {
  const newline = input.includes('\r\n') ? '\r\n' : '\n';
  let source = input.replaceAll('\r\n', '\n');
  for (const p of patches) {
    const previous = previousPatches.find(old => old.name === p.name)?.after;
    // A restored function header is a prefix of its formerly disabled version.
    // Match the longest known form first so restoration removes the guard.
    const forms = [...new Set([p.after, previous, p.before].filter(Boolean))].sort((a, b) => b.length - a.length);
    const matched = forms.find(form => source.split(form).length === 2);
    if (!matched) {
      // 函数被别的版本改写过：按函数头 + 结尾标记整体替换，仍要求两处都唯一。
      if (p.fallback && typeof p.fallback.header === 'string' && typeof p.fallback.marker === 'string') {
        const start = source.indexOf(p.fallback.header);
        const end = start >= 0 ? source.indexOf(p.fallback.marker, start) : -1;
        if (start >= 0 && end > start && source.indexOf(p.fallback.header, start + 1) < 0) {
          source = source.slice(0, start) + p.after.replace(/\n+$/, '') + '\n\n' + source.slice(end);
          continue;
        }
      }
      // 可选补丁（双写等新增钩子）在旧版本桥上找不到锚点时跳过，不影响核心补丁安装。
      if (p.optional === true) continue;
      throw Error(`补丁不匹配或有歧义：${p.name}；未写入，请人工适配此桥接版本。`);
    }
    source = source.replace(matched, p.after);
  }
  return source.replaceAll('\n', newline);
}

export function install(target, mode = 'check') {
  if (!['check', 'apply', 'undo'].includes(mode)) throw Error('invalid mode');
  const root = path.resolve(target), sourcePath = path.join(root, 'src', 'bridge.js');
  const modulePath = path.join(root, 'src', 'human-context.mjs');
  const receiptPath = path.join(root, 'human-context-install.json');
  const original = fs.readFileSync(sourcePath);
  const moduleBytes = fs.readFileSync(path.join(here, 'human-context.mjs'));
  const oldModule = fs.existsSync(modulePath) ? fs.readFileSync(modulePath) : null;
  const oldReceipt = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : null;
  const backupFile = name => {
    if (typeof name !== 'string' || path.basename(name) !== name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw Error('invalid backup name');
    return path.join(root, '.human-context-backups', name);
  };
  if (mode === 'undo') {
    const receipt = JSON.parse(oldReceipt);
    const backupPath = backupFile(receipt.backupName);
    const backup = fs.readFileSync(backupPath);
    if (hash(original) !== receipt.after || hash(backup) !== receipt.before || hash(fs.readFileSync(modulePath)) !== receipt.moduleHash) throw Error('安装后文件有变化，自动回退已拒绝，防止覆盖后续修改。');
    const moduleBackup = receipt.moduleBackupName ? fs.readFileSync(backupFile(receipt.moduleBackupName)) : null;
    const receiptBackup = receipt.receiptBackupName ? fs.readFileSync(backupFile(receipt.receiptBackupName)) : null;
    if ((moduleBackup && hash(moduleBackup) !== receipt.beforeModuleHash) || (receiptBackup && hash(receiptBackup) !== receipt.beforeReceiptHash)) throw Error('备份校验失败，未回退。');
    try {
      if (moduleBackup) fs.writeFileSync(modulePath, moduleBackup);
      fs.writeFileSync(sourcePath, backup);
      if (receiptBackup) fs.writeFileSync(receiptPath, receiptBackup);
    } catch (error) {
      fs.writeFileSync(sourcePath, original);
      if (oldModule) fs.writeFileSync(modulePath, oldModule);
      if (oldReceipt) fs.writeFileSync(receiptPath, oldReceipt);
      throw error;
    }
    // First-install undo may leave an unused module; never delete data recursively.
    return { status: 'restored', backupPath };
  }
  const next = patchSource(original.toString('utf8'));
  if (oldModule && hash(oldModule) !== hash(moduleBytes)) {
    const prior = oldReceipt ? JSON.parse(oldReceipt) : null;
    if (!prior || prior.after !== hash(original) || prior.moduleHash !== hash(oldModule)) throw Error('目标代码不符合已有安装回执，未覆盖。');
  }
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: next, encoding: 'utf8', windowsHide: true });
  if (syntax.status !== 0) throw Error(`桥接语法检查失败：${syntax.stderr}`);
  const already = hash(original) === hash(next) && oldModule && hash(oldModule) === hash(moduleBytes);
  if (mode === 'check' || already) return { status: already ? 'already-installed' : 'compatible', mode, before: hash(original), after: hash(next) };
  // No config, database, process, network or QQ actions are touched.
  const backupDir = path.join(root, '.human-context-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupName = `bridge-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.js`;
  fs.writeFileSync(path.join(backupDir, backupName), original, { flag: 'wx' });
  const receipt = { version: '0.7.2', backupName, before: hash(original), after: hash(next), moduleHash: hash(moduleBytes) };
  if (oldModule) {
    receipt.moduleBackupName = backupName + '.mjs'; receipt.beforeModuleHash = hash(oldModule);
    fs.writeFileSync(backupFile(receipt.moduleBackupName), oldModule, { flag: 'wx' });
  }
  if (oldReceipt) {
    receipt.receiptBackupName = backupName + '.json'; receipt.beforeReceiptHash = hash(oldReceipt);
    fs.writeFileSync(backupFile(receipt.receiptBackupName), oldReceipt, { flag: 'wx' });
  }
  // Put the dependency first. Roll back source on any failed write.
  try {
    fs.writeFileSync(modulePath, moduleBytes);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    fs.writeFileSync(sourcePath, next);
    if (hash(fs.readFileSync(sourcePath)) !== receipt.after) throw Error('写入校验失败');
  } catch (error) {
    fs.writeFileSync(sourcePath, original);
    if (oldModule) fs.writeFileSync(modulePath, oldModule);
    if (oldReceipt) fs.writeFileSync(receiptPath, oldReceipt);
    throw error;
  }
  return { status: 'installed', ...receipt, backupPath: path.join(backupDir, backupName), restartRequired: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const targetIndex = args.indexOf('--target');
    if (targetIndex < 0 || !args[targetIndex + 1]) throw Error('用法：node bridge/install.mjs --target <QQ桥接目录> [--check|--apply|--undo]');
    const modes = args.filter(a => ['--check', '--apply', '--undo'].includes(a));
    if (modes.length > 1) throw Error('只能选择一个操作');
    console.log(JSON.stringify(install(args[targetIndex + 1], modes[0]?.slice(2) || 'check'), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
