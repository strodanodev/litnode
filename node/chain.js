/** litVM RPC, the thin part. No wallet, no signing — the node only reads.
 *  Every read reports its source so a fallback never looks like a chain read. */
import { beaconFromBlocks, blockOf, localBeacon } from '../protocol/beacon.js';
import { standingCall, decodeStanding } from '../protocol/staking.js';

export function createChain({ rpc, offline = false, nodeStake = null, fetchImpl = globalThis.fetch }) {
  let id = 0;
  const blocks = [];
  let lastError = null;

  const call = async (method, params) => {
    const r = await fetchImpl(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };

  /** Poll the head; keep a short window of blocks for beacon selection. */
  const pollBlock = async () => {
    if (offline) return null;
    try {
      const b = blockOf(await call('eth_getBlockByNumber', ['latest', false]));
      if (!blocks.some((x) => x.number === b.number)) { blocks.push(b); if (blocks.length > 600) blocks.shift(); }
      lastError = null;
      return b;
    } catch (e) { lastError = String(e.message ?? e); return null; }
  };

  const beaconFor = (bucket) => {
    if (offline) return localBeacon(bucket);
    const b = beaconFromBlocks(bucket, blocks);
    if (b) return b;
    if (lastError) return { ...localBeacon(bucket), source: 'local-fallback', error: lastError };
    return null; // chain reachable, block not yet seen → wait
  };

  /** NodeStake.standingOf for many keys. Missing contract → null (dev mesh). */
  const standings = async (nodeIds) => {
    if (!nodeStake || offline) return null;
    const out = {};
    for (const nodeId of nodeIds) {
      try {
        const res = await call('eth_call', [standingCall(nodeStake, nodeId), 'latest']);
        out[nodeId] = decodeStanding(res);
      } catch (e) { lastError = String(e.message ?? e); }
    }
    return out;
  };

  return {
    pollBlock, beaconFor, standings,
    status: () => ({ rpc, offline, nodeStake, blocks: blocks.length, head: blocks.at(-1)?.number ?? null, lastError }),
  };
}
