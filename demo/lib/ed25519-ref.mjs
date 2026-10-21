/** A small BigInt model of edwards25519 for TESTS: it builds the inputs a
 *  signer never would (small-order keys, non-canonical encodings, S + L,
 *  signatures that pass only the cofactorless equation) so
 *  demo/ed25519-vm.test.mjs can show contracts/Ed25519.sol refuses them.
 *  node:crypto signs and verifies the honest cases; this is never used to
 *  sign anything real. Also: deterministic ed25519 key pairs from a label,
 *  and a raw-bytes signer, for the in-process-EVM suites that bond nodes. */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';

export const P = 2n ** 255n - 19n;
export const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const md = (a) => ((a % P) + P) % P;
export const powm = (b, e, m = P) => { let r = 1n; b %= m; if (b < 0n) b += m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const inv = (a) => powm(md(a), P - 2n);
export const D = md(-121665n * inv(121666n));
export const SQRT_M1 = powm(2n, (P - 1n) / 4n);
export const IDENTITY = [0n, 1n, 1n, 0n];

/** Extended-coordinate addition (a = -1, unified, complete). */
export const add = ([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) => {
  const A = md((Y1 - X1) * (Y2 - X2)), B = md((Y1 + X1) * (Y2 + X2)), C = md(T1 * 2n * D * T2), DD = md(Z1 * 2n * Z2);
  const E = B - A, F = DD - C, G = DD + C, H = B + A;
  return [md(E * F), md(G * H), md(F * G), md(E * H)];
};
export const neg = ([X, Y, Z, T]) => [md(-X), Y, Z, md(-T)];
export const mul = (n, pt) => { let r = IDENTITY, q = pt; n = BigInt(n); while (n > 0n) { if (n & 1n) r = add(r, q); q = add(q, q); n >>= 1n; } return r; };
export const affine = ([X, Y, Z]) => { const zi = inv(Z); return [md(X * zi), md(Y * zi)]; };
export const isIdentity = (pt) => { const [x, y] = affine(pt); return x === 0n && y === 1n; };

export const leToInt = (bytes) => { let v = 0n; for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]); return v; };
export const intToLe = (v, n = 32) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

/** Encode an (x, y) pair with an arbitrary y (lets a test write y + p) and sign bit. */
export const encodeRaw = (y, sign) => intToLe(y | (BigInt(sign) << 255n));
export const encode = (pt) => { const [x, y] = affine(pt); return encodeRaw(y, x & 1n); };

/** x for y, or null when y is not on the curve. */
export const recoverX = (y, sign) => {
  y = md(y);
  const u = md(y * y - 1n), v = md(D * y * y + 1n);
  let x = md(u * powm(v, 3n) * powm(md(u * powm(v, 7n)), (P - 5n) / 8n));
  if (md(v * x * x) !== u) { if (md(v * x * x) !== md(-u)) return null; x = md(x * SQRT_M1); }
  if (x === 0n && sign) return null;
  if ((x & 1n) !== BigInt(sign)) x = md(-x);
  return x;
};
/** Strict RFC 8032 decode, as the contract does it; null on any failure. */
export const decode = (bytes) => {
  const v = leToInt(bytes), sign = Number(v >> 255n), y = v & ((1n << 255n) - 1n);
  if (y >= P) return null;
  const x = recoverX(y, sign);
  return x === null ? null : [x, y, 1n, md(x * y)];
};

const by = md(4n * inv(5n));
export const B = [recoverX(by, 0), by, 1n, md(recoverX(by, 0) * by)];

/** k = SHA-512(R ‖ A ‖ M) mod L. */
export const challenge = (R, A, M) => leToInt(createHash('sha512').update(Buffer.concat([R, A, M])).digest()) % L;

/** Does (R, S) satisfy the COFACTORLESS equation [S]B = R + [k]A with a lax A decode? (What a careless verifier accepts.) */
export const laxEquation = (A, M, sig) => {
  const R = sig.subarray(0, 32), S = leToInt(sig.subarray(32));
  const v = leToInt(A), sign = Number(v >> 255n), y = md(v & ((1n << 255n) - 1n));
  const x = recoverX(y, sign); if (x === null) return false;
  const Ap = [x, y, 1n, md(x * y)], Rp = decode(R);
  if (!Rp) return false;
  const lhs = mul(S % L, B), rhs = add(mul(challenge(R, A, M), Ap), Rp);
  const [x1, y1] = affine(lhs), [x2, y2] = affine(rhs);
  return x1 === x2 && y1 === y2;
};

// ------------------------------------------------------------ node:crypto keys

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const privOf = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
export const publicOf = (seed) => Buffer.from(createPublicKey(privOf(seed)).export({ format: 'der', type: 'spki' })).subarray(-32);
export const signRaw = (seed, msg) => nodeSign(null, Buffer.from(msg), privOf(seed));
export const verifyRaw = (pub, msg, sig) => { try { return nodeVerify(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig)); } catch { return false; } };

/** A deterministic node identity from a label: { seed, publicKey (hex, no 0x), key (0x bytes32) }. */
export const nodeIdentity = (label) => {
  const seed = createHash('sha256').update(`litnode-test-node:${label}`).digest();
  const pub = publicOf(seed).toString('hex');
  return { seed, publicKey: pub, privateKey: seed.toString('hex'), key: '0x' + pub };
};
