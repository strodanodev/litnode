/** Character registry reads (ERC6699Registry v2, this project's PROPOSED
 *  ERC-6699 interface). Pure: the caller does the eth_call, and passes a
 *  BLOCK TAG so a hydration is pinned to the block the match was placed at
 *  — the same reads on the same block give the same agent on every node.
 *
 *  What the node builds from these: `agent()` (erc6699.js) with
 *  `source: 'registry'`, and the authority check `mayPlay()` — the player
 *  key's profile owner must be the character's owner or controller. */
import { selector } from './keccak.js';
import { agent as makeAgent, SLOTS, slotId } from './erc6699.js';

export const CORE_STATS = 'coreStats(uint256)';
export const MANIFEST_OF = 'manifestOf(uint256)';
export const OWNER_OF = 'ownerOf(uint256)';
export const EQUIPPED = 'equipped(uint256,bytes32)';
export const PROGRESS = 'progress(uint256,(uint16,uint16,uint16,uint16,uint32,uint64),uint64)';
export const FORGE = 'forge(uint256,address,(uint16,uint16,uint16,uint16,uint32,uint64),(string,bytes32,address,bytes32,uint64,uint64))';

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const dec = new TextDecoder();
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

export const coreStatsCall = (contract, tokenId) => ({ to: contract, data: selector(CORE_STATS) + word(tokenId) });
export const manifestOfCall = (contract, tokenId) => ({ to: contract, data: selector(MANIFEST_OF) + word(tokenId) });
export const ownerOfCall = (contract, tokenId) => ({ to: contract, data: selector(OWNER_OF) + word(tokenId) });
export const equippedCall = (contract, tokenId, slot) => ({ to: contract, data: selector(EQUIPPED) + word(tokenId) + slotId(slot).slice(2) });

const words = (hex) => { const d = hex.replace(/^0x/, ''); return Array.from({ length: Math.floor(d.length / 64) }, (_, i) => d.slice(i * 64, i * 64 + 64)); };
const u = (w) => Number(BigInt('0x' + w));

/** (uint16 strength, agility, resilience, intelligence, uint32 level, uint64 experience) */
export function decodeCoreStats(hex) {
  const w = words(hex);
  if (w.length < 6) throw new Error('short coreStats result');
  return { strength: u(w[0]), agility: u(w[1]), resilience: u(w[2]), intelligence: u(w[3]), level: u(w[4]), experience: u(w[5]) };
}
/** (string uri, bytes32 soul, address controller, bytes32 configHash, uint64 statsNonce, uint64 manifestNonce) — a struct return: one offset word, then the tuple. */
export function decodeManifest(hex) {
  const d = hex.replace(/^0x/, '');
  const w = words(hex);
  if (w.length < 7) throw new Error('short manifestOf result');
  const base = u(w[0]) * 2;                         // tuple start (bytes → hex chars)
  const at = (i) => d.slice(base + i * 64, base + i * 64 + 64);
  const strOff = base + u(at(0)) * 2;
  const len = u(d.slice(strOff, strOff + 64));
  return {
    characterConfigURI: dec.decode(fromHex(d.slice(strOff + 64, strOff + 64 + len * 2))),
    soulManifestHash: '0x' + at(1),
    agentController: '0x' + at(2).slice(24),
    characterConfigHash: '0x' + at(3),
    statsNonce: u(at(4)),
    manifestNonce: u(at(5)),
  };
}
export const decodeAddress = (hex) => '0x' + words(hex)[0].slice(24);
export function decodeEquipped(hex) {
  const w = words(hex);
  if (w.length < 2) throw new Error('short equipped result');
  const collection = '0x' + w[0].slice(24);
  return collection === '0x' + '0'.repeat(40) ? null : { collection, assetId: BigInt('0x' + w[1]).toString() };
}

/** Read one character completely at `blockTag`. `call(payload, blockTag)`
 *  is the caller's eth_call. Returns null for an unknown token. */
export async function readAgent(call, contract, tokenId, blockTag = 'latest') {
  const owner = decodeAddress(await call(ownerOfCall(contract, tokenId), blockTag));
  if (owner === '0x' + '0'.repeat(40)) return null;
  const [stats, manifest] = await Promise.all([
    call(coreStatsCall(contract, tokenId), blockTag).then(decodeCoreStats),
    call(manifestOfCall(contract, tokenId), blockTag).then(decodeManifest),
  ]);
  const equipped = {};
  for (const slot of SLOTS) { const e = decodeEquipped(await call(equippedCall(contract, tokenId, slot), blockTag)); if (e) equipped[slot] = e; }
  return makeAgent({ tokenId, stats, manifest: { ...manifest, owner }, equipped, controller: manifest.agentController, source: 'registry', pin: { contract, block: blockTag } });
}

/** May this player key field this character? The key's profile OWNER (a
 *  wallet) must be the character's owner or its controller. A key with no
 *  profile can prove nothing and may not field a registry character. */
export function mayPlay(agentRec, profile) {
  const owner = profile?.owner?.toLowerCase();
  if (!owner || !profile.active) return { ok: false, reason: 'player key has no active profile' };
  const tokenOwner = agentRec.manifest?.owner?.toLowerCase(), controller = agentRec.controller?.toLowerCase();
  if (owner === tokenOwner || owner === controller) return { ok: true };
  return { ok: false, reason: `profile owner ${owner.slice(0, 10)}… neither owns nor controls token ${agentRec.tokenId}` };
}

/** progress(tokenId, stats, expectedNonce) calldata — for the authorized progressor tool. */
export function progressCalldata(tokenId, s, expectedNonce) {
  return selector(PROGRESS) + word(tokenId) + [s.strength, s.agility, s.resilience, s.intelligence, s.level ?? 0, s.experience ?? 0].map(word).join('') + word(expectedNonce);
}
