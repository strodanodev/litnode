/** Gossip limits (node/litnode.js, M4): what a peer hands a node is verified before the node forwards it, a queue
 *  entry outside the pairing window or for a title nobody runs is dropped, and the tables a stranger can add to
 *  have ceilings. A flood of new keys costs a few stake reads a tick, and an address only unbonded keys claim is
 *  pushed to rarely.
 *    node --test demo/gossip-limits.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { seal, generateKeypair } from '../protocol/keys.js';
import { HEARTBEAT_TAG, epochOf } from '../protocol/snapshot.js';
import { QUEUE_TAG, bucketOf } from '../protocol/pairing.js';
import { STANDING_OF } from '../protocol/staking.js';
import { selector } from '../protocol/keccak.js';
import { until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const STAKE = '0x' + '11'.repeat(20);
const tmp = mkdtempSync(join(tmpdir(), 'litnode-guard-'));
const nodes = [];
test.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

const gossip = async (node, msg) => (await fetch(`${node.addr}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })).json();
const health = async (node) => (await fetch(`${node.addr}/health`)).json();
const heartbeat = (kp, addr = 'http://127.0.0.1:9') => seal(HEARTBEAT_TAG, { nodeId: kp.publicKey, operator: 'x', roles: ['mesh'], region: 'local', addr, wsAddr: null, standing: 0, version: '0.0.0', protocol: 3, buildHashes: {}, manifests: {}, epoch: epochOf(Date.now()) }, kp);

/** NodeStake where only `bonded` keys are active; counts standingOf reads between block polls (one tick each). */
function stakeChain(bonded) {
  const word = (h) => h.replace(/^0x/, '').padStart(64, '0');
  const ticks = [0];
  const f = async (_url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    let result = null;
    if (method === 'eth_getBlockByNumber') { ticks.push(0); result = { number: '0x10', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + 'ff'.repeat(32) }; }
    else if (method === 'eth_blockNumber') result = '0x10';
    else if (method === 'eth_call' && params[0].data.startsWith(selector(STANDING_OF))) {
      ticks[ticks.length - 1]++;
      const key = params[0].data.slice(10, 74);
      result = '0x' + word('aa'.repeat(20)) + word('0de0b6b3a7640000') + word(bonded.has(key) ? '1' : '0');
    } else if (method === 'eth_call') result = '0x';
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
  f.ticks = ticks;
  return f;
}

test('gossip limits: forged envelopes and out-of-window queue entries are not forwarded; a valid entry is', { timeout: 30_000 }, async () => {
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'a', roles: ['mesh', 'host'], rulesets: [RULESET], updates: false });
  nodes.push(a);
  const rulesetId = Object.keys((await health(a)).rulesets)[0];
  const peer = await generateKeypair(), other = await generateKeypair(), player = await generateKeypair(), p2 = await generateKeypair();
  const forged = { ...(await heartbeat(other)), body: { ...(await heartbeat(other)).body, nodeId: peer.publicKey }, signer: peer.publicKey }; // other's signature, peer's name
  const good = await heartbeat(peer);
  const now = bucketOf(Date.now());
  const entry = (kp, bucket, rid = rulesetId) => seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: rid, tokenId: '0', mode: 'casual', bucket }, kp);
  const valid = await entry(player, now);
  const future = await entry(p2, now + 500);
  const unknownTitle = await entry(p2, now, 'no-such-title.v1');
  const badSig = { ...(await entry(p2, now)), sig: valid.sig };

  const reply = await gossip(a, { heartbeats: [forged], queue: [future, unknownTitle, badSig] });
  assert.ok(!reply.heartbeats.some((e) => e.body.nodeId === peer.publicKey), 'a forged heartbeat is not echoed back');
  assert.equal(reply.queue.length, 0, 'no out-of-window, unknown-title or forged entry is held for forwarding');
  let g = (await health(a)).gossipLimits;
  assert.equal(g.refused.heartbeat.badSig, 1);
  assert.deepEqual(g.refused.queue, { badSig: 1, window: 1, unknownTitle: 1, full: 0 });

  const reply2 = await gossip(a, { heartbeats: [good], queue: [valid] });
  assert.ok(reply2.heartbeats.some((e) => e.body.nodeId === peer.publicKey && e.sig === good.sig), 'the real heartbeat is forwarded');
  assert.ok(reply2.queue.some((e) => e.sig === valid.sig), 'the valid entry is forwarded');
  // the same envelopes again are not verified again
  const cache = (await health(a)).gossipLimits.verifyCache;
  await gossip(a, { heartbeats: [good], queue: [valid] });
  g = (await health(a)).gossipLimits;
  assert.equal(g.verifyCache, cache);
  assert.equal(g.refused.heartbeat.badSig, 1);
});

