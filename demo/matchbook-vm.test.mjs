/** The contracts' BEHAVIOUR, executed: NodeStake v3's lock, eligibility
 *  age, adjudicator-only slashing and bounds; MatchBook's whole lifecycle —
 *  commit refusals, settle window, the happy path, the liveness extension,
 *  a dissent escalating to nine seats, a resolution against the host and
 *  one for the host, slashes landing in the treasury, expiry of every
 *  stuck state — and the two attacks from the 22 Sep review: a top-up after
 *  the draw must not change the tally (weights are snapshotted) and the
 *  seed block is fixed before anyone can call escalate(). Runs on an
 *  in-process EVM (demo/lib/evm.mjs); the protocol decoders fold the real
 *  event log at the end.
 *    node --test demo/matchbook-vm.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createEvm } from './lib/evm.mjs';
import { sha256Hex } from '../protocol/canonical.js';
import * as mb from '../protocol/matchbook.js';

const ONE = 10n ** 18n;
const PARAMS = { settleWindow: 60n, attestWindow: 120n, escalationWindow: 300n, drawDelay: 2n, hostSlashBps: 1000, witnessSlashBps: 500 };
const LOCK = 600, AGE = 120, UNBOND = 1200;
const key = (i) => '0x' + sha256Hex(`node-${i}`);
const H = (s) => '0x' + sha256Hex(s);
const ADMIN = 0, TREASURY = 23;
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

/** A mesh: token, NodeStake v3, MatchBook (adjudicator); nodes 1..n bonded by
 *  account i (operator = delegate for simplicity), enrolled in the pool,
 *  aged past eligibility. Node i's bond is `bond(i)` tokens. */
async function mesh(n, bond = () => 1n) {
  const evm = await createEvm();
  const token = await evm.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await evm.deploy('NodeStake.sol', 'NodeStake', [token, ONE, LOCK, AGE, UNBOND, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]);
  const book = await evm.deploy('MatchBook.sol', 'MatchBook', [stake, PARAMS, evm.addressOf(ADMIN)]);
  await evm.send(ADMIN, stake, 'setAdjudicator', [book, true]);
  for (let i = 1; i <= n; i++) {
    await evm.send(i, token, 'faucet', []);
    await evm.send(i, token, 'approve', [stake, 1000n * ONE]);
    await evm.send(i, stake, 'stake', [key(i), bond(i) * ONE]);
    await evm.send(i, book, 'enroll', [key(i)]);
  }
  evm.warp(AGE);
  const bondOf = async (i) => (await evm.read(stake, 'standingOf', [key(i)]))[1];
  const treasury = async () => (await evm.read(token, 'balanceOf', [evm.addressOf(TREASURY)]))[0];
  const status = async (id) => mb.STATUS[Number((await evm.read(book, 'statusOf', [id]))[0])];
  return { evm, token, stake, book, bondOf, treasury, status };
}

