/** The beacon: a value neither host nor player chooses.
 *
 *  litVM (Arbitrum Orbit) facts that shape this, from docs.litvm.com
 *  "EVM Differences": blocks are produced on demand (measured ~250 ms apart
 *  under load on Liteforge), `blockhash` is "NOT cryptographically secure",
 *  `prevrandao` is the constant 1, and `block.number` is an approximate L1
 *  number. So:
 *
 *   - the beacon for queue bucket B is the hash of the first litVM block whose
 *     timestamp ≥ bucketEnd(B): chosen after every entry in B committed, so a
 *     player cannot grind a key or time an entry to pick a host;
 *   - it is unpredictable to players and hosts, NOT to the sequencer. That is
 *     the honest claim. A sequencer that also operates a node could bias its
 *     own draw; nothing short of a VRF or an on-chain commit-reveal closes it;
 *   - offline nodes substitute a local string and REPORT it (§5.2). */
import { h } from './canonical.js';
import { bucketEnd } from './pairing.js';

/** Pure: given the blocks a node has seen (any order), the beacon for a bucket.
 *  "First block at or after the bucket end" is only knowable when the window
 *  also holds a block from BEFORE it; a window that starts after the bucket
 *  end (the node came up later, or its rolling window slid past) cannot say
 *  which block was first, and answers null rather than a guess. Without this
 *  a rolling window re-picked a later block every poll, and a stale queue
 *  pair minted a new match id every second (0.9.1). */
export function beaconFromBlocks(bucket, blocks) {
  const t = bucketEnd(bucket) / 1000;
  if (!blocks.some((b) => b.timestamp < t)) return null;
  const after = blocks.filter((b) => b.timestamp >= t).sort((a, b) => a.number - b.number);
  const first = after[0];
  return first ? { beacon: h('beacon', first.hash), source: 'chain', block: first.number } : null;
}

/** Local substitute for an offline node: deterministic, and labelled. */
export const localBeacon = (bucket) => ({ beacon: h('beacon', `local:${bucket}`), source: 'local', block: null });

/** Parse an eth_getBlockByNumber result into what beaconFromBlocks reads. */
export const blockOf = (rpcBlock) => ({
  number: parseInt(rpcBlock.number, 16),
  timestamp: parseInt(rpcBlock.timestamp, 16),
  hash: rpcBlock.hash,
});
