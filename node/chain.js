/** litVM RPC, the thin part. No wallet, no signing — the node only reads.
 *  Every read reports its source so a fallback never looks like a chain read. */
import { beaconFromBlocks, blockOf, localBeacon } from '../protocol/beacon.js';
import { bucketOf } from '../protocol/pairing.js';
import { standingCall, decodeStanding } from '../protocol/staking.js';
import { ownerOfKeyCall, decodeOwner, nameOfCall, decodeString } from '../protocol/profile.js';
import { keysCall, decodeKeys, entryOfCall, decodeEntry } from '../protocol/directory.js';
import { readAgent } from '../protocol/registry.js';

export function createChain({ rpc, offline = false, nodeStake = null, playerProfile = null, nodeDirectory = null, erc6699 = null, fetchImpl = globalThis.fetch }) {
  let id = 0;
  const blocks = [];
  let lastError = null;

  // Liteforge's gateway answers 502/530 with an HTML page now and then. A
  // transient answer (5xx, non-JSON, network) is retried a few times with a
  // growing pause; a JSON-RPC error (a revert, a bad argument) is not.
  const call = async (method, params, tries = 4) => {
    for (let i = 1; ; i++) {
      try {
        const r = await fetchImpl(rpc, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        let j;
        if (typeof r.text === 'function') {
          const text = await r.text();
          try { j = JSON.parse(text); } catch { throw Object.assign(new Error(`${method}: HTTP ${r.status} non-JSON reply from the RPC gateway`), { transient: true }); }
        } else j = await r.json(); // a test fake with only json()
        if (j.error) throw new Error(`${method}: ${j.error.message}`);
        return j.result;
      } catch (e) {
        const transient = e.transient || e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(String(e.message));
        if (!transient || i >= tries) throw e;
        await new Promise((res) => setTimeout(res, 1000 * i));
      }
    }
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

  // A bucket's chain beacon is pinned the first time it is known: the block
  // window rolls on, and a placement frozen on one beacon must keep it.
  const pinned = new Map(); // bucket → { beacon, source, block }
  const PIN_MS = 30 * 60_000;
  const beaconFor = (bucket) => {
    if (offline) return localBeacon(bucket);
    const p = pinned.get(bucket);
    if (p) return p;
    const b = beaconFromBlocks(bucket, blocks);
    if (b) {
      pinned.set(bucket, b);
      if (pinned.size > 2000) { const cut = bucketOf(Date.now() - PIN_MS); for (const k of pinned.keys()) if (k < cut) pinned.delete(k); }
      return b;
    }
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

  /** PlayerProfile.ownerOfKey for many player keys. Missing contract → null. */
  const profiles = async (keys) => {
    if (!playerProfile || offline) return null;
    const out = {};
    for (const k of keys) {
      try { out[k] = decodeOwner(await call('eth_call', [ownerOfKeyCall(playerProfile, k), 'latest'])); }
      catch (e) { lastError = String(e.message ?? e); }
    }
    return out;
  };
  const profileName = async (tokenId) => {
    if (!playerProfile || offline) return null;
    try { return decodeString(await call('eth_call', [nameOfCall(playerProfile, tokenId), 'latest'])); } catch { return null; }
  };

  /** ERC6699Registry (v2) at a PINNED block: the character as the chain had
   *  it when the match was placed. Same reads on every node → same agent.
   *  A registry that cannot serve the block (pruned) throws; the caller
   *  refuses rather than hydrating from the submission. */
  const agentAt = async (tokenId, blockTag = 'latest') => {
    if (!erc6699 || offline) return null;
    return readAgent((payload, tag) => call('eth_call', [payload, tag]), erc6699, tokenId, blockTag);
  };

  /** NodeDirectory: every announced key → entry. Missing contract → null. */
  const directory = async () => {
    if (!nodeDirectory || offline) return null;
    try {
      const keys = decodeKeys(await call('eth_call', [keysCall(nodeDirectory), 'latest']));
      const out = {};
      for (const k of keys) { try { out[k] = decodeEntry(await call('eth_call', [entryOfCall(nodeDirectory, k), 'latest'])); } catch (e) { lastError = String(e.message ?? e); } }
      return out;
    } catch (e) { lastError = String(e.message ?? e); return null; }
  };

  return {
    pollBlock, beaconFor, standings, profiles, profileName, directory, agentAt, rpc: call,
    status: () => ({ rpc, offline, nodeStake, playerProfile, nodeDirectory, erc6699, blocks: blocks.length, head: blocks.at(-1)?.number ?? null, lastError }),
  };
}
