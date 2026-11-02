#!/usr/bin/env node
// Adapted from qq-bridge; see ../LICENSE.qq-bridge and SOURCE-PROVENANCE.json.
// Register only in an existing, explicitly selected DSH profile. No DSH process
// is started/stopped here. Every changed file is backed up before the transaction.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import {PRESETS, renderPatch, patchFileFor} from './build-agent-preset-patches.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export function setupDsh({home, profile, pluginRoot, apply = false}) {
  if (!profile || ['.', '..', 'node_modules'].includes(profile) || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile)) throw Error('请明确指定有效的 DSH profile 名称');
  home = path.resolve(home); pluginRoot = path.resolve(pluginRoot);
  const dir = path.join(home, 'profiles', profile), pkgFile = path.join(dir, 'package.json'), patchFile = path.join(dir, 'cordis.patch.yml');
  if (!fs.existsSync(pkgFile)) throw Error('目标 DSH profile 不存在；先确认宿主实际使用的 DSH_HOME 与 profile');
  if (JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).name !== 'dsh-feiyu-memory-console') throw Error('--plugin 必须指向回响插件根目录');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const original = exists(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const operations = yaml.load(original) ?? [];
  if (!Array.isArray(operations)) throw Error('cordis.patch.yml 顶层必须是数组');
  const ids = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];
  const scripts = ['mcp-snowluma-safe.js', 'mcp-host-server.js', 'mcp-web-search-safe.js'];
  const kept = operations.flatMap(op => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw Error('无效 patch 操作');
    if (!Object.hasOwn(op, 'insert')) return [op];
    if (!Array.isArray(op.insert)) throw Error('patch insert 必须是数组');
    const insert = op.insert.filter(row => !ids.includes(row?.id));
    return insert.length || Object.keys(op).length > 1 ? [{...op, insert}] : [];
  });
  const mcps = ids.map((id, i) => ({insert: [{id, name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: ['snowluma', 'snowluma-host', 'web-search-safe'][i], transport: 'stdio', command: process.execPath,
    args: [path.join(ROOT, 'src', scripts[i])], ...(i === 0 ? {toolCallTimeoutMs: 725000} : {})
  }}]}));
  const bundles = {'qq-mode-console': path.join(ROOT, 'plugins/qq-mode-console'), 'qq-agent-presets': path.join(ROOT, 'plugins/qq-agent-presets'), 'dsh-feiyu-memory-console': pluginRoot};
  const links = [];
  for (const [name, target] of Object.entries(bundles)) {
    if (!fs.existsSync(path.join(target, 'package.json'))) throw Error('bundle 缺失：' + name);
    const installed = path.join(home, 'plugins', name);
    for (const [link, destination] of [[installed, target], [path.join(dir, 'node_modules', name), target]]) {
      if (exists(link)) {
        // Existing real directories and links to other installs belong to the user.
        if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link).toLowerCase() !== fs.realpathSync(target).toLowerCase()) throw Error('安装位已被其他内容占用，未覆盖：' + link);
      } else links.push({link, destination});
    }
  }
  pkg.dependencies ??= {}; pkg.dsh ??= {}; pkg.dsh.profile ??= {}; pkg.dsh.profile.bundles ??= [];
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies) || !Array.isArray(pkg.dsh.profile.bundles)) throw Error('profile package.json 字段类型无效');
  for (const [name, target] of Object.entries(bundles)) {
    pkg.dependencies[name] = 'link:' + target.replaceAll('\\', '/');
    if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
  }
  const proposed = new Map([[pkgFile, JSON.stringify(pkg, null, 2) + '\n'], [patchFile, yaml.dump([...kept, ...mcps], {lineWidth: -1, noRefs: true})]]);
  for (const name of PRESETS) proposed.set(patchFileFor(name), renderPatch(name));
  const mode = path.join(ROOT, 'state/mode.json');
  if (!exists(mode)) proposed.set(mode, JSON.stringify({mode: 'reserved2', closedAgentPreset: ''}, null, 2) + '\n');
  const writes = [...proposed].filter(([file, text]) => !exists(file) || fs.readFileSync(file, 'utf8') !== text);
  const result = {status: apply ? 'registered' : 'ready', home, profile, files: writes.length, links: links.length, bundles: Object.keys(bundles), presets: PRESETS, restartRequired: true, hostRuntimeVerified: false};
  if (!apply || (!writes.length && !links.length)) return result;
  const backup = path.join(ROOT, '.setup-backups', Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(backup, {recursive: true});
  const records = writes.map(([file, text], i) => ({file, text, before: exists(file) ? fs.readFileSync(file) : null, backup: path.join(backup, String(i))}));
  for (const record of records) if (record.before !== null) fs.writeFileSync(record.backup, record.before, {flag: 'wx'});
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(records.map(r => ({file: r.file, existed: r.before !== null, backup: r.backup})), null, 2));
  const made = [], changed = [];
  try {
    for (const {link, destination} of links) { fs.mkdirSync(path.dirname(link), {recursive: true}); fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir'); made.push(link); }
    for (const record of records) {
      fs.mkdirSync(path.dirname(record.file), {recursive: true});
      const staged = record.file + '.xinji-stage';
      fs.writeFileSync(staged, record.text, {flag: 'wx'});
      try { fs.renameSync(staged, record.file); changed.push(record); } finally { if (exists(staged)) fs.unlinkSync(staged); }
    }
  } catch (error) {
    for (const record of changed.reverse()) { if (record.before === null) fs.unlinkSync(record.file); else fs.writeFileSync(record.file, record.before); }
    for (const link of made.reverse()) fs.unlinkSync(link);
    throw error;
  }
  return {...result, backup};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), profile = args[0], i = args.indexOf('--plugin');
    const metadata = fs.existsSync(path.join(ROOT, '.xinji-install.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, '.xinji-install.json'), 'utf8')) : {};
    const pluginRoot = i >= 0 ? args[i + 1] : metadata.pluginRoot;
    if (!pluginRoot) throw Error('请用 --plugin 指定回响插件目录');
    console.log(JSON.stringify(setupDsh({home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), profile, pluginRoot, apply: args.includes('--apply')}), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
