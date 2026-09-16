/** Settlement tree. BUILD-SPEC §11: one root per hour, sha256 binary tree
 *  over the sorted leaf set, short inclusion paths, anchor calldata prepared
 *  by the node and broadcast by the operator's own key. */
import { h, sha256Hex } from './canonical.js';
import { selector } from './keccak.js';

export const EPOCH_HOUR_MS = 3_600_000;
export const hourOf = (ms) => Math.floor(ms / EPOCH_HOUR_MS);

/** A leaf commits to everything a match settled: the ruleset build, the
 *  state root, the hydration, the scores, who hosted and who co-signed. */
export const leafOf = (d) => h('leaf', {
  matchId: d.matchId, rulesetId: d.rulesetId, buildHash: d.buildHash,
  finalStateRoot: d.finalStateRoot, hydrationHash: d.hydrationHash,
  scores: d.scores, hostId: d.hostId, cosigners: [...(d.cosigners ?? [])].sort(),
});

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

/** anchorEpoch(uint64 epoch, bytes32 root) calldata. The selector is derived
 *  with keccak here rather than copied, so the spec's constant is checked
 *  by the test rather than trusted. */
export const ANCHOR_SIG = 'anchorEpoch(uint64,bytes32)';
export const anchorSelector = () => selector(ANCHOR_SIG);
export function anchorCalldata(epochHour, rootHex) {
  const root = rootHex.replace(/^0x/, '');
  if (root.length !== 64) throw new Error('root must be 32 bytes');
  return anchorSelector() + BigInt(epochHour).toString(16).padStart(64, '0') + root;
}
