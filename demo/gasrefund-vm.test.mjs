/** GasRefund (contracts/GasRefund.sol), executed: the treasury pays back the gas a ranked match cost
 *  the nodes that served it — host and agreeing witnesses, into each node's hot key, once per FINAL
 *  match, at most refundBps of min(basefee, cap), at most dailyCapWei per node per day. Also measures
 *  what commit, settle, attest, finalize and claim actually cost, which the deploy defaults follow.
 *    node --test demo/gasrefund-vm.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createEvm } from './lib/evm.mjs';
import { sha256Hex } from '../protocol/canonical.js';
import * as mb from '../protocol/matchbook.js';

const ONE = 10n ** 18n, GWEI = 10n ** 9n;
const MB_PARAMS = { settleWindow: 60n, attestWindow: 120n, escalationWindow: 300n, drawDelay: 2n, hostSlashBps: 1000, witnessSlashBps: 500 };
const LOCK = 600, AGE = 120, UNBOND = 1200;
const key = (i) => '0x' + sha256Hex(`node-${i}`);
const H = (s) => '0x' + sha256Hex(s);
const ADMIN = 0, TREASURY = 23, STRANGER = 20;
const HOT = (i) => 10 + i; // node i's delegate (hot key) is account 10 + i
const RS = '0x' + mb.rulesetIdBytes32('agent-fighter.v1');
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const R = { hostGas: 400_000n, witnessGas: 90_000n, claimGas: 120_000n, refundBps: 8000, maxPriceWei: 50n * GWEI, dailyCapWei: ONE / 20n };

/** Token, NodeStake, MatchBook, GasRefund; nodes 1..n bonded by account i, each with hot key 10 + i
 *  (node 5, if present, keeps no delegate). GasRefund funded with 1 coin from the treasury. */
async function setup(n = 5, params = R) {
  const evm = await createEvm();
  const token = await evm.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await evm.deploy('NodeStake.sol', 'NodeStake', [token, ONE, LOCK, AGE, UNBOND, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]);
  const book = await evm.deploy('MatchBook.sol', 'MatchBook', [stake, MB_PARAMS, evm.addressOf(ADMIN)]);
  await evm.send(ADMIN, stake, 'setAdjudicator', [book, true]);
  for (let i = 1; i <= n; i++) {
    await evm.send(i, token, 'faucet', []);
    await evm.send(i, token, 'approve', [stake, 1000n * ONE]);
    await evm.send(i, stake, 'stake', [key(i), ONE]);
    if (i !== 5) await evm.send(i, stake, 'setDelegate', [key(i), evm.addressOf(HOT(i))]);
  }
  evm.warp(AGE);
  const refund = await evm.deploy('GasRefund.sol', 'GasRefund', [book, stake, params, evm.addressOf(ADMIN)]);
  await evm.pay(TREASURY, refund, ONE);
  return { evm, stake, book, refund };
}

/** One ranked match through MatchBook, sent by the nodes' hot keys. `votes`: which panel seats attest
 *  (true = agrees, false = dissents, null = absent). Returns the gas each step used. */
async function play(ctx, id, { host = 1, panel = [2, 3, 4], votes = [true, true, true], finalizeAfterWindow = false } = {}) {
  const { evm, book } = ctx;
  const hot = (i) => (i === 5 ? i : HOT(i));
  const gas = {};
  gas.commit = (await evm.send(hot(host), book, 'commit', [id, H(`d-${id}`), RS, key(host), panel.map(key)])).gas;
  gas.settle = (await evm.send(hot(host), book, 'settle', [id, H(`r-${id}`), H(`l-${id}`), H('build'), [H('p1'), H('p2')], [2, 1], []])).gas;
  gas.attest = [];
  for (let s = 0; s < 3; s++) if (votes[s] !== null) gas.attest.push((await evm.send(hot(panel[s]), book, 'attest', [id, key(panel[s]), votes[s] ? H(`r-${id}`) : H('other')])).gas);
  if (finalizeAfterWindow) evm.warp(Number(MB_PARAMS.attestWindow) + 1);
  gas.finalize = (await evm.send(hot(host), book, 'finalize', [id])).gas;
  return gas;
}
const status = async (ctx, id) => mb.STATUS[Number((await ctx.evm.read(ctx.book, 'statusOf', [id]))[0])];
const balances = async (ctx, accounts) => Promise.all(accounts.map((a) => ctx.evm.balance(ctx.evm.addressOf(a))));
const cost = (g, price) => g * price * BigInt(R.refundBps) / 10000n;

test('a final match: the host and each agreeing witness get their gas back, into their hot keys, once', { timeout: 120_000 }, async () => {
  const ctx = await setup();
  const { evm, refund } = ctx;
  const id = H('m1');
  const g = await play(ctx, id);
  assert.equal(await status(ctx, id), 'final');
  // What the steps really cost (execution gas; a transaction adds 21000 + calldata on top). The deploy defaults follow these.
  console.log(`[gas] commit ${g.commit} settle ${g.settle} attest ${g.attest.join('/')} finalize ${g.finalize}`);
  evm.setBaseFee(2n * GWEI);
  const before = await balances(ctx, [HOT(1), HOT(2), HOT(3), HOT(4)]);
  const q = await evm.read(refund, 'quote', [id, key(1)]);
  assert.equal(q[3], 2n * GWEI, 'price = basefee under the cap');
  const r = await evm.send(HOT(1), refund, 'claim', [id, key(1)]);
  console.log(`[gas] claim ${r.gas}`);
  const after = await balances(ctx, [HOT(1), HOT(2), HOT(3), HOT(4)]);
  assert.equal(after[0] - before[0], cost(R.hostGas + R.claimGas, 2n * GWEI), 'host: commit + settle + finalize, and the claim it sent');
  for (let s = 1; s <= 3; s++) assert.equal(after[s] - before[s], cost(R.witnessGas, 2n * GWEI), `witness ${s}: its attest`);
  assert.equal(r.logs.filter((l) => l.name === 'Refunded').length, 4);
  assert.equal(r.logs.find((l) => l.name === 'Claimed').args.total, q[2], 'claim pays exactly what quote said');
  await rejects(evm.send(HOT(1), refund, 'claim', [id, key(1)]), /AlreadyClaimed/);
  assert.equal((await evm.read(refund, 'claimed', [id]))[0], true);
});

