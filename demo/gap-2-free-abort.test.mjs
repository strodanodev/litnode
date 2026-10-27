/** Gap 2 (handoff/mesh-gaps/REPORT.md): aborting a hosted match is free, and a player's own node can host it.
 *
 *  Characterizes TODAY's behaviour, so the suite stays green; a fix flips the assertions marked TODAY.
 *
 *    1. placement() has no input that names who plays: a node bonded by a participant's own wallet is drawn as
 *       host like any other — every time, when it is the only node running the title's match server (the
 *       gauntlet partition is outermost) — and is seated on the panel too.
 *    2. On MatchBook, a host that commits and never settles (it killed its per-match server mid-match) is
 *       expired to Void: no slash, nothing on either player's ladder.
 *    3. On a mesh too small to seat nine (fewer than 13 operators), one dissenting seat voids a match outright:
 *       escalate() voids for want of candidates and nobody is slashed — a participant who sits on the panel
 *       of a match it lost erases it.
 *
 *    node --test demo/gap-2-free-abort.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvm } from './lib/evm.mjs';
import { placement } from '../protocol/placement.js';
import { h, sha256Hex } from '../protocol/canonical.js';
import * as mb from '../protocol/matchbook.js';
import { nodeIdentity } from './lib/ed25519-ref.mjs';

const RID = 'agent-fighter.v1';
const BUILD = 'b'.repeat(64);
const manifest = { buildHash: BUILD, standingFloor: 0, hostPolicy: {} };
const W = { alice: '0x' + 'a1'.repeat(20), op2: '0x' + '02'.repeat(20), op3: '0x' + '03'.repeat(20), op4: '0x' + '04'.repeat(20) };
const node = (id, operator, extra = {}) => ({ nodeId: h('node', id), operator, roles: ['mesh', 'host', 'settler', 'witness'], region: 'lan', standing: 1, eligible: true, buildHashes: { [RID]: BUILD }, wsAddr: 'wss://x', ...extra });
const ALICE = h('player', 'alice'), BOB = h('player', 'bob'); // player keys; alice's binds to W.alice on PlayerProfile
const draws = (nodes, n = 400) => Array.from({ length: n }, (_, i) => placement({ nodes, manifest, rulesetId: RID, matchId: h('match', RID, ALICE, BOB, `beacon-${i}`), beacon: `beacon-${i}`, regions: ['lan', 'lan'] }));

test('gap 2.1: placement draws a participant-run node as host and as a panel seat; nothing in its inputs names the players', () => {
  const aliceNode = node('alice-node', W.alice);
  const others = [node('n2', W.op2), node('n3', W.op3), node('n4', W.op4)];

  // four equal hosts: alice's own node hosts about a quarter of her matches
  const even = draws([aliceNode, ...others]);
  const hosted = even.filter((p) => p.host.nodeId === aliceNode.nodeId).length / even.length;
  assert.ok(hosted > 0.15 && hosted < 0.35, `TODAY: alice's node hosts ${(hosted * 100).toFixed(0)}% of alice's matches (fix: 0%)`);
  const seated = even.filter((p) => p.host.nodeId !== aliceNode.nodeId && p.panel.some((s) => s.nodeId === aliceNode.nodeId)).length;
  assert.ok(seated > 0, `TODAY: alice's node sits on the panel of ${seated}/${even.length} of her own matches (fix: 0)`);

  // alice runs the only node with the title's match server (AF ranked is gauntlet-only): she hosts EVERY match she plays
  const gauntlet = draws([{ ...aliceNode, gauntlets: [RID] }, ...others]);
  assert.equal(gauntlet.filter((p) => p.host.nodeId === aliceNode.nodeId).length, gauntlet.length, 'TODAY: the sole gauntlet runner hosts 100% of its operator\'s own matches');

  // there is no input to exclude her: the players' keys or wallets change nothing
  const args = { nodes: [aliceNode, ...others], manifest, rulesetId: RID, matchId: h('match', 'x'), beacon: 'x', regions: ['lan', 'lan'] };
  const a = placement(args), b = placement({ ...args, participants: [ALICE, BOB], owners: { [ALICE]: W.alice } });
  assert.deepEqual(b.order.map((n) => n.nodeId), a.order.map((n) => n.nodeId), 'TODAY: placement takes no participants (fix: an owners map, or a chain-derived one, excludes them)');
});

// ---- the contract side, on an in-process EVM (as demo/matchbook-vm.test.mjs)
const ONE = 10n ** 18n;
const PARAMS = { settleWindow: 60n, attestWindow: 120n, escalationWindow: 300n, drawDelay: 2n, hostSlashBps: 1000, witnessSlashBps: 500 };
const ident = (i) => nodeIdentity(`node-${i}`);
const key = (i) => ident(i).key;
const H = (s) => '0x' + sha256Hex(s);
const ADMIN = 0, TREASURY = 23;
async function mesh(n) {
  const evm = await createEvm();
  const token = await evm.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await evm.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 120, 1200, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]);
  const book = await evm.deploy('MatchBook.sol', 'MatchBook', [stake, PARAMS, evm.addressOf(ADMIN)]);
  await evm.send(ADMIN, stake, 'setAdjudicator', [book, true]);
  for (let i = 1; i <= n; i++) { await evm.send(i, token, 'faucet', []); await evm.send(i, token, 'approve', [stake, 1000n * ONE]); await evm.bondNode(i, stake, ident(i), ONE); }
  evm.warp(120);
  for (let i = 1; i <= n; i++) await evm.send(i, book, 'enroll', [key(i)]);
  return {
    evm, book,
    bondOf: async (i) => (await evm.read(stake, 'standingOf', [key(i)]))[1],
    treasury: async () => (await evm.read(token, 'balanceOf', [evm.addressOf(TREASURY)]))[0],
    status: async (id) => mb.STATUS[Number((await evm.read(book, 'statusOf', [id]))[0])],
    fold: () => mb.foldChain(evm.allLogs().filter((l) => l.address.toLowerCase() === book).map(mb.decodeLog).filter(Boolean), 'tug.v1', { services: { leaderboard: { kind: 'elo', k: 24 }, stats: true } }, { rulesets: mb.rulesetKeys(['tug.v1']) }),
  };
}

test('gap 2.2: a host that commits and kills its match server mid-match is expired to Void — no slash, nothing on either ladder', { timeout: 120_000 }, async () => {
  const m = await mesh(4); // node 1: the host (alice's own node, say); 2..4 the panel
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1');
  const id = H('losing-match');
  await m.evm.send(1, m.book, 'commit', [id, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  // ...play starts; alice is losing; her node stops the per-match server. No settle is ever sent.
  m.evm.warp(Number(PARAMS.settleWindow) + 1);
  const t0 = await m.treasury();
  await m.evm.send(3, m.book, 'expire', [id]); // a seat's backstop (node/matchbook.js drive) does exactly this
  assert.equal(await m.status(id), 'void');
  assert.equal(await m.bondOf(1), ONE, 'TODAY: the host keeps its whole bond (fix keeps this: honest crashes happen; demote in the draw instead)');
  assert.equal(await m.treasury(), t0, 'nobody slashed');
  assert.deepEqual(m.fold().counts, { official: 0, pending: 0 }, 'the match never reaches any ladder: no Elo moved for either player');
});

test('gap 2.3: below 13 operators one dissenting seat voids a settled match, and keeps its bond', { timeout: 120_000 }, async () => {
  const m = await mesh(4);
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1');
  const id = H('settled-loss');
  const ledger = { matchId: 'settled-loss', entries: [{ k: 0, inputs: [1, 2] }], participants: ['alice', 'bob'] };
  await m.evm.send(1, m.book, 'commit', [id, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await m.evm.send(1, m.book, 'settle', [id, H('r'), '0x' + mb.ledgerHash(ledger), H('b'), [H('alice'), H('bob')], [0, 3], [key(1)]]);
  await m.evm.send(2, m.book, 'attest', [id, key(2), H('r')]);
  await m.evm.send(3, m.book, 'attest', [id, key(3), H('not-what-happened')]); // seat 3: alice's second node
  await m.evm.send(4, m.book, 'attest', [id, key(4), H('r')]);
  await m.evm.send(2, m.book, 'finalize', [id]);
  assert.equal(await m.status(id), 'escalating', 'one dissent, two agreeing: escalation, not final');
  m.evm.mine(Number(PARAMS.drawDelay) + 1);
  const t0 = await m.treasury();
  await m.evm.send(1, m.book, 'escalate', [id, mb.ledgerBytes(ledger)]); // the honest host feeds the ledger at once
  assert.equal(await m.status(id), 'void', 'TODAY: too few candidates to seat nine → void');
  assert.equal(await m.bondOf(3), ONE, 'TODAY: the dissenter keeps its bond (fix: the dissent is answered by replay, not by headcount)');
  assert.equal(await m.treasury(), t0);
  assert.deepEqual(m.fold().counts, { official: 0, pending: 0 }, 'alice\'s 0–3 loss is on no ladder');
});
