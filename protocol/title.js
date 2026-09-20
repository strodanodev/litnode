/** TitleRegistry reads and writes. Pure — the caller does the eth_call /
 *  the publisher's wallet sends the calldata.
 *
 *  A title is an ERC-721 whose tokenId = keccak256(rulesetId); the holder
 *  is the publisher. A build is keyed by its buildHash — the same
 *  H('ruleset', bytes) every node pins — as bytes32. A node asks
 *  buildStatus(titleId, buildHash) before loading a peer's build; only a
 *  build that is registered, active (activatesAt passed) and not revoked
 *  may load. */
import { selector, keccak256Hex } from './keccak.js';

export const BUILD_STATUS = 'buildStatus(uint256,bytes32)';
export const TITLE_OF = 'titleOf(uint256)';
export const BUILDS_OF = 'buildsOf(uint256)';
export const REGISTER_TITLE = 'register(string,bytes32)';
export const SET_BUILD = 'setBuild(uint256,bytes32,uint64)';
export const REVOKE_BUILD = 'revokeBuild(uint256,bytes32)';
export const TRANSFER_FROM = 'transferFrom(address,address,uint256)';
export const OWNER_OF = 'ownerOf(uint256)';
export const ACTIVATION_DELAY = 'activationDelay()';

const hex32 = (h) => { const s = String(h).replace(/^0x/, '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('buildHash must be 32 bytes hex'); return s; };
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => { const h = String(a).replace(/^0x/, '').toLowerCase(); if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('bad address'); return h.padStart(64, '0'); };
const utf8Hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const checkId = (rulesetId) => { if (typeof rulesetId !== 'string' || !rulesetId.length || new TextEncoder().encode(rulesetId).length > 64) throw new Error('rulesetId: 1–64 bytes'); return rulesetId; };

/** tokenId of a rulesetId, as a 64-hex word (no 0x) — keccak256 of the UTF-8 bytes. */
export const titleIdOf = (rulesetId) => keccak256Hex(checkId(rulesetId));

export const buildStatusCall = (contract, rulesetId, buildHash) => ({ to: contract, data: selector(BUILD_STATUS) + titleIdOf(rulesetId) + hex32(buildHash) });
export const titleOfCall = (contract, rulesetId) => ({ to: contract, data: selector(TITLE_OF) + titleIdOf(rulesetId) });
export const buildsOfCall = (contract, rulesetId) => ({ to: contract, data: selector(BUILDS_OF) + titleIdOf(rulesetId) });
export const ownerOfCall = (contract, rulesetId) => ({ to: contract, data: selector(OWNER_OF) + titleIdOf(rulesetId) });
export const activationDelayCall = (contract) => ({ to: contract, data: selector(ACTIVATION_DELAY) });

/** register(string rulesetId, bytes32 buildHash): head = offset of the string (0x40: two head words), the hash; tail = length + padded bytes. */
export function registerCalldata(rulesetId, buildHash) {
  const s = utf8Hex(checkId(rulesetId));
  return selector(REGISTER_TITLE) + uintWord(0x40) + hex32(buildHash) + uintWord(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0');
}
/** activatesAt 0 = the earliest the contract allows (now + activationDelay). */
export const setBuildCalldata = (rulesetId, buildHash, activatesAt = 0) => selector(SET_BUILD) + titleIdOf(rulesetId) + hex32(buildHash) + uintWord(activatesAt);
export const revokeBuildCalldata = (rulesetId, buildHash) => selector(REVOKE_BUILD) + titleIdOf(rulesetId) + hex32(buildHash);
export const transferCalldata = (from, to, rulesetId) => selector(TRANSFER_FROM) + addrWord(from) + addrWord(to) + titleIdOf(rulesetId);

const word = (d, i) => d.slice(i * 64, (i + 1) * 64);
const addr = (w) => { const a = '0x' + w.slice(24); return a === '0x' + '0'.repeat(40) ? null : a; };
/** Decode (address publisher, bool registered, bool active, bool revoked, uint64 activatesAt). */
export function decodeBuildStatus(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 320) throw new Error('short buildStatus result');
  const flag = (i) => BigInt('0x' + word(d, i)) === 1n;
  return { publisher: addr(word(d, 0)), registered: flag(1), active: flag(2), revoked: flag(3), activatesAt: Number(BigInt('0x' + word(d, 4))) };
}
/** Decode (address publisher, string rulesetId, uint64 registeredAt, uint256 buildCount). publisher null = unregistered. */
export function decodeTitle(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 320) throw new Error('short titleOf result');
  const off = Number(BigInt('0x' + word(d, 1))) * 2;
  const len = Number(BigInt('0x' + d.slice(off, off + 64)));
  const rulesetId = new TextDecoder().decode(Uint8Array.from(d.slice(off + 64, off + 64 + len * 2).match(/../g) ?? [], (h) => parseInt(h, 16)));
  return { publisher: addr(word(d, 0)), rulesetId, registeredAt: Number(BigInt('0x' + word(d, 2))), buildCount: Number(BigInt('0x' + word(d, 3))) };
}
export const decodeOwner = (hex) => addr(hex.replace(/^0x/, '').padStart(64, '0'));
export const decodeUint = (hex) => BigInt('0x' + (hex.replace(/^0x/, '') || '0'));
/** Decode bytes32[] */
export function decodeHashes(hex) {
  const d = hex.replace(/^0x/, '');
  const off = Number(BigInt('0x' + word(d, 0))) * 2, n = Number(BigInt('0x' + d.slice(off, off + 64)));
  return Array.from({ length: n }, (_, i) => d.slice(off + 64 + i * 64, off + 128 + i * 64));
}

/** The one-line verdict a node acts on for a PEER's build. `status` null =
 *  the chain could not be read; the gate stays shut (the caller may still
 *  fall back to a signature from TRUSTED_PUBLISHERS). */
export function titleVerdict(status) {
  if (!status) return { ok: false, reason: 'title registry unreadable' };
  if (!status.publisher) return { ok: false, reason: 'title is not registered on chain' };
  if (!status.registered) return { ok: false, reason: 'build is not registered under its title' };
  if (status.revoked) return { ok: false, reason: 'build was revoked by its publisher' };
  if (!status.active) return { ok: false, reason: `build activates at ${new Date(status.activatesAt * 1000).toISOString()}` };
  return { ok: true, reason: null };
}