test('gossip limits: the peer table has a ceiling', { timeout: 60_000 }, async () => {
  const b = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 1000, operator: 'b', roles: ['mesh'], updates: false });
  nodes.push(b);
  const kps = await Promise.all(Array.from({ length: 520 }, generateKeypair));
  await gossip(b, { heartbeats: await Promise.all(kps.map((k) => heartbeat(k))) });
  const g = (await health(b)).gossipLimits;
  assert.equal(g.peerKeys, g.maxPeerKeys, 'filled to the ceiling, not past it');
  assert.equal(g.refused.heartbeat.full, 520 - g.maxPeerKeys);
});

test('gossip limits: new keys cost at most a few stake reads a tick; unbonded keys are capped and rarely pushed to', { timeout: 60_000 }, async () => {
  // a stranger's server, standing in for the addresses forged heartbeats point every node at
  const pushes = new Map();
  const srv = createServer((req, res) => { pushes.set(req.url, (pushes.get(req.url) ?? 0) + 1); req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const chainFetch = stakeChain(new Set());
    const c = await createNode({ dataDir: join(tmp, 'c'), rpc: 'mock://', offline: false, chainFetch, nodeStake: STAKE, chainId: 4441, heartbeatMs: 200, operator: 'c', roles: ['mesh'], updates: false, announce: false });
    nodes.push(c);
    const N = 80;
    const kps = await Promise.all(Array.from({ length: N }, generateKeypair));
    await gossip(c, { heartbeats: await Promise.all(kps.map((k, i) => heartbeat(k, `${base}/u${i}`))) });
    const settled = await until(async () => { const g = (await health(c)).gossipLimits; return g.unbonded === g.maxUnbonded && g.refused.heartbeat.evicted === N - g.maxUnbonded ? g : null; }, 40_000, 200);
    assert.ok(settled, 'every key read, the unbonded trimmed to the cap');
    assert.equal(settled.peerKeys, settled.maxUnbonded);
    assert.ok(Math.max(...chainFetch.ticks) <= 5, `at most 4 new keys (and our own) read in a tick, saw ${Math.max(...chainFetch.ticks)}`);
    // the evicted keys sent again (fresh heartbeats) are not taken back
    await gossip(c, { heartbeats: await Promise.all(kps.map((k, i) => heartbeat(k, `${base}/u${i}`))) });
    assert.equal((await health(c)).gossipLimits.peerKeys, settled.maxUnbonded, 'evicted keys stay out');
    // pushes: unbonded addresses every tenth tick, evicted ones never
    pushes.clear();
    await new Promise((r) => setTimeout(r, 3000)); // ~15 ticks
    const kept = new Set((await (await fetch(`${c.addr}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).heartbeats.map((e) => e.body.addr));
    let keptPushes = 0, evictedPushes = 0, maxPerAddr = 0;
    for (let i = 0; i < N; i++) {
      const n = pushes.get(`/u${i}/gossip`) ?? 0;
      if (kept.has(`${base}/u${i}`)) { keptPushes += n; maxPerAddr = Math.max(maxPerAddr, n); } else evictedPushes += n;
    }
    assert.equal(evictedPushes, 0, 'an evicted address is not pushed to');
    assert.ok(keptPushes > 0, 'an unbonded peer still hears from us');
    assert.ok(maxPerAddr <= 3, `an unbonded address is pushed to every tenth tick, not every tick (max ${maxPerAddr} in ~15 ticks)`);
  } finally { srv.close(); }
});
