/** The node's side of MatchBook (BUILD-SPEC v0.3 §6, §11): what this node
 *  SENDS from its delegated hot key, what it WATCHES on the event log, and
 *  the ladder it FOLDS from that log.
 *
 *  SEND   commit  — when this node is the drawn host of a ranked placement
 *         settle  — when a ranked, placed ledger settled here (node/settle.js)
 *         attest  — when this node sits on a panel and has recomputed the
 *                   result itself (settlement.cosign): the hash IT reached,
 *                   agree or not
 *         finalize / escalate / resolve — for matches this node hosted,
 *                   when their windows pass; escalate posts the ledger it
 *                   keeps in custody
 *  WATCH  Committed (am I on this panel?), Settled (then witness it),
 *         Escalating / Escalated (am I on the nine? does mine need feeding?),
 *         Finalized — from TRANSACTION RECEIPTS first: every transaction this
 *         node sends is read back from its receipt, and the hashes travel to
 *         peers as a bounded gossip hint (`hints()`: the last day's matches
 *         this node touched), so a witness learns of a Settled event in one
 *         receipt read (~2 s on Liteforge) instead of a log scan. The log
 *         scan (`eth_getLogs`) still runs for the ladder, in small ranges
 *         from a persisted cursor: Liteforge's public gateway serves logs at
 *         ~100 ms per block (measured 21 Sep 2026: 100 blocks 12 s, 500
 *         time out), slower than the chain makes them, so it can never be
 *         the path a live match depends on.
 *  FOLD   protocol/matchbook.js foldChain over every decoded log, per
 *         ruleset: official (finalized) and pending (settled) ladders. The
 *         same fold the cabinet runs on RPC alone.
 *
 *  Key: <dataDir>/announcer.json — the announcer key the operator already
 *  funds IS the delegate (tools/delegate.mjs). Not delegated or unfunded →
 *  every send reports why on /health and the node keeps settling locally.
 *  Nothing here can move the bond. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomPrivateKey, addressOf, signTransaction } from '../protocol/evm.js';
import * as mb from '../protocol/matchbook.js';
import { mayActForCall, decodeBool } from '../protocol/staking.js';
import { descriptorHash as descriptorHashOf } from './settle.js';
import { proposeCalldata, hourOf, freezeAt } from '../protocol/epoch.js';
import { selector } from '../protocol/keccak.js';
import { decodeBytes32Array } from '../protocol/abi.js';

const POLL_MS = 2000;
const SCAN_RANGE = 40;          // blocks per eth_getLogs — Liteforge answers ~100 ms/block; 40 keeps one call under its timeout
const SCAN_START_BEHIND = 400;  // a fresh node starts its ladder scan this far behind the head, not at the deploy block
const HINT_TTL_MS = 24 * 3600_000;

export function createMatchBook({
  dataDir, nodeId, contract, stakeContract = null, epochAnchor = null, chainId, rpc, fromBlock = 0, log = () => {}, emit = () => {},
  // the node's own pieces
  settlement, hostAddr = () => null, rulesetIds = () => [], hasRole = () => true,
  windows = { attestWindow: 120, escalationWindow: 300 }, fetchImpl = globalThis.fetch,
}) {
  const keyPath = join(dataDir, 'announcer.json');
  const key = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : { privateKey: randomPrivateKey() };
  if (!existsSync(keyPath)) writeFileSync(keyPath, JSON.stringify(key, null, 2) + '\n');
  const address = addressOf(key.privateKey);
  const call = rpc;

  // ---------------------------------------------------------------- state
  const decoded = [];                       // every decoded log, in arrival order (block order by construction)
  const seenLog = new Set();                // tx:logIndex already absorbed (receipts and the scan overlap)
  const cursorPath = join(dataDir, 'matchbook-cursor.json');
  let cursor = (() => { try { return JSON.parse(readFileSync(cursorPath, 'utf8')).cursor ?? null; } catch { return null; } })(); // last block fully scanned; null = not started
  let scanError = null;
  const txlog = new Map();                  // matchId (chain key) → { txs: [{ what, tx, at }] } — what this node sent, for hints and receipts
  const ingested = new Set();               // tx hashes whose receipts are absorbed
  const pendingReceipts = new Map();        // tx → { since, tries } waiting for a receipt
  let delegated = null, funded = null, lastError = null, lastTx = null, polling = false, sends = 0;
  const panels = new Map();                 // matchId → { hostKey, panel[] } from Committed
  const settled = new Map();                // matchId → Settled event
  const mine = new Map();                   // matchId (this node hosted) → { settledAt, finalizedAt, escalatedAt, drawBlock, status }
  const attested = new Set();               // matchIds this node answered (either panel)
  const witnessing = new Set();             // in flight
  const escalation = new Map();             // matchId → { panel[], escalatedAt }
  const blockTs = new Map();                // block number → timestamp (seconds), for the hour a Finalized event belongs to
  const proposedHours = new Set();          // epochs this node already proposed (a restart re-tries; the contract refuses harmlessly)
  const committed = new Set();              // matchIds (chain keys) this node committed — a settle without a commit would only revert

  // ---------------------------------------------------------------- send
  let nonce = null;
  // One transaction at a time from this key: two sends racing for the same nonce lose one of them
  // (seen in the end-to-end test: two placements committed in the same tick).
  let chainOfSends = Promise.resolve();
  const send = (data, what, to) => { const p = chainOfSends.then(() => sendNow(data, what, to)); chainOfSends = p.catch(() => {}); return p; };
  const sendNow = async (data, what, to = contract) => {
    if (delegated === false) throw new Error(`delegate ${address} is not this node's delegate on NodeStake — operator: npm run delegate -- ${nodeId.slice(0, 12)}… ${address}`);
    const [nonceHex, gasPriceHex, gasHex] = await Promise.all([
      nonce === null ? call('eth_getTransactionCount', [address, 'pending']) : '0x' + nonce.toString(16),
      call('eth_gasPrice', []),
      call('eth_estimateGas', [{ from: address, to, data }]),
    ]);
    nonce = BigInt(nonceHex);
    const raw = signTransaction({ nonce, gasPrice: BigInt(gasPriceHex) * 12n / 10n, gasLimit: BigInt(gasHex) * 13n / 10n, to, value: 0n, data, chainId: BigInt(chainId) }, key.privateKey);
    const hash = await call('eth_sendRawTransaction', [raw]);
    nonce += 1n; sends++; lastTx = hash; lastError = null;
    emit('tx', { what, tx: hash });
    return hash;
  };
  const trySend = async (data, what, matchId, to) => {
    try {
      const tx = await send(data, what, to); log(`matchbook: ${what} ${matchId?.slice(0, 12) ?? ''} (tx ${tx.slice(0, 12)}…)`);
      if (matchId && /^[0-9a-f]{64}$/i.test(matchId) || (matchId && what !== 'propose' && what !== 'enroll')) {
        const key = /^[0-9a-f]{64}$/i.test(matchId) ? matchId.toLowerCase() : mb.matchIdBytes32(matchId);
        const rec = txlog.get(key) ?? { txs: [] }; rec.txs.push({ what, tx, at: Date.now() }); txlog.set(key, rec);
        pendingReceipts.set(tx, { since: Date.now(), tries: 0 });
      }
      return tx;
    }
    catch (e) { lastError = `${what}: ${e.message}`; nonce = null; emit('tx-failed', { what, matchId, reason: e.message }); log(`matchbook: ${what} ${matchId?.slice(0, 12) ?? ''} failed: ${e.message}`); return null; }
  };
  const checkDelegate = async () => {
    if (!stakeContract) { delegated = true; return; }
    try { delegated = decodeBool(await call('eth_call', [mayActForCall(stakeContract, nodeId, address), 'latest'])); } catch { /* keep the last answer */ }
    try { funded = BigInt(await call('eth_getBalance', [address, 'latest'])) > 0n; } catch { /* unknown */ }
  };
  // The witness pool for escalations: a delegated, funded WITNESS enrols itself — no operator step,
  // no tool. Asked once per start and again after any failure; a node that is not a witness stays out.
  let enrolled = null, enrolTried = 0;
  const autoEnrol = async () => {
    if (!hasRole('witness') || delegated !== true || !funded || enrolled === true || Date.now() - enrolTried < 5 * 60_000) return;
    enrolTried = Date.now();
    try {
      const pool = decodeBytes32Array(await call('eth_call', [{ to: contract, data: selector('pool()') }, 'latest']));
      enrolled = pool.includes(nodeId.toLowerCase());
      if (enrolled) return;
      const tx = await trySend(mb.enrollCalldata(nodeId), 'enroll', nodeId);
      if (tx) { enrolled = true; emit('enrolled', { tx }); }
    } catch (e) { lastError = `enroll: ${e.message}`; }
  };

  /** This node is the drawn host of a ranked placement: commit before play. */
  const commit = async (descriptor) => {
    if (!hasRole('settler') && !hasRole('host')) return null;
    const panel = descriptor.panel ?? [];
    if (panel.length !== 3) { lastError = `commit ${descriptor.matchId.slice(0, 12)}: the draw seated ${panel.length} witnesses, MatchBook needs 3 — placed casual-only`; emit('commit-skipped', { matchId: descriptor.matchId, reason: lastError }); return null; }
    const dh = descriptorHashOf(descriptor);
    const tx = await trySend(mb.commitCalldata(descriptor.matchId, dh, descriptor.rulesetId, nodeId, panel), 'commit', descriptor.matchId);
    if (tx) committed.add(mb.matchIdBytes32(descriptor.matchId));
    return tx;
  };
  /** A ranked, placed match settled here: put the result on chain. */
  const settle = async (delta, ledger) => {
    const key = mb.matchIdBytes32(delta.matchId);
    if (!committed.has(key) && !panels.has(key)) {
      // no commit went out for this placement (the mesh could not seat three witnesses, or the send failed):
      // the match settled locally and stays local; a settle on chain would only revert with WrongStatus
      log(`matchbook: ${delta.matchId.slice(0, 12)} settled locally only — it was never committed on chain (${lastError ?? 'no commit'})`);
      emit('settle-skipped', { matchId: delta.matchId, reason: 'not committed' });
      return null;
    }
    const panel = panels.get(key)?.panel ?? ledger.descriptor?.body?.panel ?? [];
    const custodians = [nodeId, ...panel];
    const tx = await trySend(mb.settleCalldata(delta.matchId, { resultHash: delta.resultHash, ledger, buildHash: delta.buildHash, participants: delta.participants, scores: delta.scores, custodians }), 'settle', delta.matchId);
    if (tx) mine.set(mb.matchIdBytes32(delta.matchId), { matchId: delta.matchId, settledAt: Date.now(), status: 'settled', ledger });
    return tx;
  };

  // ---------------------------------------------------------------- watch
  const absorb = (e) => {
    const id = `${e.tx ?? '?'}:${e.block}:${e.logIndex}`;
    if (seenLog.has(id)) return;
    seenLog.add(id);
    decoded.push(e);
    if (e.event === 'Committed') panels.set(e.matchId, { hostKey: e.hostKey, panel: e.panel });
    if (e.event === 'Settled') settled.set(e.matchId, e);
    if (e.event === 'Escalating' && mine.has(e.matchId)) Object.assign(mine.get(e.matchId), { status: 'escalating', drawBlock: e.drawBlock, feedBy: e.feedBy });
    if (e.event === 'Escalated') { escalation.set(e.matchId, { panel: e.panel, at: Date.now() }); if (mine.has(e.matchId)) Object.assign(mine.get(e.matchId), { status: 'escalated', escalatedAt: Date.now() }); }
    if (e.event === 'Finalized') { if (mine.has(e.matchId)) mine.get(e.matchId).status = e.status; emit('chain-final', { matchId: e.matchId, status: e.status, finalHash: e.finalHash }); }
  };
  /** The timestamp of every block a Finalized event sits in, read once. */
  const stampBlocks = async () => {
    const want = [...new Set(decoded.filter((e) => e.event === 'Finalized' && !blockTs.has(e.block)).map((e) => e.block))];
    for (const n of want.slice(0, 50)) { try { const b = await call('eth_getBlockByNumber', ['0x' + n.toString(16), false]); if (b?.timestamp) blockTs.set(n, parseInt(b.timestamp, 16)); } catch { /* next poll */ } }
  };
  /** The hour's tree over the FINALIZED set, as every reader of the log computes it (§11.6). */
  const epoch = (hour = hourOf(Date.now())) => mb.chainEpoch(decoded, hour, (n) => blockTs.get(n) ?? null);
  /** Propose the hour's root from the delegate once the hour has frozen. `force` (tests) skips the wait. */
  const propose = async (hour, { force = false } = {}) => {
    if (!epochAnchor || !hasRole('settler')) return null;
    if (!force && Date.now() < freezeAt(hour)) return null;
    if (proposedHours.has(hour)) return null;
    const ep = epoch(hour);
    if (ep.count === 0) return null;
    proposedHours.add(hour);
    const tx = await trySend(proposeCalldata(hour, ep.root, nodeId), 'propose', String(hour), epochAnchor);
    if (tx) emit('proposed', { epoch: hour, root: ep.root, count: ep.count, tx });
    return tx;
  };
  /** One receipt: every MatchBook log in it is an event we can trust. Returns true once absorbed (or failed for good). */
  const ingestReceipt = async (tx) => {
    if (ingested.has(tx)) return true;
    const rc = await call('eth_getTransactionReceipt', [tx]);
    if (!rc) return false; // not mined yet
    ingested.add(tx); pendingReceipts.delete(tx);
    if (rc.status !== '0x1') return true;
    for (const l of rc.logs ?? []) { if ((l.address ?? '').toLowerCase() !== contract.toLowerCase()) continue; const e = mb.decodeLog({ ...l, transactionHash: l.transactionHash ?? tx }); if (e) absorb(e); }
    return true;
  };
  /** Receipts for what this node sent (retried until mined) and for what peers hinted. */
  const readReceipts = async () => {
    for (const [tx, p] of [...pendingReceipts]) {
      if (p.tries > 40 && Date.now() - p.since > 10 * 60_000) { pendingReceipts.delete(tx); continue; }
      p.tries++;
      try { await ingestReceipt(tx); } catch { /* next poll */ }
    }
  };
  /** The ladder's log scan: SCAN_RANGE blocks per poll from a persisted cursor. A fresh node starts a little behind
   *  the head; history before that is a backfill job for later, not something a live match waits on. */
  const read = async () => {
    const head = parseInt(await call('eth_blockNumber', []), 16);
    if (cursor === null) cursor = Math.max(fromBlock - 1, head - SCAN_START_BEHIND);
    if (cursor >= head) return;
    const to = Math.min(head, cursor + SCAN_RANGE);
    const logs = await call('eth_getLogs', [mb.logsFilter(contract, cursor + 1, to)]);
    for (const l of logs) { const e = mb.decodeLog(l); if (e) absorb(e); }
    cursor = to;
    try { writeFileSync(cursorPath, JSON.stringify({ cursor })); } catch { /* read-only data dir */ }
  };
  /** Gossip hints: the transactions of every match this node touched in the last day — bounded by time, never by history. */
  const hints = () => { const cut = Date.now() - HINT_TTL_MS; const out = []; for (const [key, rec] of txlog) { const txs = rec.txs.filter((t) => t.at > cut); if (txs.length) out.push({ key, txs: txs.map((t) => t.tx) }); else txlog.delete(key); } return out; };
  const absorbHints = (list) => { for (const h of list ?? []) for (const tx of h?.txs ?? []) if (typeof tx === 'string' && /^0x[0-9a-f]{64}$/i.test(tx) && !ingested.has(tx) && !pendingReceipts.has(tx)) pendingReceipts.set(tx, { since: Date.now(), tries: 0 }); };

  /** I sit on this match's panel and it has settled: recompute and attest what I reached. */
  const witness = async (s) => {
    if (attested.has(s.matchId) || witnessing.has(s.matchId)) return;
    const p = panels.get(s.matchId);
    const onFirst = p?.panel.includes(nodeId), onNine = escalation.get(s.matchId)?.panel.includes(nodeId);
    if (!onFirst && !onNine) return;
    if (p?.hostKey === nodeId) return;
    witnessing.add(s.matchId);
    try {
      const addr = hostAddr(p?.hostKey ?? s.hostKey);
      if (!addr) throw new Error('host address unknown (no fresh heartbeat)');
      // the host serves by its own match id; the chain key is the same 64 hex for a mesh-placed match, and /delta resolves a chain key otherwise
      const [delta, ledger] = await Promise.all([
        fetchImpl(`${addr}/delta/${encodeURIComponent(s.matchId)}`).then((r) => r.json()),
        fetchImpl(`${addr}/ledger/${encodeURIComponent(s.matchId)}`).then((r) => r.json()),
      ]);
      if (delta?.error || ledger?.error) throw new Error(delta?.error ?? ledger?.error);
      if (mb.ledgerHash(ledger) !== s.ledgerHash) throw new Error('the ledger the host serves is not the one it committed');
      const res = await settlement.cosign(delta, ledger);
      const ours = res.ok ? delta.resultHash : res.ours;
      if (!ours) throw new Error(`could not verify: ${res.reason}`);
      attested.add(s.matchId);
      const tx = await trySend(mb.attestCalldata(delta.matchId, nodeId, ours), res.ok ? 'attest' : 'dispute', delta.matchId);
      emit('attested', { matchId: delta.matchId, agrees: res.ok, reason: res.ok ? null : res.reason, tx, escalation: !!onNine && !onFirst });
    } catch (e) { log(`matchbook: witness ${s.matchId.slice(0, 12)}: ${e.message}`); emit('witness-failed', { matchId: s.matchId, reason: e.message }); }
    finally { witnessing.delete(s.matchId); }
  };

  /** Drive my own hosted matches through their windows. */
  const drive = async () => {
    const now = Date.now();
    for (const [id, m] of mine) {
      // finalize as soon as all three answered, else once the window (plus a margin for clock skew) has passed
      const answered = decoded.filter((e) => e.event === 'Attested' && e.matchId === id && !e.escalation).length;
      if (m.status === 'settled' && (answered >= 3 || now - m.settledAt > (windows.attestWindow + 5) * 1000) && !m.finalizeTried) {
        m.finalizeTried = now;
        const tx = await trySend(mb.finalizeCalldata(m.matchId), 'finalize', m.matchId);
        if (!tx) m.finalizeTried = null; // WindowOpen (an extension) or a hiccup: try again next window
        else m.settledAt = now;           // an Extended reply resets the clock; a Finalized/Escalating event updates status
      }
      if (m.status === 'escalating' && !m.fed) {
        const head = parseInt(await call('eth_blockNumber', []), 16);
        if (head > (m.drawBlock ?? Infinity)) { m.fed = true; const tx = await trySend(mb.escalateCalldata(m.matchId, m.ledger), 'escalate', m.matchId); if (!tx) m.fed = false; }
      }
      if (m.status === 'escalated' && now - (m.escalatedAt ?? now) > (windows.escalationWindow + 5) * 1000 && !m.resolveTried) {
        m.resolveTried = true;
        const tx = await trySend(mb.resolveCalldata(m.matchId), 'resolve', m.matchId);
        if (!tx) m.resolveTried = false;
      }
      void id;
    }
  };

  let lastPoll = 0;
  const poll = async () => {
    if (polling || Date.now() - lastPoll < POLL_MS) return;
    polling = true; lastPoll = Date.now();
    try {
      if (delegated === null || !funded) await checkDelegate();
      await autoEnrol();
      await readReceipts();
      try { await read(); scanError = null; } catch (e) { scanError = String(e.message ?? e); } // the scan is best effort: nothing live waits on it
      for (const s of settled.values()) { const st = statusOf(s.matchId); if (st === 'settled' || st === 'escalated') void witness(s); }
      await drive();
      await stampBlocks();
      // the settler proposes every frozen hour it holds finalized matches for (the last three, in case a restart missed one)
      const h = hourOf(Date.now());
      for (const hour of [h - 3, h - 2, h - 1]) if (Date.now() >= freezeAt(hour)) await propose(hour);
    } catch (e) { lastError = String(e.message ?? e); }
    finally { polling = false; }
  };
  const statusOf = (matchIdB32) => { let st = settled.has(matchIdB32) ? 'settled' : panels.has(matchIdB32) ? 'committed' : 'none'; for (const e of decoded) if (e.matchId === matchIdB32) { if (e.event === 'Escalating') st = 'escalating'; if (e.event === 'Escalated') st = 'escalated'; if (e.event === 'Finalized') st = e.status; } return st; };

  // ---------------------------------------------------------------- fold
  const ladder = (rulesetId, manifest, { scope = 'official' } = {}) => {
    const f = mb.foldChain(decoded, rulesetId, manifest, { rulesets: mb.rulesetKeys([...new Set([rulesetId, ...rulesetIds()])]) });
    return { ...(scope === 'pending' ? f.pending : f.official), scope, cursor: { block: cursor }, counts: f.counts, source: 'chain' };
  };

  return {
    address, commit, settle, poll, ladder, statusOf, epoch, propose, hints, absorbHints, ingestReceipt,
    proof: (matchId) => { const key = mb.matchIdBytes32(matchId); const fin = decoded.find((e) => e.event === 'Finalized' && e.matchId === key); if (!fin) return null; const ts = blockTs.get(fin.block); if (ts == null) return null; return mb.chainProof(epoch(hourOf(ts * 1000)), key); },
    chainStatus: (matchId) => ({ matchId, key: mb.matchIdBytes32(matchId), status: statusOf(mb.matchIdBytes32(matchId)), panel: panels.get(mb.matchIdBytes32(matchId))?.panel ?? null, events: decoded.filter((e) => e.matchId === mb.matchIdBytes32(matchId)) }),
    status: () => ({ contract, epochAnchor, delegate: address, delegated, funded, enrolled, cursor, scanError, receipts: ingested.size, pendingReceipts: pendingReceipts.size, events: decoded.length, sends, lastTx, lastError, hosting: mine.size, attested: attested.size, proposed: [...proposedHours] }),
  };
}

