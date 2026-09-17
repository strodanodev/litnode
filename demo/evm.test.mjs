/** protocol/evm.js — the zero-dependency signer — against ethers, byte for
 *  byte: addresses, deterministic ECDSA, RLP, and signed legacy transactions.
 *    node --test demo/evm.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { addressOf, publicKey, sign, rlp, signTransaction, randomPrivateKey, encodeBytes32StringString, decodeStringStringUintAddress, decodeBytes32Array } from '../protocol/evm.js';

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
