/** The node owns its tunnel (node/tunnel.js): the public URL lands in the
 *  heartbeat, a relay tunnel becomes wsAddr, a dropped tunnel falls back to
 *  the LAN address and the restarted one is picked up again. cloudflared is
 *  replaced by a script that behaves like it.
 *    node --test demo/tunnel.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'seed', roles: ['mesh', 'host'], tunnel: 'quick', relayPort: 8477, tunnelBin: bin, updates: false });
  const b = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 200, operator: 'peer', roles: ['mesh', 'witness'], seeds: [a.addr], updates: false });
  t.after(async () => { await a.stop().catch(() => {}); await b.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const health = async () => (await fetch(`${a.addr}/health`)).json();
  assert.ok(await until(async () => { const h = await health(); return h.tunnel.node.state === 'up' && h.tunnel.relay?.state === 'up'; }), 'node and relay tunnels up');
  const h = await health();
  assert.equal(h.addr, `https://fake-${a.port}-g0.trycloudflare.com`, 'the advertised address IS the tunnel');
  assert.equal(h.lanAddr, a.addr);
  assert.equal(h.wsAddr, 'wss://fake-8477-g0.trycloudflare.com', 'the relay tunnel is advertised as wsAddr');
  // peer b sees both through gossip (b reached a on its LAN address; what a advertises is the tunnel)
  assert.ok(await until(async () => { const s = await (await fetch(`${b.addr}/snapshot`)).json(); const p = s.peers.find((x) => x.nodeId === a.nodeId); return p?.addr === h.addr && p?.wsAddr === h.wsAddr; }), 'peer learned tunnel + relay from the heartbeat');
  // the named mode is refused without a hostname, and an explicit WS_ADDR wins over a relay tunnel
  await assert.rejects(createNode({ dataDir: join(tmp, 'c'), offline: true, operator: 'c', tunnel: 'named', tunnelName: 'x', tunnelBin: bin, updates: false }), /TUNNEL_HOST/);
  const d = await createNode({ dataDir: join(tmp, 'd'), offline: true, heartbeatMs: 200, operator: 'd', roles: ['mesh'], wsAddr: 'wss://explicit.example', relayPort: 8477, tunnelBin: bin, updates: false });
  t.after(() => d.stop().catch(() => {}));
  assert.equal((await (await fetch(`${d.addr}/health`)).json()).wsAddr, 'wss://explicit.example');
  assert.equal(d.tunnels.relay, null);
});
