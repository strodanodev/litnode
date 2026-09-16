/** Three nodes in one process, offline beacon. What §0.1 R2 and C2/C3 claim:
 *  peers converge, a ruleset spreads by hash and is refused when tampered,
 *  two players queued at different nodes are paired identically everywhere,
 *  and the publisher going dark leaves the title hosted.
 *    node --test demo/mesh.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode, rulesetHash } from '../node/litnode.js';
import { generateKeypair, seal } from '../protocol/keys.js';
import { QUEUE_TAG, bucketOf, BUCKET_MS } from '../protocol/pairing.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 8000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(step); }
  return false;
};
const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-'));
const nodes = [];
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator + Math.random().toString(36).slice(2, 6)), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));

test('mesh: gossip converges, ruleset spreads by hash, publisher dies, title survives', { timeout: 60_000 }, async (t) => {
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

  const pub = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'witness'], rulesets: [RULESET] });
  const a = await spawn({ operator: 'guild-a', roles: ['mesh', 'host', 'witness'], seeds: [pub.addr] });
  const b = await spawn({ operator: 'guild-b', roles: ['mesh', 'host', 'witness'], seeds: [pub.addr] });

  assert.ok(await until(() => [pub, a, b].every((n) => n.snapshot().peers.length === 3)), 'three peers everywhere');
  assert.equal(pub.snapshot().staking, 'unbonded-dev', 'no NodeStake configured → reported, not hidden');

  // C2: operators who were never handed the game end up holding it, by hash.
  assert.ok(await until(() => a.rulesets()['agent-fighter.v1'] && b.rulesets()['agent-fighter.v1']), 'guilds hydrate the ruleset');
  assert.equal(a.rulesets()['agent-fighter.v1'], pub.rulesets()['agent-fighter.v1']);
  const roots = [pub, a, b].map((n) => n.snapshot().root);
  assert.ok(await until(() => new Set([pub, a, b].map((n) => n.snapshot().root)).size === 1), `snapshot roots converge (${roots.map((r) => r.slice(0, 8))})`);

  // Tampered bytes are refused.
  const src = await (await fetch(`${pub.addr}/ruleset/agent-fighter.v1`)).text();
  await assert.rejects(() => a.installRuleset(src + '\n// tamper', rulesetHash(src)), /hash mismatch/);

  // Queue two players at DIFFERENT nodes; everyone pairs them identically.
  const [p1, p2] = await Promise.all([generateKeypair(), generateKeypair()]);
  const bucket = bucketOf(Date.now());
  const entry = (kp) => seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: 'agent-fighter.v1', tokenId: '1', mode: 'ranked', bucket, region: 'local' }, kp);
  const r1 = await fetch(`${a.addr}/queue`, { method: 'POST', body: JSON.stringify(await entry(p1)) });
  const r2 = await fetch(`${b.addr}/queue`, { method: 'POST', body: JSON.stringify(await entry(p2)) });
  assert.equal(r1.status, 202); assert.equal(r2.status, 202);
  const forged = await entry(p1); forged.body = { ...forged.body, playerId: p2.publicKey };
  assert.equal((await fetch(`${a.addr}/queue`, { method: 'POST', body: JSON.stringify(forged) })).status, 400, 'cannot enqueue somebody else');

  await sleep(2 * BUCKET_MS + 300); // bucket closes
  assert.ok(await until(() => [pub, a, b].every((n) => n.matches().length === 1)), 'every node computes the pair');
  const [mp, ma, mb] = [pub, a, b].map((n) => n.matches()[0]);
  assert.equal(ma.matchId, mb.matchId); assert.equal(mp.matchId, ma.matchId);
  assert.equal(ma.host, mb.host, 'same host drawn at nodes that never saw each other\'s player');
  assert.equal(ma.beaconSource, 'local');
  assert.ok(ma.witness && ma.witness !== ma.host);
  const viaHttp = await (await fetch(`${b.addr}/match?playerId=${p1.publicKey}`)).json();
  assert.equal(viaHttp.matches[0].matchId, ma.matchId, 'a node answers /match for a player it never saw queue');

  // C3: publisher goes dark; the title keeps taking matches on the guilds.
  await pub.stop();
  assert.ok(await until(() => a.snapshot().peers.length === 2 && b.snapshot().peers.length === 2, 10_000), 'publisher ages out');
  assert.ok(a.snapshot().manifests['agent-fighter.v1'], 'manifest still advertised by the guilds');
  const [p3, p4] = await Promise.all([generateKeypair(), generateKeypair()]);
  const bucket2 = bucketOf(Date.now());
  const entry2 = (kp) => seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: 'agent-fighter.v1', tokenId: '2', mode: 'casual', bucket: bucket2 }, kp);
  await fetch(`${a.addr}/queue`, { method: 'POST', body: JSON.stringify(await entry2(p3)) });
  await fetch(`${a.addr}/queue`, { method: 'POST', body: JSON.stringify(await entry2(p4)) });
  await sleep(2 * BUCKET_MS + 300);
  assert.ok(await until(() => a.matches().some((m) => m.bucket === bucket2) && b.matches().some((m) => m.bucket === bucket2)));
  const m2 = a.matches().find((m) => m.bucket === bucket2);
  assert.ok([a.nodeId, b.nodeId].includes(m2.host), 'draw falls through to the remaining operators');
  assert.equal(m2.host, b.matches().find((m) => m.bucket === bucket2).host);
});
