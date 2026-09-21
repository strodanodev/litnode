/** A peer nobody has heard from in ten minutes is forgotten — by the table,
 *  by the envelopes we forward, by /peers. Before this, every node ever
 *  heard of travelled the mesh until a restart (21 Sep 2026: four dead
 *  test nodes from the day before, in every peer's gossip).
 *    node --test demo/forget.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { EPOCH_MS } from '../protocol/snapshot.js';
import { until } from './lib/mesh.mjs';

test('a silent peer is forgotten after ten minutes, and no longer forwarded', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-forget-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'a', roles: ['mesh'], updates: false }); nodes.push(a);
  const b = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 200, operator: 'b', roles: ['mesh'], seeds: [a.addr], updates: false }); nodes.push(b);
  const peersOf = async (n) => (await (await fetch(`${n.addr}/peers`)).json()).peers.map((p) => p.nodeId);
  assert.ok(await until(async () => (await peersOf(a)).includes(b.nodeId), 10_000), 'a hears b');
  // b falls silent for good
  await b.stop(); nodes.pop();
  assert.ok((await peersOf(a)).includes(b.nodeId), 'still listed while recent (stale, not forgotten)');
  // ten minutes pass, as far as the epoch clock is concerned
  const realNow = Date.now;
  const skip = 10 * 60_000 + 3 * EPOCH_MS;
  Date.now = () => realNow() + skip;
  t.after(() => { Date.now = realNow; });
  assert.ok(await until(async () => !(await peersOf(a)).includes(b.nodeId), 10_000), 'forgotten');
  const s = await (await fetch(`${a.addr}/snapshot?envelopes=1`)).json();
  assert.ok(!s.envelopes.some((e) => e.body.nodeId === b.nodeId), 'no longer forwarded');
  assert.ok(s.envelopes.some((e) => e.body.nodeId === a.nodeId), 'our own heartbeat is never forgotten');
});
