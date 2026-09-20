/** MatchBook (contracts/MatchBook.sol) — calldata the node's delegate sends,
 *  the reads, and the EVENT LOG as the delta set (BUILD-SPEC v0.3 §6, §11).
 *  Pure and isomorphic: the node sends transactions with it, the cabinet
 *  folds a ladder from RPC alone with it.
 *
 *  Mapping the node's identifiers onto bytes32, in one place:
 *    matchId     64-hex (sha256 from pairing.matchIdFor) as is; anything else
 *                (a relay's own id) as H('matchId', id)
 *    rulesetId   H('rulesetId', 'agent-fighter.v1') — the reader maps back
 *                through the rulesets it knows (rulesetKeys)
 *    player      a 64-hex player key as is; a display name (af:…) as H('player', name)
 *    node keys, buildHash, resultHash, descriptorHash: 64-hex as is
 *    ledgerHash  sha256 over the canonical JSON bytes of the ledger, so the
 *                contract's sha256(ledger) at escalation matches
 *    scores      int64: rounded */
import { canonical, h, sha256Hex } from './canonical.js';
import { keccak256Hex, selector } from './keccak.js';
import { derive } from './derive.js';

export const COMMIT = 'commit(bytes32,bytes32,bytes32,bytes32,bytes32[3])';
export const SETTLE = 'settle(bytes32,bytes32,bytes32,bytes32,bytes32[],int64[],bytes32[])';
export const ATTEST = 'attest(bytes32,bytes32,bytes32)';
export const FINALIZE = 'finalize(bytes32)';
export const ESCALATE = 'escalate(bytes32,bytes)';
export const RESOLVE = 'resolve(bytes32)';
export const EXPIRE = 'expire(bytes32)';
export const ENROLL = 'enroll(bytes32)';
export const WITHDRAW = 'withdraw(bytes32)';
export const STATUS_OF = 'statusOf(bytes32)';
export const PANEL_OF = 'panelOf(bytes32)';
export const TOTAL_WINDOW = 'totalWindow()';

export const STATUS = ['none', 'committed', 'settled', 'final', 'void', 'escalating', 'escalated'];

const HEX64 = /^[0-9a-f]{64}$/i;
export const matchIdBytes32 = (id) => (HEX64.test(id) ? id.toLowerCase() : h('matchId', id));
export const rulesetIdBytes32 = (id) => h('rulesetId', id);
export const playerBytes32 = (p) => (HEX64.test(p) ? p.toLowerCase() : h('player', p));
const b32 = (x, what) => { const s = String(x).replace(/^0x/, '').toLowerCase(); if (!HEX64.test(s)) throw new Error(`${what} must be 32 bytes hex`); return s; };
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const int64 = (n) => { const v = BigInt(Math.round(Number(n))); if (v < -(2n ** 63n) || v >= 2n ** 63n) throw new Error('score out of int64'); return ((v + 2n ** 256n) % 2n ** 256n).toString(16).padStart(64, '0'); };
const arr = (words) => word(words.length) + words.join('');
const bytesTail = (hex) => { const s = hex.replace(/^0x/, ''); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); };

/** The ledger as the contract will see it at escalation. */
export const ledgerBytes = (ledger) => new TextEncoder().encode(canonical(ledger));
export const ledgerHash = (ledger) => sha256Hex(ledgerBytes(ledger));
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------ calldata (the delegate signs)
export const commitCalldata = (matchId, descriptorHash, rulesetId, hostKey, panel) => {
  if (!Array.isArray(panel) || panel.length !== 3) throw new Error('panel must be three node keys');
  return selector(COMMIT) + b32(matchIdBytes32(matchId), 'matchId') + b32(descriptorHash, 'descriptorHash') + rulesetIdBytes32(rulesetId) + b32(hostKey, 'hostKey') + panel.map((k) => b32(k, 'panel key')).join('');
};
export const settleCalldata = (matchId, { resultHash, ledger, buildHash, participants, scores, custodians }) => {
  const ps = participants.map(playerBytes32);
  const sc = participants.map((p) => int64(scores?.[p] ?? 0));
  const cs = (custodians ?? []).map((k) => b32(k, 'custodian'));
  const head = b32(matchIdBytes32(matchId), 'matchId') + b32(resultHash, 'resultHash') + b32(ledgerHash(ledger), 'ledgerHash') + b32(buildHash, 'buildHash');
  const o1 = 7 * 32, o2 = o1 + 32 + ps.length * 32, o3 = o2 + 32 + sc.length * 32;
  return selector(SETTLE) + head + word(o1) + word(o2) + word(o3) + arr(ps) + arr(sc) + arr(cs);
};
export const attestCalldata = (matchId, witnessKey, resultHash) => selector(ATTEST) + b32(matchIdBytes32(matchId), 'matchId') + b32(witnessKey, 'witnessKey') + b32(resultHash, 'resultHash');
export const finalizeCalldata = (matchId) => selector(FINALIZE) + b32(matchIdBytes32(matchId), 'matchId');
export const escalateCalldata = (matchId, ledger) => selector(ESCALATE) + b32(matchIdBytes32(matchId), 'matchId') + word(64) + bytesTail(toHex(ledgerBytes(ledger)));
export const resolveCalldata = (matchId) => selector(RESOLVE) + b32(matchIdBytes32(matchId), 'matchId');
export const expireCalldata = (matchId) => selector(EXPIRE) + b32(matchIdBytes32(matchId), 'matchId');
export const enrollCalldata = (nodeKey) => selector(ENROLL) + b32(nodeKey, 'nodeKey');
export const withdrawCalldata = (nodeKey) => selector(WITHDRAW) + b32(nodeKey, 'nodeKey');

