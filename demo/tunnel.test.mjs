/** The node owns its tunnel (node/tunnel.js): the public URL lands in the
 *  heartbeat, a relay tunnel becomes wsAddr, a dropped tunnel falls back to
 *  the LAN address and the restarted one is picked up again. cloudflared is
 *  replaced by a script that behaves like it.
 *    node --test demo/tunnel.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTunnel } from '../node/tunnel.js';
import { createNode } from '../node/litnode.js';

const tmp = mkdtempSync(join(tmpdir(), 'litnode-tunnel-'));
// A stand-in cloudflared: announces a hostname derived from its port on stderr
// (the way the real one does), then lives until killed. FAKE_DIE=ms makes it
// exit once, so the restart path runs.
const fake = join(tmp, 'fake-cloudflared.mjs');
writeFileSync(fake, `
const port = process.argv[process.argv.indexOf('--url') + 1].split(':').pop();
const gen = Number(process.env.FAKE_GEN ?? 0);
setTimeout(() => process.stderr.write(\`INF |  https://fake-\${port}-g\${gen}.trycloudflare.com  |\\n\`), 50);
if (process.env.FAKE_DIE) setTimeout(() => process.exit(1), Number(process.env.FAKE_DIE));
setInterval(() => {}, 1000);
`);
const bin = [process.execPath, fake];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(50); } return false; };

test('tunnel: quick tunnel announces, restarts after a crash with a new hostname', async () => {
  const seen = [];
  process.env.FAKE_DIE = '400';
  const t = createTunnel({ port: 7801, bin, onUrl: (u) => seen.push(u) });
  assert.ok(await until(() => seen.length >= 1), 'first hostname');
  assert.equal(seen[0], 'https://fake-7801-g0.trycloudflare.com');
  assert.ok(await until(() => seen.length >= 2), 'drop reported');
  assert.equal(seen[1], null);
  delete process.env.FAKE_DIE;
  process.env.FAKE_GEN = '1';
  assert.ok(await until(() => seen.length >= 3, 10_000), 'restarted');
  assert.equal(seen[2], 'https://fake-7801-g1.trycloudflare.com', 'a quick tunnel comes back with a new name');
  assert.equal(t.status().restarts, 1);
  t.stop();
  delete process.env.FAKE_GEN;
  assert.throws(() => createTunnel({ port: 1, name: 'x' }), /TUNNEL_HOST/);
});

test('tunnel: the node advertises the tunnel URL and the relay as wsAddr; peers learn both by gossip', { timeout: 30_000 }, async (t) => {
  // the relay behind the tunnel: a WebSocket must open through the public hostname before it is advertised
  let relayAlive = true;
  const relayProbe = async () => { if (!relayAlive) throw new Error('refused'); return 7; };
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'seed', roles: ['mesh', 'host'], tunnel: 'quick', relayPort: 8477, tunnelBin: bin, tunnelProbe: async () => true, relayProbe, updates: false });
  const b = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 200, operator: 'peer', roles: ['mesh', 'witness'], seeds: [a.addr], updates: false });
  t.after(async () => { await a.stop().catch(() => {}); await b.stop().catch(() => {}); }); // tmp (and the fake) outlive this test
  const health = async () => (await fetch(`${a.addr}/health`)).json();
  assert.ok(await until(async () => { const h = await health(); return h.tunnel.node.state === 'up' && h.tunnel.relay?.state === 'up'; }), 'node and relay tunnels up');
  const h = await health();
  assert.equal(h.addr, `https://fake-${a.port}-g0.trycloudflare.com`, 'the advertised address IS the tunnel');
  assert.equal(h.lanAddr, a.addr);
  assert.ok(await until(async () => (await health()).relay?.state === 'up'), 'the relay answered a WebSocket through the tunnel');
  const h2 = await health();
  assert.equal(h2.wsAddr, 'wss://fake-8477-g0.trycloudflare.com', 'the relay tunnel is advertised as wsAddr once verified');
  assert.equal(h2.relay.ms, 7); assert.equal(h2.relay.port, 8477);
  // peer b sees both through gossip (b reached a on its LAN address; what a advertises is the tunnel)
  assert.ok(await until(async () => { const s = await (await fetch(`${b.addr}/snapshot`)).json(); const p = s.peers.find((x) => x.nodeId === a.nodeId); return p?.addr === h.addr && p?.wsAddr === h2.wsAddr; }), 'peer learned tunnel + relay from the heartbeat');
  // the relay process dies: the hostname still resolves, nothing answers — wsAddr is withdrawn from the heartbeat
  // (and the directory) rather than pointing every client at "server offline"
  relayAlive = false;
  assert.ok(await until(async () => { const x = await health(); return x.relay.state === 'down' && x.wsAddr === null; }, 15_000), 'a dead relay is withdrawn');
  assert.ok(await until(async () => { const s = await (await fetch(`${b.addr}/snapshot`)).json(); const p = s.peers.find((x) => x.nodeId === a.nodeId); return p && !p.wsAddr; }), 'peers stop hearing a relay');
  relayAlive = true;
  assert.ok(await until(async () => { const x = await health(); return x.relay.state === 'up' && x.wsAddr === h2.wsAddr; }, 15_000), 'and it comes back when the relay does');
  // the named mode is refused without a hostname, and an explicit WS_ADDR wins over a relay tunnel
  await assert.rejects(createNode({ dataDir: join(tmp, 'c'), offline: true, operator: 'c', tunnel: 'named', tunnelName: 'x', tunnelBin: bin, tunnelProbe: async () => true, updates: false }), /TUNNEL_HOST/);
  const d = await createNode({ dataDir: join(tmp, 'd'), offline: true, heartbeatMs: 200, operator: 'd', roles: ['mesh'], wsAddr: 'wss://explicit.example', relayPort: 8477, tunnelBin: bin, tunnelProbe: async () => true, relayProbe, updates: false });
  t.after(() => d.stop().catch(() => {}));
  assert.equal((await (await fetch(`${d.addr}/health`)).json()).wsAddr, 'wss://explicit.example');
  assert.equal(d.tunnels.relay, null);
});

test('tunnel: a new hostname is advertised only once reachable from outside, and rotated when it never is', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-tunnel-verify-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // reachable on the third probe: advertised then, not before
  let asked = 0;
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'a', roles: ['mesh'], tunnel: 'quick', tunnelBin: bin, tunnelProbe: async () => ++asked >= 3, updates: false });
  t.after(() => a.stop());
  await new Promise((r) => setTimeout(r, 150));
  assert.match((await (await fetch(`${a.addr}/health`)).json()).addr, /^http:\/\/127\.0\.0\.1/, 'a fresh, unverified name is NOT the advertised address');
  const advertised = await (async () => { const end = Date.now() + 10_000; while (Date.now() < end) { const h = await (await fetch(`${a.addr}/health`)).json(); if (h.addr.startsWith('https://')) return h.addr; await new Promise((r) => setTimeout(r, 100)); } return null; })();
  assert.equal(advertised, `https://fake-${a.port}-g0.trycloudflare.com`, 'advertised once the probe answered');
  assert.ok(asked >= 3);
  // never reachable: the name is rotated (cloudflared restarted → generation 1), and the LAN address stays advertised meanwhile
  const b = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 200, operator: 'b', roles: ['mesh'], tunnel: 'quick', tunnelBin: bin, tunnelProbe: async () => false, updates: false });
  t.after(() => b.stop());
  const rotated = await (async () => { const end = Date.now() + 15_000; while (Date.now() < end) { if (b.tunnels.node?.status().restarts >= 1) return true; await new Promise((r) => setTimeout(r, 200)); } return false; })();
  assert.ok(rotated, 'a hostname that never became reachable was rotated');
  assert.match((await (await fetch(`${b.addr}/health`)).json()).addr, /^http:\/\/127\.0\.0\.1/, 'never advertised');
});

test('cleanup', () => { rmSync(tmp, { recursive: true, force: true }); });
