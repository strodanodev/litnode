/** MatchBook (BUILD-SPEC v0.3 §6, §11): the node-side calldata matches
 *  ethers' encoding of the contract ABI, event logs decode the way ethers
 *  emits them, and the fold over the log gives official / pending ladders
 *  with the same digest whatever order the logs arrive in.
 *    node --test demo/matchbook.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import solc from 'solc';
import { ethers } from 'ethers';
import * as mb from '../protocol/matchbook.js';
import { selector } from '../protocol/keccak.js';
import { sha256Hex, canonical } from '../protocol/canonical.js';

// The ABI straight from the compiler, so the encoders are checked against the contract as written.
const src = readFileSync(join(process.cwd(), 'contracts', 'MatchBook.sol'), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'MatchBook.sol': { content: src } }, settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.methodIdentifiers'] } } } })));
assert.deepEqual((out.errors ?? []).filter((e) => e.severity === 'error'), []);
const { abi, evm } = out.contracts['MatchBook.sol'].MatchBook;
const iface = new ethers.Interface(abi);
const H = (s) => sha256Hex(s);
const K = { match: H('m1'), desc: H('d'), host: H('host'), w1: H('w1'), w2: H('w2'), w3: H('w3'), build: H('b'), result: H('r'), p1: H('p1'), p2: H('p2') };
const x = (h) => '0x' + h;

test('matchbook: selectors and event topics match solc', () => {
  for (const sig of [mb.COMMIT, mb.SETTLE, mb.ATTEST, mb.FINALIZE, mb.ESCALATE, mb.RESOLVE, mb.EXPIRE, mb.ENROLL, mb.WITHDRAW, mb.STATUS_OF, mb.PANEL_OF, mb.TOTAL_WINDOW]) {
    assert.ok(evm.methodIdentifiers[sig] !== undefined, `contract lacks ${sig}`);
    assert.equal(selector(sig), '0x' + evm.methodIdentifiers[sig]);
  }
  for (const name of Object.keys(mb.EVENTS)) assert.equal(mb.topic(name), iface.getEvent(name).topicHash, name);
});

test('matchbook: calldata matches ethers for every call the delegate sends', () => {
  assert.equal(mb.commitCalldata(K.match, K.desc, 'agent-fighter.v1', K.host, [K.w1, K.w2, K.w3]),
    iface.encodeFunctionData('commit', [x(K.match), x(K.desc), x(mb.rulesetIdBytes32('agent-fighter.v1')), x(K.host), [x(K.w1), x(K.w2), x(K.w3)]]));
  const ledger = { matchId: 'mmtyf9tz57bbb-3', entries: [{ k: 0, inputs: [1, 2] }, { k: 1, inputs: [0, 3] }], participants: ['af:ann', K.p2] };
  const lh = sha256Hex(new TextEncoder().encode(canonical(ledger)));
  assert.equal(mb.ledgerHash(ledger), lh);
  const cd = mb.settleCalldata('mmtyf9tz57bbb-3', { resultHash: K.result, ledger, buildHash: K.build, participants: ['af:ann', K.p2], scores: { 'af:ann': 2, [K.p2]: -1.4 }, custodians: [K.host, K.w1] });
  assert.equal(cd, iface.encodeFunctionData('settle', [x(mb.matchIdBytes32('mmtyf9tz57bbb-3')), x(K.result), x(lh), x(K.build), [x(mb.playerBytes32('af:ann')), x(K.p2)], [2, -1], [x(K.host), x(K.w1)]]));
  assert.equal(mb.attestCalldata(K.match, K.w1, K.result), iface.encodeFunctionData('attest', [x(K.match), x(K.w1), x(K.result)]));
  assert.equal(mb.finalizeCalldata(K.match), iface.encodeFunctionData('finalize', [x(K.match)]));
  assert.equal(mb.escalateCalldata(K.match, ledger), iface.encodeFunctionData('escalate', [x(K.match), mb.ledgerBytes(ledger)]));
  assert.equal(mb.resolveCalldata(K.match), iface.encodeFunctionData('resolve', [x(K.match)]));
  assert.equal(mb.expireCalldata(K.match), iface.encodeFunctionData('expire', [x(K.match)]));
  assert.equal(mb.enrollCalldata(K.w1), iface.encodeFunctionData('enroll', [x(K.w1)]));
  assert.equal(mb.statusOfCall('0x' + '11'.repeat(20), K.match).data, iface.encodeFunctionData('statusOf', [x(K.match)]));
  assert.throws(() => mb.commitCalldata(K.match, K.desc, 'x', K.host, [K.w1]), /three/);
  assert.throws(() => mb.settleCalldata(K.match, { resultHash: K.result, ledger, buildHash: K.build, participants: [K.p1], scores: { [K.p1]: 2 ** 70 } }), /int64/);
});

test('matchbook: reads decode', () => {
  const st = ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'bytes32', 'uint8', 'uint8'], [2, x(K.result), 2, 1]);
  assert.deepEqual(mb.decodeStatus(st), { status: 'settled', resultHash: K.result, attests: 2, agreeing: 1 });
  const p = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[3]'], [[x(K.w1), x(K.w2), x(K.w3)]]);
  assert.deepEqual(mb.decodePanel(p), [K.w1, K.w2, K.w3]);
});

/** A log entry as eth_getLogs returns it, built by ethers from the ABI. */
const emitted = (name, args, block, logIndex) => {
  const { data, topics } = iface.encodeEventLog(name, args);
  return { address: '0x' + '11'.repeat(20), data, topics, blockNumber: '0x' + block.toString(16), logIndex: '0x' + logIndex.toString(16), transactionHash: '0x' + 'ab'.repeat(32) };
};
const RS = mb.rulesetIdBytes32('tug.v1');
const manifest = { services: { leaderboard: { kind: 'elo', k: 24 }, credits: { kind: 'pot', currency: 'credits', pot: 10 }, stats: true } };

