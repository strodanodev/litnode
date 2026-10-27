/** RO3Emu hosting through the node's own quick tunnel (node/ro3.js): the RO3 URL is advertised once RO3Emu answers
 *  through it, peers list it at /ro3/hosts, a dead server is withdrawn, and a restarted tunnel's new hostname is
 *  what peers list next. cloudflared is replaced by a script that behaves like it.
 *    node --test demo/ro3.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { ro3Entry, ro3Name } from '../node/ro3.js';
import { generateKeypair } from '../protocol/keys.js';
import { createRpcEvm } from './lib/rpc-evm.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'litnode-ro3-'));
// A stand-in cloudflared: a hostname from its port and FAKE_RO3_GEN (bumped by the test before a restart).
const fake = join(tmp, 'fake-cloudflared.mjs');
const gen = join(tmp, 'gen.txt');
writeFileSync(gen, '0');
writeFileSync(fake, `
import { readFileSync } from 'node:fs';
const port = process.argv[process.argv.indexOf('--url') + 1].split(':').pop();
const g = readFileSync(${JSON.stringify(gen)}, 'utf8').trim();
setTimeout(() => process.stderr.write(\`INF |  https://fake-\${port}-g\${g}.trycloudflare.com  |\\n\`), 50);
setInterval(() => {}, 1000);
`);
const bin = [process.execPath, fake];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(50); } return false; };

test('ro3: a heartbeat entry is a bare https origin and a short printable name', () => {
  assert.deepEqual(ro3Entry({ nodeId: 'ab'.repeat(32), ro3: { url: 'https://Fake-1.trycloudflare.com', name: 'Prontera <b>' } }), { url: 'https://fake-1.trycloudflare.com', name: 'Prontera b' });
  assert.equal(ro3Entry({ nodeId: 'x', ro3: { url: 'http://plain.example' } }), null, 'not https');
  assert.equal(ro3Entry({ nodeId: 'x', ro3: { url: 'https://a.example/path' } }), null, 'not a bare origin');
  assert.equal(ro3Entry({ nodeId: 'x', ro3: { url: 'javascript:alert(1)' } }), null);
  assert.equal(ro3Entry({ nodeId: 'x' }), null);
  assert.equal(ro3Entry({ nodeId: 'cd'.repeat(32), operator: 'sedano', ro3: { url: 'https://a.example' } }).name, 'sedano', 'the operator label by default');
  assert.equal(ro3Name('x'.repeat(40)).length, 32);
});

test('ro3: the host advertises its RO3 tunnel once RO3Emu answers; peers list it and follow a new hostname', { timeout: 40_000 }, async (t) => {
  const dead = new Set(); // hostnames Cloudflare dropped: a quick tunnel's name never answers again
  const probed = [];
  const ro3Probe = async (u) => { probed.push(u); if (dead.has(u)) throw new Error('530'); return true; };
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'host', roles: ['mesh'], ro3Port: 5480, ro3Name: 'Prontera', tunnelBin: bin, ro3Probe, updates: false });
  const b = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 200, operator: 'player', roles: ['mesh'], seeds: [a.addr], updates: false });
  t.after(async () => { await a.stop().catch(() => {}); await b.stop().catch(() => {}); });
  const hosts = async (n) => (await (await fetch(`${n.addr}/ro3/hosts`)).json()).hosts;
  const first = 'https://fake-5480-g0.trycloudflare.com';

  assert.ok(await until(async () => (await hosts(b)).some((h) => h.url === first)), 'the player\'s node lists the host');
  const listed = (await hosts(b)).find((h) => h.url === first);
  assert.equal(listed.nodeId, a.nodeId); assert.equal(listed.name, 'Prontera');
  assert.equal((await hosts(a))[0].self, true, 'the host lists itself');
  assert.ok(probed.includes(first), 'checked through the tunnel before it was advertised');
  const health = await (await fetch(`${a.addr}/health`)).json();
  assert.equal(health.tunnel.ro3.state, 'up'); assert.equal(health.tunnel.ro3.port, 5480);

  // The tunnel's name dies: withdrawn (players stop being sent to it), then cloudflared is restarted and the fresh
  // hostname is verified, advertised and listed in its place.
  writeFileSync(gen, '1');
  dead.add(first);
  assert.ok(await until(async () => !(await hosts(b)).some((h) => h.url === first), 15_000), 'a dead name is withdrawn');
  const second = 'https://fake-5480-g1.trycloudflare.com';
  assert.ok(await until(async () => (await hosts(b)).some((h) => h.url === second), 20_000), 'the new hostname reaches the player\'s node');
  assert.ok((await (await fetch(`${a.addr}/health`)).json()).tunnel.ro3.rotations >= 1);
});

test('ro3: a node without RO3_PORT advertises nothing and lists an empty mesh', async (t) => {
  const c = await createNode({ dataDir: join(tmp, 'c'), offline: true, heartbeatMs: 200, operator: 'c', roles: ['mesh'], updates: false });
  t.after(() => c.stop().catch(() => {}));
  assert.deepEqual((await (await fetch(`${c.addr}/ro3/hosts`)).json()).hosts, []);
  assert.equal((await (await fetch(`${c.addr}/health`)).json()).tunnel.ro3, null);
});

test('ro3: with a chain, a player\'s node lists only bonded peers\' servers, with their operator and wallet', { timeout: 120_000 }, async (t) => {
  const chain = await createRpcEvm();
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  t.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); });
  const ONE = 10n ** 18n;
  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const kp = await generateKeypair();
  const dir = join(tmp, 'bonded'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'identity.json'), JSON.stringify(kp));
  await chain.send(1, token, 'faucet', []);
  await chain.send(1, token, 'approve', [stake, 10n * ONE]);
  await chain.bondNode(1, stake, kp, ONE);
  chain.warp(2);

  // Two RO3 servers under the same name (the fake cloudflared names a tunnel by its port): only the first node bonded.
  const ro3Probe = async () => true;
  const host = await createNode({ dataDir: dir, offline: true, heartbeatMs: 200, operator: 'guild', roles: ['mesh'], ro3Port: 5490, ro3Name: 'Prontera', tunnelBin: bin, ro3Probe, updates: false });
  nodes.push(host);
  const rogue = await createNode({ dataDir: join(tmp, 'rogue'), offline: true, heartbeatMs: 200, operator: 'rogue', roles: ['mesh'], ro3Port: 5491, ro3Name: 'Prontera', tunnelBin: bin, ro3Probe, updates: false, seeds: [host.addr] });
  nodes.push(rogue);
  const player = await createNode({ dataDir: join(tmp, 'player'), rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, chainId: 4441, heartbeatMs: 200, operator: 'player', roles: ['mesh'], seeds: [host.addr, rogue.addr], updates: false, announce: false });
  nodes.push(player);
  const hosts = async (n) => (await (await fetch(`${n.addr}/ro3/hosts`)).json()).hosts;
  const good = (h) => h.url.startsWith('https://fake-5490-'), bad = (h) => h.url.startsWith('https://fake-5491-');

  assert.ok(await until(async () => (await hosts(host)).some(bad), 20_000), 'the rogue advertised: a mesh with no chain lists it');
  assert.ok(await until(async () => (await hosts(player)).some(good), 30_000), 'the player\'s node lists the bonded server');
  const listed = (await hosts(player)).find(good);
  assert.equal(listed.nodeId, host.nodeId); assert.equal(listed.name, 'Prontera'); assert.equal(listed.operator, 'guild');
  assert.equal(listed.wallet, chain.addressOf(1).toLowerCase(), 'the staking wallet, so two servers named alike can be told apart');
  // the rogue's heartbeat reaches the player's node too, but a key that staked nothing is never listed
  for (const end = Date.now() + 3000; Date.now() < end; await sleep(100)) assert.ok(!(await hosts(player)).some(bad), 'an unbonded server is not listed');
});