// ------------------------------------------------------------ reads
export const statusOfCall = (contract, matchId) => ({ to: contract, data: selector(STATUS_OF) + b32(matchIdBytes32(matchId), 'matchId') });
export const panelOfCall = (contract, matchId) => ({ to: contract, data: selector(PANEL_OF) + b32(matchIdBytes32(matchId), 'matchId') });
export const totalWindowCall = (contract) => ({ to: contract, data: selector(TOTAL_WINDOW) });
export function decodeStatus(hex) {
  const d = hex.replace(/^0x/, '');
  if (d.length < 256) throw new Error('short statusOf result');
  const w = (i) => d.slice(i * 64, (i + 1) * 64);
  return { status: STATUS[Number(BigInt('0x' + w(0)))] ?? 'unknown', resultHash: w(1), attests: Number(BigInt('0x' + w(2))), agreeing: Number(BigInt('0x' + w(3))) };
}
export const decodePanel = (hex) => { const d = hex.replace(/^0x/, ''); return [0, 1, 2].map((i) => d.slice(i * 64, (i + 1) * 64)); };
export const decodeUint = (hex) => Number(BigInt('0x' + (hex.replace(/^0x/, '') || '0')));

// ------------------------------------------------------------ the event log
export const EVENTS = {
  Committed: 'Committed(bytes32,bytes32,bytes32,bytes32,bytes32[3])',
  Settled: 'Settled(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32[],int64[],bytes32[])',
  Attested: 'Attested(bytes32,bytes32,bytes32,bool,bool)',
  Extended: 'Extended(bytes32,uint64)',
  Escalating: 'Escalating(bytes32,uint64,uint64)',
  Escalated: 'Escalated(bytes32,bytes32,bytes32[],uint256[])',
  Finalized: 'Finalized(bytes32,bytes32,bytes32,uint8)',
};
export const topic = (name) => '0x' + keccak256Hex(EVENTS[name]);
const byTopic = Object.fromEntries(Object.keys(EVENTS).map((n) => [topic(n), n]));

/** eth_getLogs filter for everything the contract emitted in a block range. */
export const logsFilter = (contract, fromBlock, toBlock = 'latest') => ({ address: contract, fromBlock: typeof fromBlock === 'number' ? '0x' + fromBlock.toString(16) : fromBlock, toBlock: typeof toBlock === 'number' ? '0x' + toBlock.toString(16) : toBlock, topics: [Object.keys(byTopic)] });

const t32 = (t) => t.replace(/^0x/, '').toLowerCase();
const sInt64 = (w) => { let v = BigInt('0x' + w); if (v >= 2n ** 255n) v -= 2n ** 256n; return Number(v); };
const dynArr = (d, off, map) => { const o = Number(BigInt('0x' + d.slice(off * 2, off * 2 + 64))) * 2; const n = Number(BigInt('0x' + d.slice(o, o + 64))); return Array.from({ length: n }, (_, i) => map(d.slice(o + 64 + i * 64, o + 128 + i * 64))); };

/** One eth_getLogs entry → { event, matchId, …, block, logIndex } or null for a foreign log. */
export function decodeLog(log) {
  const name = byTopic[(log.topics?.[0] ?? '').toLowerCase()];
  if (!name) return null;
  const d = log.data.replace(/^0x/, '');
  const w = (i) => d.slice(i * 64, (i + 1) * 64);
  const base = { event: name, matchId: t32(log.topics[1]), block: parseInt(log.blockNumber, 16), logIndex: parseInt(log.logIndex ?? '0x0', 16), tx: log.transactionHash ?? null };
  switch (name) {
    case 'Committed': return { ...base, rulesetKey: t32(log.topics[2]), hostKey: t32(log.topics[3]), descriptorHash: w(0), panel: [w(1), w(2), w(3)] };
    case 'Settled': return { ...base, rulesetKey: t32(log.topics[2]), hostKey: t32(log.topics[3]), resultHash: w(0), ledgerHash: w(1), buildHash: w(2), participants: dynArr(d, 3 * 32, (x) => x), scores: dynArr(d, 4 * 32, sInt64), custodians: dynArr(d, 5 * 32, (x) => x) };
    case 'Attested': return { ...base, witnessKey: t32(log.topics[2]), resultHash: w(0), agrees: w(1).endsWith('1'), escalation: w(2).endsWith('1') };
    case 'Finalized': return { ...base, rulesetKey: t32(log.topics[2]), finalHash: w(0), status: STATUS[Number(BigInt('0x' + w(1)))] ?? 'unknown' };
    case 'Extended': return { ...base, until: Number(BigInt('0x' + w(0))) };
    case 'Escalating': return { ...base, drawBlock: Number(BigInt('0x' + w(0))), feedBy: Number(BigInt('0x' + w(1))) };
    case 'Escalated': return { ...base, ledgerHash: w(0), panel: dynArr(d, 32, (x) => x), weights: dynArr(d, 64, (x) => BigInt('0x' + x)) };
    default: return null;
  }
}

