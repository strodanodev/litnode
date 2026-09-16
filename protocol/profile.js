/** Player profile reads and writes: what the node asks PlayerProfile, what
 *  the cabinet sends it, and how a delta set is folded by owner instead of by
 *  key. Pure — the caller does the eth_call / eth_sendTransaction.
 *  docs/WALLET-IDENTITY.md; contracts/PlayerProfile.sol.
 *
 *  A player key is the browser's 32-byte ed25519 public key — exactly a
 *  bytes32, the same as a node key (staking.js nodeKeyBytes32). */
import { selector } from './keccak.js';
import { nodeKeyBytes32 } from './staking.js';

export const OWNER_OF_KEY = 'ownerOfKey(bytes32)';
export const PROFILE_OF = 'profileOf(address)';
export const NAME_OF = 'nameOf(uint256)';
export const REGISTER = 'register(bytes32,string)';
export const BIND_KEY = 'bindKey(bytes32)';
export const REVOKE_KEY = 'revokeKey(bytes32)';
export const CLAIM_BADGE = 'claim(bytes32)';

const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => { const h = a.replace(/^0x/, '').toLowerCase(); if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('bad address'); return h.padStart(64, '0'); };
const utf8Hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------ reads
export const ownerOfKeyCall = (contract, playerKeyHex) => ({ to: contract, data: selector(OWNER_OF_KEY) + nodeKeyBytes32(playerKeyHex).slice(2) });
export const profileOfCall = (contract, address) => ({ to: contract, data: selector(PROFILE_OF) + addrWord(address) });
export const nameOfCall = (contract, tokenId) => ({ to: contract, data: selector(NAME_OF) + uintWord(tokenId) });

/** Decode (address owner, uint256 tokenId, bool active). tokenId 0 = never bound. */
export function decodeOwner(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 192) throw new Error('short ownerOfKey result');
  const tokenId = BigInt('0x' + d.slice(64, 128));
  return { owner: tokenId === 0n ? null : '0x' + d.slice(24, 64), tokenId, active: BigInt('0x' + d.slice(128, 192)) === 1n };
}
export const decodeUint = (hex) => BigInt('0x' + (hex.replace(/^0x/, '') || '0'));
/** Decode one ABI string return value. */
export function decodeString(hex) {
  const d = hex.replace(/^0x/, '');
  const off = Number(BigInt('0x' + d.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + d.slice(off, off + 64)));
  const bytes = d.slice(off + 64, off + 64 + len * 2);
  return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) ?? [], (h) => parseInt(h, 16)));
}

// ------------------------------------------------------------ writes (the cabinet builds these; MetaMask signs)
/** register(bytes32 key, string name): bytes32, then the string's offset, length and padded bytes. */
export function registerCalldata(playerKeyHex, name) {
  if (typeof name !== 'string' || !name.length || name.length > 32 || !/^[A-Za-z0-9 _.-]+$/.test(name)) throw new Error('name: 1–32 of [A-Za-z0-9 _.-]');
  const s = utf8Hex(name);
  return selector(REGISTER) + nodeKeyBytes32(playerKeyHex).slice(2) + uintWord(0x40) + uintWord(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0');
}
export const bindKeyCalldata = (playerKeyHex) => selector(BIND_KEY) + nodeKeyBytes32(playerKeyHex).slice(2);
export const revokeKeyCalldata = (playerKeyHex) => selector(REVOKE_KEY) + nodeKeyBytes32(playerKeyHex).slice(2);
export const claimBadgeCalldata = (nodeKeyHex) => selector(CLAIM_BADGE) + nodeKeyBytes32(nodeKeyHex).slice(2);

// ------------------------------------------------------------ the fold by owner
/** Re-key a delta set so every participant is its profile owner (lowercase
 *  address) when the key has an ACTIVE binding, and stays the key otherwise.
 *  Pure; the result feeds derive() unchanged, so two nodes with the same
 *  deltas and the same profile reads produce the same digest (BUILD-SPEC §9:
 *  "the fold counts identities, not keys"). Scores and teams follow. When two
 *  keys of one owner meet in one match the delta is kept as-is under the
 *  keys: a person cannot be both sides of a ranked result. */
export function applyProfiles(deltas, profiles) {
  const who = (k) => { const p = profiles?.[k]; return p?.active && p.owner ? p.owner.toLowerCase() : k; };
  return deltas.map((d) => {
    const participants = d.participants.map(who);
    if (new Set(participants).size !== participants.length) return d;
    const scores = {}; for (const [k, v] of Object.entries(d.scores ?? {})) scores[who(k)] = v;
    const teams = Array.isArray(d.teams) ? d.teams.map((t) => t.map(who)) : d.teams;
    return { ...d, participants, scores, ...(teams ? { teams } : {}) };
  });
}
