/** Ranked binding outlives the host's match book (audit 2026-10-21 §4.1 finding 5; 0.11.31).
 *
 *  The host used to bind a ranked ledger only to the placement in its in-memory book — gone once an earlier
 *  rival replaced it, once its 15 minutes ran out, or on a restart — while the witness path accepted the
 *  signed descriptor envelope stored with the ledger. Now GET /match serves each placement's envelope, the
 *  client sends it back as the submission's `descriptor`, and the host binds to it the way a witness does:
 *  signature, protocol, the placing key bonded (in the live table, or at the pinned block when no heartbeat
 *  reaches it any more), the beacon this node holds for that bucket, and a match id the beacon derives.
 *    node --test demo/binding.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { createChain } from '../node/chain.js';
import { descriptorHash } from '../node/settle.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { generateKeypair, seal } from '../protocol/keys.js';
import { matchIdFor, bucketOf } from '../protocol/pairing.js';
import { h } from '../protocol/canonical.js';
import { STANDING_OF } from '../protocol/staking.js';
import { selector } from '../protocol/keccak.js';
import { placeMatch, playPlaced, until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);
const play = { title, engine, manifest, balance };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const cosigned = (addr, matchId, ms = 30_000) => until(async () => (await (await fetch(`${addr}/delta/${matchId}`)).json()).cosigners?.length === 1, ms);

test('binding: a ledger for a placement the book replaced, and one after a host restart, bind from the envelope the client carried', { timeout: 180_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-bind-'));
  const nodes = [];
  const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, updates: false, ...opts }).then((n) => (nodes.push(n), n));
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  let host = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET] });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], seeds: [host.addr], titleTrust: 'open' });
  assert.ok(await until(() => wit.rulesets()['agent-fighter.v1']), 'witness hydrates the ruleset');

  // ---- GET /match carries the signed envelope; the test client sends it back as `descriptor`
  const kps = await Promise.all([generateKeypair(), generateKeypair()]);
  const desc = await placeMatch(host.addr, kps, { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  assert.equal(desc.envelope?.signer, host.nodeId, 'the placement comes with the host\'s envelope');
  assert.equal(desc.envelope.body.matchId, desc.matchId);
  const sub = await playPlaced(desc, kps, play);
  assert.equal(sub.descriptor, desc.envelope);

  // ---- an earlier rival for the same players (what a peer that pinned another block for the bucket gossips:
  // same bucket, another beacon, a smaller id) replaces the placement in the host's book — after the client fetched it
  let rival, n = 0;
  do { const beacon = h('beacon', `rival-${n++}`); rival = { ...desc.envelope.body, beacon, matchId: matchIdFor(desc.rulesetId, desc.participants[0], desc.participants[1], beacon), computedBy: wit.nodeId, computedAt: Date.now() }; } while (rival.matchId >= desc.matchId);
  assert.equal((await post(`${host.addr}/gossip`, { matches: [await seal('match', rival, wit.identity)] })).status, 200);
  const listed = await until(async () => { const { matches } = await (await fetch(`${host.addr}/match?playerId=${kps[0].publicKey}`)).json(); return matches.some((m) => m.matchId === rival.matchId) && !matches.some((m) => m.matchId === desc.matchId) ? matches : null; });
  assert.ok(listed, 'the host\'s book now holds the rival, not the placement the client played');

  // without the envelope: refused, as before — the book does not hold it
  const { descriptor: _d, ...bare } = sub;
  const rb = await post(`${host.addr}/ledger`, bare);
  assert.equal(rb.status, 400); assert.match((await rb.json()).error, /no placement descriptor/);
  // an envelope whose id is not what its beacon derives (a bonded key grinding a seed): refused
  const grind = await seal('match', { ...desc.envelope.body, beacon: h('beacon', 'grind'), computedBy: wit.nodeId }, wit.identity);
  const rg = await post(`${host.addr}/ledger`, { ...sub, descriptor: grind });
  assert.equal(rg.status, 400); assert.match((await rg.json()).error, /no placement descriptor/);
  // with the envelope the client was served: binds to the placement it played
  const r = await post(`${host.addr}/ledger`, sub);
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const delta = JSON.parse(text);
  assert.equal(delta.placed, true); assert.equal(delta.attestation, 'players');
  assert.equal(delta.descriptorHash, descriptorHash(desc.envelope.body), 'bound to the placement the client played, not the rival');
  assert.equal(delta.seed, h('seed', desc.beacon, desc.matchId));
  assert.equal((await (await fetch(`${host.addr}/ledger/${desc.matchId}`)).json()).descriptor.signer, host.nodeId, 'the stored ledger carries the envelope for the witnesses');
  assert.ok(await cosigned(host.addr, desc.matchId), 'the witness (whose book also holds the rival) binds the ledger\'s envelope and co-signs');
  assert.equal((await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json()).verification, 'verified');

  // ---- a restart empties the book; the ledger still binds, and the witness still agrees
  const kps2 = await Promise.all([generateKeypair(), generateKeypair()]);
  const desc2 = await placeMatch(host.addr, kps2, { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  const sub2 = await playPlaced(desc2, kps2, play);
  await host.stop(); nodes.splice(nodes.indexOf(host), 1);
  const was = host.nodeId;
  host = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET], seeds: [wit.addr] });
  assert.equal(host.nodeId, was, 'the same identity');
  assert.equal((await (await fetch(`${host.addr}/match?playerId=${kps2[0].publicKey}`)).json()).matches.length, 0, 'the book is empty after the restart');
  const r2 = await post(`${host.addr}/ledger`, sub2);
  assert.equal(r2.status, 200, await r2.clone().text());
  const delta2 = await r2.json();
  assert.equal(delta2.placed, true); assert.equal(delta2.descriptorHash, descriptorHash(desc2.envelope.body));
  assert.ok(await cosigned(host.addr, desc2.matchId), 'the witness co-signs the restarted host\'s result');
  assert.equal((await (await fetch(`${host.addr}/leaderboard?ruleset=agent-fighter.v1`)).json()).leaderboard.length, 4, 'both results are official');
});

/** A deterministic chain (one block a second, hash and timestamp from the height) with NodeStake: `now` is the
 *  set of keys bonded at `latest`, `then(key, tag)` says whether a key was bonded at a historical block. */
