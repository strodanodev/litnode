/** Generation 4, executed (audit 2026-10-21 §4.2 findings 1–5): NodeStake binds a key only with the
 *  key's own ed25519 proof and only at minStake; stake() tops up a bound key only; NodeDirectory
 *  announces only for an active, minStake-bonded key and pages its key list; MatchBook enrols only
 *  eligible keys into a capped pool that anyone can prune of inactive keys, and a seated escalation
 *  whose resolve() reverts still expires; EpochAnchor refuses an hour that has not ended. Plus the
 *  protocol helpers the node, the tools and the cabinet use for all of it, and the gas of one bond.
 *    node --test demo/gen4-vm.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import solc from 'solc';
import { ethers } from 'ethers';
import { createEvm } from './lib/evm.mjs';
import { createRpcEvm } from './lib/rpc-evm.mjs';
import { nodeIdentity, signRaw as nodeSign, verifyRaw as nodeVerify } from './lib/ed25519-ref.mjs';
import { sha256Hex } from '../protocol/canonical.js';
import * as mb from '../protocol/matchbook.js';
import { bondMessage, bondCalldata, bondProof, versionCall, decodeVersion, BOND, VERSION, BOND_TAG, stakeCalldata } from '../protocol/staking.js';
import { signRaw, verifyRaw, generateKeypair } from '../protocol/keys.js';
import { readDirectoryKeys, mapLimit, keysPageCall, countCall, keysCall, KEYS_PAGE, COUNT } from '../protocol/directory.js';
import { selector } from '../protocol/keccak.js';

const ONE = 10n ** 18n;
const LOCK = 600, AGE = 120, UNBOND = 1200;
const PARAMS = { settleWindow: 60n, attestWindow: 120n, escalationWindow: 300n, drawDelay: 2n, hostSlashBps: 1000, witnessSlashBps: 500 };
const ADMIN = 0, TREASURY = 23;
const H = (s) => '0x' + sha256Hex(s);
const ident = (label) => nodeIdentity(label);
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

/** Token + NodeStake (+ MatchBook as adjudicator). `token` may be a pre-deployed address. */
async function world({ accounts = 24, token = null, evm = null } = {}) {
  evm ??= await createEvm({ accounts });
  token ??= await evm.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await evm.deploy('NodeStake.sol', 'NodeStake', [token, ONE, LOCK, AGE, UNBOND, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]);
  const book = await evm.deploy('MatchBook.sol', 'MatchBook', [stake, PARAMS, evm.addressOf(ADMIN)]);
  await evm.send(ADMIN, stake, 'setAdjudicator', [book, true]);
  const funded = new Set();
  const fund = async (acct) => { if (funded.has(acct)) return; funded.add(acct); await evm.send(acct, token, 'faucet', []); await evm.send(acct, token, 'approve', [stake, 10n ** 30n]); };
  return { evm, token, stake, book, fund };
}

// ------------------------------------------------------------------------------------------ NodeStake

test('version() is 4 on NodeStake, NodeDirectory, MatchBook and EpochAnchor; a generation-3 contract has none', async () => {
  const { evm, stake, book } = await world();
  const dir = await evm.deploy('NodeDirectory.sol', 'NodeDirectory', [stake]);
  const anchor = await evm.deploy('EpochAnchor.sol', 'EpochAnchor', [stake, 5000, evm.addressOf(ADMIN)]);
  for (const c of [stake, dir, book, anchor]) assert.equal(Number((await evm.read(c, 'version', []))[0]), 4);
  // the selector the tools call, and the decoder they read it with
  assert.equal(versionCall(stake).data, evm.iface(stake).encodeFunctionData('version', []));
  assert.equal(selector(VERSION), evm.iface(stake).getFunction('version').selector);
  assert.equal(decodeVersion('0x' + '4'.padStart(64, '0')), 4);
  assert.equal(decodeVersion('0x'), null); assert.equal(decodeVersion(null), null);
  // a contract without version() (any generation-3 contract): the eth_call reverts, so callers fall back to stake()
  const chain = await createRpcEvm();
  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  await assert.rejects(chain.rpc('eth_call', [versionCall(token), 'latest']));
});

