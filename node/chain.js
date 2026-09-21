/** litVM RPC, the thin part. No wallet, no signing — the node only reads.
 *  Every read reports its source so a fallback never looks like a chain read. */
import { blockOf, localBeacon } from '../protocol/beacon.js';
import { h } from '../protocol/canonical.js';
import { bucketOf, bucketEnd } from '../protocol/pairing.js';
import { standingCall, decodeStanding, nodeOfCall, decodeNode, adminIsContractCall, decodeBool, witnessEligibleCall } from '../protocol/staking.js';
import { statusOfCall, decodeStatus } from '../protocol/release.js';
import { buildStatusCall, decodeBuildStatus, titleOfCall, decodeTitle } from '../protocol/title.js';
import { ownerOfKeyCall, decodeOwner, nameOfCall, decodeString } from '../protocol/profile.js';
import { keysCall, decodeKeys, entryOfCall, decodeEntry } from '../protocol/directory.js';
import { readAgent } from '../protocol/registry.js';

export function createChain({ rpc, offline = false, nodeStake = null, playerProfile = null, nodeDirectory = null, erc6699 = null, releaseRegistry = null, titleRegistry = null, fetchImpl = globalThis.fetch }) {
  let id = 0;
  const blocks = [];
  let lastError = null;
  // RPC round-trip, for the operator's dashboard: the last call and a moving average (every call, not only polls).
  let rpcMs = null, rpcLastMs = null, rpcCalls = 0, rpcFailures = 0, rpcLastAt = 0;
  const timed = (t0, ok) => { rpcLastMs = Math.round(performance.now() - t0); rpcMs = rpcMs == null ? rpcLastMs : Math.round(rpcMs * 0.8 + rpcLastMs * 0.2); rpcCalls++; if (!ok) rpcFailures++; rpcLastAt = Date.now(); };

  // Liteforge's gateway answers 502/530 with an HTML page now and then. A
  // transient answer (5xx, non-JSON, network) is retried a few times with a
  // growing pause; a JSON-RPC error (a revert, a bad argument) is not.
  const call = async (method, params, tries = 4) => {
    for (let i = 1; ; i++) {
      const t0 = performance.now();
      let answered = false; // the gateway replied (a revert is an answer; a timeout or an HTML page is not)
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
        answered = true; timed(t0, true);
        if (j.error) throw new Error(`${method}: ${j.error.message}`);
        return j.result;
      } catch (e) {
        if (!answered) timed(t0, false);
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
  // The beacon is THE first block at or after the bucket end — not the first such block this node happened
  // to sample. Liteforge makes a block every 0.25 s and a node samples the head every ~2 s, so two nodes'
  // windows held different 'first' blocks, named different beacons for the same bucket and players, and
  // minted three match ids — three commits — for one match (21 Sep 2026). When the sampled blocks bracket
  // the end without being adjacent, the exact block is found by number (a short binary search, cached)
  // before the bucket is pinned; until then the bucket waits a tick rather than guess.
  const resolving = new Map(); // bucket → promise of the exact first block
  const byNumber = new Map();  // number → block, for the search
  const fetchBlock = async (n) => { let b = byNumber.get(n); if (!b) { b = blockOf(await call('eth_getBlockByNumber', ['0x' + n.toString(16), false])); byNumber.set(n, b); if (byNumber.size > 4000) byNumber.delete(byNumber.keys().next().value); } return b; };
  const resolveExact = (bucket, lo, hi) => {
    // lo: a block with timestamp < end; hi: a block with timestamp ≥ end; find the least number ≥ end
    const t = bucketEnd(bucket) / 1000;
    const p = (async () => {
      let a = lo, b = hi;
      while (b - a > 1) { const m = Math.floor((a + b) / 2); const blk = await fetchBlock(m); if (blk.timestamp >= t) b = m; else a = m; }
      return fetchBlock(b);
    })();
    resolving.set(bucket, p);
    p.then((blk) => { if (!pinned.has(bucket)) pin(bucket, { beacon: h('beacon', blk.hash), source: 'chain', block: blk.number }); }).catch(() => {}).finally(() => resolving.delete(bucket));
  };
  const pin = (bucket, b) => { pinned.set(bucket, b); if (pinned.size > 2000) { const cut = bucketOf(Date.now() - PIN_MS); for (const k of pinned.keys()) if (k < cut) pinned.delete(k); } };
  const beaconFor = (bucket) => {
    if (offline) return localBeacon(bucket);
    const p = pinned.get(bucket);
    if (p) return p;
    const t = bucketEnd(bucket) / 1000;
    const before = blocks.filter((x) => x.timestamp < t).sort((x, y) => y.number - x.number)[0];
    const after = blocks.filter((x) => x.timestamp >= t).sort((x, y) => x.number - y.number)[0];
    if (before && after) {
      if (after.number === before.number + 1) { pin(bucket, { beacon: h('beacon', after.hash), source: 'chain', block: after.number }); return pinned.get(bucket); }
      if (!resolving.has(bucket)) resolveExact(bucket, before.number, after.number);
      return null; // exact block on its way: a tick later
    }
    if (lastError) return { ...localBeacon(bucket), source: 'local-fallback', error: lastError };
    return null; // chain reachable, block not yet seen → wait
  };

  /** NodeStake.standingOf for many keys. Missing contract → null (dev mesh). */
  let stakeIsV3 = null; // witnessEligible answered once → v3; reverted once → v2, never asked again
  const standings = async (nodeIds) => {
    if (!nodeStake || offline) return null;
    const out = {};
    for (const nodeId of nodeIds) {
      try {
        const res = await call('eth_call', [standingCall(nodeStake, nodeId), 'latest']);
        out[nodeId] = decodeStanding(res);
        if (stakeIsV3 !== false && out[nodeId].active) {
          try { out[nodeId].eligible = decodeBool(await call('eth_call', [witnessEligibleCall(nodeStake, nodeId), 'latest'])); stakeIsV3 = true; }
          catch { if (stakeIsV3 === null) stakeIsV3 = false; }
        }
      } catch (e) { lastError = String(e.message ?? e); }
    }
    return out;
  };
  /** eth_getLogs for a filter (protocol/matchbook.js logsFilter). Throws on an RPC failure so a cursor is never advanced past a gap. */
  const getLogs = async (filter) => { if (offline) return []; return await call('eth_getLogs', [filter]); };
  const blockNumber = async () => { if (offline) return null; return parseInt(await call('eth_blockNumber', []), 16); };

  /** NodeStake v3: lock, eligibility age and delegate for ONE key. A v2
   *  contract has no nodeOf and reverts → null, labelled by the caller. */
  const nodeInfo = async (nodeId) => {
    if (!nodeStake || offline) return null;
    try { return decodeNode(await call('eth_call', [nodeOfCall(nodeStake, nodeId), 'latest'])); }
    catch (e) { lastError = String(e.message ?? e); return null; }
  };
  /** Is NodeStake's admin a contract (multisig / timelock) or a wallet. null = unknown / v2. */
  const stakeAdminIsContract = async () => {
    if (!nodeStake || offline) return null;
    try { return decodeBool(await call('eth_call', [adminIsContractCall(nodeStake), 'latest'])); } catch { return null; }
  };
  /** ReleaseRegistry.statusOf(zipHash). Missing contract → null; an RPC
   *  failure THROWS so the updater can tell "unset" from "unreadable". */
  const releaseStatus = async (zipHash) => {
    if (!releaseRegistry || offline) return null;
    return decodeStatus(await call('eth_call', [statusOfCall(releaseRegistry, zipHash), 'latest']));
  };
  /** TitleRegistry.buildStatus(titleId(rulesetId), buildHash): who holds the
   *  title and whether this build is registered, active, revoked. Missing
   *  contract → null; an RPC failure THROWS (unreadable ≠ unregistered). */
  const titleBuild = async (rulesetId, buildHash) => {
    if (!titleRegistry || offline) return null;
    return decodeBuildStatus(await call('eth_call', [buildStatusCall(titleRegistry, rulesetId, buildHash), 'latest']));
  };
  /** TitleRegistry.titleOf: the publisher (token holder) of a rulesetId; null = unregistered. An RPC failure THROWS so the caller keeps what it knew. */
  const titleOwner = async (rulesetId) => {
    if (!titleRegistry || offline) return null;
    return decodeTitle(await call('eth_call', [titleOfCall(titleRegistry, rulesetId), 'latest'])).publisher;
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
    pollBlock, beaconFor, standings, nodeInfo, stakeAdminIsContract, releaseStatus, titleBuild, titleOwner, getLogs, blockNumber, profiles, profileName, directory, agentAt, rpc: call,
    // The last n blocks this node sampled (number, hash, timestamp) — for a dashboard's block strip; real hashes, not a fixture.
    recentBlocks: (n = 12) => blocks.slice(-n).map((b) => ({ number: b.number, hash: b.hash, timestamp: b.timestamp })),
    status: () => ({ rpc, offline, nodeStake, playerProfile, nodeDirectory, erc6699, releaseRegistry, titleRegistry, blocks: blocks.length, head: blocks.at(-1)?.number ?? null, headTs: blocks.at(-1)?.timestamp ?? null, lastError,
      // `lagS`: seconds between the head we hold and now — the RPC's freshness, or ours; Liteforge makes a block every 0.25 s.
      rpcMs, rpcLastMs, rpcCalls, rpcFailures, rpcAt: rpcLastAt ? new Date(rpcLastAt).toISOString() : null, lagS: blocks.at(-1)?.timestamp ? Math.max(0, Math.round(Date.now() / 1000 - blocks.at(-1).timestamp)) : null }),
  };
}
