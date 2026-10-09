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

/** An RPC URL as the dashboard may show it: no credentials, no query, and a path segment that looks like an
 *  API key (a provider's https://…/v2/<key>) replaced by '…'. */
export const redactRpc = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.split('/').map((s) => (/^[A-Za-z0-9_-]{16,}$/.test(s) ? '…' : s)).join('/');
  } catch { return String(url); }
};

/** `rpc` is one URL, a comma-separated list or an array: the first is preferred, the rest are fallbacks. */
export const rpcList = (rpc) => (Array.isArray(rpc) ? rpc : String(rpc ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);

const BENCH_MS = 60_000, BENCH_MAX_MS = 10 * 60_000;
// A rate limit is not a hiccup: retrying it makes it worse. Caldera's public gateway answered "429" and
// "Bandwidth limit exceeded" to the desktop node 42 times a second on 9 Oct 2026, every call retried, while its
// view of the chain sat four minutes behind. A rate-limited endpoint is paused for RATE_MS, doubling while the
// limit persists, up to RATE_MAX_MS, and nothing is sent to it meanwhile.
const RATE_MS = 30_000, RATE_MAX_MS = 5 * 60_000;
const RATE_RE = /rate.?limit|bandwidth limit|too many requests|request limit|limit exceeded|exceeded .*limit|capacity exceeded/i;

export function createChain({ rpc, offline = false, nodeStake = null, playerProfile = null, nodeDirectory = null, erc6699 = null, releaseRegistry = null, titleRegistry = null, fetchImpl = globalThis.fetch }) {
  let id = 0;
  const blocks = [];
  let lastError = null;
  // RPC round-trip, for the operator's dashboard: the last call and a moving average (every call, not only polls).
  let rpcMs = null, rpcLastMs = null, rpcCalls = 0, rpcFailures = 0, rpcLastAt = 0;
  const timed = (t0, ok) => { rpcLastMs = Math.round(performance.now() - t0); rpcMs = rpcMs == null ? rpcLastMs : Math.round(rpcMs * 0.8 + rpcLastMs * 0.2); rpcCalls++; if (!ok) rpcFailures++; rpcLastAt = Date.now(); };

  // Endpoints, preferred first. One that fails in transit (timeout, 5xx page, 429, refused) is benched for a
  // minute, doubling while it keeps failing, up to ten; calls go to the next one meanwhile and come back to the
  // preferred one when its bench ends. A JSON-RPC error (a revert) is an answer and never moves a call.
  const endpoints = rpcList(rpc).map((url) => ({ url, downUntil: 0, failures: 0, lastError: null, head: null, answered: 0, limitedUntil: 0, limits: 0 }));
  let active = endpoints[0] ?? null; // the endpoint that answered last
  const usable = () => {
    const now = Date.now();
    const up = endpoints.filter((e) => e.downUntil <= now);
    const down = endpoints.filter((e) => e.downUntil > now).sort((a, b) => a.downUntil - b.downUntil);
    return [...up, ...down]; // all benched: still try, the one back soonest first
  };
  const bench = (ep, e) => {
    ep.failures++; ep.lastError = String(e.message ?? e);
    if (endpoints.length > 1) ep.downUntil = Date.now() + Math.min(BENCH_MS * 2 ** (ep.failures - 1), BENCH_MAX_MS);
  };
  const transientError = (msg) => Object.assign(new Error(msg), { transient: true });
  const rateError = (msg) => Object.assign(new Error(msg), { transient: true, rateLimited: true });
  const limit = (ep, e) => {
    ep.limits++; ep.lastError = String(e.message ?? e);
    ep.limitedUntil = Date.now() + Math.min(RATE_MS * 2 ** (ep.limits - 1), RATE_MAX_MS);
  };
  const limited = (ep) => ep.limitedUntil > Date.now();
  const isTransient = (e) => e.transient || e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(String(e.message));
  const blockNum = (tag) => (typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag) ? parseInt(tag, 16) : typeof tag === 'number' ? tag : null);

  const post = async (ep, method, params) => {
    const t0 = performance.now();
    let answered = false; // the gateway replied (a revert is an answer; a timeout or an HTML page is not)
    try {
      const r = await fetchImpl(ep.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 429) throw rateError(`${method}: HTTP 429 from the RPC gateway (rate limited)`);
      let j;
      if (typeof r.text === 'function') {
        const text = await r.text();
        try { j = JSON.parse(text); } catch { throw transientError(`${method}: HTTP ${r.status} non-JSON reply from the RPC gateway`); }
      } else j = await r.json(); // a test fake with only json()
      // "Bandwidth limit exceeded" can come as a JSON-RPC error with a 200: a limit, not an answer
      if (j.error && RATE_RE.test(String(j.error.message))) throw rateError(`${method}: ${j.error.message} (rate limited)`);
      answered = true; timed(t0, true);
      ep.failures = 0; ep.downUntil = 0; ep.limits = 0; ep.limitedUntil = 0; ep.answered++; active = ep;
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      if (method === 'eth_blockNumber') ep.head = Math.max(ep.head ?? 0, parseInt(j.result, 16));
      else if (method === 'eth_getBlockByNumber' && params?.[0] === 'latest' && j.result?.number) ep.head = Math.max(ep.head ?? 0, parseInt(j.result.number, 16));
      return j.result;
    } finally { if (!answered) timed(t0, false); }
  };

  // Liteforge's gateway answers 502/530 with an HTML page now and then. A transient failure moves the call to
  // the next endpoint at once; when every endpoint has failed it is retried a few times with a growing pause.
  // eth_getLogs over a numbered range is only taken from an endpoint whose head has reached the range's end: a
  // fallback a few blocks behind answers [] for blocks it does not have yet, and MatchBook's cursor would move
  // past events it never saw.
  const call = async (method, params, tries = 4) => {
    const need = method === 'eth_getLogs' && endpoints.length > 1 ? blockNum(params?.[0]?.toBlock) : null;
    if (!endpoints.length) throw new Error(`${method}: no RPC endpoint configured`);
    let last = null;
    for (let round = 1; ; round++) {
      const open = usable().filter((ep) => !limited(ep));
      if (!open.length) {
        // every endpoint is rate-limited: fail at once, without touching the network
        const until = Math.min(...endpoints.map((ep) => ep.limitedUntil));
        throw rateError(`${method}: RPC rate-limited; calls paused until ${new Date(until).toISOString()}`);
      }
      for (const ep of open) {
        try {
          if (need != null && (ep.head ?? -1) < need) {
            await post(ep, 'eth_blockNumber', []);
            if (ep.head < need) { last = transientError(`${method}: ${redactRpc(ep.url)} is at block ${ep.head}, behind ${need}`); continue; }
          }
          return await post(ep, method, params);
        } catch (e) {
          if (e.rateLimited) { limit(ep, e); last = e; continue; } // the next endpoint, if any; never this one again now
          if (!isTransient(e)) throw e;
          last = e; bench(ep, e);
        }
      }
      if (last?.rateLimited && endpoints.every(limited)) throw last; // never retried: the pause decides when to ask again
      if (round >= tries) throw last;
      await new Promise((res) => setTimeout(res, 1000 * round));
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
    /** The head's base fee in wei, or null (no base fee on this chain / nothing polled yet). */
    baseFeeWei: () => { const b = blocks.at(-1); return b?.baseFeePerGas != null ? BigInt(b.baseFeePerGas) : null; },
    status: () => ({ rpc: active ? redactRpc(active.url) : null, offline,
      // every endpoint, preferred first: which answered last, which are benched and why (URLs redacted)
      rateLimitedUntil: endpoints.length && endpoints.every(limited) ? new Date(Math.min(...endpoints.map((e) => e.limitedUntil))).toISOString() : null,
      rpcEndpoints: endpoints.map((e) => ({ url: redactRpc(e.url), active: e === active, down: e.downUntil > Date.now(), downUntil: e.downUntil > Date.now() ? new Date(e.downUntil).toISOString() : null, limitedUntil: limited(e) ? new Date(e.limitedUntil).toISOString() : null, failures: e.failures, answered: e.answered, head: e.head, lastError: e.lastError })), nodeStake, playerProfile, nodeDirectory, erc6699, releaseRegistry, titleRegistry, blocks: blocks.length, head: blocks.at(-1)?.number ?? null, headTs: blocks.at(-1)?.timestamp ?? null, lastError,
      // `lagS`: seconds between the head we hold and now — the RPC's freshness, or ours; Liteforge makes a block every 0.25 s.
      rpcMs, rpcLastMs, rpcCalls, rpcFailures, rpcAt: rpcLastAt ? new Date(rpcLastAt).toISOString() : null, lagS: blocks.at(-1)?.timestamp ? Math.max(0, Math.round(Date.now() / 1000 - blocks.at(-1).timestamp)) : null }),
  };
}
