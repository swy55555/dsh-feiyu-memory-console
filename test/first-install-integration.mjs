// Run against an ISOLATED installation created from the candidate .tgz with npm ci.
// Does not install packages, contact real QQ, or call paid models.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
const target = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(target, '.allow-isolated-release-test'))) throw Error('Explicit isolated target and .allow-isolated-release-test marker required');
const home = path.join(target, 'test-dsh-home'), profileDir = path.join(home, 'profiles/desktop');
fs.mkdirSync(profileDir, {recursive: true});
const metadata = JSON.parse(fs.readFileSync(path.join(target, '.xinji-install.json')));
const require = createRequire(path.join(target, 'package.json'));
const yaml = require('js-yaml');
const {WebSocketServer} = require('ws');
const {setupDsh} = await import(pathToFileURL(path.join(target, 'scripts/setup-dsh.mjs')));
const pkgFile = path.join(profileDir, 'package.json'), patchFile = path.join(profileDir, 'cordis.patch.yml');
fs.writeFileSync(pkgFile, JSON.stringify({name: 'isolated-profile', dependencies: {unrelated: '1.0.0'}, dsh: {profile: {bundles: ['unrelated']}}}));
fs.writeFileSync(patchFile, yaml.dump([{insert: [{id: 'unrelated', name: 'fixture-only', config: {keep: 'preserved'}}]}]));
const before = fs.readFileSync(pkgFile);
assert.equal(setupDsh({home, profile: 'desktop', pluginRoot: metadata.pluginRoot}).status, 'ready');
assert.deepEqual(fs.readFileSync(pkgFile), before);
const first = setupDsh({home, profile: 'desktop', pluginRoot: metadata.pluginRoot, apply: true});
assert.equal(first.bundles.length, 3); assert.equal(first.presets.length, 3);
const pkg = JSON.parse(fs.readFileSync(pkgFile)); assert.equal(pkg.dependencies.unrelated, '1.0.0');
const rows = yaml.load(fs.readFileSync(patchFile, 'utf8')).flatMap(op => op.insert || []);
assert.equal(rows.length, 4); assert.equal(rows[0].config.keep, 'preserved');
assert.equal(setupDsh({home, profile: 'desktop', pluginRoot: metadata.pluginRoot, apply: true}).files, 0);
assert.deepEqual(fs.readFileSync(path.join(first.backup, '0')), before);
for (const p of first.presets) assert.ok(fs.existsSync(path.join(target, 'plugins/qq-agent-presets/presets', p + '.patch.yml')));
// Malformed YAML must fail before changing package.json or links.
const correctPatch = fs.readFileSync(patchFile), correctPackage = fs.readFileSync(pkgFile);
fs.writeFileSync(patchFile, 'invalid: [');
assert.throws(() => setupDsh({home, profile: 'desktop', pluginRoot: metadata.pluginRoot, apply: true}));
assert.deepEqual(fs.readFileSync(pkgFile), correctPackage); fs.writeFileSync(patchFile, correctPatch);
console.log('PASS profile check/apply/idempotence, three bundles/presets, preservation, backups, malformed YAML');
const conflictHome = path.join(target, 'test-conflict-home'), conflictProfile = path.join(conflictHome, 'profiles/desktop');
fs.mkdirSync(conflictProfile, {recursive: true});
const conflictPkg = path.join(conflictProfile, 'package.json'); fs.writeFileSync(conflictPkg, '{"name":"isolated-conflict"}');
const occupied = path.join(conflictHome, 'plugins/qq-mode-console'); fs.mkdirSync(occupied, {recursive: true});
assert.throws(() => setupDsh({home: conflictHome, profile: 'desktop', pluginRoot: metadata.pluginRoot, apply: true}), /占用/);
assert.equal(fs.readFileSync(conflictPkg, 'utf8'), '{"name":"isolated-conflict"}'); fs.rmdirSync(occupied);
// An existing stage file forces a write failure after links were created.
fs.writeFileSync(conflictPkg + '.xinji-stage', 'preexisting-fixture');
assert.throws(() => setupDsh({home: conflictHome, profile: 'desktop', pluginRoot: metadata.pluginRoot, apply: true}), /EEXIST/);
assert.equal(fs.existsSync(occupied), false); assert.equal(fs.existsSync(path.join(conflictProfile, 'node_modules/qq-mode-console')), false);
assert.equal(fs.readFileSync(conflictPkg, 'utf8'), '{"name":"isolated-conflict"}');
assert.equal(fs.readFileSync(conflictPkg + '.xinji-stage', 'utf8'), 'preexisting-fixture');
console.log('PASS registration refuses occupied directories and rolls back links after a write failure');
const requests = [], sockets = new Set();
const mock = http.createServer((req, res) => { requests.push(req.url); res.writeHead(503, {'content-type': 'application/json'}); res.end('{"error":"isolated external service unavailable"}'); });
const wss = new WebSocketServer({server: mock});
wss.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('message', bytes => { const r = JSON.parse(bytes); if (r.echo) socket.send(JSON.stringify({status: 'ok', retcode: 0, data: {}, echo: r.echo})); }); });
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
const configPath = path.join(target, 'config.json'), configBytes = fs.readFileSync(configPath), config = JSON.parse(configBytes);
config.consolePort = port; config.dsh.baseUrl = 'http://127.0.0.1:' + mockPort; config.dsh.authToken = 'isolated-test-token-not-a-real-credential';
config.snowluma = {httpUrl: 'http://127.0.0.1:' + mockPort, wsUrl: 'ws://127.0.0.1:' + mockPort, accessToken: '', homeDir: path.join(home, 'no-snowluma'), followDiscoveredEndpoint: false};
config.socialV2.sticker = {enabled: false}; config.socialV2.tools = {extra: false};
fs.writeFileSync(configPath, JSON.stringify(config));
const env = {...process.env, DSH_HOME: home, FEIYU_BRIDGE_DIR: target, FEIYU_MEMVEC_URL: 'http://127.0.0.1:' + mockPort, FEIYU_MEMVEC_DB: path.join(home, 'memories.db'), MEMVEC_DB_PATH: path.join(home, 'memories.db'), MEMVEC_API_TOKEN: 'isolated-memvec-token-for-tests-only', SNOWLUMA_HOME: path.join(home, 'no-snowluma')};
delete env.NODE_PATH; delete env.NODE_OPTIONS; delete env.DSH_LAUNCH_TOKEN;
const check = spawnSync(process.execPath, ['src/bridge.js', '--check', '--dependencies'], {cwd: target, env, encoding: 'utf8', windowsHide: true, timeout: 20000});
assert.equal(check.status, 0, check.stdout + check.stderr);
const child = spawn(process.execPath, ['src/bridge.js'], {cwd: target, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
const clients = [];
try {
  const base = 'http://127.0.0.1:' + port; let started = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error('Bridge exited: ' + output.slice(-5000));
    try { const r = await fetch(base + '/api/status', {signal: AbortSignal.timeout(250)}); if (r.status === 401 || r.status === 403) { started = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(started, output.slice(-5000));
  const status = await fetch(base + '/api/status', {headers: {'x-console-token': config.consoleToken}}); assert.equal(status.status, 200);
  assert.equal((await fetch(base + '/api/status', {headers: {'x-console-token': 'invalid'}})).status, 401);
  console.log('PASS real bridge startup, protected control API, invalid token denied; external DSH intentionally unavailable');
  const {Client} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const {StdioClientTransport} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  const counts = {};
  for (const script of ['mcp-snowluma-safe.js', 'mcp-host-server.js', 'mcp-web-search-safe.js']) {
    const client = new Client({name: 'isolated-release-test', version: '1.0.0'});
    const transport = new StdioClientTransport({command: process.execPath, args: [path.join(target, 'src', script)], cwd: target, env, stderr: 'pipe'});
    clients.push(client); await client.connect(transport); const list = await client.listTools(); counts[script] = list.tools.length; assert.ok(list.tools.length > 0);
    if (script === 'mcp-snowluma-safe.js') {
      assert.ok(list.tools.some(t => t.name === 'qq_send_message'));
      const result = await client.callTool({name: 'qq_send_message', arguments: {key: 'private:12345', token: 'invalid-session-token', messages: 'synthetic-test-not-to-be-sent'}});
      assert.equal(result.isError, true); assert.match(JSON.stringify(result), /401|403|权限|token|令牌|鉴权|Unauthorized/i);
    }
    if (script === 'mcp-web-search-safe.js') {
      const result = await client.callTool({name: 'web_fetch', arguments: {url: 'http://127.0.0.1:' + mockPort + '/private'}});
      assert.equal(result.isError, true);
    }
    await client.close();
  }
  assert.ok(!requests.some(url => /send_msg|send_private_msg|send_group_msg|session\/prompt|\/private$/.test(url)));
  console.log(JSON.stringify({ok: true, mcpToolCounts: counts, deniedUnauthorizedSend: true, deniedPrivateWebFetch: true, realQQ: false, paidModel: false}));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  child.kill(); await new Promise(r => { if (child.exitCode !== null) r(); else child.once('exit', r); });
  for (const socket of sockets) socket.terminate(); await new Promise(r => wss.close(r)); mock.closeAllConnections(); await new Promise(r => mock.close(r));
  fs.writeFileSync(configPath, configBytes);
}
