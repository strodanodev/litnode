/** NodeDirectory reads and the one write a node makes. Pure — the caller
 *  does the eth_call / eth_sendRawTransaction. contracts/NodeDirectory.sol.
 *
 *  Readers: keys() → entryOf(key) for each → keep those whose NodeStake
 *  standing is active and whose entry is fresh. That list is the mesh's
 *  bootstrap: what a fresh install seeds from and what the hosted arcade
 *  page reads when the visitor has no node. */
import { selector } from './keccak.js';
import { nodeKeyBytes32 } from './staking.js';
import { encodeBytes32StringString, decodeStringStringUintAddress, decodeBytes32Array } from './abi.js';

export const ANNOUNCE = 'announce(bytes32,string,string)';
export const ENTRY_OF = 'entryOf(bytes32)';
export const KEYS = 'keys()';
export const SET_ANNOUNCER = 'setAnnouncer(bytes32,address)';
export const ANNOUNCER_OF = 'announcerOf(bytes32)';
/** An entry older than this is not a seed any more (the node stopped announcing). */
export const FRESH_S = 7 * 24 * 3600;

export const keysCall = (contract) => ({ to: contract, data: selector(KEYS) });
export const entryOfCall = (contract, nodeKeyHex) => ({ to: contract, data: selector(ENTRY_OF) + nodeKeyBytes32(nodeKeyHex).slice(2) });
export const announcerOfCall = (contract, nodeKeyHex) => ({ to: contract, data: selector(ANNOUNCER_OF) + nodeKeyBytes32(nodeKeyHex).slice(2) });
export const decodeKeys = decodeBytes32Array;
export const decodeEntry = decodeStringStringUintAddress;
export const decodeAddress = (hex) => '0x' + hex.replace(/^0x/, '').slice(24, 64);

export const announceCalldata = (nodeKeyHex, url, wsAddr = '') => selector(ANNOUNCE) + encodeBytes32StringString(nodeKeyBytes32(nodeKeyHex).slice(2), url, wsAddr);
export const setAnnouncerCalldata = (nodeKeyHex, announcer) => selector(SET_ANNOUNCER) + nodeKeyBytes32(nodeKeyHex).slice(2) + announcer.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Fold raw reads into the seed list a client uses. `stakes` maps key → {active}. */
export function liveSeeds(entries, stakes, nowS = Math.floor(Date.now() / 1000)) {
  return Object.entries(entries)
    .filter(([k, e]) => e.url && stakes?.[k]?.active && nowS - e.updatedAt <= FRESH_S)
    .map(([nodeId, e]) => ({ nodeId, url: e.url, wsAddr: e.wsAddr || null, updatedAt: e.updatedAt, operator: stakes[nodeId].operator }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
