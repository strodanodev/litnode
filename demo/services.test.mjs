/** Publisher services (node/publisher-services.js): a title's long-lived backend run by the node
 *  and published on the gateway at /svc/<prefix>.<name>. HTTP and WebSocket are proxied with the
 *  prefix stripped; services find each other (${local:x}) and their public address (${public:x});
 *  secrets come from env files and operator keys never reach a service; a crashed service comes
 *  back; a service that hands out its public address is restarted when that address changes; the
 *  heartbeat and /health say what the node runs.
 *    node --test demo/services.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { loadServiceBundles, createServices } from '../node/publisher-services.js';

const ROOT = process.cwd();
const FAKE = join(ROOT, 'demo', 'fixtures', 'fake-service.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await pred()) return true; } catch { /* not yet */ } await sleep(100); } return false; };

const bundleFile = (dir) => {
  writeFileSync(join(dir, 'secrets.env'), 'SECRET_FROM_FILE="from the file"\n# a comment\nOPERATOR_KEY=0xnope\n');
  const b = { prefix: 'demo-game', cwd: ROOT, envFiles: [join(dir, 'secrets.env')], portRange: [8840, 8869], services: {
    api: { command: '${node}', args: [FAKE], env: { PORT: '${port}', PEER_URL: '${local:mm}' } },
    mm: { command: '${node}', args: [FAKE], env: { PORT: '${port}', PUBLIC_URL: '${public:api}' } },
  } };
  const f = join(dir, 'bundle.json');
  writeFileSync(f, JSON.stringify(b));
  return f;
};

test('services: bundles validate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litsvc-'));
  try {
    const [b] = loadServiceBundles(bundleFile(dir), { root: dir });
    assert.equal(b.prefix, 'demo-game'); assert.deepEqual(Object.keys(b.services), ['api', 'mm']);
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ prefix: 'Bad Name', services: { a: { command: 'x' } } }));
    assert.throws(() => loadServiceBundles(join(dir, 'bad.json')), /prefix/);
    assert.throws(() => loadServiceBundles(join(dir, 'missing.json')), /not found/);
    assert.deepEqual(loadServiceBundles(''), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('services: the node runs them, publishes them at /svc/<name>, proxies HTTP and WebSocket, passes secrets but not operator keys, and says so in its heartbeat', { timeout: 90_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'litsvc-'));
  const node = await createNode({ dataDir: join(dir, 'n'), offline: true, heartbeatMs: 200, operator: 's', roles: ['mesh'], services: loadServiceBundles(bundleFile(dir)), gauntletPort: 0 });
  t.after(async () => { await node.stop(); rmSync(dir, { recursive: true, force: true }); });
  const gw = `http://127.0.0.1:${node.gauntlet.port}`;
  assert.ok(await until(async () => (await (await fetch(`${gw}/svc`)).json()).services.every((s) => s.state === 'up')), 'both services up');
  assert.deepEqual((await (await fetch(`${gw}/svc`)).json()).services.map((s) => s.name), ['demo-game.api', 'demo-game.mm']);

  const r = await (await fetch(`${gw}/svc/demo-game.api/api/session?x=1`, { method: 'POST', body: 'hello' })).json();
  assert.equal(r.path, '/api/session', 'the /svc/<name> prefix is stripped'); assert.equal(r.search, '?x=1'); assert.equal(r.method, 'POST'); assert.equal(r.body, 'hello');
  assert.equal(r.name, 'demo-game.api'); assert.equal(r.secret, 'from the file', 'env files reach the service');
  assert.equal(r.operatorKey, null, 'an operator key in an env file never reaches a service');
  const mmPort = node.gauntlet.status().services.find((s) => s.name === 'demo-game.mm').port;
  assert.equal(r.peer, `http://127.0.0.1:${mmPort}`, 'local:mm is the other service on loopback');
  const mm = await (await fetch(`${gw}/svc/demo-game.mm/`)).json();
  assert.equal(mm.pub, `ws://127.0.0.1:${node.gauntlet.port}/svc/demo-game.api`, 'no tunnel: public:api is the gateway itself');
  assert.equal((await fetch(`${gw}/svc/demo-game.nope/x`)).status, 404);

  const echoed = await new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${node.gauntlet.port}/svc/demo-game.api/socket?room=1`); ws.onopen = () => ws.send('ping'); ws.onmessage = (e) => { res(String(e.data)); ws.close(); }; ws.onerror = () => rej(new Error('ws failed')); });
  assert.equal(echoed, 'svc:/socket?room=1:ping', 'WebSocket proxied with the prefix stripped');

  const h = await (await fetch(`${node.addr}/health`)).json();
  assert.deepEqual(h.gauntlet.services.map((s) => s.name), ['demo-game.api', 'demo-game.mm']);
  const snap = await (await fetch(`${node.addr}/snapshot?envelopes=1`)).json();
  assert.deepEqual(snap.envelopes.find((e) => e.body.nodeId === node.nodeId).body.services, ['demo-game.api', 'demo-game.mm']);

  const pid0 = r.pid;
  await fetch(`${gw}/svc/demo-game.api/crash`);
  assert.ok(await until(async () => { const x = await (await fetch(`${gw}/svc/demo-game.api/`)).json(); return x.pid && x.pid !== pid0; }, 30_000), 'restarted after a crash');
});

test('services: a service that hands out its public address is restarted when it changes; others are left alone', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'litsvc-'));
  let pub = null;
  const svc = createServices({ bundles: loadServiceBundles(bundleFile(dir)), nodeUrl: 'http://127.0.0.1:1', publicBase: () => pub, watchMs: 100 });
  await svc.start({ gatewayPort: 1 });
  t.after(async () => { await svc.stop(); rmSync(dir, { recursive: true, force: true }); });
  const pids = () => Object.fromEntries(svc.status().map((s) => [s.name, s.pid]));
  const before = pids();
  pub = 'wss://moved.example';
  assert.ok(await until(() => { const p = pids(); return svc.status().every((s) => s.state === 'up') && p['demo-game.mm'] && p['demo-game.mm'] !== before['demo-game.mm']; }, 30_000), 'mm (which names public:api) restarted');
  assert.equal(pids()['demo-game.api'], before['demo-game.api'], 'api (which does not) kept running');
  const mm = await (await fetch(`http://127.0.0.1:${svc.all.get('demo-game.mm').port}/`)).json();
  assert.equal(mm.pub, 'wss://moved.example/svc/demo-game.api');
});
