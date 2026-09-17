/** Settlement tree. BUILD-SPEC §11: one root per hour, sha256 binary tree
 *  over the sorted leaf set, short inclusion paths, anchor calldata prepared
 *  by the node and broadcast by the operator's own key. */
import { h, sha256Hex } from './canonical.js';
import { selector } from './keccak.js';

export const EPOCH_HOUR_MS = 3_600_000;
export const hourOf = (ms) => Math.floor(ms / EPOCH_HOUR_MS);

/** A leaf commits to everything a match settled — through the result
 *  commitment (protocol/result.js: build, root, hydration, scores, seed,
 *  attestation, host…) — plus the witness set and the verification status
 *  AS OF THE FREEZE. A co-signature that arrives after the hour is frozen
 *  lands on the delta but never changes the leaf, so a historical proof
 *  stays reproducible from the frozen batch alone (BUILD-SPEC §11, audit
 *  finding 4). `verified` is what a reader uses to tell "included in a
 *  committed batch" from "independently verified competitive result". */
export const leafOf = (d, { cosigners = d.cosigners ?? [], verified = d.verified ?? false } = {}) => h('leaf', {
  matchId: d.matchId, rulesetId: d.rulesetId, buildHash: d.buildHash,
  resultHash: d.resultHash ?? null,
  finalStateRoot: d.finalStateRoot, hydrationHash: d.hydrationHash,
  scores: d.scores, hostId: d.hostId, cosigners: [...cosigners].sort(), verified: !!verified,
});

/** How long after the hour ends a batch stays open for late co-signatures
 *  before the node freezes it. */
export const FREEZE_GRACE_MS = 15 * 60_000;
export const freezeAt = (hour) => (hour + 1) * EPOCH_HOUR_MS + FREEZE_GRACE_MS;

const pairHash = (a, b) => sha256Hex(`${a}${b}`);

/** Build the tree over a leaf set (sorted, deduplicated). Odd levels
 *  duplicate the last node. Returns { root, leaves, levels }. */
export function buildTree(leafHashes) {
  const leaves = [...new Set(leafHashes)].sort();
  if (leaves.length === 0) return { root: h('empty-epoch'), leaves, levels: [[]] };
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(pairHash(prev[i], prev[i + 1] ?? prev[i]));
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], leaves, levels };
}

/** Inclusion path for a leaf: [{hash, left}] from leaf to root. */
export function proofFor(tree, leaf) {
  let idx = tree.leaves.indexOf(leaf);
  if (idx < 0) return null;
  const path = [];
  for (let l = 0; l < tree.levels.length - 1; l++) {
    const level = tree.levels[l];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    path.push({ hash: level[sib] ?? level[idx], left: idx % 2 === 1 });
    idx = Math.floor(idx / 2);
  }
  return path;
}

export function verifyProof(leaf, path, root) {
  let cur = leaf;
  for (const { hash, left } of path) cur = left ? pairHash(hash, cur) : pairHash(cur, hash);
  return cur === root;
}

/** EpochAnchor v2: propose(uint64 epoch, bytes32 root, bytes32 nodeKey),
 *  callable only by the operator of the bonded `nodeKey`; the root finalizes
 *  when `quorum` distinct operators proposed it. The selector is derived
 *  with keccak here rather than copied, so the constant is checked by the
 *  test rather than trusted. */
export const PROPOSE_SIG = 'propose(uint64,bytes32,bytes32)';
export const proposeSelector = () => selector(PROPOSE_SIG);
export function proposeCalldata(epochHour, rootHex, nodeKeyHex) {
  const root = rootHex.replace(/^0x/, ''), key = nodeKeyHex.replace(/^0x/, '');
  if (root.length !== 64) throw new Error('root must be 32 bytes');
  if (key.length !== 64) throw new Error('nodeKey must be 32 bytes');
  return proposeSelector() + BigInt(epochHour).toString(16).padStart(64, '0') + root + key;
}
/** v1 (any caller, first root wins) — kept so an old anchor can still be decoded; do not use for new anchors. */
export const ANCHOR_SIG = 'anchorEpoch(uint64,bytes32)';
export const anchorSelector = () => selector(ANCHOR_SIG);
export function anchorCalldata(epochHour, rootHex) {
  const root = rootHex.replace(/^0x/, '');
  if (root.length !== 64) throw new Error('root must be 32 bytes');
  return anchorSelector() + BigInt(epochHour).toString(16).padStart(64, '0') + root;
}