test('matchbook: event logs decode; the fold gives official and pending ladders, order-independent', () => {
  const m1 = H('match-1'), m2 = H('match-2'), m3 = H('match-3');
  const logs = [
    emitted('Committed', [x(m1), x(RS), x(K.host), x(K.desc), [x(K.w1), x(K.w2), x(K.w3)]], 100, 0),
    emitted('Settled', [x(m1), x(RS), x(K.host), x(K.result), x(H('l1')), x(K.build), [x(K.p1), x(K.p2)], [3, 1], [x(K.host), x(K.w1)]], 101, 0),
    emitted('Attested', [x(m1), x(K.w1), x(K.result), true, false], 102, 0),
    emitted('Attested', [x(m1), x(K.w2), x(K.result), true, false], 102, 1),
    emitted('Finalized', [x(m1), x(RS), x(K.result), 3], 103, 0),
    // m2: settled, not decided → pending
    emitted('Settled', [x(m2), x(RS), x(K.host), x(H('r2')), x(H('l2')), x(K.build), [x(K.p2), x(K.p1)], [2, 0], [x(K.host)]], 104, 0),
    // m3: voided → dropped
    emitted('Settled', [x(m3), x(RS), x(K.host), x(H('r3')), x(H('l3')), x(K.build), [x(K.p1), x(K.p2)], [0, 9], []], 105, 0),
    emitted('Finalized', [x(m3), x(RS), ethers.ZeroHash, 4], 106, 0),
    emitted('Escalating', [x(m3), 105, 1_800_000_000], 105, 1),
    emitted('Escalated', [x(m3), x(H('l3')), [x(K.w1), x(K.w2)], [5n * 10n ** 18n, 1n * 10n ** 18n]], 106, 1),
    emitted('Extended', [x(m2), 1_800_000_000], 107, 0),
    { address: '0x' + '22'.repeat(20), data: '0x', topics: ['0x' + 'ff'.repeat(32)], blockNumber: '0x1', logIndex: '0x0' }, // foreign
  ];
  const dec = logs.map(mb.decodeLog);
  assert.equal(dec.at(-1), null, 'a foreign log decodes to null');
  assert.deepEqual(dec[1], { event: 'Settled', matchId: m1, block: 101, logIndex: 0, tx: '0x' + 'ab'.repeat(32), rulesetKey: RS, hostKey: K.host, resultHash: K.result, ledgerHash: H('l1'), buildHash: K.build, participants: [K.p1, K.p2], scores: [3, 1], custodians: [K.host, K.w1] });
  assert.deepEqual(dec[0].panel, [K.w1, K.w2, K.w3]);
  assert.equal(dec[2].agrees, true); assert.equal(dec[2].escalation, false);
  assert.equal(dec[4].status, 'final'); assert.equal(dec[7].status, 'void');
  assert.deepEqual(dec[8], { event: 'Escalating', matchId: m3, block: 105, logIndex: 1, tx: '0x' + 'ab'.repeat(32), drawBlock: 105, feedBy: 1_800_000_000 });
  assert.deepEqual(dec[9].panel, [K.w1, K.w2]); assert.deepEqual(dec[9].weights, [5n * 10n ** 18n, 1n * 10n ** 18n]);
  assert.equal(dec[10].until, 1_800_000_000);

  const rulesets = mb.rulesetKeys(['tug.v1', 'agent-fighter.v1']);
  const deltas = mb.chainDeltas(dec, { rulesets });
  assert.deepEqual(deltas.map((d) => [d.matchId, d.rulesetId, d.chainStatus, d.official]), [[m1, 'tug.v1', 'final', true], [m2, 'tug.v1', 'pending', false]]);
  assert.deepEqual(deltas[0].scores, { [K.p1]: 3, [K.p2]: 1 });
  const f = mb.foldChain(dec, 'tug.v1', manifest, { rulesets });
  assert.deepEqual(f.counts, { official: 1, pending: 1 });
  assert.equal(f.official.leaderboard[0].player, K.p1, 'p1 won the only final match');
  assert.equal(f.pending.leaderboard[0].player, K.p2, 'with m2 folded in p2 leads: it beat p1 as the underdog (1188 v 1212), which pays more than the even win p1 took');
  assert.equal(f.official.credits.credits[K.p1], 10);
  assert.equal(f.pending.credits.credits[K.p2], 10, 'the pending pot is visible in the pending view only');
  assert.equal(f.official.credits.credits[K.p2], 0);
  // block order is the order: shuffled logs give the same digests
  const shuffled = [...dec].reverse();
  const g = mb.foldChain(shuffled, 'tug.v1', manifest, { rulesets });
  assert.equal(g.official.digest, f.official.digest); assert.equal(g.pending.digest, f.pending.digest);
  assert.deepEqual(f.cursor, { block: 107 }, 'cursor = last block read, void and all');
  assert.equal(mb.foldChain(dec, 'agent-fighter.v1', manifest, { rulesets }).counts.pending, 0);
});
