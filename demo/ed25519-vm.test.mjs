/** contracts/Ed25519.sol, executed: RFC 8032 ed25519 verification on the EVM
 *  (generation 4's proof of possession for NodeStake.bond). Checked against
 *  node:crypto on random keys and messages, against the RFC 8032 §7.1
 *  vectors, and against inputs a careless verifier would accept: small-order
 *  and non-canonical keys, S >= L, flipped bits, wrong lengths.
 *    node --test demo/ed25519-vm.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import solc from 'solc';
import { createEvm } from './lib/evm.mjs';
import * as ref from './lib/ed25519-ref.mjs';

const HARNESS = `// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;
import "Ed25519.sol";
contract Ed25519Harness {
    function verify(bytes32 pk, bytes calldata sig, bytes calldata m) external view returns (bool) { return Ed25519.verify(pk, sig, m); }
    function verifyGas(bytes32 pk, bytes calldata sig, bytes calldata m) external view returns (bool ok, uint256 used) {
        uint256 g = gasleft(); ok = Ed25519.verify(pk, sig, m); used = g - gasleft();
    }
    function sha512(bytes calldata m) external pure returns (bytes32, bytes32) { return Ed25519.sha512(m); }
    function decodePoint(bytes32 e) external view returns (bool, uint256, uint256) { return Ed25519.decodePoint(e); }
    function isSmallOrder(uint256 x, uint256 y) external pure returns (bool) { return Ed25519.isSmallOrder(x, y); }
    function hashToScalar(bytes32 r, bytes32 pk, bytes calldata m) external pure returns (uint256) { return Ed25519.hashToScalar(r, pk, m); }
}`;

let ctxP = null;
function ctx() {
  ctxP ??= (async () => {
    const out = JSON.parse(solc.compile(JSON.stringify({
      language: 'Solidity',
      sources: { 'Ed25519.sol': { content: readFileSync(join(process.cwd(), 'contracts', 'Ed25519.sol'), 'utf8') }, 'Harness.sol': { content: HARNESS } },
      settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    })));
    const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
    const c = out.contracts['Harness.sol'].Ed25519Harness;
    const evm = await createEvm({ accounts: 2 });
    const h = await evm.deployRaw(c.abi, c.evm.bytecode.object);
    return { evm, h };
  })();
  return ctxP;
}
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const onChain = async (pub, msg, sig) => (await (await ctx()).evm.read((await ctx()).h, 'verify', [hex(pub), hex(sig), hex(msg)]))[0];

/** Reproducible "random" bytes: sha256 in counter mode over a label. */
const drbg = (label) => { let i = 0; return (n) => { const out = []; let have = 0; while (have < n) { const b = createHash('sha256').update(`${label}:${i++}`).digest(); out.push(b); have += b.length; } return Buffer.concat(out).subarray(0, n); }; };

test('SHA-512 constants are the cube and square roots of the first primes, and the digest matches node:crypto at every length 0..300', async () => {
  const src = readFileSync(join(process.cwd(), 'contracts', 'Ed25519.sol'), 'utf8');
  const primes = []; for (let n = 2; primes.length < 80; n++) if (primes.every((q) => n % q)) primes.push(n);
  const iroot = (x, k) => { let lo = 0n, hi = 1n; while (hi ** BigInt(k) <= x) hi <<= 1n; while (lo < hi - 1n) { const m = (lo + hi) >> 1n; if (m ** BigInt(k) <= x) lo = m; else hi = m; } return lo; };
  const mask = 2n ** 64n - 1n;
  const K = primes.map((q) => (iroot(BigInt(q) << 192n, 3) & mask).toString(16).padStart(16, '0')).join('');
  assert.equal(src.match(/K512 = hex"([0-9a-f]+)"/)[1], K);
  for (const [i, q] of primes.slice(0, 8).entries()) assert.ok(src.includes('0x' + (iroot(BigInt(q) << 128n, 2) & mask).toString(16).padStart(16, '0')), `H${i}`);
  const { evm, h } = await ctx();
  const rnd = drbg('sha');
  for (let len = 0; len <= 300; len++) {
    const m = rnd(len);
    const [a, b] = await evm.read(h, 'sha512', [hex(m)]);
    assert.equal(a.slice(2) + b.slice(2), createHash('sha512').update(m).digest('hex'), `len ${len}`);
  }
});