test('NodeStake v3: lock, eligibility age, top-ups, re-stake, adjudicator-only slash, bounded params', { timeout: 120_000 }, async () => {
  const { evm, token, stake, book } = await mesh(2);
  // lock: unstake refused until bondedSince + lockTerm
  await rejects(evm.send(1, stake, 'unstake', [key(1)]), /StillLocked/);
  assert.equal((await evm.read(stake, 'witnessEligible', [key(1)]))[0], true, 'aged past eligibility');
  // a top-up restarts the ELIGIBILITY age, not the lock
  await evm.send(1, stake, 'stake', [key(1), ONE]);
  assert.equal((await evm.read(stake, 'witnessEligible', [key(1)]))[0], false, 'fresh stake: not eligible to be drawn');
  assert.equal((await evm.read(stake, 'standingOf', [key(1)]))[2], true, 'but still active for hosting');
  evm.warp(AGE);
  assert.equal((await evm.read(stake, 'witnessEligible', [key(1)]))[0], true);
  // after the lock: unstake, then withdraw only after the unbonding period
  evm.warp(LOCK);
  await evm.send(1, stake, 'unstake', [key(1)]);
  assert.equal((await evm.read(stake, 'standingOf', [key(1)]))[2], false, 'unbonding = not active');
  await rejects(evm.send(1, stake, 'withdraw', [key(1)]), /StillBonded/);
  evm.warp(UNBOND);
  await evm.send(1, stake, 'withdraw', [key(1)]);
  assert.equal((await evm.read(stake, 'standingOf', [key(1)]))[1], 0n);
  // re-stake after withdraw: a NEW lock (the v3 review's bug 8)
  await evm.send(1, stake, 'stake', [key(1), ONE]);
  await rejects(evm.send(1, stake, 'unstake', [key(1)]), /StillLocked/, 'unbond-and-rebond does not skip the lock');
  // only an adjudicator contract may slash; the admin wallet may not
  await rejects(evm.send(ADMIN, stake, 'slash', [key(2), 1000, H('x')]), /NotAdjudicator/);
  await rejects(evm.send(1, stake, 'slash', [key(2), 1000, H('x')]), /NotAdjudicator/);
  // bounded admin: a term past MAX_TERM is refused
  await rejects(evm.send(ADMIN, stake, 'setParams', [ONE, 366n * 86400n, AGE, UNBOND, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]), /BadParams/);
  await rejects(evm.send(1, stake, 'setParams', [ONE, LOCK, AGE, UNBOND, evm.addressOf(1), evm.addressOf(1)]), /NotAdmin/);
  // delegate: may act for the key on MatchBook, may not move the bond
  await evm.send(2, stake, 'setDelegate', [key(2), evm.addressOf(10)]);
  assert.equal((await evm.read(stake, 'mayActFor', [key(2), evm.addressOf(10)]))[0], true);
  await rejects(evm.send(10, stake, 'unstake', [key(2)]), /NotOperator/);
  await rejects(evm.send(10, stake, 'setDelegate', [key(2), evm.addressOf(11)]), /NotOperator/);
  await evm.send(10, book, 'withdraw', [key(2)]); // the delegate can leave the pool for its node
  assert.deepEqual((await evm.read(book, 'pool', []))[0].map((k) => k.toLowerCase()), [key(1)]);
  void token;
});

