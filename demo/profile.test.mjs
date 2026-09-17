/** Wallet-bound player profiles (docs/WALLET-IDENTITY.md), everything short
 *  of the chain itself: the eth_call payloads and decoders, the register
 *  calldata a wallet signs, the fold by owner, and a node against a mocked
 *  PlayerProfile — a revoked key is refused at /queue, /profile answers, and
 *  /leaderboard?by=owner merges two keys of one wallet into one row.
 *    node --test demo/profile.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair, seal } from '../protocol/keys.js';
import { createLog, ledgerBody, signLedger } from '../protocol/log.js';
import { agent, hydrationManifest } from '../protocol/erc6699.js';
import { h } from '../protocol/canonical.js';
import { selector } from '../protocol/keccak.js';
import { QUEUE_TAG, bucketOf } from '../protocol/pairing.js';
import { derive } from '../protocol/derive.js';
import { ownerOfKeyCall, decodeOwner, decodeString, registerCalldata, bindKeyCalldata, applyProfiles, OWNER_OF_KEY, REGISTER, NAME_OF } from '../protocol/profile.js';

const CONTRACT = '0x' + '22'.repeat(20);
const OWNER = '0x' + 'ab'.repeat(20);
const KEY = 'cd'.repeat(32);

test('profile: ownerOfKey call and result, string decode, register calldata', () => {
  const c = ownerOfKeyCall(CONTRACT, KEY);
  assert.equal(c.to, CONTRACT);
  assert.ok(c.data.startsWith(selector(OWNER_OF_KEY)));
  assert.equal(c.data.length, 2 + 8 + 64);

  const enc = (owner, tokenId, active) => '0x' + '0'.repeat(24) + owner.slice(2) + tokenId.toString(16).padStart(64, '0') + (active ? '1' : '0').padStart(64, '0');
  const o = decodeOwner(enc(OWNER, 7n, true));
  assert.deepEqual(o, { owner: OWNER, tokenId: 7n, active: true });
  assert.equal(decodeOwner(enc('0x' + '0'.repeat(40), 0n, false)).owner, null, 'never bound → no owner');

  const str = (s) => { const b = Buffer.from(s, 'utf8').toString('hex'); return '0x' + (0x20).toString(16).padStart(64, '0') + (b.length / 2).toString(16).padStart(64, '0') + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };
  assert.equal(decodeString(str('Nezuko')), 'Nezuko');
  assert.equal(decodeString(str('')), '');

  const cd = registerCalldata(KEY, 'Nezuko');
  assert.ok(cd.startsWith(selector(REGISTER)));
  const words = cd.slice(10).match(/.{64}/g);
  assert.equal(words[0], KEY, 'bytes32 key first');
  assert.equal(BigInt('0x' + words[1]), 0x40n, 'string offset after two head words');
  assert.equal(BigInt('0x' + words[2]), 6n, 'string length');
  assert.equal(Buffer.from(words[3].slice(0, 12), 'hex').toString(), 'Nezuko');
  assert.equal(words.length, 4);
  assert.throws(() => registerCalldata(KEY, 'no"quotes'), /name/);
  assert.throws(() => registerCalldata(KEY, 'x'.repeat(33)), /name/);
  assert.equal(bindKeyCalldata(KEY).length, 10 + 64);
  assert.ok(selector(NAME_OF).length === 10);
});

test('profile: applyProfiles folds two keys of one owner into one ladder row; a self-match stays keyed', () => {
  const svc = { leaderboard: { kind: 'elo', k: 24 }, stats: true };
  const d = (id, a, b, win) => ({ matchId: id, epoch: 1, mode: 'ranked', participants: [a, b], scores: { [a]: win === a ? 1 : 0, [b]: win === b ? 1 : 0 }, ticks: 10, cosigners: [] });
  const profiles = { A: { owner: OWNER, tokenId: 1n, active: true }, B: { owner: OWNER, tokenId: 1n, active: true }, R: { owner: '0x' + 'ee'.repeat(20), tokenId: 2n, active: false } };
  const deltas = [d('m1', 'A', 'C', 'A'), d('m2', 'B', 'C', 'B'), d('m3', 'R', 'C', 'C')];
  const byKey = derive(deltas, { services: svc });
  const byOwner = derive(applyProfiles(deltas, profiles), { services: svc });
  assert.equal(byKey.leaderboard.length, 4);
  assert.equal(byOwner.leaderboard.length, 3, 'A and B became one owner; R stays a key (revoked)');
  assert.equal(byOwner.stats[OWNER.toLowerCase()].matches, 2);
  assert.equal(byOwner.stats.R.matches, 1);
  assert.notEqual(byKey.digest, byOwner.digest);
  const self = applyProfiles([d('m4', 'A', 'B', 'A')], profiles)[0];
  assert.deepEqual(self.participants, ['A', 'B'], 'both sides one wallet → left under the keys');
});

// ---------------------------------------------------------------- a node against a mocked PlayerProfile
const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);
const tmp = mkdtempSync(join(tmpdir(), 'litnode-profile-'));

async function playSigned(matchId, kps) {
  const P = kps.map((k) => k.publicKey);
  const agents = { [P[0]]: agent({ tokenId: 1, stats: { strength: 30000, agility: 58000, resilience: 20000, intelligence: 40000 }, manifest: { soulManifestHash: 'aa' } }),
                   [P[1]]: agent({ tokenId: 2, stats: { strength: 65535, agility: 5000, resilience: 60000, intelligence: 1000 }, manifest: { soulManifestHash: 'bb' } }) };
  const s = title.init(h('seed', matchId), P, { agents });
  const ai = [engine.createAi(0, 60, 11), engine.createAi(1, 60, 99)];
  const log = createLog();
  while (!title.done(s)) { const fr = [engine.aiPoll(ai[0], s), engine.aiPoll(ai[1], s)]; log.append(fr); title.step(s, { [P[0]]: fr[0], [P[1]]: fr[1] }); }
  const hm = hydrationManifest({ agents: [agents[P[0]], agents[P[1]]], mode: 'casual', balanceVersion: balance.version });
  const body = ledgerBody({ matchId, ticks: log.length, head: log.head, buildHash: manifest.buildHash, hydrationHash: hm.manifestHash });
  const signatures = Object.fromEntries(await Promise.all(kps.map(async (k) => [k.publicKey, await signLedger(body, k)])));
  return { matchId, rulesetId: 'agent-fighter.v1', buildHash: manifest.buildHash, mode: 'casual', participants: P, entries: log.entries(), signatures, hydration: { agents } };
}

/** A JSON-RPC that knows one block and one PlayerProfile. */
function mockChain(bindings, names) {
  const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
  return async (url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    let result;
    if (method === 'eth_getBlockByNumber') result = { number: '0x10', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + 'ff'.repeat(32) };
    else if (method === 'eth_call') {
      const data = params[0].data;
      if (data.startsWith(selector(OWNER_OF_KEY))) { const b = bindings[data.slice(10)] ?? { owner: '0x' + '0'.repeat(40), tokenId: 0n, active: false }; result = '0x' + word(b.owner) + word(b.tokenId.toString(16)) + word(b.active ? '1' : '0'); }
      else if (data.startsWith(selector(NAME_OF))) { const n = names[BigInt('0x' + data.slice(10))] ?? ''; const hex = Buffer.from(n).toString('hex'); result = '0x' + word('20') + word((hex.length / 2).toString(16)) + hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0'); }
      else result = '0x';
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
}

test('profile: node reads bindings, refuses a revoked key, answers /profile, folds the ladder by owner', { timeout: 60_000 }, async (t) => {
  const [alice1, alice2, bob, revoked] = await Promise.all([generateKeypair(), generateKeypair(), generateKeypair(), generateKeypair()]);
  const bindings = {
    [alice1.publicKey]: { owner: OWNER, tokenId: 1n, active: true },
    [alice2.publicKey]: { owner: OWNER, tokenId: 1n, active: true },
    [revoked.publicKey]: { owner: '0x' + 'ee'.repeat(20), tokenId: 2n, active: false },
  };
  const node = await createNode({ dataDir: join(tmp, 'n'), rpc: 'mock://', offline: false, playerProfile: CONTRACT, chainFetch: mockChain(bindings, { 1n: 'Nezuko', 2n: 'Ghost' }), heartbeatMs: 200, operator: 'publisher', roles: ['mesh', 'host', 'witness', 'settler'], rulesets: [RULESET] });
  t.after(async () => { await node.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const json = async (p, init) => { const r = await fetch(`${node.addr}${p}`, init); return { status: r.status, body: await r.json() }; };

  // alice plays bob twice, once per device key; bob wins one
  for (const [i, kp] of [alice1, alice2].entries()) {
    const sub = await playSigned(`prof-${i}`, [kp, bob]);
    const r = await json('/ledger', { method: 'POST', body: JSON.stringify(sub) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  await new Promise((r) => setTimeout(r, 600)); // a tick reads the participants' bindings

  assert.equal((await json('/health')).body.profiles, 'chain');
  const byKey = (await json('/leaderboard?ruleset=agent-fighter.v1&scope=all')).body;
  const byOwner = (await json('/leaderboard?ruleset=agent-fighter.v1&by=owner&scope=all')).body;
  assert.equal(byKey.by, 'key'); assert.equal(byKey.leaderboard.length, 3);
  assert.equal(byOwner.by, 'owner'); assert.equal(byOwner.leaderboard.length, 2, 'two alice keys → one wallet row');
  assert.ok(byOwner.leaderboard.some((r) => r.player === OWNER.toLowerCase()));
  const st = (await json('/stats?ruleset=agent-fighter.v1&by=owner&scope=all&player=' + OWNER.toLowerCase())).body;
  assert.equal(st.matches, 2);

  const p = (await json(`/profile?player=${alice1.publicKey}`)).body;
  assert.equal(p.owner, OWNER); assert.equal(p.tokenId, '1'); assert.equal(p.active, true); assert.equal(p.name, 'Nezuko');
  const g = (await json(`/profile?player=${bob.publicKey}`)).body;
  assert.equal(g.owner, null, 'an unbound key is a guest');

  const entry = async (kp) => seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: 'agent-fighter.v1', tokenId: '1', mode: 'ranked', bucket: bucketOf(Date.now()) }, kp);
  assert.equal((await json('/queue', { method: 'POST', body: JSON.stringify(await entry(bob)) })).status, 202, 'guest key queues');
  assert.equal((await json('/queue', { method: 'POST', body: JSON.stringify(await entry(alice1)) })).status, 202, 'bound key queues');
  const rv = await json('/queue', { method: 'POST', body: JSON.stringify(await entry(revoked)) });
  assert.equal(rv.status, 403); assert.match(rv.body.error, /revoked/);
});