test('curve constants: B is the RFC 8032 base point, d and sqrt(-1) as derived', () => {
  const src = readFileSync(join(process.cwd(), 'contracts', 'Ed25519.sol'), 'utf8');
  const word = (name) => BigInt(src.match(new RegExp(`constant ${name} = (0x[0-9a-f]+);`))[1]);
  const [bx, by] = ref.affine(ref.B);
  assert.equal(word('BX'), bx); assert.equal(word('BY'), by);
  assert.equal(word('D'), ref.D); assert.equal(word('D2'), (2n * ref.D) % ref.P);
  assert.equal(word('SQRT_M1'), ref.SQRT_M1); assert.equal(word('L'), ref.L); assert.equal(word('P'), ref.P);
  assert.equal(word('R256'), 2n ** 256n % ref.L);
  assert.ok(ref.isIdentity(ref.mul(ref.L, ref.B)), '[L]B = O');
  assert.equal(ref.encode(ref.B).toString('hex'), '5866666666666666666666666666666666666666666666666666666666666666');
});

test('RFC 8032 §7.1 vectors: node:crypto reproduces each signature, the contract accepts it and refuses it on another message', async () => {
  const vectors = [
    ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
    ['4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
    ['c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
    // TEST SHA(abc): the message is SHA-512("abc")
    ['833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42', 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf', createHash('sha512').update('abc').digest('hex'), 'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704'],
  ];
  for (const [sk, pk, msg, sig] of vectors) {
    const seed = Buffer.from(sk, 'hex'), m = Buffer.from(msg, 'hex');
    assert.equal(ref.publicOf(seed).toString('hex'), pk);
    assert.equal(ref.signRaw(seed, m).toString('hex'), sig);
    assert.equal(await onChain(Buffer.from(pk, 'hex'), m, Buffer.from(sig, 'hex')), true, `vector ${pk.slice(0, 8)}`);
    assert.equal(await onChain(Buffer.from(pk, 'hex'), Buffer.concat([m, Buffer.from([0])]), Buffer.from(sig, 'hex')), false);
  }
});

test('agrees with node:crypto on 240 random keys and messages (0..520 bytes, incl. 87, 88 and > 128); k matches the model', async () => {
  const rnd = drbg('pairs');
  const fixed = [0, 1, 31, 32, 33, 63, 64, 65, 87, 88, 95, 96, 111, 112, 113, 127, 128, 129, 175, 200, 239, 240, 255, 256, 257, 383, 384, 500, 520];
  const { evm, h } = await ctx();
  for (let i = 0; i < 240; i++) {
    const seed = rnd(32), pub = ref.publicOf(seed);
    const len = i < fixed.length ? fixed[i] : rnd(2).readUInt16BE() % 521;
    const m = rnd(len), sig = ref.signRaw(seed, m);
    assert.equal(ref.verifyRaw(pub, m, sig), true);
    assert.equal(await onChain(pub, m, sig), true, `pair ${i} len ${len}`);
    if (i % 24 === 0) {
      const k = (await evm.read(h, 'hashToScalar', [hex(sig.subarray(0, 32)), hex(pub), hex(m)]))[0];
      assert.equal(k, ref.challenge(sig.subarray(0, 32), pub, m));
    }
  }
});

test('negatives: one flipped bit in the signature, the message or the key is refused (as node:crypto refuses it)', async () => {
  const rnd = drbg('flip');
  for (let i = 0; i < 30; i++) {
    const seed = rnd(32), pub = ref.publicOf(seed), m = rnd(40 + i * 7), sig = ref.signRaw(seed, m);
    const bit = rnd(2).readUInt16BE();
    const s2 = Buffer.from(sig); s2[(bit >> 3) % 64] ^= 1 << (bit & 7);
    const m2 = Buffer.from(m); m2[(bit >> 3) % m.length] ^= 1 << (bit & 7);
    const p2 = Buffer.from(pub); p2[(bit >> 3) % 32] ^= 1 << (bit & 7);
    for (const [pk, msg, sg, what] of [[pub, m, s2, 'sig'], [pub, m2, sig, 'msg'], [p2, m, sig, 'key']]) {
      assert.equal(ref.verifyRaw(pk, msg, sg), false, `node:crypto ${what} ${i}`);
      assert.equal(await onChain(pk, msg, sg), false, `contract ${what} ${i}`);
    }
  }
});

test('negatives: S >= L is refused even though [S]B = [S mod L]B', async () => {
  const seed = drbg('sl')(32), pub = ref.publicOf(seed), m = Buffer.from('malleable');
  const sig = ref.signRaw(seed, m);
  const S = ref.leToInt(sig.subarray(32));
  assert.equal(await onChain(pub, m, sig), true);
  for (const bad of [S + ref.L, S + 2n * ref.L, ref.L, 2n ** 256n - 1n]) {
    const s2 = Buffer.concat([sig.subarray(0, 32), ref.intToLe(bad)]);
    if (bad === S + ref.L) assert.ok(ref.laxEquation(pub, m, s2), 'a verifier without the S < L check would accept S + L');
    assert.equal(ref.verifyRaw(pub, m, s2), false);
    assert.equal(await onChain(pub, m, s2), false, `S = ${bad.toString(16)}`);
  }
});

test('negatives: small-order keys are refused even with a signature that satisfies [S]B = R + [k]A', async () => {
  // the 8-torsion: [L]P for a point P with a torsion component
  const torsion = new Map();
  for (let y = 2n; torsion.size < 8 && y < 200n; y++) {
    const x = ref.recoverX(y, 0); if (x === null) continue;
    const t = ref.mul(ref.L, [x, y, 1n, (x * y) % ref.P]);
    for (let j = 0n; j < 8n; j++) { const q = ref.mul(j, t); torsion.set(ref.encode(q).toString('hex'), q); }
  }
  assert.equal(torsion.size, 8, 'found all eight small-order points');
  const { evm, h } = await ctx();
  const rnd = drbg('small');
  for (const [encHex, T] of torsion) {
    const A = Buffer.from(encHex, 'hex');
    const [tx, ty] = ref.affine(T);
    assert.equal((await evm.read(h, 'isSmallOrder', [tx, ty]))[0], true);
    // forge: R = [S]B - [j]A for a guess j, until k ≡ j on A's order (1 in 8 tries)
    const m = Buffer.from(`small-order ${encHex}`);
    let sig = null;
    for (let tries = 0; tries < 200 && !sig; tries++) {
      const S = ref.leToInt(rnd(32)) % ref.L, j = BigInt(tries % 8);
      const R = ref.encode(ref.add(ref.mul(S, ref.B), ref.neg(ref.mul(j, T))));
      const k = ref.challenge(R, A, m);
      const cand = Buffer.concat([R, ref.intToLe(S)]);
      if (ref.laxEquation(A, m, cand) && k >= 0n) sig = cand;
    }
    assert.ok(sig, 'forged a cofactorless-valid signature');
    assert.equal(await onChain(A, m, sig), false, `small-order key ${encHex}`);
  }
  // a real key is not small-order
  const pub = ref.publicOf(rnd(32));
  const [x, y] = ref.affine(ref.decode(pub));
  assert.equal((await evm.read(h, 'isSmallOrder', [x, y]))[0], false);
});

test('negatives: non-canonical key encodings (y >= p, x = 0 with the sign bit) do not decode; canonical ones do', async () => {
  const { evm, h } = await ctx();
  const dec = async (b) => evm.read(h, 'decodePoint', [hex(b)]);
  let found = 0;
  for (let y = 0n; y < 19n; y++) {
    for (const sign of [0, 1]) {
      const x = ref.recoverX(y, sign);
      const canonical = ref.encodeRaw(y, sign), aliased = ref.encodeRaw(y + ref.P, sign);
      const [ok, cx, cy] = await dec(canonical);
      assert.equal(ok, x !== null, `y=${y} sign=${sign}`);
      if (ok) { assert.equal(cx, x); assert.equal(cy, y); found++; }
      assert.equal((await dec(aliased))[0], false, `aliased y=${y}+p`);
    }
  }
  assert.ok(found >= 2);
  // x = 0 carries sign 0 only: (0, 1) and (0, -1) with the bit set are refused
  assert.equal((await dec(ref.encodeRaw(1n, 1)))[0], false);
  assert.equal((await dec(ref.encodeRaw(ref.P - 1n, 1)))[0], false);
  // a y that is not on the curve at all
  let off = 2n; while (ref.recoverX(off, 0) !== null) off++;
  assert.equal((await dec(ref.encodeRaw(off, 0)))[0], false);
  // an honest signature checked against the aliased encoding of the identity (y = p + 1) is refused
  const m = Buffer.from('alias'), S = 12345n, R = ref.encode(ref.mul(S, ref.B));
  assert.equal(await onChain(ref.encodeRaw(ref.P + 1n, 0), m, Buffer.concat([R, ref.intToLe(S)])), false);
});

test('negatives: wrong signature lengths are false, not a revert', async () => {
  const seed = drbg('len')(32), pub = ref.publicOf(seed), m = Buffer.from('length'), sig = ref.signRaw(seed, m);
  for (const s of [Buffer.alloc(0), sig.subarray(0, 63), Buffer.concat([sig, Buffer.from([0])]), Buffer.concat([sig, sig])]) assert.equal(await onChain(pub, m, s), false, `len ${s.length}`);
  assert.equal(await onChain(pub, m, sig), true);
});

test('gas: one verification of the 88-byte bond message', async () => {
  const { evm, h } = await ctx();
  const seed = drbg('gas')(32), pub = ref.publicOf(seed), m = Buffer.alloc(88, 7), sig = ref.signRaw(seed, m);
  const [ok, used] = await evm.read(h, 'verifyGas', [hex(pub), hex(sig), hex(m)]);
  assert.equal(ok, true);
  console.log(`# Ed25519.verify, 88-byte message: ${used} gas`);
  assert.ok(used < 1_500_000n, `verify used ${used} gas`);
});
