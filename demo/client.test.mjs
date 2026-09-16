/** The cabinet's client (cabinet/client.js) against a two-node mesh: identity persists, a signed
 *  queue entry pairs, the client recomputes placement and ACCEPTS the host the
 *  rule produced, and REFUSES a descriptor naming another host. The node also
 *  serves the lobby page and the protocol modules it imports.
 *    node --test demo/client.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { loadPlayer, createClient } from '../cabinet/client.js';
import { roomCodeFor } from '../protocol/pairing.js';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-arcade-'));
const nodes = [];
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));
const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('arcade: lobby served, identity persists, queue → pair → client verifies placement', { timeout: 60_000 }, async (t) => {
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const a = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'witness'], rulesets: [RULESET] });
  const b = await spawn({ operator: 'guild-a', roles: ['mesh', 'host', 'witness'], seeds: [a.addr] });

  const page = await fetch(`${a.addr}/`); assert.equal(page.status, 200); assert.match(await page.text(), /LIT GAMES/);
  const mod = await fetch(`${a.addr}/protocol/placement.js`); assert.equal(mod.status, 200); assert.match(mod.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${a.addr}/protocol/../package.json`)).status, 404, 'no path escape');

  const store = memStorage();
  const p1 = await loadPlayer(store); assert.deepEqual(await loadPlayer(store), p1, 'identity persists in storage');
  const p2 = await loadPlayer(memStorage());
  const c1 = createClient({ nodeUrl: a.addr, player: p1 });
  const c2 = createClient({ nodeUrl: b.addr, player: p2 });
  await new Promise((r) => setTimeout(r, 1500)); // let the mesh converge

  await c1.queue({ rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  await c2.queue({ rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  const [r1, r2] = await Promise.all([c1.waitForMatch({ timeoutMs: 20_000 }), c2.waitForMatch({ timeoutMs: 20_000 })]);
  assert.ok(r1 && r2, 'both paired');
  assert.equal(r1.match.matchId, r2.match.matchId, 'same match at different nodes');
  assert.equal(r1.check.ok, true, r1.check.reason);
  assert.equal(r2.check.ok, true, r2.check.reason);
  assert.equal(r1.check.host, r1.match.host);
  // the relay rendezvous code both players derive from the same match
  assert.equal(roomCodeFor(r1.match.matchId), roomCodeFor(r2.match.matchId));
  assert.match(roomCodeFor(r1.match.matchId), /^[A-Z0-9-]{3,40}$/, "fits Agent Fighter's room-code rule");

  // A node that lies about the host is refused by the client.
  const other = r1.snapshot.peers.find((p) => p.nodeId !== r1.match.host)?.nodeId;
  const lie = c1.verifyPlacement({ ...r1.match, host: other }, r1.snapshot);
  assert.equal(lie.ok, false);
  assert.match(lie.reason, /did not produce/);

  const st = await c1.stats('agent-fighter.v1'); assert.equal(st.matches, 0);
});
