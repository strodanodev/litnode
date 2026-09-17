/** The seed list on chain (NodeDirectory), read straight from litVM by the
 *  browser — no node needed. This is how the hosted arcade page finds the
 *  mesh for a visitor with no node of their own, and how a fresh install
 *  could seed without anyone typing a URL. Read-only; the same calldata the
 *  node uses (vendored protocol/directory.js). */
import { CHAIN } from './config.js';
import { keysCall, entryOfCall, decodeKeys, decodeEntry, liveSeeds } from './protocol/directory.js';
import { standingCall, decodeStanding } from './protocol/staking.js';

let id = 0;
async function rpc(method, params) {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
export const configured = () => !!CHAIN.NodeDirectory;

/** Live seeds: announced, bonded, fresh — newest first. [] when unconfigured or unreachable. */
export async function chainSeeds() {
  if (!configured()) return [];
  try {
    const keys = decodeKeys(await rpc('eth_call', [keysCall(CHAIN.NodeDirectory), 'latest']));
    const entries = {}, stakes = {};
    await Promise.all(keys.map(async (k) => {
      const [e, s] = await Promise.all([rpc('eth_call', [entryOfCall(CHAIN.NodeDirectory, k), 'latest']), rpc('eth_call', [standingCall(CHAIN.NodeStake, k), 'latest'])]);
      entries[k] = decodeEntry(e); stakes[k] = decodeStanding(s);
    }));
    return liveSeeds(entries, stakes);
  } catch { return []; }
}

/** The first seed that answers /health over https (a browser on https can
 *  only talk to https seeds). null when none does. */
export async function reachableSeed(seeds) {
  for (const s of seeds) {
    if (!/^https:/.test(s.url)) continue;
    try { const r = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(6000) }); if (r.ok) return s; } catch { /* next */ }
  }
  return null;
}
