import { canonical, h } from './canonical.js';
import { keccak256Hex } from './keccak.js';

/** ERC-6699 (proposed), Article VI. Stats are uint16 in [0, 65535] so no title
 *  can overflow another's balance, and the soul is a hash rather than a string
 *  so the document can live anywhere and still be checked. */

export const U16 = 65535;
export const SLOTS = ['head', 'body', 'mainhand', 'offhand', 'trinket'];

export const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

/** Article VII step 2. A title declares how normalized stats become its numbers. */
export function defineBalance(map) {
  return {
    map,
    version: h('balance', canonical(Object.keys(map).sort())),
    apply(stats) {
      const out = {};
      for (const [k, fn] of Object.entries(map)) out[k] = fn(stats);
      return out;
    },
  };
}

/** What a title hydrates when an agent walks in. Shape mirrors IERC6699. */
export function agent({ tokenId, stats, manifest, equipped = {}, controller }) {
  return {
    tokenId: String(tokenId),
    stats: normalize(stats),
    manifest,            // { characterConfigURI, soulManifestHash, agentController }
    equipped,            // slot -> { collection, assetId }
    controller: controller ?? manifest?.agentController ?? null,
  };
}

function normalize(s) {
  const clamp = (v) => Math.max(0, Math.min(U16, Math.round(Number(v) || 0)));
  return {
    strength: clamp(s.strength), agility: clamp(s.agility),
    resilience: clamp(s.resilience), intelligence: clamp(s.intelligence),
    level: Math.max(0, Math.round(Number(s.level) || 0)),
    experience: Math.max(0, Math.round(Number(s.experience) || 0)),
  };
}

/** The manifest commitment that travels in every delta. A witness recomputes it
 *  and a mismatched hydration produces a mismatched root, so ranked sterility
 *  and soul tampering are the same event as any other bad root. */
export function hydrationManifest({ agents, mode, balanceVersion }) {
  const sterile = mode === 'ranked';
  const entries = agents.map((a) => ({
    tokenId: a.tokenId,
    stats: a.stats,
    // Stats can change between match start and witness time (progression),
    // so the manifest also carries the registry's stat nonce when it has
    // one: the witness compares nonces instead of needing an archive read.
    statsNonce: a.manifest?.statsNonce ?? null,
    soulManifestHash: a.manifest?.soulManifestHash ?? null,
    characterConfigURI: a.manifest?.characterConfigURI ?? null,
    characterConfigHash: a.manifest?.characterConfigHash ?? null,
    // Ranked disables all stat-altering gear. The manifest records the fact so
    // the witness can replay with equipment off and reach the same root.
    equipped: sterile ? {} : a.equipped,
  }));
  const body = { mode, balanceVersion, sterile, entries };
  return { ...body, manifestHash: h('hydration', canonical(body)) };
}

/** What the chain commits to. Article VI: `bytes32 soulManifestHash =
 *  keccak256(SOUL.MD)`. The same is done for character.json: §6.3 says its
 *  hash is committed on chain, but the §6.4 struct only carries the URI —
 *  see the integration notes; the node commits the hash regardless so a
 *  hydration manifest can be verified even if the URI's content moves. */
export const soulHash = (soulMarkdown) => '0x' + keccak256Hex(soulMarkdown);
export const characterConfigHash = (characterJsonText) => '0x' + keccak256Hex(characterJsonText);

/** Equipment slot ids as the contract keys them: bytes32 = keccak256(name). */
export const slotId = (name) => '0x' + keccak256Hex(name);
