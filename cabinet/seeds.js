/** The seed list on chain (NodeDirectory), read straight from litVM by the
 *  browser — no node needed. This is how the hosted arcade page finds the
 *  mesh for a visitor with no node of their own, and how a fresh install
 *  could seed without anyone typing a URL. Read-only; the same calldata the
 *  node uses (vendored protocol/directory.js). */
import { CHAIN } from './config.js';
import { entryOfCall, decodeEntry, liveSeeds, readDirectoryKeys, mapLimit, READ_CONCURRENCY } from './protocol/directory.js';
import { standingCall, decodeStanding } from './protocol/staking.js';
import { checkChallenge, newNonce } from './protocol/challenge.js';

let id = 0;
export async function rpc(method, params) {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
export const configured = () => !!CHAIN.NodeDirectory;

/** Live seeds: announced, bonded, fresh — newest first. [] when unconfigured or unreachable.
 *  The key list is paged (generation 4, falls back to keys() on generation 3); per-key reads run
 *  READ_CONCURRENCY keys at a time (two eth_calls each), so the gateway's ~25 req/s limit is not
 *  tripped by a 2×N fan-out. One key failing to read drops that key, not the whole list. */
export async function chainSeeds() {
  if (!configured()) return [];
  try {
    const call = (payload) => rpc('eth_call', [payload, 'latest']);
    const keys = await readDirectoryKeys(call, CHAIN.NodeDirectory);
    const entries = {}, stakes = {};
    await mapLimit(keys, Math.max(1, READ_CONCURRENCY / 2), async (k) => {
      try {
        const [e, s] = await Promise.all([call(entryOfCall(CHAIN.NodeDirectory, k)), call(standingCall(CHAIN.NodeStake, k))]);
        entries[k] = decodeEntry(e); stakes[k] = decodeStanding(s);
      } catch { /* this key is skipped */ }
    });
    return liveSeeds(entries, stakes);
  } catch { return []; }
}

/** The first seed that PROVES it is the node its directory entry names: it
 *  signs our nonce with that key (GET /whoami). A URL that merely answers
 *  /health is not a seed — anyone can answer /health. Over https only (a
 *  browser on https can only talk to https seeds). null when none does. */
export async function reachableSeed(seeds) {
  for (const s of seeds) {
    if (!/^https:/.test(s.url)) continue;
    try {
      const nonce = newNonce();
      const r = await fetch(`${s.url}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const c = await checkChallenge(await r.json(), { expectNodeId: s.nodeId, nonce });
      if (c.ok) return { ...s, proven: true };
    } catch { /* next */ }
  }
  return null;
}