test('MatchBook: commit refusals, settle window, the happy path, expiry of an abandoned commit', { timeout: 120_000 }, async () => {
  const { evm, stake, book, status } = await mesh(6);
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1');
  const m1 = H('m1');
  // refusals
  await rejects(evm.send(1, book, 'commit', [m1, H('d'), RS, key(1), [key(1), key(2), key(3)]]), /BadPanel/, 'host on its own panel');
  await rejects(evm.send(1, book, 'commit', [m1, H('d'), RS, key(1), [key(2), key(2), key(3)]]), /BadPanel/, 'a key twice');
  await rejects(evm.send(2, book, 'commit', [m1, H('d'), RS, key(1), [key(2), key(3), key(4)]]), /NotAllowed/, 'not the host\'s delegate or operator');
  await evm.send(6, stake, 'stake', [key(6), ONE]); // fresh top-up: node 6 is not eligible
  await rejects(evm.send(1, book, 'commit', [m1, H('d'), RS, key(1), [key(2), key(3), key(6)]]), /BadPanel/, 'ineligible panel key');
  await rejects(evm.send(1, book, 'commit', [m1, ethers.ZeroHash, RS, key(1), [key(2), key(3), key(4)]]), /ZeroHash/);
  // an abandoned commit expires
  const c = await evm.send(1, book, 'commit', [m1, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  assert.equal(c.logs[0].name, 'Committed');
  await rejects(evm.send(1, book, 'commit', [m1, H('d'), RS, key(1), [key(2), key(3), key(4)]]), /WrongStatus/);
  await rejects(evm.send(2, book, 'expire', [m1]), /WindowOpen/);
  evm.warp(Number(PARAMS.settleWindow) + 1);
  await rejects(evm.send(1, book, 'settle', [m1, H('r'), H('l'), H('b'), [H('p1'), H('p2')], [1, 0], []]), /WindowClosed/);
  await evm.send(5, book, 'expire', [m1]);
  assert.equal(await status(m1), 'void');
  // the happy path: three agree, finalized as soon as the third answers
  const m2 = H('m2');
  await evm.send(1, book, 'commit', [m2, H('d2'), RS, key(1), [key(2), key(3), key(4)]]);
  await rejects(evm.send(2, book, 'settle', [m2, H('r'), H('l'), H('b'), [H('p1'), H('p2')], [1, 0], []]), /NotAllowed/);
  const s = await evm.send(1, book, 'settle', [m2, H('r'), H('l'), H('b'), [H('p1'), H('p2')], [3, 1], [key(1), key(2)]]);
  assert.equal(s.logs[0].name, 'Settled');
  await rejects(evm.send(5, book, 'attest', [m2, key(5), H('r')]), /NotOnPanel/);
  await rejects(evm.send(2, book, 'attest', [m2, key(2), ethers.ZeroHash]), /ZeroHash/);
  await evm.send(2, book, 'attest', [m2, key(2), H('r')]);
  await rejects(evm.send(2, book, 'attest', [m2, key(2), H('r')]), /AlreadyVoted/);
  await rejects(evm.send(5, book, 'finalize', [m2]), /WindowOpen/, 'one answer, window open');
  await evm.send(3, book, 'attest', [m2, key(3), H('r')]);
  await evm.send(4, book, 'attest', [m2, key(4), H('r')]);
  const f = await evm.send(5, book, 'finalize', [m2]);
  assert.equal(f.logs[0].name, 'Finalized'); assert.equal(Number(f.logs[0].args.status), 3);
  assert.equal(await status(m2), 'final');
  assert.equal(c.gas < 400_000n && s.gas < 200_000n, true, `commit ${c.gas} settle ${s.gas} gas`);
});

test('MatchBook: liveness — one agreeing witness extends the window once; still alone, it escalates; nobody feeds the ledger → expires void', { timeout: 120_000 }, async () => {
  const { evm, book, status } = await mesh(5);
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1'), m = H('m');
  await evm.send(1, book, 'commit', [m, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await evm.send(1, book, 'settle', [m, H('r'), H('l'), H('b'), [H('p1'), H('p2')], [1, 0], []]);
  await evm.send(2, book, 'attest', [m, key(2), H('r')]);
  evm.warp(Number(PARAMS.attestWindow) + 1);
  let r = await evm.send(5, book, 'finalize', [m]);
  assert.equal(r.logs[0].name, 'Extended', 'liveness is not a dispute');
  assert.equal(await status(m), 'settled');
  await evm.send(3, book, 'attest', [m, key(3), H('r')]); // a late witness makes it in
  await rejects(evm.send(5, book, 'finalize', [m]), /WindowOpen/);
  evm.warp(Number(PARAMS.attestWindow) + 1);
  r = await evm.send(5, book, 'finalize', [m]);
  assert.equal(r.logs[0].name, 'Finalized', 'two agree after the extension: final');
  // and one alone, twice: escalates; nobody feeds it: expires
  const m2 = H('m2');
  await evm.send(1, book, 'commit', [m2, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await evm.send(1, book, 'settle', [m2, H('r'), H('l'), H('b'), [H('p1'), H('p2')], [1, 0], []]);
  evm.warp(Number(PARAMS.attestWindow) + 1); await evm.send(5, book, 'finalize', [m2]);
  evm.warp(Number(PARAMS.attestWindow) + 1);
  r = await evm.send(5, book, 'finalize', [m2]);
  assert.equal(r.logs[0].name, 'Escalating'); assert.equal(await status(m2), 'escalating');
  await rejects(evm.send(5, book, 'expire', [m2]), /WindowOpen/);
  evm.warp(Number(PARAMS.escalationWindow) + 1);
  await evm.send(5, book, 'expire', [m2]);
  assert.equal(await status(m2), 'void');
});

/** Sum of every node's bond, for treasury accounting. */
const bonds = async (bondOf, n) => { let t = 0n; for (let i = 1; i <= n; i++) t += await bondOf(i); return t; };

test('MatchBook: a dissent escalates; the nine decide AGAINST the host; every slash lands in the treasury; a post-draw top-up does not change the tally; the seed is fixed before escalate()', { timeout: 300_000 }, async () => {
  const N = 14;
  const { evm, stake, book, bondOf, treasury, status } = await mesh(N, (i) => (i === 3 ? 3n : 1n));
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1'), m = H('m');
  const ledger = { matchId: 'm', entries: [{ k: 0, inputs: [1, 2] }], participants: ['p1', 'p2'] };
  const lh = '0x' + mb.ledgerHash(ledger);
  const idx = (k) => { for (let i = 1; i <= N; i++) if (key(i) === k) return i; throw new Error('unknown key'); };
  await evm.send(1, book, 'commit', [m, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await evm.send(1, book, 'settle', [m, H('lie'), lh, H('b'), [H('p1'), H('p2')], [9, 0], [key(1), key(2), key(3), key(4)]]);
  await evm.send(2, book, 'attest', [m, key(2), H('lie')]);
  const d = await evm.send(3, book, 'attest', [m, key(3), H('truth')]);
  assert.equal(d.logs[0].args.agrees, false, 'a different hash is a dispute');
  await evm.send(4, book, 'attest', [m, key(4), H('lie')]);
  const f = await evm.send(5, book, 'finalize', [m]);
  assert.equal(f.logs[0].name, 'Escalating', '2-against-1 is not decided by the contract: it escalates');
  const drawBlock = Number(f.logs[0].args.drawBlock);
  assert.equal(drawBlock, evm.blockNumber() - 1 + Number(PARAMS.drawDelay), 'the seed block is named at finalize');
  // ATTACK 2: the seed is fixed before anyone can act, and the ledger must be the committed one
  await rejects(evm.send(5, book, 'escalate', [m, mb.ledgerBytes(ledger)]), /SeedNotReady/);
  evm.mine(Number(PARAMS.drawDelay) + 1);
  await rejects(evm.send(5, book, 'escalate', [m, new TextEncoder().encode('not the ledger')]), /LedgerMismatch/);
  const e = await evm.send(5, book, 'escalate', [m, mb.ledgerBytes(ledger)]);
  assert.equal(e.logs[0].name, 'Escalated');
  const nine = e.logs[0].args.panel.map((k) => k.toLowerCase());
  assert.equal(nine.length, 9);
  assert.equal(new Set(nine).size, 9, 'distinct seats');
  for (const k of [key(1), key(2), key(3), key(4)]) assert.ok(!nine.includes(k), 'host and first panel excluded');
  assert.ok(e.gas < 3_000_000n, `escalate gas ${e.gas}`);
  assert.equal(await status(m), 'escalated');
  // the nine vote: five for the truth, three for the lie, one silent
  const truth = nine.slice(0, 5), lie = nine.slice(5, 8), silent = nine[8];
  for (const k of truth) await evm.send(idx(k), book, 'attest', [m, k, H('truth')]);
  for (const k of lie) await evm.send(idx(k), book, 'attest', [m, k, H('lie')]);
  const outsider = [...Array(N).keys()].map((i) => i + 1).find((i) => i > 4 && !nine.includes(key(i)));
  await rejects(evm.send(outsider, book, 'attest', [m, key(outsider), H('lie')]), /NotOnPanel/, 'a node not drawn cannot vote');
  // ATTACK 1: a lie-voter tops up 100 tokens after the draw — the snapshot must ignore it
  const whale = idx(lie[0]);
  await evm.send(whale, stake, 'stake', [key(whale), 100n * ONE]);
  assert.equal(await bondOf(whale), 101n * ONE);
  await rejects(evm.send(5, book, 'resolve', [m]), /WindowOpen/);
  evm.warp(Number(PARAMS.escalationWindow) + 1);
  const before = { all: await bonds(bondOf, N), host: await bondOf(1), w2: await bondOf(2), w3: await bondOf(3), w4: await bondOf(4), whale: await bondOf(whale), treasury: await treasury() };
  const r = await evm.send(5, book, 'resolve', [m]);
  const fin = r.logs.find((l) => l.name === 'Finalized');
  assert.equal(Number(fin.args.status), 4, 'void: the majority rejected the host; the whale’s 100 tokens counted for nothing');
  assert.equal(fin.args.finalHash.toLowerCase(), H('truth'));
  assert.equal(await status(m), 'void');
  // who paid: the host 10%; every key on either panel that voted the lie 5% of its bond NOW; nobody else
  assert.equal(await bondOf(1), before.host - before.host / 10n, 'host slashed 10%');
  assert.equal(await bondOf(2), before.w2 - before.w2 / 20n, 'first-panel seat that backed the lie: 5%');
  assert.equal(await bondOf(4), before.w4 - before.w4 / 20n);
  assert.equal(await bondOf(3), before.w3, 'the dissenter who was right keeps its bond');
  assert.equal(await bondOf(whale), before.whale - before.whale / 20n, 'the whale pays 5% of its now-larger bond: the top-up bought nothing and cost more');
  for (const k of truth) assert.equal(await bondOf(idx(k)), ONE, 'majority voters untouched');
  assert.equal(await bondOf(idx(silent)), ONE, 'a silent seat is not slashed');
  assert.equal((await treasury()) - before.treasury, before.all - (await bonds(bondOf, N)), 'every slashed token reached the treasury');
  assert.equal(r.logs.filter((l) => l.name === 'Slashed').length, 6, 'host + w2 + w4 + three lie-voters');
});

test('MatchBook: the nine decide FOR the host — the original dissenter and the minority pay, the host does not; then too few nodes to seat nine → void, nobody slashed', { timeout: 300_000 }, async () => {
  const N = 14;
  const { evm, book, bondOf, treasury, status } = await mesh(N);
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1'), m = H('m');
  const ledger = { matchId: 'm', entries: [{ k: 0, inputs: [3] }] };
  const idx = (k) => { for (let i = 1; i <= N; i++) if (key(i) === k) return i; throw new Error('unknown key'); };
  await evm.send(1, book, 'commit', [m, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await evm.send(1, book, 'settle', [m, H('r'), '0x' + mb.ledgerHash(ledger), H('b'), [H('p1'), H('p2')], [1, 0], []]);
  await evm.send(2, book, 'attest', [m, key(2), H('r')]);
  await evm.send(3, book, 'attest', [m, key(3), H('r')]);
  await evm.send(4, book, 'attest', [m, key(4), H('wrong')]); // one liar on the panel
  await evm.send(5, book, 'finalize', [m]);
  evm.mine(Number(PARAMS.drawDelay) + 1);
  const e = await evm.send(9, book, 'escalate', [m, mb.ledgerBytes(ledger)]);
  const nine = e.logs[0].args.panel.map((k) => k.toLowerCase());
  for (const k of nine.slice(0, 7)) await evm.send(idx(k), book, 'attest', [m, k, H('r')]);
  for (const k of nine.slice(7)) await evm.send(idx(k), book, 'attest', [m, k, H('wrong')]);
  evm.warp(Number(PARAMS.escalationWindow) + 1);
  const t0 = await treasury();
  const r = await evm.send(5, book, 'resolve', [m]);
  assert.equal(Number(r.logs.find((l) => l.name === 'Finalized').args.status), 3, 'final: the host was right');
  assert.equal(await status(m), 'final');
  assert.equal(await bondOf(1), ONE, 'host untouched');
  assert.equal(await bondOf(2), ONE); assert.equal(await bondOf(3), ONE);
  assert.equal(await bondOf(4), ONE - ONE / 20n, 'the original dissenter pays');
  for (const k of nine.slice(7)) assert.equal(await bondOf(idx(k)), ONE - ONE / 20n, 'the escalation minority pays');
  assert.equal((await treasury()) - t0, 3n * (ONE / 20n));

  // too few: a mesh of 7 (host + 3 panel + 3 candidates) cannot seat nine
  const small = await mesh(7);
  await small.evm.send(1, small.book, 'commit', [m, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await small.evm.send(1, small.book, 'settle', [m, H('r'), '0x' + mb.ledgerHash(ledger), H('b'), [H('p1'), H('p2')], [1, 0], []]);
  await small.evm.send(2, small.book, 'attest', [m, key(2), H('r')]);
  await small.evm.send(3, small.book, 'attest', [m, key(3), H('x')]);
  await small.evm.send(4, small.book, 'attest', [m, key(4), H('r')]);
  await small.evm.send(5, small.book, 'finalize', [m]);
  small.evm.mine(Number(PARAMS.drawDelay) + 1);
  const t1 = await small.treasury();
  const v = await small.evm.send(5, small.book, 'escalate', [m, mb.ledgerBytes(ledger)]);
  assert.equal(Number(v.logs[0].args.status), 4, 'void');
  assert.equal(await small.status(m), 'void');
  assert.equal(await small.treasury(), t1, 'nobody slashed when the network cannot adjudicate');
  assert.equal(await small.bondOf(3), ONE, 'the dissenter is not punished for a question nobody could answer');
});

test('the protocol decoders fold the REAL event log into official and pending ladders', { timeout: 300_000 }, async () => {
  const { evm, book } = await mesh(5);
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1');
  const p1 = H('alice').slice(2), p2 = H('bob').slice(2);
  // m1: final (p1 wins 3-1); m2: settled, pending
  for (const [m, scores, finish] of [[H('m1'), [3, 1], true], [H('m2'), [0, 2], false]]) {
    await evm.send(1, book, 'commit', [m, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
    await evm.send(1, book, 'settle', [m, H('r' + m), H('l'), H('b'), ['0x' + p1, '0x' + p2], scores, [key(1)]]);
    if (!finish) continue;
    for (const w of [2, 3, 4]) await evm.send(w, book, 'attest', [m, key(w), H('r' + m)]);
    await evm.send(5, book, 'finalize', [m]);
  }
  const logs = evm.allLogs().filter((l) => l.address.toLowerCase() === book).map(mb.decodeLog).filter(Boolean); // Enrolled and ParamsUpdated are not match events: null
  assert.deepEqual(logs.map((l) => l.event), ['Committed', 'Settled', 'Attested', 'Attested', 'Attested', 'Finalized', 'Committed', 'Settled']);
  const manifest = { services: { leaderboard: { kind: 'elo', k: 24 }, stats: true } };
  const f = mb.foldChain(logs, 'tug.v1', manifest, { rulesets: mb.rulesetKeys(['tug.v1']) });
  assert.deepEqual(f.counts, { official: 1, pending: 1 });
  assert.equal(f.official.leaderboard[0].player, p1, 'alice leads the official ladder');
  assert.equal(f.official.stats[p2].wins, 0);
  assert.equal(f.pending.stats[p2].wins, 1, 'the pending win shows in the pending view only');
});

test('EpochAnchor v3: a delegate proposes; support is bonded stake; the root finalizes at quorumBps of the active stake; one proposal per key', { timeout: 120_000 }, async () => {
  const { evm, stake } = await mesh(3, (i) => (i === 3 ? 3n : 1n)); // 1 + 1 + 3 = 5 tokens active
  const anchor = await evm.deploy('EpochAnchor.sol', 'EpochAnchor', [stake, 5000, evm.addressOf(ADMIN)]);
  await evm.send(1, stake, 'setDelegate', [key(1), evm.addressOf(11)]);
  const root = H('root-a'), other = H('root-b');
  await rejects(evm.send(12, anchor, 'propose', [500_000, root, key(1)]), /NotAllowed/, 'a stranger cannot propose for a key');
  await rejects(evm.send(11, anchor, 'propose', [500_000, ethers.ZeroHash, key(1)]), /ZeroRoot/);
  let r = await evm.send(11, anchor, 'propose', [500_000, root, key(1)]); // the delegate, weight 1
  assert.equal(r.logs[0].name, 'Proposed'); assert.equal(r.logs[0].args.weight, ONE); assert.equal(r.logs[0].args.needed, 5n * ONE / 2n);
  assert.equal(r.logs.length, 1, '1 of 5: not final');
  await rejects(evm.send(1, anchor, 'propose', [500_000, other, key(1)]), /AlreadyProposed/, 'one proposal per key per epoch');
  r = await evm.send(2, anchor, 'propose', [500_000, other, key(2)]); // the operator itself, for a DIFFERENT root
  assert.equal(r.logs.length, 1, 'conflicting roots coexist');
  assert.equal((await evm.read(anchor, 'rootOf', [500_000]))[0], ethers.ZeroHash, 'nothing final');
  r = await evm.send(3, anchor, 'propose', [500_000, root, key(3)]); // weight 3: root now has 4 of 5
  assert.equal(r.logs.at(-1).name, 'EpochFinalized');
  assert.equal(r.logs.at(-1).args.support, 4n * ONE); assert.equal(r.logs.at(-1).args.totalActive, 5n * ONE);
  assert.equal((await evm.read(anchor, 'rootOf', [500_000]))[0], root);
  const [has, needed, fin] = await evm.read(anchor, 'standing', [500_000, root]);
  assert.equal(has, 4n * ONE); assert.equal(needed, 5n * ONE / 2n); assert.equal(fin, true);
  await rejects(evm.send(2, anchor, 'propose', [500_001, root, key(4)]), /NotBonded|NotAllowed/, 'an unbonded key cannot propose');
  // two 1-token nodes cannot outvote the 3-token one: a count quorum would have let them
  const n2 = await mesh(3, (i) => (i === 3 ? 3n : 1n));
  const a2 = await n2.evm.deploy('EpochAnchor.sol', 'EpochAnchor', [n2.stake, 5000, n2.evm.addressOf(ADMIN)]);
  await n2.evm.send(1, a2, 'propose', [1, root, key(1)]); await n2.evm.send(2, a2, 'propose', [1, root, key(2)]);
  assert.equal((await n2.evm.read(a2, 'rootOf', [1]))[0], ethers.ZeroHash, '2 of 5 tokens is not a majority of stake, whatever the node count');
});