/** rulesetId → its bytes32 key, for every ruleset a reader knows. */
export const rulesetKeys = (rulesetIds) => Object.fromEntries(rulesetIds.map((id) => [rulesetIdBytes32(id), id]));

/** The fold's input from the log: one delta per SETTLED match, in block
 *  order, carrying its finality. `official` deltas are those whose
 *  Finalized event says `final`; `pending` are settled and not yet decided;
 *  a `void` match is dropped. The `epoch` field is the block-order key
 *  derive.sortDeltas already sorts by (block * 2^20 + logIndex), so the same
 *  fold gives the same digest on every reader. */
export function chainDeltas(decodedLogs, { rulesets = {} } = {}) {
  const settled = new Map(), status = new Map();
  for (const e of decodedLogs) {
    if (!e) continue;
    if (e.event === 'Settled') settled.set(e.matchId, e);
    if (e.event === 'Finalized') status.set(e.matchId, e.status); // final | void; escalation events leave it pending
  }
  const out = [];
  for (const s of settled.values()) {
    const st = status.get(s.matchId) ?? 'pending';
    if (st === 'void') continue;
    const scores = Object.fromEntries(s.participants.map((p, i) => [p, s.scores[i]]));
    out.push({ matchId: s.matchId, rulesetId: rulesets[s.rulesetKey] ?? s.rulesetKey, buildHash: s.buildHash, mode: 'ranked', participants: s.participants, scores, teams: null, ticks: 0, hostId: s.hostKey, resultHash: s.resultHash, epoch: s.block * 2 ** 20 + s.logIndex, block: s.block, official: st === 'final', chainStatus: st });
  }
  return out;
}

/** Ladder tables from the log for one ruleset: { official, pending }, each
 *  a derive() result. `pending` folds settled-but-undecided results ON TOP
 *  of the official set so a player sees where they would stand. */
export function foldChain(decodedLogs, rulesetId, manifest, { rulesets = {} } = {}) {
  const all = chainDeltas(decodedLogs, { rulesets }).filter((d) => d.rulesetId === rulesetId);
  const official = all.filter((d) => d.official);
  // The cursor is the last block READ, not the last block folded: a resume must not re-read a void or a foreign ruleset's blocks.
  const blocks = decodedLogs.filter(Boolean).map((e) => e.block);
  const cursor = blocks.length ? { block: Math.max(...blocks) } : null;
  return { rulesetId, cursor, official: derive(official, manifest), pending: derive(all, manifest), counts: { official: official.length, pending: all.length - official.length } };
}

// ------------------------------------------------------------ the hour's root over the FINALIZED set (EpochAnchor v3, §11.6)
import { buildTree, proofFor, hourOf } from './epoch.js';

/** A leaf from chain data alone: the Settled event's facts plus how the
 *  match ended. Every reader of the log builds the same leaf. */
export const chainLeaf = (s, fin) => h('leaf3', {
  matchId: s.matchId, rulesetKey: s.rulesetKey, buildHash: s.buildHash, resultHash: s.resultHash, ledgerHash: s.ledgerHash,
  participants: s.participants, scores: s.scores, hostKey: s.hostKey, finalHash: fin.finalHash, status: fin.status,
});

/** The tree for one hour: every match whose Finalized event landed in a
 *  block of that hour (`timestampOf(block)` → seconds; the caller resolves
 *  block timestamps, cached). Voids are leaves too — "this match was voided"
 *  is part of the record — with status in the leaf. */
export function chainEpoch(decodedLogs, hour, timestampOf) {
  const settled = new Map();
  for (const e of decodedLogs) if (e?.event === 'Settled') settled.set(e.matchId, e);
  const matches = [];
  for (const e of decodedLogs) {
    if (e?.event !== 'Finalized' || !settled.has(e.matchId)) continue;
    const ts = timestampOf(e.block);
    if (ts == null || hourOf(ts * 1000) !== hour) continue;
    matches.push({ matchId: e.matchId, status: e.status, block: e.block, leaf: chainLeaf(settled.get(e.matchId), e) });
  }
  const tree = buildTree(matches.map((m) => m.leaf));
  return { epoch: hour, count: matches.length, root: tree.root, matches, tree, source: 'chain' };
}
export const chainProof = (ep, matchId) => { const m = ep.matches.find((x) => x.matchId === matchId); return m ? { matchId, epoch: ep.epoch, leaf: m.leaf, status: m.status, root: ep.root, path: proofFor(ep.tree, m.leaf) } : null; };