test('the bond message: the exact 88 bytes the contract verifies, from protocol/staking.js and from NodeStake.bondMessage', async () => {
  const { evm, stake } = await world();
  const op = evm.addressOf(3);
  const msg = bondMessage(evm.chainId, stake, op);
  assert.equal(msg.length, 88);
  assert.equal(Buffer.from(msg.subarray(0, 16)).toString('latin1'), `${BOND_TAG}\0`);
  const onChain = (await evm.read(stake, 'bondMessage', [op]))[0];
  assert.equal(onChain, hex(msg));
  assert.equal(hex(msg), ethers.solidityPacked(['string', 'bytes1', 'uint256', 'address', 'address'], [BOND_TAG, '0x00', evm.chainId, stake, op]).toLowerCase());
  // the raw signer and verifier (WebCrypto) agree with node:crypto, both ways
  const id = ident('msg');
  const sig = await signRaw(msg, id.privateKey);
  assert.equal(sig, nodeSign(id.seed, msg).toString('hex'), 'ed25519 is deterministic: the same bytes');
  assert.equal(await verifyRaw(msg, sig, id.publicKey), true);
  assert.equal(await verifyRaw(bondMessage(evm.chainId, stake, evm.addressOf(4)), sig, id.publicKey), false);
  assert.ok(nodeVerify(Buffer.from(id.publicKey, 'hex'), msg, Buffer.from(sig, 'hex')));
  // bondCalldata is the ABI encoding of bond(bytes32,uint256,bytes)
  assert.equal(bondCalldata(id.publicKey, ONE, sig), evm.iface(stake).encodeFunctionData('bond', [id.key, ONE, '0x' + sig]));
  assert.equal(selector(BOND), evm.iface(stake).getFunction('bond').selector);
  assert.throws(() => bondCalldata(id.publicKey, ONE, 'ab'), /64-byte/);
});

