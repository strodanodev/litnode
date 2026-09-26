/** The chain side of the rewards fold (protocol/rewards.js): every log the
 *  fold reads, from the chain's own eth_getLogs, joined with its transaction
 *  receipt (who sent it, the gas it actually cost), decoded.
 *
 *  Why not the explorer: Liteforge's explorer answers a contract's whole
 *  history in one call, but its index has holes — on 27 Sep 2026 it lacked
 *  the Staked events of two bonded nodes, both TitleRegistry registrations
 *  of 26 Sep and a MatchBook Finalized — and a payout computed from it would
 *  silently skip people. The RPC is complete and, with an address filter,
 *  fast enough: ~1.5 ms a block per request, parallel requests scale, and a
 *  scan is cached so a season is read once (tools/rewards.mjs).
 *  Isomorphic: fetch only. */
import { keccak256Hex } from './keccak.js';
import { decodeLog } from './matchbook.js';

const SIGS = {
  NodeStake: {
    Staked: 'Staked(bytes32,address,uint256,uint256,uint64,uint64)',
    OperatorTransferred: 'OperatorTransferred(bytes32,address,address)',
    DelegateSet: 'DelegateSet(bytes32,address)',
    Slashed: 'Slashed(bytes32,uint256,uint16,bytes32,address)',
  },
  TitleRegistry: { Registered: 'Registered(uint256,string,address,bytes32)', Transfer: 'Transfer(address,address,uint256)' },
  PlayerProfile: { Transfer: 'Transfer(address,address,uint256)', KeyBound: 'KeyBound(uint256,bytes32)', KeyRevoked: 'KeyRevoked(uint256,bytes32)' },
  EpochAnchor: { Proposed: 'Proposed(uint64,bytes32,bytes32,address,uint256,uint256,uint256)' },
};
export const REWARD_CONTRACTS = ['MatchBook', 'NodeStake', 'TitleRegistry', 'PlayerProfile', 'EpochAnchor'];
const byTopic = {};
for (const [c, evs] of Object.entries(SIGS)) for (const [n, sig] of Object.entries(evs)) (byTopic[c] ??= {})['0x' + keccak256Hex(sig)] = n;
/** topic0 of an event this module decodes (tests build logs with it). */
export const rewardTopic = (contract, event) => '0x' + keccak256Hex(SIGS[contract][event]);

const t32 = (t) => String(t).replace(/^0x/, '').toLowerCase();
const addr = (w) => '0x' + String(w).replace(/^0x/, '').slice(-40).toLowerCase();
const num = (x) => (typeof x === 'number' ? x : x == null || x === '' ? 0 : /^0x/i.test(x) ? parseInt(x, 16) : Number(x));
const big = (x) => (x == null || x === '' ? 0n : BigInt(x));
const hex = (n) => '0x' + n.toString(16);
const utf8 = (h) => new TextDecoder().decode(Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16)));

/** One row — { blockNumber, logIndex, blockTimestamp, transactionHash, topics, data, from, gasUsed, effectiveGasPrice } —
 *  → a fold entry, or null for an event the fold ignores. */
export function decodeRewardLog(contract, row) {
  const base = {
    contract, block: num(row.blockNumber), logIndex: num(row.logIndex), ts: num(row.blockTimestamp),
    tx: row.transactionHash ? row.transactionHash.toLowerCase() : null, from: row.from ? row.from.toLowerCase() : null,
    gasCost: big(row.gasUsed) * big(row.effectiveGasPrice),
  };
  if (contract === 'MatchBook') { const e = decodeLog(row); return e ? { ...e, ...base } : null; }
  const name = byTopic[contract]?.[(row.topics?.[0] ?? '').toLowerCase()];
  if (!name) return null;
  const tp = row.topics, d = String(row.data ?? '').replace(/^0x/, ''), w = (i) => d.slice(i * 64, (i + 1) * 64);
  switch (`${contract}.${name}`) {
    case 'NodeStake.Staked': return { ...base, event: name, nodeKey: t32(tp[1]), operator: addr(tp[2]), amount: big('0x' + w(0)) };
    case 'NodeStake.OperatorTransferred': return { ...base, event: name, nodeKey: t32(tp[1]), previous: addr(tp[2]), operator: addr(tp[3]) };
    case 'NodeStake.DelegateSet': return { ...base, event: name, nodeKey: t32(tp[1]), delegate: addr(tp[2]) };
    case 'NodeStake.Slashed': return { ...base, event: name, nodeKey: t32(tp[1]), amount: big('0x' + w(0)), bps: Number(big('0x' + w(1))), reason: t32(tp[2]), adjudicator: addr(tp[3]) };
    case 'TitleRegistry.Registered': {
      const off = Number(big('0x' + w(0))) * 2, len = Number(big('0x' + d.slice(off, off + 64)));
      return { ...base, event: name, titleId: t32(tp[1]), rulesetId: utf8(d.slice(off + 64, off + 64 + len * 2)), publisher: addr(tp[2]), buildHash: t32(tp[3]) };
    }
    case 'TitleRegistry.Transfer': case 'PlayerProfile.Transfer': return { ...base, event: 'Transfer', previous: addr(tp[1]), to: addr(tp[2]), tokenId: t32(tp[3]) };
    case 'PlayerProfile.KeyBound': case 'PlayerProfile.KeyRevoked': return { ...base, event: name, tokenId: t32(tp[1]), key: t32(tp[2]) };
    case 'EpochAnchor.Proposed': return { ...base, event: name, epoch: Number(big(tp[1])), root: t32(tp[2]), nodeKey: t32(tp[3]), sender: addr(w(0)) };
  }
  return null;
}

/** A JSON-RPC client that retries what a retry can fix: a network error, a 5xx, a request that
 *  hangs past `timeoutMs` (fetch has no timeout of its own, and one stalled socket would stall a scan). */