test('nothing for an unfinished or void match; an absent witness gets nothing; the price is capped', { timeout: 120_000 }, async () => {
  const ctx = await setup();
  const { evm, book, refund } = ctx;
  // committed, never settled
  const open = H('open');
  await evm.send(HOT(1), book, 'commit', [open, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await rejects(evm.send(HOT(1), refund, 'claim', [open, key(1)]), /NotFinal\(1\)/);
  // abandoned commit → expired → void
  evm.warp(Number(MB_PARAMS.settleWindow) + 1);
  await evm.send(STRANGER, book, 'expire', [open]);
  assert.equal(await status(ctx, open), 'void');
  await rejects(evm.send(HOT(1), refund, 'claim', [open, key(1)]), /NotFinal\(4\)/);
  // two of three answered, both agree: final after the window — the absent seat is not paid
  const two = H('two');
  await play(ctx, two, { votes: [true, null, true], finalizeAfterWindow: true });
  assert.equal(await status(ctx, two), 'final');
  evm.setBaseFee(300n * GWEI); // above the 50 gwei cap
  const [, amounts, , price] = await evm.read(refund, 'quote', [two, ethers.ZeroHash]);
  assert.equal(price, R.maxPriceWei, 'a basefee spike is refunded at the cap');
  assert.equal(amounts[2], 0n, 'the absent seat');
  assert.equal(amounts[1], cost(R.witnessGas, R.maxPriceWei));
  assert.equal(amounts[0], cost(R.hostGas, R.maxPriceWei), 'no claim gas: the caller acts for no seat');
  // anyone may trigger it; a node key the caller does not hold cannot collect the claim gas
  await rejects(evm.send(STRANGER, refund, 'claim', [two, key(1)]), /NotYours/);
  await evm.send(STRANGER, refund, 'claim', [two, ethers.ZeroHash]);
});

test('a node is paid at most dailyCapWei a day; a node without a delegate is paid at its operator', { timeout: 120_000 }, async () => {
  const cap = cost(R.hostGas, 10n * GWEI) + 1n; // one host refund at 10 gwei, and a wei
  const ctx = await setup(5, { ...R, dailyCapWei: cap });
  const { evm, refund } = ctx;
  evm.setBaseFee(10n * GWEI);
  await play(ctx, H('a'), { host: 5 });
  await play(ctx, H('b'), { host: 5 });
  const op5 = evm.addressOf(5);
  const b0 = await evm.balance(op5);
  await evm.send(STRANGER, refund, 'claim', [H('a'), ethers.ZeroHash]);
  const b1 = await evm.balance(op5);
  assert.equal(b1 - b0, cost(R.hostGas, 10n * GWEI), 'no delegate set: the operator receives it');
  const [, second] = await evm.read(refund, 'quote', [H('b'), ethers.ZeroHash]);
  assert.equal(second[0], 1n, 'the rest of the day\'s cap, and no more');
  evm.warp(86_400);
  const [, nextDay] = await evm.read(refund, 'quote', [H('b'), ethers.ZeroHash]);
  assert.equal(nextDay[0], cost(R.hostGas, 10n * GWEI), 'a new UTC day, a new cap');
});

test('underfunded, paused and the admin\'s bounds', { timeout: 120_000 }, async () => {
  const ctx = await setup();
  const { evm, refund } = ctx;
  await evm.send(ADMIN, refund, 'withdraw', [evm.addressOf(TREASURY), ONE]);
  assert.equal(await evm.balance(refund), 0n);
  await play(ctx, H('m'));
  evm.setBaseFee(GWEI);
  await rejects(evm.send(HOT(1), refund, 'claim', [H('m'), key(1)]), /Underfunded/);
  await evm.pay(TREASURY, refund, ONE / 100n);
  await evm.send(ADMIN, refund, 'setPaused', [true]);
  await rejects(evm.send(HOT(1), refund, 'claim', [H('m'), key(1)]), /IsPaused/);
  await evm.send(ADMIN, refund, 'setPaused', [false]);
  await evm.send(HOT(1), refund, 'claim', [H('m'), key(1)]);
  // only the admin, and within bounds
  await rejects(evm.send(STRANGER, refund, 'setPaused', [true]), /NotAdmin/);
  await rejects(evm.send(STRANGER, refund, 'withdraw', [evm.addressOf(STRANGER), 1n]), /NotAdmin/);
  await rejects(evm.send(ADMIN, refund, 'setParams', [{ ...R, refundBps: 10_001 }, evm.addressOf(ADMIN)]), /BadParams/);
  await rejects(evm.send(ADMIN, refund, 'setParams', [{ ...R, maxPriceWei: 1001n * GWEI }, evm.addressOf(ADMIN)]), /BadParams/);
});
