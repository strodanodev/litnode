/** Witness-side hydration check. BUILD-SPEC §6 CO-SIGN, corrected: the
 *  witness does NOT replay from the host's manifest. It rebuilds the manifest
 *  from the registry itself and compares hashes. A host that inflated its
 *  own player's stats, or left equipment in a ranked match, produces a
 *  manifest the witness cannot reproduce — refused before any replay runs. */
import { hydrationManifest } from './erc6699.js';

/** @param claimed   the delta's hydrationManifest
 *  @param lookup    async (tokenId) → hydrated agent from the registry (at the pinned block if the registry supports it)
 *  @param balanceVersion  the title's balance version (must match the claim) */
export async function verifyHydration(claimed, lookup, balanceVersion) {
  if (!claimed?.entries?.length) return { ok: false, reason: 'no manifest' };
  if (claimed.balanceVersion !== balanceVersion) return { ok: false, reason: 'balance version' };
  if ((claimed.mode === 'ranked') !== !!claimed.sterile) return { ok: false, reason: 'sterility flag' };
  const agents = [];
  for (const e of claimed.entries) {
    const a = await lookup(e.tokenId);
    if (!a) return { ok: false, reason: `token ${e.tokenId} unknown` };
    agents.push(a);
  }
  const rebuilt = hydrationManifest({ agents, mode: claimed.mode, balanceVersion });
  return rebuilt.manifestHash === claimed.manifestHash
    ? { ok: true, manifestHash: rebuilt.manifestHash }
    : { ok: false, reason: 'manifest mismatch', expected: rebuilt.manifestHash, claimed: claimed.manifestHash };
}
