/** Staking reads: what the node asks NodeStake and how it uses the answer.
 *  Pure — the caller does the eth_call. Chain: litVM Liteforge (4441).
 *
 *  Why this exists (BUILD-SPEC §2.2): operator and standing used to be
 *  self-asserted in the heartbeat. With a bond on chain, the operator IS the
 *  staking address and the standing IS the bonded amount, both read from the
 *  contract, so a witness "under a different operator" means a different
 *  staking address, and a node that has not posted the bond is not eligible
 *  for placement no matter what its heartbeat says. */
import { selector } from './keccak.js';

export const STANDING_OF = 'standingOf(bytes32)';

/** A node key is a 32-byte ed25519 public key — exactly a bytes32. */
export const nodeKeyBytes32 = (nodeIdHex) => {
  const h = nodeIdHex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('nodeId must be a 32-byte hex key');
  return '0x' + h;
};

/** eth_call payload for standingOf(nodeKey). */
export const standingCall = (contract, nodeIdHex) => ({
  to: contract,
  data: selector(STANDING_OF) + nodeKeyBytes32(nodeIdHex).slice(2),
});

/** Decode (address operator, uint256 amount, bool active). */
export function decodeStanding(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 192) throw new Error('short standingOf result');
  return {
    operator: '0x' + d.slice(24, 64),
    amount: BigInt('0x' + d.slice(64, 128)),
    active: BigInt('0x' + d.slice(128, 192)) === 1n,
  };
}

/** Overlay on-chain standing onto gossiped peers. A peer with no active
 *  bond is dropped; `operator` and `standing` are REPLACED by chain values so
 *  nothing self-asserted survives into placement. `standing` is the bonded
 *  amount in whole tokens (18 decimals), so manifests can set a floor in
 *  tokens. `stakes` maps nodeId → decoded standing (missing = not staked). */
export function applyStakes(peers, stakes) {
  const out = [];
  for (const p of peers) {
    const s = stakes[p.nodeId];
    if (!s || !s.active) continue;
    out.push({ ...p, operator: s.operator.toLowerCase(), standing: Number(s.amount / 10n ** 18n), staked: true });
  }
  return out;
}
