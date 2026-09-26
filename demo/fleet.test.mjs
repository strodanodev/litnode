/** GET /fleet — the operator's dashboard in one signed document (docs/FLEET-TELEMETRY.md): links measured on
 *  the gossip push, a quality grade per peer, the graph every node can draw from the heartbeats' `links`, rooms,
 *  queue, titles, the last events — and a node-key proof over nonce + digest that a dashboard checks before it
 *  believes a word of it.
 *    node --test demo/fleet.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { checkChallenge, newNonce } from '../protocol/challenge.js';
import { h } from '../protocol/canonical.js';
import { until } from './lib/mesh.mjs';

test('/fleet: measured links, graded peers, a graph from everyone\'s heartbeat, signed over its digest', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-fleet-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'a', roles: ['mesh', 'host'], updates: false }); nodes.push(a);
  const b = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 200, operator: 'b', roles: ['mesh', 'witness'], seeds: [a.addr], updates: false }); nodes.push(b);
  const c = await createNode({ dataDir: join(tmp, 'c'), offline: true, heartbeatMs: 200, operator: 'c', roles: ['mesh', 'witness'], seeds: [a.addr], updates: false }); nodes.push(c);
  const fleet = async (n, q = '') => (await fetch(`${n.addr}/fleet${q}`)).json();
  // everyone hears everyone, and a has pushed to both often enough to grade them
  assert.ok(await until(async () => { const f = await fleet(a); return f.mesh.active === 3 && f.peers.every((p) => p.link?.samples >= 3); }, 20_000), 'three active, links sampled');
  const f = await fleet(a);
  assert.equal(f.nodeId, a.nodeId);
  assert.equal(f.self.operator, 'a');
  assert.equal(f.mesh.known, 3);
  for (const p of f.peers) {
    assert.ok(typeof p.link.rttMs === 'number' && p.link.rttMs >= 0, `rtt measured for ${p.operator}`);
    assert.ok(typeof p.link.emaMs === 'number', 'moving average');
    assert.equal(p.link.loss, 0, 'no loss on loopback');
    assert.equal(p.link.direct, true, 'pushed to in the last ten seconds');
    assert.equal(p.quality.grade, 'A', `fresh, lossless, fast → A (got ${JSON.stringify(p.quality)})`);
    assert.equal(p.fresh, true);
    assert.ok(p.ageS <= 2);
  }
  // the graph: our two measured edges, plus what b and c report about their own pushes (to a, learned from their heartbeats)
  assert.equal(f.graph.nodes.length, 3);
  assert.ok(f.graph.nodes.find((n) => n.self).nodeId === a.nodeId);
  const mine = f.graph.edges.filter((e) => e.measured);
  assert.equal(mine.length, 2, 'two measured edges from a');
  assert.ok(await until(async () => (await fleet(a)).graph.edges.some((e) => !e.measured && e.from === b.nodeId && e.to === a.nodeId), 10_000), 'b reports its edge to a in its heartbeat; a draws it');
  // traffic is real: a pushes to two peers several times a second
  assert.ok(f.mesh.gossip.outPerMin > 0 && f.mesh.gossip.outBytesPerMin > 0, 'gossip out counted');
  assert.ok(f.mesh.gossip.inPerMin > 0, 'gossip in counted (replies and pushes)');
  // shape the dashboard binds to
  assert.deepEqual(Object.keys(f).sort(), ['at', 'cabinet', 'chain', 'digest', 'events', 'graph', 'guardian', 'mesh', 'nodeId', 'peers', 'proof', 'protocol', 'queue', 'recent', 'rooms', 'self', 'titles', 'version'].sort());
  assert.ok(Array.isArray(f.rooms) && Array.isArray(f.queue) && Array.isArray(f.titles) && Array.isArray(f.events));
  assert.equal(f.proof, null, 'no nonce, no proof');
  assert.equal(f.chain.offline, true);
  assert.equal(typeof f.self.uptimeMs, 'number');
  assert.ok(f.events.every((e) => typeof e.t === 'number' && typeof e.type === 'string'), 'events is a ring of what the node emitted');
  assert.ok(!f.events.some((e) => e.type === 'gossip.out' || e.type === 'block'), 'per-second ticks are not in the ring');
  // signed: the digest covers the document without digest/proof; the proof is the node key's answer over nonce + digest
  const nonce = newNonce();
  const g = await fleet(a, `?nonce=${nonce}`);
  const { digest, proof, ...body } = g;
  assert.equal(h('fleet', body), digest, 'digest is the canonical hash of the body');
  assert.deepEqual(await checkChallenge(proof, { expectNodeId: a.nodeId, nonce, expectDigest: digest }), { ok: true });
  assert.deepEqual(await checkChallenge(proof, { expectNodeId: a.nodeId, nonce, expectDigest: h('fleet', { ...body, at: 'edited' }) }), { ok: false, reason: 'digest' }, 'an edited body fails');
  assert.deepEqual(await checkChallenge(proof, { expectNodeId: b.nodeId, nonce, expectDigest: digest }), { ok: false, reason: 'identity' }, 'another node cannot have signed it');
  assert.equal((await fetch(`${a.addr}/fleet?nonce=zz`)).status, 400);
  // a peer that stops answering our pushes loses its grade, and its edge
  await c.stop(); nodes.splice(nodes.indexOf(c), 1);
  assert.ok(await until(async () => { const p = (await fleet(a)).peers.find((x) => x.nodeId === c.nodeId); return p && p.link.loss > 0 && p.quality.grade !== 'A'; }, 20_000), 'loss shows, grade drops');
  assert.ok(await until(async () => !(await fleet(a)).graph.edges.some((e) => e.to === c.nodeId && e.measured), 15_000), 'no measured edge to a dead peer');
});