function stakeChain({ now, then, calls = [] }) {
  const BASE = 0x1000, genesis = Date.now() - 60_000;
  const headNo = () => BASE + Math.floor((Date.now() - genesis) / 1000);
  const blockAt = (k) => ({ number: '0x' + k.toString(16), timestamp: '0x' + Math.floor((genesis + (k - BASE) * 1000) / 1000).toString(16), hash: '0x' + k.toString(16).padStart(64, '0') });
  const word = (x) => x.replace(/^0x/, '').padStart(64, '0');
  return async (_url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    let result = null, error = null;
    if (method === 'eth_getBlockByNumber') { const k = params[0] === 'latest' ? headNo() : parseInt(params[0], 16); result = k <= headNo() ? blockAt(k) : null; }
    else if (method === 'eth_blockNumber') result = '0x' + headNo().toString(16);
    else if (method === 'eth_call' && params[0].data.startsWith(selector(STANDING_OF))) {
      const key = params[0].data.slice(10, 74), tag = params[1];
      calls.push({ key, tag });
      const r = tag === 'latest' ? now.has(key) : then(key, tag);
      if (r === 'error') error = { code: -32000, message: 'missing trie node (state pruned)' };
      else result = '0x' + word('aa'.repeat(20)) + word('0de0b6b3a7640000') + word(r ? '1' : '0');
    } else if (method === 'eth_call') result = '0x';
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) };
  };
}
const STAKE = '0x' + '11'.repeat(20);

