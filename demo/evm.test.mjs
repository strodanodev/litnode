/** protocol/evm.js — the zero-dependency signer — against ethers, byte for
 *  byte: addresses, deterministic ECDSA, RLP, and signed legacy transactions.
 *    node --test demo/evm.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { addressOf, publicKey, sign, rlp, signTransaction, signTransaction2, randomPrivateKey, encodeBytes32StringString, decodeStringStringUintAddress, decodeBytes32Array } from '../protocol/evm.js';
import { feeParams, signWithFee, effectivePrice } from '../node/fees.js';

const KEYS = ['0x' + '01'.repeat(32), '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', randomPrivateKey(), randomPrivateKey()];

test('evm: addresses and public keys match ethers', () => {
  for (const k of KEYS) {
    const w = new ethers.Wallet(k);
    assert.equal(addressOf(k).toLowerCase(), w.address.toLowerCase());
    assert.equal('0x' + publicKey(k).toString('hex'), ethers.SigningKey.computePublicKey(k, false));
  }
});

test('evm: RFC 6979 signatures equal ethers (deterministic, low-s, recovery bit)', () => {
  for (const k of KEYS) {
    const sk = new ethers.SigningKey(k);
    for (const msg of ['hello', 'litnode', '']) {
      const digest = Buffer.from(ethers.keccak256(ethers.toUtf8Bytes(msg)).slice(2), 'hex');
      const ours = sign(digest, k);
      const theirs = sk.sign(digest);
      assert.equal('0x' + ours.r.toString(16).padStart(64, '0'), theirs.r);
      assert.equal('0x' + ours.s.toString(16).padStart(64, '0'), theirs.s);
      assert.equal(ours.recovery, theirs.yParity);
    }
  }
});

test('evm: RLP matches ethers for the shapes a transaction uses', () => {
  const cases = [[], [0n], [1n, 127n, 128n, 256n], ['0x', '0x00', '0xabcd'], [[1n, [2n, 3n]], 'deadbeef'.repeat(20)], [Buffer.alloc(60, 7)]];
  for (const c of cases) {
    const toE = (v) => (Array.isArray(v) ? v.map(toE) : Buffer.isBuffer(v) ? '0x' + v.toString('hex') : typeof v === 'bigint' ? (v === 0n ? '0x' : ethers.toBeHex(v)) : v.startsWith('0x') ? v : '0x' + v);
    assert.equal('0x' + rlp(c).toString('hex'), ethers.encodeRlp(toE(c)));
  }
});

test('evm: a signed legacy transaction is what ethers would send', async () => {
  for (const k of KEYS) {
    const w = new ethers.Wallet(k);
    const tx = { nonce: 7n, gasPrice: 100_000_000n, gasLimit: 90_000n, to: '0x11C984bE3ee572eb7280334501B57c82001F397F', value: 0n, data: '0x' + encodeBytes32StringString('ab'.repeat(32), 'https://x.example', 'wss://y.example'), chainId: 4441n };
    const ours = signTransaction(tx, k);
    const theirs = await w.signTransaction({ type: 0, nonce: 7, gasPrice: 100_000_000n, gasLimit: 90_000n, to: tx.to, value: 0, data: tx.data, chainId: 4441 });
    assert.equal(ours, theirs);
    const parsed = ethers.Transaction.from(ours);
    assert.equal(parsed.from.toLowerCase(), w.address.toLowerCase());
  }
});

test('evm: ABI helpers round-trip through ethers', () => {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const enc = '0x' + encodeBytes32StringString('cd'.repeat(32), 'https://node.example/a?b=c', 'wss://relay.example');
  assert.deepEqual([...abi.decode(['bytes32', 'string', 'string'], enc)], ['0x' + 'cd'.repeat(32), 'https://node.example/a?b=c', 'wss://relay.example']);
  const ret = abi.encode(['string', 'string', 'uint64', 'address'], ['https://n', 'wss://r', 1758000000, '0x' + 'ab'.repeat(20)]);
  assert.deepEqual(decodeStringStringUintAddress(ret), { url: 'https://n', wsAddr: 'wss://r', updatedAt: 1758000000, announcer: '0x' + 'ab'.repeat(20) });
  const arr = abi.encode(['bytes32[]'], [['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]]);
  assert.deepEqual(decodeBytes32Array(arr), ['11'.repeat(32), '22'.repeat(32)]);
  assert.deepEqual(decodeBytes32Array(abi.encode(['bytes32[]'], [[]])), []);
});

test('evm: a signed type-2 (EIP-1559) transaction is what ethers would send', async () => {
  for (const k of KEYS) {
    const w = new ethers.Wallet(k);
    for (const [nonce, data] of [[7n, '0x' + encodeBytes32StringString('ab'.repeat(32), 'https://x.example', 'wss://y.example')], [0n, '0x']]) {
      const tx = { chainId: 4441n, nonce, maxPriorityFeePerGas: 6_800_000n, maxFeePerGas: 142_800_000n, gasLimit: 90_000n, to: '0x11C984bE3ee572eb7280334501B57c82001F397F', value: 0n, data };
      const ours = signTransaction2(tx, k);
      const theirs = await w.signTransaction({ type: 2, chainId: 4441, nonce: Number(nonce), maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gasLimit: 90_000n, to: tx.to, value: 0, data });
      assert.equal(ours, theirs);
      const parsed = ethers.Transaction.from(ours);
      assert.equal(parsed.type, 2);
      assert.equal(parsed.from.toLowerCase(), w.address.toLowerCase());
    }
  }
});

test('fees: type 2 at 2×base+tip under a cap when the chain has a base fee; legacy ×1.2 when it has none; over the cap refuses', async () => {
  const withBase = async (m) => (m === 'eth_getBlockByNumber' ? { baseFeePerGas: '0x40d9900' } : m === 'eth_gasPrice' ? '0x989680' : null); // base 68M wei (Liteforge, 22 Sep 2026)
  const f = await feeParams(withBase);
  assert.deepEqual(f, { type: 2, maxFeePerGas: 142_800_000n, maxPriorityFeePerGas: 6_800_000n, baseFee: 68_000_000n });
  assert.equal(effectivePrice(f), 68_000_000n, 'what the chain charges is the base fee, not the ceiling');
  const capped = await feeParams(withBase, { capWei: 100_000_000n });
  assert.equal(capped.maxFeePerGas, 100_000_000n, 'the ceiling never exceeds the cap');
  await assert.rejects(feeParams(withBase, { capWei: 10_000_000n }), (e) => e.overCap === true, 'a base fee above the cap is not bid on');
  const noBase = async (m) => (m === 'eth_getBlockByNumber' ? { number: '0x1' } : m === 'eth_gasPrice' ? '0x989680' : null);
  assert.deepEqual(await feeParams(noBase), { type: 0, gasPrice: 12_000_000n });
  // signWithFee picks the envelope from the fee
  const k = KEYS[0];
  const base = { chainId: 4441n, nonce: 1n, gasLimit: 50_000n, to: '0x11C984bE3ee572eb7280334501B57c82001F397F', value: 0n, data: '0x' };
  assert.equal(ethers.Transaction.from(signWithFee(base, f, k)).type, 2);
  assert.equal(ethers.Transaction.from(signWithFee(base, await feeParams(noBase), k)).type, 0);
});
