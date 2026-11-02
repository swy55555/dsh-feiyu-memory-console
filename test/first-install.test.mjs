import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initializeBridge} from '../bridge/first-install.mjs';
import {inspectClosure} from '../bridge/runtime-inspection.mjs';
import {installRuntime} from '../bridge/install-runtime-bundle.mjs';
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xinji-first-'));
  t.after(() => { const rel = path.relative(os.tmpdir(), parent); if (rel.startsWith('xinji-first-') && !rel.includes(path.sep)) fs.rmSync(parent, {recursive: true, force: true}); });
  return path.join(parent, 'bridge');
}
test('check leaves a nonexistent installation untouched', t => {
  const root = fixture(t); assert.equal(initializeBridge(root).status, 'ready'); assert.equal(fs.existsSync(root), false);
});
test('empty install contains transitive runtime, dependencies and host assets', t => {
  const root = fixture(t); initializeBridge(root, {apply: true});
  assert.equal(inspectClosure(path.join(root, 'src')).ok, true);
  for (const rel of ['package-lock.json', 'scripts/setup-dsh.mjs', 'scripts/build-agent-preset-patches.mjs', 'plugins/qq-agent-presets/memory-no-tools.mjs', 'plugins/qq-mode-console/cordis.patch.yml', 'dsh/agent-presets/qq-memory/agent.cordis.yml', 'LICENSE.qq-bridge']) assert.ok(fs.existsSync(path.join(root, rel)), rel);
  assert.equal(installRuntime(root, 'check').status, 'already-installed');
});
test('first install fails closed and generates a unique management token', t => {
  const a = fixture(t), b = fixture(t); initializeBridge(a, {apply: true}); initializeBridge(b, {apply: true});
  const read = root => JSON.parse(fs.readFileSync(path.join(root, 'config.json'))); const c = read(a);
  assert.equal(c.allowAllWhenEmpty, false); assert.deepEqual(c.allow, {private: [], groups: []});
  assert.equal(c.socialV2.initiative.enabled, false); assert.equal(c.socialV2.initiative.contactSend, false);
  assert.match(c.consoleToken, /^[a-f0-9]{64}$/); assert.notEqual(c.consoleToken, read(b).consoleToken);
});
test('repeating initialization preserves private configuration and state', t => {
  const root = fixture(t); initializeBridge(root, {apply: true});
  const config = path.join(root, 'config.json'), before = fs.readFileSync(config); fs.writeFileSync(path.join(root, 'state/user-fixture.json'), '{"fixture":true}');
  assert.equal(initializeBridge(root, {apply: true}).status, 'already-initialized'); assert.deepEqual(fs.readFileSync(config), before);
  assert.equal(fs.readFileSync(path.join(root, 'state/user-fixture.json'), 'utf8'), '{"fixture":true}');
});
test('existing unknown installation and changed source are never overwritten', t => {
  const root = fixture(t); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'user.txt'), 'keep');
  assert.throws(() => initializeBridge(root, {apply: true}), /非空/); assert.equal(fs.readFileSync(path.join(root, 'user.txt'), 'utf8'), 'keep');
  const other = fixture(t); initializeBridge(other, {apply: true}); const file = path.join(other, 'src/diary.js'); fs.appendFileSync(file, '\n// user change');
  assert.throws(() => initializeBridge(other, {apply: true}), /修改或缺失/); assert.match(fs.readFileSync(file, 'utf8'), /user change$/);
});
test('closure checker detects a missing indirect MCP dependency', t => {
  const root = fixture(t); initializeBridge(root, {apply: true}); fs.unlinkSync(path.join(root, 'src/voice-core.js'));
  const report = inspectClosure(path.join(root, 'src')); assert.equal(report.ok, false); assert.ok(report.missing.includes('voice-core.js'));
});
test('initialization rejects directory links without touching their target', t => {
  const root = fixture(t), target = path.join(path.dirname(root), 'elsewhere'); fs.mkdirSync(target);
  fs.symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => initializeBridge(root, {apply: true}), /真实目录/); assert.deepEqual(fs.readdirSync(target), []);
});