test('binding: a placing key no heartbeat reaches binds when it was bonded at the pinned block; never bonded, it does not', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-bind-stake-'));
  const [placer, stranger, p1, p2] = await Promise.all([generateKeypair(), generateKeypair(), generateKeypair(), generateKeypair()]);
  const calls = [];
  let host;
  // the host is bonded now; the placer was bonded at every past block and is not any more; the stranger never was
  const chainFetch = stakeChain({ now: new Set(), then: (key, tag) => key === placer.publicKey && tag !== 'latest', calls });
  host = await createNode({ dataDir: join(tmp, 'host'), rpc: 'mock://', offline: false, chainFetch, nodeStake: STAKE, chainId: 4441, heartbeatMs: 200, updates: false, announce: false, operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET] });
  t.after(async () => { await host.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const bucket = bucketOf(Date.now());
  const bc = await until(() => { const b = host.chain.beaconFor(bucket); return b?.source === 'chain' ? b : null; }, 20_000);
  assert.ok(bc, 'the host pinned a chain beacon for the bucket');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/snapshot?envelopes=1`)).json()).stakes), 'the live stake table exists (the host read its own standing), so a missing key is looked up at the block, not waved through');
  const P = [p1.publicKey, p2.publicKey].sort();
  const placed = (by) => ({ matchId: matchIdFor('agent-fighter.v1', P[0], P[1], bc.beacon), rulesetId: 'agent-fighter.v1', mode: 'ranked', bucket, beacon: bc.beacon, beaconSource: 'chain', beaconBlock: bc.block, participants: P, regions: [null, null], tokens: [null, null], protocol: PROTOCOL_VERSION, buildHash: manifest.buildHash, snapshotRoot: 'ab'.repeat(32), snapshotEpoch: 1, computedBy: by.publicKey, computedAt: Date.now(), host: host.nodeId, witness: null, panel: [], order: [host.nodeId] });
  const d = placed(placer);
  const sub = await playPlaced(d, [p1, p2], play);
  const r = await post(`${host.addr}/ledger`, { ...sub, descriptor: await seal('match', d, placer) });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const delta = JSON.parse(text);
  assert.equal(delta.placed, true); assert.equal(delta.descriptorHash, descriptorHash(d));
  assert.ok(calls.some((c) => c.key === placer.publicKey && c.tag === '0x' + bc.block.toString(16)), `the placer's standing was read at the pinned block: ${JSON.stringify(calls.filter((c) => c.key === placer.publicKey))}`);
  // the stranger: bonded at no block — refused as unplaced
  const d2 = { ...placed(stranger), computedAt: Date.now() + 1 };
  const rs = await post(`${host.addr}/ledger`, { ...sub, descriptor: await seal('match', d2, stranger) });
  assert.equal(rs.status, 200, 'settlement is idempotent by matchId: the first result stands');
  const kps3 = await Promise.all([generateKeypair(), generateKeypair()]);
  const P3 = kps3.map((k) => k.publicKey).sort();
  const d3 = { ...placed(stranger), participants: P3, matchId: matchIdFor('agent-fighter.v1', P3[0], P3[1], bc.beacon) };
  const sub3 = await playPlaced(d3, kps3, play);
  const r3 = await post(`${host.addr}/ledger`, { ...sub3, descriptor: await seal('match', d3, stranger) });
  assert.equal(r3.status, 400); assert.match((await r3.json()).error, /no placement descriptor/);
  assert.ok(calls.some((c) => c.key === stranger.publicKey && c.tag === '0x' + bc.block.toString(16)), 'the stranger was looked up at the pinned block too, and found unbonded');
});

test('chain.standingAt reads at the block, falls back to latest when the RPC holds no state there, and caches', async () => {
  const key = (await generateKeypair()).publicKey;
  const calls = [];
  const chain = createChain({ rpc: 'mock://', nodeStake: STAKE, fetchImpl: stakeChain({ now: new Set([key]), then: (k, tag) => (tag === '0x2000' ? 'error' : tag === '0x1234'), calls }) });
  const at = await chain.standingAt(key, 0x1234);
  assert.equal(at.active, true); assert.equal(at.at, '0x1234'); assert.equal(at.fallback, undefined);
  const before = await chain.standingAt(key, 0x1233);
  assert.equal(before.active, false, 'not bonded at that block');
  const pruned = await chain.standingAt(key, 0x2000);
  assert.equal(pruned.active, true); assert.equal(pruned.at, 'latest'); assert.match(pruned.fallback, /missing trie node/);
  const n = calls.length;
  await chain.standingAt(key, 0x1234); await chain.standingAt(key, 0x2000);
  assert.equal(calls.length, n, 'cached per key and block');
  assert.equal((await chain.standingAt(key, null)).at, 'latest', 'no block: the live standing');
  assert.equal(await createChain({ rpc: 'offline', offline: true, nodeStake: STAKE }).standingAt(key, 1), null, 'offline: no stake table');
});