export function rpcClient(rpc, { fetchImpl = globalThis.fetch, tries = 4, delayMs = 1000, timeoutMs = 60_000 } = {}) {
  let id = 0;
  const post = async (body) => {
    for (let i = 1; ; i++) {
      let r = null, err = null;
      try { r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { err = e; }
      if (r && r.status < 500) { if (!r.ok) throw new Error(`rpc HTTP ${r.status}`); return r.json(); }
      if (i >= tries) throw err ?? new Error(`rpc HTTP ${r.status}`);
      await new Promise((res) => setTimeout(res, delayMs * 2 ** (i - 1)));
    }
  };
  const call = async (method, params) => {
    const j = await post({ jsonrpc: '2.0', id: ++id, method, params });
    if (j.error) { const e = new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`); e.code = j.error.code; throw e; }
    return j.result;
  };
  /** Many calls in batches; one at a time when the node refuses batches. */
  const many = async (method, paramsList, batch = 50) => {
    const out = [];
    for (let i = 0; i < paramsList.length; i += batch) {
      const chunk = paramsList.slice(i, i + batch);
      const res = await post(chunk.map((params, j) => ({ jsonrpc: '2.0', id: j, method, params })));
      if (Array.isArray(res)) {
        const byId = new Map(res.map((x) => [x.id, x]));
        for (let j = 0; j < chunk.length; j++) {
          const x = byId.get(j);
          out.push(x && !x.error ? x.result : await call(method, chunk[j]));
        }
      } else for (const params of chunk) out.push(await call(method, params));
    }
    return out;
  };
  return { call, many };
}

/** Every log `addresses` emitted in [from, to], in `chunk`-block requests, `concurrency` at a time.
 *  A request the node times out is split in half and asked again. */
export async function scanLogs(client, addresses, from, to, { chunk = 2000, concurrency = 8, onProgress } = {}) {
  const ranges = [];
  for (let a = from; a <= to; a += chunk) ranges.push([a, Math.min(to, a + chunk - 1)]);
  const out = [];
  let done = 0;
  const get = async ([a, b]) => {
    try { return await client.call('eth_getLogs', [{ address: addresses, fromBlock: hex(a), toBlock: hex(b) }]); }
    catch (e) {
      if (b === a || !/timed out|timeout|too many|limit/i.test(e.message)) throw e;
      const mid = a + Math.floor((b - a) / 2);
      return [...await get([a, mid]), ...await get([mid + 1, b])];
    }
  };
  const worker = async () => {
    while (ranges.length) {
      const r = ranges.shift();
      out.push(...await get(r));
      done += r[1] - r[0] + 1;
      onProgress?.(done, to - from + 1);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

/** logs → the rows decodeRewardLog reads: each joined with its receipt's sender and gas. */
export async function withReceipts(client, logs) {
  const hashes = [...new Set(logs.map((l) => l.transactionHash.toLowerCase()))];
  const receipts = await client.many('eth_getTransactionReceipt', hashes.map((h) => [h]));
  const byTx = new Map();
  hashes.forEach((h, i) => { if (!receipts[i]) throw new Error(`no receipt for ${h}`); byTx.set(h, receipts[i]); });
  return logs.map((l) => {
    const rc = byTx.get(l.transactionHash.toLowerCase());
    return { address: l.address.toLowerCase(), blockNumber: l.blockNumber, logIndex: l.logIndex, blockTimestamp: l.blockTimestamp, transactionHash: l.transactionHash.toLowerCase(), topics: l.topics, data: l.data, from: rc.from, gasUsed: rc.gasUsed, effectiveGasPrice: rc.effectiveGasPrice ?? rc.gasPrice };
  });
}

/** Rows (from a scan, a cache or a fixture) → fold entries, each routed by its contract address. */
export function entriesFromRows(rows, contracts) {
  const nameOf = new Map(Object.entries(contracts).map(([n, c]) => [c.address.toLowerCase(), n]));
  const out = [];
  for (const row of rows) { const n = nameOf.get(String(row.address).toLowerCase()); const e = n && decodeRewardLog(n, row); if (e) out.push(e); }
  return out;
}

/** Bring a cache up to `head − confirmations`: { chainId, addresses, scannedTo, rows }.
 *  A cache for other addresses (a new contract generation) is discarded. */
export async function syncRows(client, { contracts, chainId, cache = null, confirmations = 20, chunk, concurrency, onProgress }) {
  const addresses = REWARD_CONTRACTS.map((n) => contracts[n]?.address?.toLowerCase());
  if (addresses.some((a) => !a)) throw new Error(`need addresses for ${REWARD_CONTRACTS.join(', ')}`);
  const start = Math.min(...REWARD_CONTRACTS.map((n) => contracts[n].block ?? 0));
  const same = cache && cache.chainId === chainId && JSON.stringify(cache.addresses) === JSON.stringify(addresses);
  const base = same ? cache : { chainId, addresses, scannedTo: start - 1, rows: [] };
  const head = num(await client.call('eth_blockNumber', [])) - confirmations;
  if (head <= base.scannedTo) return { ...base, head, added: 0 };
  const logs = await scanLogs(client, addresses, base.scannedTo + 1, head, { chunk, concurrency, onProgress });
  const rows = await withReceipts(client, logs.filter((l) => !l.removed));
  const seen = new Set(base.rows.map((r) => `${r.transactionHash}:${num(r.logIndex)}`));
  const fresh = rows.filter((r) => !seen.has(`${r.transactionHash}:${num(r.logIndex)}`));
  const all = [...base.rows, ...fresh].sort((a, b) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex));
  return { chainId, addresses, scannedTo: head, rows: all, head, added: fresh.length };
}