test('NodeStake.bond: the key proves possession, names this chain, this contract and this operator; the minimum is enforced; one binding per key', async () => {
  const { evm, stake, fund } = await world();
  const id = ident('bond-a'), op = 1, thief = 2;
  await fund(op); await fund(thief);
  const proofFor = (who, { chainId = evm.chainId, contract = stake, key = id } = {}) => bondProof(key.privateKey, chainId, contract, evm.addressOf(who)).then((s) => '0x' + s);
  // THE AUDIT FINDING: a stranger who saw the key in gossip cannot bind it, with any amount
  await rejects(evm.send(thief, stake, 'stake', [id.key, 1n]), /NotBound/);
  await rejects(evm.send(thief, stake, 'bond', [id.key, ONE, await proofFor(op)]), /BadProof/, 'the operator\'s proof does not work for anyone else');
  await rejects(evm.send(thief, stake, 'bond', [id.key, ONE, '0x' + '00'.repeat(64)]), /BadProof/);
  await rejects(evm.send(thief, stake, 'bond', [id.key, ONE, await proofFor(thief, { key: ident('other') })]), /BadProof/, 'signed by another key');
  await rejects(evm.send(op, stake, 'bond', [id.key, ONE, await proofFor(op, { chainId: 4441 })]), /BadProof/, 'a proof for another chain');
  await rejects(evm.send(op, stake, 'bond', [id.key, ONE, await proofFor(op, { contract: evm.addressOf(9) })]), /BadProof/, 'a proof for another NodeStake');
  await rejects(evm.send(op, stake, 'bond', [id.key, ONE, (await proofFor(op)).slice(0, -2)]), /BadProof/, '63 bytes');
  await rejects(evm.send(op, stake, 'bond', [id.key, ONE - 1n, await proofFor(op)]), /BelowMinimum/, 'below minStake');
  await rejects(evm.send(op, stake, 'bond', [id.key, 0n, await proofFor(op)]), /ZeroAmount/);
  // the real operator binds it
  const r = await evm.send(op, stake, 'bond', [id.key, ONE, await proofFor(op)]);
  assert.deepEqual(r.logs.map((l) => l.name).filter((n) => n !== 'Transfer'), ['Bound', 'Staked']);
  assert.equal(r.logs.find((l) => l.name === 'Bound').args.operator.toLowerCase(), evm.addressOf(op));
  const [operator, amount, active] = await evm.read(stake, 'standingOf', [id.key]);
  assert.equal(operator.toLowerCase(), evm.addressOf(op)); assert.equal(amount, ONE); assert.equal(active, true);
  // one binding: even a valid fresh proof cannot rebind it, nor can the operator bond it twice
  await rejects(evm.send(thief, stake, 'bond', [id.key, ONE, await proofFor(thief)]), /AlreadyBound/);
  await rejects(evm.send(op, stake, 'bond', [id.key, ONE, await proofFor(op)]), /AlreadyBound/);
  // top-ups: the operator only, any amount, through stake()
  await rejects(evm.send(thief, stake, 'stake', [id.key, ONE]), /NotOperator/);
  await evm.send(op, stake, 'stake', [id.key, 1n]);
  assert.equal((await evm.read(stake, 'standingOf', [id.key]))[1], ONE + 1n);
  // a withdrawn bond keeps its operator: it re-bonds with stake(), with a new lock; nobody else can take the key
  evm.warp(LOCK); await evm.send(op, stake, 'unstake', [id.key]); evm.warp(UNBOND); await evm.send(op, stake, 'withdraw', [id.key]);
  assert.equal((await evm.read(stake, 'standingOf', [id.key]))[1], 0n);
  await rejects(evm.send(thief, stake, 'bond', [id.key, ONE, await proofFor(thief)]), /AlreadyBound/);
  await evm.send(op, stake, 'stake', [id.key, ONE]);
  await rejects(evm.send(op, stake, 'unstake', [id.key]), /StillLocked/);
  // transferOperator still moves a bound key between wallets
  await evm.send(op, stake, 'transferOperator', [id.key, evm.addressOf(thief)]);
  await evm.send(thief, stake, 'stake', [id.key, 1n]);
});

test('gas: one NodeStake.bond (the 88-byte proof verified on chain)', async () => {
  const { evm, stake, fund } = await world();
  const id = ident('gas'); await fund(5);
  const sig = await bondProof(id.privateKey, evm.chainId, stake, evm.addressOf(5));
  const data = bondCalldata(id.publicKey, ONE, sig);
  const r = await evm.send(5, stake, 'bond', [id.key, ONE, '0x' + sig]);
  const bytes = Buffer.from(data.slice(2), 'hex');
  const intrinsic = 21_000n + BigInt([...bytes].reduce((g, b) => g + (b === 0 ? 4 : 16), 0));
  console.log(`# NodeStake.bond: ${r.gas} execution gas + ${intrinsic} intrinsic = ${r.gas + intrinsic} gas for the transaction`);
  assert.ok(r.gas + intrinsic < 1_000_000n, `bond costs ${r.gas + intrinsic}`);
  // a top-up does no verification
  const t = await evm.send(5, stake, 'stake', [id.key, 1n]);
  assert.ok(t.gas < 100_000n, `top-up ${t.gas}`);
  assert.equal(stakeCalldata(id.publicKey, 1n), evm.iface(stake).encodeFunctionData('stake', [id.key, 1n]));
});

test('protocol/keys.js generateKeypair keys bond like any other (the node\'s own identity file shape)', async () => {
  const { evm, stake, fund } = await world();
  const kp = await generateKeypair(); await fund(7);
  await evm.bondNode(7, stake, kp, ONE);
  assert.equal((await evm.read(stake, 'standingOf', ['0x' + kp.publicKey]))[2], true);
});

// ------------------------------------------------------------------------------------------ NodeDirectory

