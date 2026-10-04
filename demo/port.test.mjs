/** One node per data directory, and a diagnosis when the port is taken
 *  (node/port.js), plus the /update guard behind a tunnel.
 *
 *    node --test demo/port.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { checkInstance, describePortHolder, pidAlive } from '../node/port.js';

const tmp = mkdtempSync(join(tmpdir(), 'litnode-port-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const pidFileWith = (name, pid) => { const f = join(tmp, name); writeFileSync(f, `${pid}\n`); return f; };
const ME = 'a'.repeat(64);
const noSleep = () => Promise.resolve();

test('instance: no pid file, a dead PID or our own PID → free', async () => {
  assert.equal((await checkInstance({ pidFile: join(tmp, 'none.pid'), port: 1 })).state, 'free');
  assert.equal((await checkInstance({ pidFile: pidFileWith('dead.pid', 4242), port: 1, deps: { alive: () => false } })).state, 'free');
  assert.equal((await checkInstance({ pidFile: pidFileWith('self.pid', process.pid), port: 1 })).state, 'free');
  assert.equal(pidAlive(process.pid), true);
});

test('instance: a live node.exe answering /health as this identity → running', async () => {
  const r = await checkInstance({ pidFile: pidFileWith('run.pid', 4242), port: 7801, nodeId: ME,
    deps: { alive: () => true, name: async () => 'node.exe', health: async () => ({ nodeId: ME, operator: 'x' }), sleep: noSleep } });
  assert.equal(r.state, 'running'); assert.equal(r.pid, 4242);
});

test('instance: a node still loading at boot is waited for, not raced', async () => {
  let calls = 0;
  const r = await checkInstance({ pidFile: pidFileWith('boot.pid', 4242), port: 7801, nodeId: ME, stepMs: 1,
    deps: { alive: () => true, name: async () => 'node.exe', health: async () => (++calls < 4 ? null : { nodeId: ME }), sleep: noSleep } });
  assert.equal(r.state, 'running'); assert.equal(calls, 4, 'kept asking until the loading node answered');
});

test('instance: a PID reused by another program, or a node that never answers → not ours', async () => {
  const reused = await checkInstance({ pidFile: pidFileWith('reused.pid', 4242), port: 7801, nodeId: ME,
    deps: { alive: () => true, name: async () => 'chrome.exe', health: async () => { throw new Error('must not wait on a foreign PID'); } } });
  assert.equal(reused.state, 'stale');
  const silent = await checkInstance({ pidFile: pidFileWith('silent.pid', 4242), port: 7801, nodeId: ME, waitMs: 5, stepMs: 1,
    deps: { alive: () => true, name: async () => 'node.exe', health: async () => null, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } });
  assert.equal(silent.state, 'stale');
  const other = await checkInstance({ pidFile: pidFileWith('other.pid', 4242), port: 7801, nodeId: ME, waitMs: 5, stepMs: 1,
    deps: { alive: () => true, name: async () => 'node.exe', health: async () => ({ nodeId: 'b'.repeat(64) }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } });
  assert.equal(other.state, 'stale', 'another identity on the port is a port clash, not this node');
});

test('port holder: names this node, another litnode, or another program, and the boot task', async () => {
  const base = { pidOf: async () => 912, name: async () => 'node.exe', path: async () => 'C:\\old\\runtime\\node.exe', tasks: async () => [] };
  const self = await describePortHolder(7801, { nodeId: ME, deps: { ...base, health: async () => ({ nodeId: ME }) } });
  assert.equal(self.kind, 'self'); assert.match(self.text, /already running/);
  const peer = await describePortHolder(7801, { nodeId: ME, deps: { ...base, health: async () => ({ nodeId: 'b'.repeat(64), operator: 'old-build', version: '0.6.4' }), tasks: async () => ['litnode', 'litnode-relay'] } });
  assert.equal(peer.kind, 'litnode');
  assert.match(peer.text, /operator old-build, version 0\.6\.4, PID 912/);
  assert.match(peer.text, /C:\\old\\runtime\\node\.exe/);
  assert.match(peer.text, /litnode, litnode-relay start a node at boot/);
  const app = await describePortHolder(7801, { deps: { ...base, health: async () => null, name: async () => 'SomeApp.exe', path: async () => null } });
  assert.equal(app.kind, 'other'); assert.match(app.text, /PID 912 \(SomeApp\.exe\), which is not a litnode/);
});

test('port holder: the real OS lookup finds who listens on a port', { timeout: 30_000 }, async () => {
  const srv = createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const who = await describePortHolder(port, { deps: { tasks: async () => [] } });
    assert.equal(who.kind, 'other');
    assert.equal(who.pid, process.pid, 'the listener is this test process');
  } finally { srv.close(); }
});

test('createNode: a taken port rejects with EADDRINUSE and the port, instead of crashing', { timeout: 30_000 }, async () => {
  const srv = createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    await assert.rejects(createNode({ dataDir: join(tmp, 'busy'), port, offline: true, heartbeatMs: 200, operator: 'busy', roles: ['mesh'], updates: false }),
      (e) => e.code === 'EADDRINUSE' && e.port === port);
  } finally { srv.close(); }
});

test('/update: a loopback caller relayed by a tunnel (forwarding headers) is refused', { timeout: 30_000 }, async (t) => {
  const node = await createNode({ dataDir: join(tmp, 'upd'), offline: true, heartbeatMs: 200, operator: 'u', roles: ['mesh'], updates: false, onRestart: () => {} });
  t.after(() => node.stop().catch(() => {}));
  const post = (headers) => new Promise((resolve, reject) => {
    const u = new URL(`${node.addr}/update`);
    const req = request({ host: '127.0.0.1', port: u.port, path: '/update', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(await post({ 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'abc-SIN' }), 403, 'cloudflared connects from 127.0.0.1 but is not this machine');
  assert.equal(await post({ 'x-forwarded-for': '203.0.113.9' }), 403);
  assert.notEqual(await post({}), 403, 'a plain local caller still reaches the updater');
});
