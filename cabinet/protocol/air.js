/** Universal login (AIR Kit) meets the mesh identity — the pure part.
 *  docs/UNIVERSAL-LOGIN.md.
 *
 *  An AIR account is a user id (`sub`, a UUID) and, on the chains AIR
 *  supports, a smart account. litVM is not one of those chains, so on litVM
 *  the account is represented by a PROXY WALLET: a plain key a node creates
 *  for the user on first sign-in and keeps (node/proxy.js). What ties the
 *  two together is the same PlayerProfile contract that already ties a
 *  browser's ed25519 key to a wallet: the profile the proxy owns has the
 *  AIR identity bound to it as a key of its own — bytes32 `airKey(sub)` —
 *  so ANY node, and any browser, can go from an AIR user id to the wallet
 *  that stands for it with one eth_call (`ownerOfKey`). The rule from
 *  docs/WALLET-IDENTITY.md does not change: the wallet authorizes keys, the
 *  keys sign play, the chain says which wallet a key belongs to.
 *
 *  Nothing in this file touches the network or a private key. */
import { keccak256Hex } from './keccak.js';

/** The bytes32 (64 hex, no 0x) under which an AIR user id is bound to its
 *  profile. Domain-separated so it can never collide with a real ed25519
 *  key or a node key (both are raw public keys, never a hash of a string). */
export const airKey = (sub) => {
  if (typeof sub !== 'string' || !sub.length || sub.length > 128) throw new Error('air: bad user id');
  return keccak256Hex(`litvm-games:air:${sub}`);
};

/** The payload of a JWT WITHOUT verifying it — for a browser that wants to
 *  show who it is signed in as. Anything that matters is verified by the
 *  node (node/air.js) against AIR's JWKS; this is display only. */
export function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const bytes = typeof atob === 'function' ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(b64, 'base64'));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

/** A profile display name from what AIR knows: the email's local part
 *  (letters, digits, space . _ -; PlayerProfile's rule), else `air-<8>`.
 *  1–32 characters, never empty. */
export function nameFor({ email, sub }) {
  const local = typeof email === 'string' ? email.split('@')[0] : '';
  const cleaned = local.replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 32);
  if (cleaned.length) return cleaned;
  return `air-${String(sub ?? '').replace(/-/g, '').slice(0, 8) || 'player'}`;
}