test('NodeDirectory: announce needs an active key at minStake; keysPage pages the append-only list; keys() and count() agree', async () => {
  const { evm, stake, fund } = await world();
  const dir = await evm.deploy('NodeDirectory.sol', 'NodeDirectory', [stake]);
  const ids = Array.from({ length: 7 }, (_, i) => ident(`dir-${i}`));
  for (const [i, id] of ids.entries()) { await fund(1 + i); await evm.bondNode(1 + i, stake, id, ONE); }
  // an unbound key: nobody may announce for it
  const loose = ident('dir-loose');
  await rejects(evm.send(1, dir, 'announce', [loose.key, 'https://a.example', '']), /NotAllowed/);
  for (const [i, id] of ids.entries()) await evm.send(1 + i, dir, 'announce', [id.key, `https://n${i}.example`, '']);
  assert.equal((await evm.read(dir, 'count', []))[0], 7n);
  const page = async (o, l) => (await evm.read(dir, 'keysPage', [o, l]))[0].map((k) => k.toLowerCase());
  const all = ids.map((x) => x.key);
  assert.deepEqual(await page(0, 3), all.slice(0, 3));
  assert.deepEqual(await page(3, 3), all.slice(3, 6));
  assert.deepEqual(await page(6, 3), all.slice(6));
  assert.deepEqual(await page(7, 3), []);
  assert.deepEqual(await page(100, 5), []);
  assert.deepEqual(await page(2, 2n ** 255n), all.slice(2), 'a huge limit stops at the end');
  assert.deepEqual((await evm.read(dir, 'keys', []))[0].map((k) => k.toLowerCase()), all, 'keys() kept for readers already in the field');
  // below minStake (the admin raised it) → the same operator cannot announce any more
  await evm.send(ADMIN, stake, 'setParams', [2n * ONE, LOCK, AGE, UNBOND, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]);
  await rejects(evm.send(1, dir, 'announce', [ids[0].key, 'https://n0.example', '']), /NotBonded/);
  await evm.send(1, stake, 'stake', [ids[0].key, ONE]);
  await evm.send(1, dir, 'announce', [ids[0].key, 'https://n0b.example', '']);
  // unbonding → not active → refused, from the operator and from its announcer
  await evm.send(ADMIN, stake, 'setParams', [ONE, LOCK, AGE, UNBOND, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]);
  await evm.send(2, dir, 'setAnnouncer', [ids[1].key, evm.addressOf(20)]);
  await evm.send(20, dir, 'announce', [ids[1].key, 'https://n1b.example', '']);
  evm.warp(LOCK); await evm.send(2, stake, 'unstake', [ids[1].key]);
  await rejects(evm.send(2, dir, 'announce', [ids[1].key, 'https://n1c.example', '']), /NotBonded/);
  await rejects(evm.send(20, dir, 'announce', [ids[1].key, 'https://n1c.example', '']), /NotBonded/);
  assert.equal((await evm.read(dir, 'count', []))[0], 7n, 're-announcing adds no key');
});

