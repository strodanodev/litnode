/** The smallest EVM signer a node needs: secp256k1 over BigInt, deterministic
 *  nonces (RFC 6979), Ethereum addresses, RLP, and a signed legacy
 *  transaction. Enough to send one small call — announce(url) — and nothing
 *  more. Zero dependencies; demo/evm.test.mjs checks every output against
 *  ethers byte for byte.
 *
 *  Why this exists: the node holds no operator key (BUILD-SPEC §11), but a
 *  seed behind CGNAT has to publish its current tunnel URL somewhere the
 *  world can read — the chain — and that takes a signature. It uses a
 *  separate ANNOUNCER key that the operator delegates to one node key on
 *  NodeDirectory, so a leaked announcer can misdirect one node's discovery
 *  and nothing else. */
import { createHmac, randomBytes } from 'node:crypto';
import { keccak256Hex } from './keccak.js';
export { encodeBytes32StringString, decodeStringStringUintAddress, decodeBytes32Array } from './abi.js';

// ---------------------------------------------------------------- field + curve
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };
const mod = (a, m = P) => ((a % m) + m) % m;
const inv = (a, m = P) => { // extended Euclid
  let [r0, r1, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [x0, x1] = [x1, x0 - q * x1]; }
  return mod(x0, m);
};
const add = (a, b) => {
  if (!a) return b; if (!b) return a;
  if (a.x === b.x) { if (a.y !== b.y || a.y === 0n) return null; const l = mod(3n * a.x * a.x * inv(2n * a.y)); const x = mod(l * l - 2n * a.x); return { x, y: mod(l * (a.x - x) - a.y) }; }
  const l = mod((b.y - a.y) * inv(b.x - a.x)); const x = mod(l * l - a.x - b.x); return { x, y: mod(l * (a.x - x) - a.y) };
};
const mul = (p, k) => { let r = null, q = p; for (let e = k; e > 0n; e >>= 1n) { if (e & 1n) r = add(r, q); q = add(q, q); } return r; };

const hex = (b) => Buffer.from(b).toString('hex');
const big = (b) => BigInt('0x' + (hex(b) || '0'));
const b32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const keccak = (buf) => Buffer.from(keccak256Hex(new Uint8Array(buf)), 'hex');

// ---------------------------------------------------------------- keys
export const randomPrivateKey = () => { for (;;) { const k = randomBytes(32); const n = big(k); if (n > 0n && n < N) return '0x' + hex(k); } };
export function publicKey(privHex) {
  const d = BigInt(privHex); const p = mul(G, d);
  return Buffer.concat([Buffer.from([4]), b32(p.x), b32(p.y)]);
}
export const addressOf = (privHex) => '0x' + hex(keccak(publicKey(privHex).subarray(1)).subarray(12));

// ---------------------------------------------------------------- ECDSA, RFC 6979
function nonce(privBytes, msg) {
  const hmac = (k, ...parts) => { const h = createHmac('sha256', k); for (const p of parts) h.update(p); return h.digest(); };
  let v = Buffer.alloc(32, 1), k = Buffer.alloc(32, 0);
  k = hmac(k, v, Buffer.from([0]), privBytes, msg); v = hmac(k, v);
  k = hmac(k, v, Buffer.from([1]), privBytes, msg); v = hmac(k, v);
  for (;;) { v = hmac(k, v); const t = big(v); if (t > 0n && t < N) return t; k = hmac(k, v, Buffer.from([0])); v = hmac(k, v); }
}
/** Sign a 32-byte digest. Returns { r, s, recovery } with low s. */
export function sign(digest, privHex) {
  const d = BigInt(privHex), priv = b32(d);
  for (let attempt = 0; ; attempt++) {
    const k = attempt === 0 ? nonce(priv, digest) : nonce(priv, keccak(Buffer.concat([digest, Buffer.from([attempt])])));
    const R = mul(G, k); const r = mod(R.x, N); if (r === 0n) continue;
    let s = mod(inv(k, N) * (big(digest) + r * d), N); if (s === 0n) continue;
    let recovery = Number(R.y & 1n);
    if (s > N / 2n) { s = N - s; recovery ^= 1; }
    return { r, s, recovery };
  }
}

// ---------------------------------------------------------------- RLP
const rlpBytes = (b) => (b.length === 1 && b[0] < 0x80 ? b : Buffer.concat([len(b.length, 0x80), b]));
const len = (n, base) => { if (n < 56) return Buffer.from([base + n]); const h = n.toString(16); const hb = Buffer.from(h.length % 2 ? '0' + h : h, 'hex'); return Buffer.concat([Buffer.from([base + 55 + hb.length]), hb]); };
const toBytes = (v) => {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') { const h = v.replace(/^0x/, ''); return Buffer.from(h.length % 2 ? '0' + h : h, 'hex'); }
  if (typeof v === 'bigint' || typeof v === 'number') { const n = BigInt(v); if (n === 0n) return Buffer.alloc(0); const h = n.toString(16); return Buffer.from(h.length % 2 ? '0' + h : h, 'hex'); }
  throw new Error('rlp: bad item');
};
export const rlp = (item) => (Array.isArray(item) ? (() => { const body = Buffer.concat(item.map(rlp)); return Buffer.concat([len(body.length, 0xc0), body]); })() : rlpBytes(toBytes(item)));

// ---------------------------------------------------------------- legacy transaction (EIP-155)
/** { nonce, gasPrice, gasLimit, to, value, data, chainId } → signed raw tx hex. */
export function signTransaction(tx, privHex) {
  const fields = [tx.nonce, tx.gasPrice, tx.gasLimit, tx.to, tx.value ?? 0n, tx.data ?? '0x'];
  const digest = keccak(rlp([...fields, tx.chainId, 0n, 0n]));
  const { r, s, recovery } = sign(digest, privHex);
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(recovery);
  return '0x' + hex(rlp([...fields, v, r, s]));
}
