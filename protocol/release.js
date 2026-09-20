/** ReleaseRegistry reads and writes (BUILD-SPEC v0.3 §2.4). Pure — the
 *  caller does the eth_call / the operator's wallet sends the calldata.
 *
 *  A release is keyed by the sha256 of its zip (the same hash the signed
 *  manifest carries and node/update.js checks after download), as bytes32.
 *  The node asks statusOf(zipHash) before applying; only a release that is
 *  registered, active (activatesAt passed) and not revoked may run. */
import { selector } from './keccak.js';

export const STATUS_OF = 'statusOf(bytes32)';
export const REGISTER = 'register(bytes32,string,bytes32,uint64)';
export const REVOKE = 'revoke(bytes32)';
export const ACTIVATION_DELAY = 'activationDelay()';

const hex32 = (h) => { const s = String(h).replace(/^0x/, '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('zipHash must be 32 bytes hex'); return s; };
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const utf8Hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

export const statusOfCall = (contract, zipHash) => ({ to: contract, data: selector(STATUS_OF) + hex32(zipHash) });
export const activationDelayCall = (contract) => ({ to: contract, data: selector(ACTIVATION_DELAY) });

/** register(bytes32 zipHash, string version, bytes32 protocol, uint64 activatesAt):
 *  head = zipHash, offset of the string (0x80: four head words), protocol as a
 *  right-aligned uint, activatesAt; tail = the string's length and padded bytes. */
export function registerCalldata(zipHash, version, protocol, activatesAt) {
  if (typeof version !== 'string' || !version.length || version.length > 64) throw new Error('version: 1–64 chars');
  const s = utf8Hex(version);
  return selector(REGISTER) + hex32(zipHash) + uintWord(0x80) + uintWord(protocol) + uintWord(activatesAt)
    + uintWord(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0');
}
export const revokeCalldata = (zipHash) => selector(REVOKE) + hex32(zipHash);

/** Decode (bool registered, bool active, bool revoked, string version, uint64 activatesAt). */
export function decodeStatus(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 320) throw new Error('short statusOf result');
  const word = (i) => d.slice(i * 64, (i + 1) * 64);
  const flag = (i) => BigInt('0x' + word(i)) === 1n;
  const off = Number(BigInt('0x' + word(3))) * 2;
  const len = Number(BigInt('0x' + d.slice(off, off + 64)));
  const version = new TextDecoder().decode(Uint8Array.from(d.slice(off + 64, off + 64 + len * 2).match(/../g) ?? [], (h) => parseInt(h, 16)));
  return { registered: flag(0), active: flag(1), revoked: flag(2), version, activatesAt: Number(BigInt('0x' + word(4))) };
}
export const decodeUint = (hex) => BigInt('0x' + (hex.replace(/^0x/, '') || '0'));

/** The one-line verdict the updater acts on. `status` null = the chain could
 *  not be read; the caller decides whether that blocks (it does: a gate that
 *  opens when the chain is down is no gate). */
export function releaseVerdict(status) {
  if (!status) return { ok: false, reason: 'release registry unreadable' };
  if (!status.registered) return { ok: false, reason: 'release is not registered on chain' };
  if (status.revoked) return { ok: false, reason: `release ${status.version} was revoked on chain` };
  if (!status.active) return { ok: false, reason: `release ${status.version} activates at ${new Date(status.activatesAt * 1000).toISOString()}` };
  return { ok: true, reason: null };
}