test('readers: readDirectoryKeys pages a generation-4 directory and falls back to keys() on generation 3; mapLimit bounds what is in flight', async () => {
  const chain = await createRpcEvm();
  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const dir = await chain.deploy('NodeDirectory.sol', 'NodeDirectory', [stake]);
  const ids = Array.from({ length: 11 }, (_, i) => ident(`rd-${i}`));
  for (const [i, id] of ids.entries()) {
    const acct = 1 + (i % 5);
    if (i < 5) { await chain.send(acct, token, 'faucet', []); await chain.send(acct, token, 'approve', [stake, 10n ** 30n]); }
    await chain.bondNode(acct, stake, id, ONE);
    await chain.send(acct, dir, 'announce', [id.key, `https://r${i}.example`, '']);
  }
  const calls = [];
  const call = (payload) => { calls.push(payload.data.slice(0, 10)); return chain.rpc('eth_call', [payload, 'latest']); };
  const got = await readDirectoryKeys(call, dir, { page: 4 });
  assert.deepEqual(got, ids.map((x) => x.key.slice(2)));
  assert.deepEqual(calls, Array(3).fill(selector(KEYS_PAGE)), 'three pages of four, no keys()');
  assert.equal(keysPageCall(dir, 4, 4).data, chain.iface(dir).encodeFunctionData('keysPage', [4, 4]));
  assert.equal(countCall(dir).data, chain.iface(dir).encodeFunctionData('count', []));
  assert.equal(selector(COUNT), chain.iface(dir).getFunction('count').selector);
  // an exact multiple of the page: one more (empty) page ends it
  assert.equal((await readDirectoryKeys(call, dir, { page: 11 })).length, 11);
  // generation 3: keysPage reverts (or a gateway answers "0x") → the whole keys()
  const gen3 = (mode) => (payload) => payload.data.startsWith(selector(KEYS_PAGE)) ? (mode === 'revert' ? Promise.reject(new Error('execution reverted')) : Promise.resolve('0x')) : chain.rpc('eth_call', [payload, 'latest']);
  assert.deepEqual(await readDirectoryKeys(gen3('revert'), dir), got);
  assert.deepEqual(await readDirectoryKeys(gen3('empty'), dir), got);
  assert.equal(keysCall(dir).data, chain.iface(dir).encodeFunctionData('keys', []));
  // bounded concurrency
  let inFlight = 0, peak = 0;
  const out = await mapLimit([...Array(25).keys()], 4, async (i) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return i * 2; });
  assert.equal(peak, 4); assert.deepEqual(out, [...Array(25).keys()].map((i) => i * 2));
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

// ------------------------------------------------------------------------------------------ MatchBook

test('MatchBook: enrol only while witness-eligible; the pool is capped by an admin parameter; prune drops inactive keys only', { timeout: 120_000 }, async () => {
  const { evm, stake, book, fund } = await world();
  const ids = Array.from({ length: 6 }, (_, i) => ident(`pool-${i}`));
  for (const [i, id] of ids.entries()) { await fund(1 + i); await evm.bondNode(1 + i, stake, id, ONE); }
  await rejects(evm.send(1, book, 'enroll', [ids[0].key]), /NotEligible/, 'bonded this second: not eligible yet');
  await rejects(evm.send(2, book, 'enroll', [ids[0].key]), /NotAllowed/, 'not its operator or delegate');
  evm.warp(AGE);
  assert.equal((await evm.read(book, 'maxPool', []))[0], 256n);
  await rejects(evm.send(1, book, 'setMaxPool', [3]), /NotAdmin/);
  await rejects(evm.send(ADMIN, book, 'setMaxPool', [0]), /BadParams/);
  await rejects(evm.send(ADMIN, book, 'setMaxPool', [1025]), /BadParams/);
  await evm.send(ADMIN, book, 'setMaxPool', [3]);
  for (let i = 0; i < 3; i++) await evm.send(1 + i, book, 'enroll', [ids[i].key]);
  await evm.send(1, book, 'enroll', [ids[0].key]); // already in: a no-op, not PoolFull
  await rejects(evm.send(4, book, 'enroll', [ids[3].key]), /PoolFull\(3\)/);
  assert.equal((await evm.read(book, 'poolSize', []))[0], 3n);
  // prune: an ACTIVE key stays, even inside its eligibility age after a top-up (adding stake must not get you evicted)
  await rejects(evm.send(9, book, 'prune', [ids[0].key]), /StillActive/);
  await evm.send(1, stake, 'stake', [ids[0].key, ONE]);
  assert.equal((await evm.read(stake, 'witnessEligible', [ids[0].key]))[0], false);
  await rejects(evm.send(9, book, 'prune', [ids[0].key]), /StillActive/);
  // unbonding → anyone prunes it, and the freed seat takes a new key
  evm.warp(LOCK); await evm.send(2, stake, 'unstake', [ids[1].key]);
  const p = await evm.send(9, book, 'prune', [ids[1].key]);
  assert.equal(p.logs[0].name, 'Enrolled'); assert.equal(p.logs[0].args.enrolled, false);
  await evm.send(9, book, 'prune', [ids[1].key]); // not enrolled any more: a no-op
  await evm.send(4, book, 'enroll', [ids[3].key]);
  // below minStake after the admin raised it → inactive → prunable; ids[0] (2 tokens after its top-up) stays
  await evm.send(ADMIN, stake, 'setParams', [2n * ONE, LOCK, AGE, UNBOND, evm.addressOf(ADMIN), evm.addressOf(TREASURY)]);
  await evm.send(9, book, 'prune', [ids[2].key]);
  await evm.send(9, book, 'prune', [ids[3].key]);
  await rejects(evm.send(9, book, 'prune', [ids[0].key]), /StillActive/);
  assert.deepEqual((await evm.read(book, 'pool', []))[0].map((k) => k.toLowerCase()), [ids[0].key], 'only the key still active remains');
});

/** The broken stake token: transfer() can be switched to return false, so a slash (and with it resolve) reverts. */
const BROKEN = `// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;
contract BrokenToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public broken;
    function faucet() external { balanceOf[msg.sender] += 1000 ether; }
    function setBroken(bool b) external { broken = b; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { if (broken) return false; balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true; }
}`;

test('MatchBook: a seated escalation whose resolve() reverts (a token whose transfer fails) is not forever — expire() voids it after a second escalation window', { timeout: 300_000 }, async () => {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Broken.sol': { content: BROKEN } }, settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const c = out.contracts['Broken.sol'].BrokenToken;
  const evm = await createEvm();
  const token = await evm.deployRaw(c.abi, c.evm.bytecode.object);
  const { stake, book, fund } = await world({ evm, token });
  const N = 14;
  const id = (i) => ident(`esc-${i}`), key = (i) => id(i).key;
  for (let i = 1; i <= N; i++) { await fund(i); await evm.bondNode(i, stake, id(i), ONE); }
  evm.warp(AGE);
  for (let i = 1; i <= N; i++) await evm.send(i, book, 'enroll', [key(i)]);
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1'), m = H('stuck');
  const ledger = { matchId: 'stuck', entries: [{ k: 0, inputs: [1] }], participants: ['p1', 'p2'] };
  await evm.send(1, book, 'commit', [m, H('d'), RS, key(1), [key(2), key(3), key(4)]]);
  await evm.send(1, book, 'settle', [m, H('r'), '0x' + mb.ledgerHash(ledger), H('b'), [H('p1'), H('p2')], [1, 0], []]);
  await evm.send(2, book, 'attest', [m, key(2), H('r')]);
  await evm.send(3, book, 'attest', [m, key(3), H('other')]); // dissent
  await evm.send(4, book, 'attest', [m, key(4), H('r')]);
  await evm.send(5, book, 'finalize', [m]);
  evm.mine(Number(PARAMS.drawDelay) + 1);
  const e = await evm.send(5, book, 'escalate', [m, mb.ledgerBytes(ledger)]);
  const nine = e.logs[0].args.panel.map((k) => k.toLowerCase());
  const idx = (k) => { for (let i = 1; i <= N; i++) if (key(i) === k) return i; throw new Error('unknown'); };
  for (const k of nine) await evm.send(idx(k), book, 'attest', [m, k, H('r')]); // the nine back the host: the dissenter is slashed
  await evm.send(1, token, 'setBroken', [true]);
  await rejects(evm.send(5, book, 'expire', [m]), /WindowOpen/, 'the vote is still open');
  evm.warp(Number(PARAMS.escalationWindow) + 1);
  await rejects(evm.send(5, book, 'resolve', [m]), /transfer/, 'the slash cannot pay the treasury: resolve reverts');
  await rejects(evm.send(5, book, 'expire', [m]), /WindowOpen/, 'resolve gets one more escalation window first');
  evm.warp(Number(PARAMS.escalationWindow));
  const x = await evm.send(5, book, 'expire', [m]);
  assert.equal(x.logs[0].name, 'Finalized'); assert.equal(mb.STATUS[Number(x.logs[0].args.status)], 'void');
  assert.equal(mb.STATUS[Number((await evm.read(book, 'statusOf', [m]))[0])], 'void');
  await rejects(evm.send(5, book, 'resolve', [m]), /WrongStatus/);
  assert.equal((await evm.read(book, 'totalWindow', []))[0], PARAMS.settleWindow + 2n * PARAMS.attestWindow + 3n * PARAMS.escalationWindow);
});

test('MatchBook: a full default pool (256 keys) — the 257th is refused, and escalate() over all of it fits a block', { timeout: 600_000 }, async () => {
  const OPS = 30;
  const { evm, stake, book, fund } = await world({ accounts: OPS + 2 });
  const id = (j) => ident(`full-${j}`), key = (j) => id(j).key, opOf = (j) => 1 + (j % OPS);
  for (let j = 0; j < 257; j++) { await fund(opOf(j)); await evm.bondNode(opOf(j), stake, id(j), ONE); }
  evm.warp(AGE);
  for (let j = 0; j < 256; j++) await evm.send(opOf(j), book, 'enroll', [key(j)]);
  await rejects(evm.send(opOf(256), book, 'enroll', [key(256)]), /PoolFull\(256\)/);
  const RS = '0x' + mb.rulesetIdBytes32('tug.v1'), m = H('full');
  const ledger = { matchId: 'full', entries: [{ k: 0, inputs: [1] }], participants: ['p1', 'p2'] };
  await evm.send(opOf(0), book, 'commit', [m, H('d'), RS, key(0), [key(1), key(2), key(3)]]);
  await evm.send(opOf(0), book, 'settle', [m, H('r'), '0x' + mb.ledgerHash(ledger), H('b'), [H('p1'), H('p2')], [1, 0], []]);
  await evm.send(opOf(1), book, 'attest', [m, key(1), H('r')]);
  await evm.send(opOf(2), book, 'attest', [m, key(2), H('x')]);
  await evm.send(opOf(3), book, 'attest', [m, key(3), H('r')]);
  await evm.send(opOf(4), book, 'finalize', [m]);
  evm.mine(Number(PARAMS.drawDelay) + 1);
  const e = await evm.send(opOf(4), book, 'escalate', [m, mb.ledgerBytes(ledger)]);
  assert.equal(e.logs[0].name, 'Escalated');
  assert.equal(e.logs[0].args.panel.length, 9);
  console.log(`# MatchBook.escalate over a full pool of 256 keys: ${e.gas} gas`);
  assert.ok(e.gas < 15_000_000n, `escalate over 256 keys: ${e.gas} gas`);
});

// ------------------------------------------------------------------------------------------ EpochAnchor

test('EpochAnchor: an hour that has not ended cannot be proposed; once it ends, it can', async () => {
  const { evm, stake, fund } = await world();
  const anchor = await evm.deploy('EpochAnchor.sol', 'EpochAnchor', [stake, 5000, evm.addressOf(ADMIN)]);
  const a = ident('anchor'); await fund(1); await evm.bondNode(1, stake, a, ONE);
  const hour = () => BigInt(Math.floor(evm.now() / 3600));
  const now = hour();
  await rejects(evm.send(1, anchor, 'propose', [now, H('root'), a.key]), new RegExp(`EpochNotOver\\(${now}\\)`), 'the current hour');
  await rejects(evm.send(1, anchor, 'propose', [now + 1n, H('root'), a.key]), /EpochNotOver/, 'a future hour');
  await rejects(evm.send(1, anchor, 'propose', [2n ** 63n, H('root'), a.key]), /EpochNotOver/, 'a far future hour');
  const r = await evm.send(1, anchor, 'propose', [now - 1n, H('root'), a.key]);
  assert.equal(r.logs.at(-1).name, 'EpochFinalized', 'the only bond: quorum at once');
  evm.warp(3600 - (evm.now() % 3600));
  assert.equal(hour(), now + 1n);
  const r2 = await evm.send(1, anchor, 'propose', [now, H('root-2'), a.key]);
  assert.equal(r2.logs.at(-1).name, 'EpochFinalized', 'the hour has ended: proposable');
  void createHash;
});
