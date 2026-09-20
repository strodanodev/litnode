/** The pure protocol layer. No network, no disk, no engine.
 *    node --test demo/protocol.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical, h } from '../protocol/canonical.js';
import { keccak256Hex, selector } from '../protocol/keccak.js';
import { generateKeypair, sign, verify, seal, opened } from '../protocol/keys.js';
import { createLog, chainHead, ledgerBody, signLedger, verifyLedger } from '../protocol/log.js';
import { placement, acceptsHost } from '../protocol/placement.js';
import { pair, bucketOf, isClosed, isStale, BUCKET_MS, QUEUE_TTL_MS } from '../protocol/pairing.js';
import { beaconFromBlocks, localBeacon } from '../protocol/beacon.js';
import { snapshot, verifyHeartbeats, HEARTBEAT_TAG, epochOf } from '../protocol/snapshot.js';
import { buildTree, proofFor, verifyProof, leafOf, anchorCalldata, anchorSelector } from '../protocol/epoch.js';
import { derive } from '../protocol/derive.js';
import { verifyHydration } from '../protocol/hydration.js';
import { agent, hydrationManifest } from '../protocol/erc6699.js';
import { eloLeaderboard, winnerTakesCredits } from '../titles/title.js';

// ---------------------------------------------------------------- hashing
test('keccak256 matches the known vectors', () => {
  assert.equal(keccak256Hex(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256Hex('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256Hex('a'.repeat(200)).length, 64); // multi-block absorb
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
});

test('anchorEpoch selector is derived, and the spec constant is checked against it', () => {
  const s = anchorSelector();
  console.log(JSON.stringify({ anchorSelector: s, specSaid: '0x7e8a0a8b', agree: s === '0x7e8a0a8b' }));
  const cd = anchorCalldata(497_000, 'ab'.repeat(32));
  assert.equal(cd.length, 2 + 8 + 64 + 64);
  assert.ok(cd.startsWith(s));
});

// ---------------------------------------------------------------- keys
test('ed25519 sign/verify, purpose tags bind, envelopes open', async () => {
  const kp = await generateKeypair();
  assert.equal(kp.publicKey.length, 64);
  const body = { playerId: kp.publicKey, rulesetId: 'r', bucket: 7 };
  const sig = await sign('queue', body, kp.privateKey);
  assert.ok(await verify('queue', body, sig, kp.publicKey));
  assert.ok(!(await verify('heartbeat', body, sig, kp.publicKey)), 'same bytes under another tag must fail');
  assert.ok(!(await verify('queue', { ...body, bucket: 8 }, sig, kp.publicKey)));
  const other = await generateKeypair();
  assert.ok(!(await verify('queue', body, sig, other.publicKey)));
  const env = await seal('queue', body, kp);
  assert.ok(await opened('queue', env));
  assert.ok(!(await opened('queue', { ...env, signer: other.publicKey })));
  assert.ok(!(await opened('queue', { ...env, sig: 'zz' })), 'malformed never throws');
});

// ---------------------------------------------------------------- log
test('hash-chained log: gaps and reorders are rejected, two signatures settle', async () => {
  const log = createLog();
  for (let k = 0; k < 50; k++) log.append([k % 3, (k * 7) % 5]);
  const entries = log.entries();
  assert.equal(chainHead(entries), log.head);
  assert.throws(() => chainHead([entries[0], entries[2]]), /tick 2 at index 1/);
  const swapped = entries.slice(); [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.throws(() => chainHead(swapped));
  const tampered = entries.map((e) => (e.k === 10 ? { ...e, inputs: [0, 0] } : e));
  assert.notEqual(chainHead(tampered), log.head);

  const [a, b] = await Promise.all([generateKeypair(), generateKeypair()]);
  const pins = { matchId: 'm1', participants: [a.publicKey, b.publicKey], buildHash: 'bh', hydrationHash: 'hh' };
  const body = ledgerBody({ matchId: 'm1', ticks: entries.length, head: log.head, buildHash: 'bh', hydrationHash: 'hh' });
  const signatures = { [a.publicKey]: await signLedger(body, a), [b.publicKey]: await signLedger(body, b) };
  const ok = await verifyLedger({ entries, ...pins, signatures });
  assert.equal(ok.ok, true);
  const one = await verifyLedger({ entries, ...pins, signatures: { [a.publicKey]: signatures[a.publicKey] } });
  assert.equal(one.ok, false);
  assert.deepEqual(one.signed, [a.publicKey]);
  const bad = await verifyLedger({ entries: tampered, ...pins, signatures });
  assert.equal(bad.ok, false, 'a host that edits one tick loses both signatures');
});

// ---------------------------------------------------------------- placement
const node = (id, operator, roles, region = 'ap', bh = 'B1', standing = 10) =>
  ({ nodeId: id, operator, roles, region, standing, buildHashes: { r: bh } });
const manifest = { buildHash: 'B1', standingFloor: 5, hostPolicy: { affinity: 'open' } };

test('placement: one node and fifty are the same code path; client refuses other hosts', () => {
  const one = placement({ nodes: [node('n1', 'pub', ['host'])], manifest, rulesetId: 'r', matchId: 'm', beacon: 'x' });
  assert.equal(one.host.nodeId, 'n1');
  assert.equal(one.witness, null);
  const many = Array.from({ length: 50 }, (_, i) => node(`n${i}`, `op${i % 7}`, ['host', 'witness']));
  const p = placement({ nodes: many, manifest, rulesetId: 'r', matchId: 'm', beacon: 'x' });
  assert.equal(p.order.length, 50);
  assert.ok(p.witness && p.witness.operator !== p.host.operator && p.witness.nodeId !== p.host.nodeId);
  const again = placement({ nodes: [...many].reverse(), manifest, rulesetId: 'r', matchId: 'm', beacon: 'x' });
  assert.equal(again.host.nodeId, p.host.nodeId, 'input order does not matter');
  assert.ok(acceptsHost({ nodes: many, manifest, rulesetId: 'r', matchId: 'm', beacon: 'x' }, p.host.nodeId));
  assert.ok(!acceptsHost({ nodes: many, manifest, rulesetId: 'r', matchId: 'm', beacon: 'x' }, p.order[1].nodeId));
  const other = placement({ nodes: many, manifest, rulesetId: 'r', matchId: 'm', beacon: 'y' });
  assert.notEqual(other.host.nodeId, p.host.nodeId, 'beacon changes the draw (probabilistically)');
});

test('placement: eligibility, publisher affinity by node key, region affinity', () => {
  const nodes = [
    node('wrongbuild', 'a', ['host'], 'ap', 'B2'),
    node('lowstanding', 'a', ['host'], 'ap', 'B1', 1),
    node('meshonly', 'a', ['mesh'], 'ap'),
    node('eu1', 'guild', ['host', 'witness'], 'eu'),
    node('eu2', 'guild', ['host', 'witness'], 'eu'),
    node('ap1', 'pub', ['host'], 'ap'),
  ];
  const base = { nodes, manifest, rulesetId: 'r', matchId: 'm', beacon: 'b' };
  const p = placement(base);
  assert.ok(!p.order.some((n) => ['wrongbuild', 'lowstanding', 'meshonly'].includes(n.nodeId)));
  const aff = placement({ ...base, manifest: { ...manifest, hostPolicy: { affinity: 'operator', publisherNodes: ['ap1'] } } });
  assert.equal(aff.host.nodeId, 'ap1');
  assert.equal(aff.order.length, 3, 'affinity never removes the open fallback');
  const claimant = placement({ ...base, nodes: [...nodes, node('fake', 'pub', ['host'], 'ap')], manifest: { ...manifest, hostPolicy: { affinity: 'operator', publisherNodes: ['ap1'] } } });
  assert.equal(claimant.host.nodeId, 'ap1', 'claiming the operator string buys nothing');
  const reg = placement({ ...base, regions: ['eu', 'eu'] });
  assert.equal(reg.host.region, 'eu');
  // a host that fronts a relay wins over one that does not, whatever the seed says;
  // with no relay anywhere the draw is unchanged (placed, not playable — honestly)
  const relayed = nodes.map((n) => (n.nodeId === 'eu2' ? { ...n, wsAddr: 'wss://relay.example' } : n));
  for (const matchId of ['m', 'm2', 'm3', 'm4']) assert.equal(placement({ ...base, nodes: relayed, matchId }).host.nodeId, 'eu2', 'relay host first');
  assert.equal(placement({ ...base, nodes: relayed, matchId: 'm' }).order.length, 3, 'relay-first never removes the fallback');
  const regionVsRelay = placement({ ...base, nodes: relayed.map((n) => (n.nodeId === 'ap1' ? { ...n, wsAddr: 'wss://ap.example' } : n)), regions: ['eu', 'eu'] });
  assert.equal(regionVsRelay.host.nodeId, 'eu2', 'among relay hosts, region still decides');
});

// ---------------------------------------------------------------- pairing
test('pairing: closed buckets only, no self-pair, same result from any node', () => {
  const now = 100 * BUCKET_MS + 500;
  const b = bucketOf(now) - 2;
  assert.ok(isClosed(b, now) && !isClosed(b + 1, now));
  const q = [
    { playerId: 'p3', rulesetId: 'r', mode: 'ranked', bucket: b },
    { playerId: 'p1', rulesetId: 'r', mode: 'ranked', bucket: b },
    { playerId: 'p1', rulesetId: 'r', mode: 'ranked', bucket: b }, // duplicate
    { playerId: 'p2', rulesetId: 'r', mode: 'ranked', bucket: b },
    { playerId: 'p9', rulesetId: 'r', mode: 'ranked', bucket: b + 1 }, // open bucket
    { playerId: 'p8', rulesetId: 'r', mode: 'ranked', bucket: b + 1 },
  ];
  const beaconFor = (bk) => `beacon-${bk}`;
  const m = pair(q, now, beaconFor);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].participants, ['p1', 'p2']);
  assert.ok(!m.some((x) => x.participants[0] === x.participants[1]));
  const m2 = pair([...q].reverse(), now, beaconFor);
  assert.deepEqual(m2, m, 'gossip order is irrelevant');
  assert.equal(pair(q, now, () => null).length, 0, 'no beacon yet → no pairing yet');
  const later = pair(q, now + 2 * BUCKET_MS, beaconFor);
  assert.equal(later.length, 2);
});

test('beacon: first block after bucket end; local fallback is labelled', () => {
  const bucket = 5;
  const end = 6 * BUCKET_MS / 1000; // seconds
  const blocks = [
    { number: 10, timestamp: end - 1, hash: '0xaa' },
    { number: 12, timestamp: end + 1, hash: '0xcc' },
    { number: 11, timestamp: end, hash: '0xbb' },
  ];
  const b = beaconFromBlocks(bucket, blocks);
  assert.equal(b.block, 11);
  assert.equal(b.source, 'chain');
  assert.equal(beaconFromBlocks(bucket, blocks.slice(0, 1)), null);
  assert.equal(localBeacon(bucket).source, 'local');
  // A window that starts after the bucket end cannot know which block was
  // first: null, not the earliest block it happens to hold.
  assert.equal(beaconFromBlocks(bucket, blocks.slice(1)), null);
  // …so a rolling window never re-picks: once the pre-end block rolls out,
  // the answer is unknown rather than a different block each poll.
  const rolled = blocks.slice(1).concat([{ number: 13, timestamp: end + 2, hash: '0xdd' }]);
  assert.equal(beaconFromBlocks(bucket, rolled), null);
});

test('pairing: a queue entry outlives its bucket by QUEUE_TTL_MS and no more', () => {
  const now = 10_000_000;
  const fresh = bucketOf(now) - 3;                       // closed, recent
  const old = bucketOf(now - QUEUE_TTL_MS - 3 * BUCKET_MS); // closed long ago
  assert.equal(isStale(fresh, now), false);
  assert.equal(isStale(old, now), true);
  const q = (bucket) => [{ playerId: 'a', rulesetId: 'r', mode: 'casual', bucket }, { playerId: 'b', rulesetId: 'r', mode: 'casual', bucket }];
  assert.equal(pair(q(fresh), now, () => 'beacon').length, 1);
  assert.equal(pair(q(old), now, () => 'beacon').length, 0, 'a stale pair places nothing');
});

// ---------------------------------------------------------------- snapshot
test('snapshot: signed heartbeats, freshness, majority build wins, root is stable', async () => {
  const kps = await Promise.all([generateKeypair(), generateKeypair(), generateKeypair(), generateKeypair()]);
  const now = 1_000_000;
  const hb = (kp, buildHash, epoch = epochOf(now)) => seal(HEARTBEAT_TAG, {
    nodeId: kp.publicKey, operator: 'op', roles: ['host'], region: 'ap', addr: 'http://x', wsAddr: 'ws://x',
    standing: 10, buildHashes: { r: buildHash }, manifests: { r: { rulesetId: 'r', buildHash } }, epoch,
  }, kp);
  const envs = [
    await hb(kps[0], 'B1'), await hb(kps[1], 'B1'), await hb(kps[2], 'B2'),
    await hb(kps[3], 'B2', epochOf(now) - 3), // stale
  ];
  const forged = { ...(await hb(kps[2], 'B2')), signer: kps[0].publicKey };
  const bodies = await verifyHeartbeats([...envs, forged]);
  assert.equal(bodies.length, 4);
  const s = snapshot(bodies, now);
  assert.equal(s.peers.length, 3);
  assert.equal(s.manifests.r.buildHash, 'B1');
  const s2 = snapshot([...bodies].reverse(), now);
  assert.equal(s2.root, s.root);
  const tie = snapshot(bodies.filter((b) => b.nodeId !== kps[1].publicKey), now);
  assert.equal(tie.manifests.r.buildHash, 'B1', 'ties break lexicographically');
});

// ---------------------------------------------------------------- epoch
test('epoch tree: proofs verify, tampered leaves do not, empty is defined', () => {
  const deltas = Array.from({ length: 7 }, (_, i) => ({
    matchId: `m${i}`, rulesetId: 'r', buildHash: 'B', finalStateRoot: `s${i}`, hydrationHash: 'h',
    scores: { a: i, b: 0 }, hostId: 'n', cosigners: ['w'],
  }));
  const leaves = deltas.map(leafOf);
  const tree = buildTree(leaves);
  for (const leaf of leaves) assert.ok(verifyProof(leaf, proofFor(tree, leaf), tree.root));
  assert.ok(!verifyProof(leafOf({ ...deltas[0], scores: { a: 99, b: 0 } }), proofFor(tree, leaves[0]), tree.root));
  assert.equal(buildTree([...leaves].reverse()).root, tree.root);
  assert.equal(buildTree([...leaves, leaves[0]]).root, tree.root, 'duplicates collapse');
  assert.equal(proofFor(tree, 'nope'), null);
  assert.equal(typeof buildTree([]).root, 'string');
});

// ---------------------------------------------------------------- derive
test('derived services: order-independent, idempotent, ranked needs a co-signer when asked', () => {
  const m = { services: { leaderboard: eloLeaderboard({ k: 24 }), credits: winnerTakesCredits({ pot: 10, currency: 'c' }), stats: {} } };
  const d = (id, a, b, sa, sb, extra = {}) => ({ matchId: id, epoch: 1, participants: [a, b], scores: { [a]: sa, [b]: sb }, ticks: 100, mode: 'ranked', cosigners: ['w'], ...extra });
  const deltas = [d('m1', 'A', 'B', 2, 0), d('m2', 'B', 'C', 2, 1), d('m3', 'A', 'C', 0, 2), d('m4', 'A', 'B', 1, 1)];
  const x = derive(deltas, m);
  const y = derive([...deltas].reverse(), m);
  assert.equal(x.digest, y.digest);
  assert.equal(derive([...deltas, deltas[1]], m).digest, x.digest, 'replaying a delta changes nothing');
  assert.equal(x.stats.A.matches, 3);
  assert.equal(x.credits.c.A + x.credits.c.B + x.credits.c.C, 40);
  const un = derive([...deltas, d('m5', 'A', 'B', 2, 0, { cosigners: [] })], m, { requireCosign: true });
  assert.deepEqual(un.skipped, ['m5']);
  assert.equal(un.digest, x.digest);
});

// ---------------------------------------------------------------- hydration
test('witness re-hydrates from the registry and refuses an inflated manifest', async () => {
  const reg = {
    1: agent({ tokenId: 1, stats: { strength: 100, agility: 200, resilience: 300, intelligence: 400, level: 1, experience: 0 }, manifest: { soulManifestHash: 's1' }, equipped: { head: { collection: 'x', assetId: '1' } } }),
    2: agent({ tokenId: 2, stats: { strength: 500, agility: 600, resilience: 700, intelligence: 800, level: 2, experience: 0 }, manifest: { soulManifestHash: 's2' } }),
  };
  const lookup = async (id) => reg[id] ?? null;
  const honest = hydrationManifest({ agents: [reg[1], reg[2]], mode: 'ranked', balanceVersion: 'v' });
  assert.equal((await verifyHydration(honest, lookup, 'v')).ok, true);
  const inflated = hydrationManifest({ agents: [agent({ ...reg[1], stats: { ...reg[1].stats, strength: 65535 } }), reg[2]], mode: 'ranked', balanceVersion: 'v' });
  const r = await verifyHydration(inflated, lookup, 'v');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'manifest mismatch');
  const geared = { ...hydrationManifest({ agents: [reg[1], reg[2]], mode: 'casual', balanceVersion: 'v' }), mode: 'ranked' };
  assert.equal((await verifyHydration(geared, lookup, 'v')).ok, false, 'ranked with equipment left in');
  assert.equal((await verifyHydration(honest, lookup, 'v2')).ok, false);
});

test('canonical is key-order independent', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(h('t', { b: 1, a: 2 }), h('t', { a: 2, b: 1 }));
  assert.equal(h('x', 'abc').length, 64);
  assert.equal(h('x', 'abc'), createHash('sha256').update('x\0abc').digest('hex'));
});
