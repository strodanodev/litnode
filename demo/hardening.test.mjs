/** Hardening from the 21 Oct 2026 audit (audit/audit-2026-10-21.md): a peer address is an origin or it is refused;
 *  the node's own gossip push can never pass for the operator at a loopback-only route; an oversize body is cut
 *  off, not accumulated; a queue entry is typed and known before it is held; unsigned ledgers have a budget per
 *  address; sandbox children are counted; unsigned casual deltas age out.
 *    node --test demo/hardening.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode, peerOrigin } from '../node/litnode.js';
import { createSandbox } from '../node/sandbox.js';
import { seal, generateKeypair } from '../protocol/keys.js';
import { HEARTBEAT_TAG, epochOf } from '../protocol/snapshot.js';
import { QUEUE_TAG, bucketOf } from '../protocol/pairing.js';
import { until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'tug.v1.js');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-hardening-'));
const nodes = [];
test.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

const post = (node, path, body, headers = {}) => fetch(`${node.addr}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const health = async (node) => (await fetch(`${node.addr}/health`)).json();
const heartbeat = (kp, addr) => seal(HEARTBEAT_TAG, { nodeId: kp.publicKey, operator: 'x', roles: ['mesh'], region: 'local', addr, wsAddr: null, standing: 0, version: '0.0.0', protocol: PROTOCOL_VERSION, buildHashes: {}, manifests: {}, epoch: epochOf(Date.now()) }, kp);

test('peerOrigin: an http(s) origin and nothing else', () => {
  assert.equal(peerOrigin('http://127.0.0.1:7801'), 'http://127.0.0.1:7801');
  assert.equal(peerOrigin('https://node.example.com'), 'https://node.example.com');
  assert.equal(peerOrigin('https://node.example.com/'), 'https://node.example.com');
  for (const bad of ['http://127.0.0.1:7801/update?x=', 'http://127.0.0.1:7801/update', 'http://a:b@host', 'ftp://host', 'host:7801', 'http://host/#x', '', null, 42, 'http://' + 'a'.repeat(300)]) assert.equal(peerOrigin(bad), null, String(bad));
});

test('hardening: a heartbeat whose addr carries a path is refused; the node\'s own push never passes as loopback; oversize bodies are cut off', { timeout: 30_000 }, async () => {
  const a = await createNode({ dataDir: join(tmp, 'a'), offline: true, heartbeatMs: 200, operator: 'a', roles: ['mesh', 'host'], rulesets: [RULESET], updates: false });
  nodes.push(a);
  const evil = await generateKeypair(), fine = await generateKeypair();
  await post(a, '/gossip', { heartbeats: [await heartbeat(evil, `${a.addr}/update?x=`), await heartbeat(fine, 'http://127.0.0.1:9')] });
  const peers = (await (await fetch(`${a.addr}/peers`)).json()).peers.map((p) => p.nodeId);
  assert.ok(peers.includes(fine.publicKey), 'a bare origin is learned');
  assert.ok(!peers.includes(evil.publicKey), 'an addr with a path is refused whole');
  const h = await health(a);
  assert.ok((h.gossipLimits?.refused?.heartbeat?.badAddr ?? 0) >= 1, `refusal counted: ${JSON.stringify(h.gossipLimits)}`);

  // The operator's machine may apply an update; a request wearing the node's own push header may not, even from loopback.
  const r = await post(a, '/update', {}, { 'x-litnode-from': evil.publicKey });
  assert.equal(r.status, 403);

  // 5 MB in one request: refused at the cap and the socket closed; the node answers the next request.
  const big = JSON.stringify({ matchId: 'x', participants: [], rulesetId: 'tug.v1', pad: 'p'.repeat(5_000_000) });
  const outcome = await post(a, '/ledger', big).then((res) => res.status).catch((e) => e.cause?.code ?? e.message);
  assert.ok(outcome === 400 || typeof outcome === 'string', `cut off, got ${outcome}`);
  assert.equal((await health(a)).nodeId, a.nodeId);
});

test('hardening: a queue entry is typed and for a known title before it is held; unsigned ledgers have a budget per address', { timeout: 30_000 }, async () => {
  const a = await createNode({ dataDir: join(tmp, 'b'), offline: true, heartbeatMs: 200, operator: 'b', roles: ['mesh', 'host'], rulesets: [RULESET], updates: false });
  nodes.push(a);
  const rulesetId = Object.keys((await health(a)).rulesets)[0];
  const p = await generateKeypair();
  const noBucket = await seal(QUEUE_TAG, { playerId: p.publicKey, rulesetId, mode: 'casual', tokenId: '0' }, p);
  assert.equal((await post(a, '/queue', noBucket)).status, 400, 'no bucket');
  const objBucket = await seal(QUEUE_TAG, { playerId: p.publicKey, rulesetId, mode: 'casual', tokenId: '0', bucket: {} }, p);
  assert.equal((await post(a, '/queue', objBucket)).status, 400, 'bucket is not a number');
  const unknown = await seal(QUEUE_TAG, { playerId: p.publicKey, rulesetId: 'nobody.v1', mode: 'casual', tokenId: '0', bucket: bucketOf(Date.now()) }, p);
  assert.equal((await post(a, '/queue', unknown)).status, 400, 'unknown title');
  const ok = await seal(QUEUE_TAG, { playerId: p.publicKey, rulesetId, mode: 'casual', tokenId: '0', bucket: bucketOf(Date.now()) }, p);
  assert.equal((await post(a, '/queue', ok)).status, 202, 'a typed entry for a known title is accepted');

  // Eleven unsigned submissions from one (forwarded, so not the operator's) address: the eleventh is budgeted out.
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await post(a, '/ledger', { matchId: `m${i}`, participants: ['a', 'b'], rulesetId, mode: 'casual', entries: [] }, { 'x-forwarded-for': '203.0.113.9' })).status);
  assert.ok(codes.slice(0, 10).every((c) => c === 400), `malformed but within budget: ${codes}`);
  assert.equal(codes[10], 429);
  // The operator's own machine has no budget.
  assert.equal((await post(a, '/ledger', { matchId: 'm11', participants: ['a', 'b'], rulesetId, mode: 'casual', entries: [] })).status, 400);
});

test('hardening: sandbox children are counted against a ceiling', { timeout: 60_000 }, async () => {
  const sb = createSandbox({ maxConcurrent: 1, timeoutMs: 20_000 });
  const src = readFileSync(RULESET, 'utf8');
  const runs = [1, 2, 3].map(() => sb.one(src, { kind: 'manifest' }));
  const peak = await until(async () => { const s = sb.status(); return s.queued >= 1 ? s : null; }, 10_000, 5);
  assert.ok(peak, 'with one slot, the second and third job waited');
  assert.ok(peak.active <= 1, `never more than one child: ${JSON.stringify(peak)}`);
  const results = await Promise.all(runs);
  assert.equal(results.length, 3);
  assert.deepEqual([sb.status().active, sb.status().queued], [0, 0]);
});

test('hardening: an unsigned casual delta older than a day is dropped with its ledger at start', { timeout: 30_000 }, async () => {
  const dir = join(tmp, 'c');
  for (const d of ['deltas', 'ledgers']) mkdirSync(join(dir, d), { recursive: true });
  const old = { matchId: 'old-host-match', rulesetId: 'tug.v1', mode: 'casual', placed: false, attestation: 'host', settledAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), participants: ['a', 'b'], cosigners: [], disputes: [] };
  const fresh = { ...old, matchId: 'fresh-host-match', settledAt: new Date().toISOString() };
  const signed = { ...old, matchId: 'old-players-match', attestation: 'players' };
  for (const d of [old, fresh, signed]) { writeFileSync(join(dir, 'deltas', `${d.matchId}.json`), JSON.stringify(d)); writeFileSync(join(dir, 'ledgers', `${d.matchId}.json`), JSON.stringify({ matchId: d.matchId })); }
  const a = await createNode({ dataDir: dir, offline: true, heartbeatMs: 200, operator: 'c', roles: ['mesh', 'host'], rulesets: [RULESET], updates: false });
  nodes.push(a);
  assert.ok(!existsSync(join(dir, 'deltas', 'old-host-match.json')) && !existsSync(join(dir, 'ledgers', 'old-host-match.json')), 'the stale unsigned one is gone');
  assert.ok(existsSync(join(dir, 'deltas', 'fresh-host-match.json')), 'a fresh unsigned one stays');
  assert.ok(existsSync(join(dir, 'deltas', 'old-players-match.json')), 'a player-signed one is kept whatever its age');
  const ids = (await (await fetch(`${a.addr}/deltas`)).json()).deltas?.map((d) => d.matchId) ?? [];
  assert.ok(!ids.includes('old-host-match'));
});
