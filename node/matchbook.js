/** The node's side of MatchBook (BUILD-SPEC v0.3 §6, §11): what this node
 *  SENDS from its delegated hot key, what it WATCHES on the event log, and
 *  the ladder it FOLDS from that log.
 *
 *  SEND   commit  — when this node is the drawn host of a ranked placement
 *         settle  — when a ranked, placed ledger settled here (node/settle.js)
 *         attest  — when this node sits on a panel and has recomputed the
 *                   result itself (settlement.cosign): the hash IT reached,
 *                   agree or not
 *         finalize / escalate / resolve / expire — for matches this node
 *                   HOSTED when their windows pass (escalate posts the
 *                   ledger it keeps in custody), and, after a stagger, for
 *                   matches this node SITS ON whose host did not: every one
 *                   of those calls is permissionless, so a host that
 *                   restarted or vanished cannot strand a match in Settled
 *  WATCH  Committed (am I on this panel?), Settled (then witness it),
 *         Escalating / Escalated (am I on the nine? does mine need feeding?),
 *         Finalized — from TRANSACTION RECEIPTS first: every transaction this
 *         node sends is read back from its receipt, and the hashes travel to
 *         peers as a bounded gossip hint (`hints()`: the last day's matches
 *         this node touched), so a witness learns of a Settled event in one
 *         receipt read (~2 s on Liteforge) instead of a log scan. The log
 *         scan (`eth_getLogs`) still runs for the ladder, in small ranges
 *         from a persisted cursor, beside the live poll rather than inside
 *         it: Liteforge's public gateway answers eth_getLogs in 1–3 s for
 *         ranges up to ~20 blocks and 10–16 s past that (21 Sep 2026), so
 *         the range adapts to the answer and no live step waits on it.
 *  FOLD   protocol/matchbook.js foldChain over every decoded log, per
 *         ruleset: official (finalized) and pending (settled) ladders. The
 *         same fold the cabinet runs on RPC alone.
 *
 *  Key: <dataDir>/announcer.json — the announcer key the operator already
 *  funds IS the delegate (tools/delegate.mjs). Not delegated or unfunded →
 *  every send reports why on /health and the node keeps settling locally.
 *  Nothing here can move the bond. */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomPrivateKey, addressOf } from '../protocol/evm.js';
import { feeParams, signWithFee, effectivePrice, capFromEnv } from './fees.js';
import * as mb from '../protocol/matchbook.js';
import { mayActForCall, decodeBool } from '../protocol/staking.js';
import { descriptorHash as descriptorHashOf } from './settle.js';
import { proposeCalldata, hourOf, freezeAt } from '../protocol/epoch.js';
import { selector } from '../protocol/keccak.js';
import { decodeBytes32Array } from '../protocol/abi.js';

const POLL_MS = 2000;
// Blocks per eth_getLogs, adapted to what the gateway answers in time. Liteforge's cost is not linear in the
// range: measured 21 Sep 2026 (0.25 s blocks), ≤20 blocks answer in 1–3 s, 25+ blocks take 10–16 s. A fixed 40
// sat past that knee: both live nodes' cursors fell ~3.5 blocks/s behind the head and never caught up.
const SCAN_MIN = 4, SCAN_MAX = 32, SCAN_START = 16;
const SCAN_FAST_MS = 1000, SCAN_SLOW_MS = 3000; // grow the range under a fast answer, halve it under a slow one
const SCAN_START_BEHIND = 400;  // a fresh node starts its ladder scan this far behind the head, not at the deploy block
const HINT_TTL_MS = 24 * 3600_000;
const HINT_MAX = 50;                 // matches per heartbeat hint list (newest first)
const HINT_TAKE_PER_ENVELOPE = 20;   // receipts one peer's envelope may enqueue
const RECEIPTS_MAX_PENDING = 200;    // receipts waiting at once (our own sends are always taken)
const RECEIPTS_PER_POLL = 10;        // receipt reads per 2 s poll, our own first
// The host acts first on its own match; each panel seat waits one more stagger before acting in its place,
// so a live host is never raced by three witnesses and a dead one is covered within a minute. The feed of
// an escalation is staggered in BLOCKS: the seed is blockhash(drawBlock), gone 256 blocks later — 64 s on
// Liteforge's 0.25 s blocks — so the seats must fall in well inside that, whatever the clock says.
const WINDOW_MARGIN_S = 5;           // clock skew between this node and the chain
const SEAT_STAGGER_MS = 20_000;      // finalize / resolve / expire: host +0, seat i at +(i+1)×this
const FEED_STAGGER_BLOCKS = 24;      // escalate: host +0, seat i at +(i+1)×this blocks after drawBlock
const PARAMS_TTL_MS = 3600_000;      // the windows are read from the contract, not trusted from a file

export function createMatchBook({
  dataDir, nodeId, contract, stakeContract = null, epochAnchor = null, chainId, rpc, fromBlock = 0, log = () => {}, emit = () => {},
  // the head's base fee, for the purse's "matches left" before this key has sent anything (Liteforge moved 68M → 357M wei in a day)
  baseFee = () => null,
  // the node's own pieces
  settlement, hostAddr = () => null, rulesetIds = () => [], hasRole = () => true,
  windows: windowsIn = { attestWindow: 120, escalationWindow: 300 }, fetchImpl = globalThis.fetch,
  drive: driving = true, // false: this node never drives windows (tests: a host that settles and then does nothing)
}) {
  const windows = { settleWindow: 1800, ...windowsIn };
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
  const sentLog = [];                       // every transaction this key sent, newest last: { what, matchId, tx, at, ok, gasUsed } — the operator's ledger of work (/fleet)
  const SENT_MAX = 200;
  const noteSent = (what, matchId, tx) => { sentLog.push({ what, matchId: matchId ?? null, tx, at: Date.now(), ok: null, gasUsed: null }); if (sentLog.length > SENT_MAX) sentLog.shift(); };
  const seenTx = new Map();                 // matchId (chain key) → { txs: Set, at } — every transaction whose events this node holds, passed on as hints
  const ingested = new Set();               // tx hashes whose receipts are absorbed
  const pendingReceipts = new Map();        // tx → { since, tries } waiting for a receipt
  let delegated = null, funded = null, lastError = null, lastTx = null, polling = false, sends = 0;
  // The hot key's purse, for the operator's dashboard: balance read with the delegate check and every BALANCE_TTL,
  // the price the last send paid, and from those how many clean matches (~670k gas as host) the key still covers.
  // `low` flips at LOW_GAS_MATCHES matches left and is logged once — a host that runs dry mid-match voids it.
  let balanceWei = null, balanceAt = 0, gasPriceWei = null, txType = null, lowLogged = false;
  const BALANCE_TTL = 5 * 60_000, GAS_PER_MATCH = 670_000n, LOW_GAS_MATCHES = 25;
  const purse = () => {
    const price = gasPriceWei ?? baseFee() ?? 68_000_000n; // the last send's price, else the head's base fee, else Liteforge on 22 Sep 2026
    const matchesLeft = balanceWei == null ? null : Number(balanceWei / (GAS_PER_MATCH * price));
    return { address, balanceWei: balanceWei == null ? null : balanceWei.toString(), balance: balanceWei == null ? null : (Number(balanceWei) / 1e18).toFixed(6), gasPriceWei: price.toString(), priceSource: gasPriceWei != null ? 'send' : baseFee() != null ? 'head' : 'default', txType, matchesLeft, low: matchesLeft != null && matchesLeft < LOW_GAS_MATCHES, readAt: balanceAt ? new Date(balanceAt).toISOString() : null };
  };
  const readBalance = async () => {
    try { balanceWei = BigInt(await call('eth_getBalance', [address, 'latest'])); balanceAt = Date.now(); funded = balanceWei > 0n; } catch { /* unknown; keep the last */ }
    const p = purse();
    if (p.low && !lowLogged) { lowLogged = true; log(`matchbook: hot key ${address} is low — ${p.balance} zkLTC covers ~${p.matchesLeft} more matches as host; send it zkLTC (faucet: liteforge.hub.caldera.xyz)`); emit('gas-low', { address, balance: p.balance, matchesLeft: p.matchesLeft }); }
    if (!p.low) lowLogged = false;
  };
  const panels = new Map();                 // matchId → { hostKey, panel[] } from Committed
  const settled = new Map();                // matchId → Settled event
  // Every match this node has a duty on — as host or as a panel seat — with the clocks the contract runs on it.
  // Persisted without ledgers: a host that restarts resumes driving what it settled (the ledger is in its
  // settlement store), a seat resumes covering for the host.
  const dutiesPath = join(dataDir, 'matchbook-duties.json');
  const duties = new Map();                 // key → { matchId, role: 'host'|'seat', seat, status, committedAt, settledAt, drawBlock, escalatedAt, tried: {} }
  const saveDuties = () => { try { writeFileSync(dutiesPath, JSON.stringify([...duties.values()].map(({ tried, ledger, ...d }) => d))); } catch { /* read-only data dir */ } };
  const ledgers = new Map();                // key → ledger a seat fetched and verified (to feed an escalation if the host will not)
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
    const [nonceHex, fee, gasHex] = await Promise.all([
      nonce === null ? call('eth_getTransactionCount', [address, 'pending']) : '0x' + nonce.toString(16),
      feeParams(call, { capWei: capFromEnv() }), // type 2 with a ceiling where the chain has a base fee (node/fees.js); refuses above MAX_FEE_GWEI
      call('eth_estimateGas', [{ from: address, to, data }]),
    ]);
    nonce = BigInt(nonceHex);
    gasPriceWei = effectivePrice(fee);
    const raw = signWithFee({ nonce, gasLimit: BigInt(gasHex) * 13n / 10n, to, value: 0n, data, chainId: BigInt(chainId) }, fee, key.privateKey);
    const hash = await call('eth_sendRawTransaction', [raw]);
    nonce += 1n; sends++; lastTx = hash; lastError = null; txType = fee.type;
    emit('tx', { what, tx: hash });
    return hash;
  };
  const trySend = async (data, what, matchId, to) => {
    try {
      const tx = await send(data, what, to); log(`matchbook: ${what} ${matchId?.slice(0, 12) ?? ''} (tx ${tx.slice(0, 12)}…)`);
      noteSent(what, matchId, tx);
      if (matchId && /^[0-9a-f]{64}$/i.test(matchId) || (matchId && what !== 'propose' && what !== 'enroll')) {
        const key = /^[0-9a-f]{64}$/i.test(matchId) ? matchId.toLowerCase() : mb.matchIdBytes32(matchId);
        const rec = txlog.get(key) ?? { txs: [] }; rec.txs.push({ what, tx, at: Date.now() }); txlog.set(key, rec);
        pendingReceipts.set(tx, { since: Date.now(), tries: 0, own: true });
      }
      return tx;
    }
    catch (e) { lastError = `${what}: ${e.message}`; nonce = null; emit('tx-failed', { what, matchId, reason: e.message }); log(`matchbook: ${what} ${matchId?.slice(0, 12) ?? ''} failed: ${e.message}`); return null; }
  };
  const checkDelegate = async () => {
    if (!stakeContract) { delegated = true; return; }
    try { delegated = decodeBool(await call('eth_call', [mayActForCall(stakeContract, nodeId, address), 'latest'])); } catch { /* keep the last answer */ }
    await readBalance();
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
    if (tx) { const d = duty(key, delta.matchId, 'host', null); Object.assign(d, { status: 'settled', settledAt: Date.now() }); saveDuties(); }
    return tx;
  };

  // ---------------------------------------------------------------- watch
  // Every decoded event is appended to <dataDir>/matchbook-events.jsonl and replayed at start: the cursor
  // was persisted, the events were not, so a restart lost the ladder's history — the first final match
  // vanished from every node when all four restarted for 0.11.10 (21 Sep 2026). Nothing re-scans on
  // Liteforge; what this node has seen once, it keeps.
  const eventsPath = join(dataDir, 'matchbook-events.jsonl');
  let replaying = false;
  const absorb = (e) => {
    const id = `${e.tx ?? '?'}:${e.block}:${e.logIndex}`;
    if (seenLog.has(id)) return;
    seenLog.add(id);
    decoded.push(e);
    if (!replaying) { try { appendFileSync(eventsPath, JSON.stringify(e) + '\n'); } catch { /* read-only data dir */ } }
    // What we hold, we pass on: a match's transactions travel as hints from every node that holds their events,
    // not only from the node that sent them — a restarted peer, or one that joined late, learns the day's
    // matches from anyone (after 0.11.10 every node had restarted and nobody could tell anyone about the finals).
    if (e.tx) { const rec = seenTx.get(e.matchId) ?? { txs: new Set(), at: 0 }; rec.txs.add(e.tx); rec.at = Math.max(rec.at, (blockTs.get(e.block) ?? Date.now() / 1000) * 1000); seenTx.set(e.matchId, rec); }
    const at = (blockTs.get(e.block) ?? Date.now() / 1000) * 1000; // the block's own clock once stamped, ours until then
    if (e.event === 'Committed') {
      panels.set(e.matchId, { hostKey: e.hostKey, panel: e.panel });
      const seat = e.panel.indexOf(nodeId);
      const mineToDrive = e.hostKey === nodeId ? duty(e.matchId, e.matchId, 'host', null) : seat >= 0 ? duty(e.matchId, e.matchId, 'seat', seat) : null;
      if (mineToDrive && mineToDrive.status === 'none') Object.assign(mineToDrive, { status: 'committed', committedAt: at, block: e.block }); // never behind a Settled we already saw
    }
    if (e.event === 'Settled') settled.set(e.matchId, { ...e, seenAt: Date.now() });
    const d = duties.get(e.matchId);
    if (d) {
      if (e.event === 'Settled') Object.assign(d, { status: 'settled', settledAt: at, block: e.block, tried: {} });
      if (e.event === 'Extended') Object.assign(d, { status: 'settled', settledAt: at, block: e.block, tried: {} }); // the contract reset the clock
      if (e.event === 'Escalating') Object.assign(d, { status: 'escalating', drawBlock: e.drawBlock, feedBy: e.feedBy, tried: {} });
      if (e.event === 'Escalated') Object.assign(d, { status: 'escalated', escalatedAt: at, block: e.block, tried: {} });
      if (e.event === 'Finalized') { duties.delete(e.matchId); ledgers.delete(e.matchId); }
      if (!replaying) saveDuties();
    }
    if (e.event === 'Escalated') escalation.set(e.matchId, { panel: e.panel, at: Date.now() });
    if (e.event === 'Finalized' && !replaying) emit('chain-final', { matchId: e.matchId, status: e.status, finalHash: e.finalHash });
  };
  /** Replay what this node saw before, in order; then the persisted duties (their clocks are the true ones). */
  const replayEvents = () => {
    let lines = [];
    try { lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
    replaying = true;
    let n = 0;
    for (const line of lines) { try { absorb(JSON.parse(line)); n++; } catch { /* a torn last line */ } }
    replaying = false;
    for (const d of (() => { try { return JSON.parse(readFileSync(dutiesPath, 'utf8')); } catch { return []; } })()) if (d?.key) duties.set(d.key, { ...d, tried: {} });
    for (const k of [...duties.keys()]) if (decoded.some((e) => e.event === 'Finalized' && e.matchId === k)) duties.delete(k); // a duty file older than its events
    return n;
  };
  const duty = (key, matchId, role, seat) => { let d = duties.get(key); if (!d) { d = { key, matchId, role, seat, status: 'none', tried: {} }; duties.set(key, d); } return d; };
  /** The contract's windows, from the contract: a file can be stale (npm run params changes them live). */
  let paramsAt = 0;
  const readParams = async () => {
    if (Date.now() - paramsAt < PARAMS_TTL_MS) return;
    paramsAt = Date.now();
    try {
      const ret = (await call('eth_call', [{ to: contract, data: selector('params()') }, 'latest'])).replace(/^0x/, '');
      const w = (i) => Number(BigInt('0x' + ret.slice(i * 64, i * 64 + 64)));
      if (ret.length >= 6 * 64) Object.assign(windows, { settleWindow: w(0), attestWindow: w(1), escalationWindow: w(2) });
    } catch { paramsAt = Date.now() - PARAMS_TTL_MS + 60_000; /* try again in a minute */ }
  };
  /** The timestamp of every block a Finalized event sits in, read once. */
  const stampBlocks = async () => {
    const want = [...new Set(decoded.filter((e) => e.event === 'Finalized' && !blockTs.has(e.block)).map((e) => e.block).concat([...duties.values()].map((d) => d.block).filter((b) => b != null && !blockTs.has(b))))];
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
    // a restart forgets what it proposed; the chain does not — an hour with a finalized root needs nothing from us
    // (the desktop re-proposed a finalized hour after every restart and reported the revert as an error, 22 Sep 2026)
    try {
      const root = await call('eth_call', [{ to: epochAnchor, data: selector('rootOf(uint64)') + hour.toString(16).padStart(64, '0') }, 'latest']);
      if (root && !/^0x0*$/.test(root)) { proposedHours.add(hour); return null; }
    } catch { /* unknown: propose and let the contract answer */ }
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
    const mine = sentLog.find((s) => s.tx === tx); if (mine) { mine.ok = rc.status === '0x1'; mine.gasUsed = rc.gasUsed ? parseInt(rc.gasUsed, 16) : null; mine.block = rc.blockNumber ? parseInt(rc.blockNumber, 16) : null; }
    if (rc.status !== '0x1') return true;
    for (const l of rc.logs ?? []) { if ((l.address ?? '').toLowerCase() !== contract.toLowerCase()) continue; const e = mb.decodeLog({ ...l, transactionHash: l.transactionHash ?? tx }); if (e) absorb(e); }
    return true;
  };
  /** Receipts for what this node sent (retried until mined) and for what peers hinted. Bounded per poll: a peer's
   *  hints are unverified hashes, and the gateway rate-limits one IP at ~25 req/s — our own sends go first. */
  const readReceipts = async () => {
    let reads = 0;
    for (const [tx, p] of [...pendingReceipts].sort((a, b) => Number(b[1].own ?? 0) - Number(a[1].own ?? 0))) {
      if (p.tries > 40 && Date.now() - p.since > 10 * 60_000) { pendingReceipts.delete(tx); continue; }
      if (reads++ >= RECEIPTS_PER_POLL) break;
      p.tries++;
      try { await ingestReceipt(tx); } catch { /* next poll */ }
    }
  };
  /** The ladder's log scan: SCAN_RANGE blocks per poll from a persisted cursor. A fresh node starts a little behind
   *  the head; history before that is a backfill job for later, not something a live match waits on. */
  let scanRange = SCAN_START, scanning = false, scanMs = null;
  const read = async () => {
    const head = parseInt(await call('eth_blockNumber', []), 16);
    if (cursor === null) cursor = Math.max(fromBlock - 1, head - SCAN_START_BEHIND);
    if (cursor >= head) return;
    const to = Math.min(head, cursor + scanRange);
    const t0 = Date.now();
    const logs = await call('eth_getLogs', [mb.logsFilter(contract, cursor + 1, to)]);
    scanMs = Date.now() - t0;
    if (scanMs < SCAN_FAST_MS) scanRange = Math.min(SCAN_MAX, Math.ceil(scanRange * 1.5));
    else if (scanMs > SCAN_SLOW_MS) scanRange = Math.max(SCAN_MIN, Math.floor(scanRange / 2));
    for (const l of logs) { const e = mb.decodeLog(l); if (e) absorb(e); }
    cursor = to;
    try { writeFileSync(cursorPath, JSON.stringify({ cursor })); } catch { /* read-only data dir */ }
  };
  /** The scan runs beside the live poll, never inside it: a 16 s eth_getLogs used to sit between a Settled
   *  receipt and the attest it called for. Best effort — nothing live waits on the ladder's history. */
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try { await read(); scanError = null; } catch (e) { scanError = String(e.message ?? e); }
    finally { scanning = false; }
  };
  /** Gossip hints: the transactions of every match this node touched in the last day — bounded by time, never by history. */
  const hints = () => {
    const cut = Date.now() - HINT_TTL_MS; const out = [];
    for (const [key, rec] of txlog) { const txs = rec.txs.filter((t) => t.at > cut); if (txs.length) out.push({ key, at: txs[txs.length - 1].at, txs: txs.map((t) => t.tx) }); else txlog.delete(key); }
    for (const [key, rec] of seenTx) {
      if (rec.at <= cut) { seenTx.delete(key); continue; }
      const mine = out.find((o) => o.key === key);
      if (mine) { for (const tx of rec.txs) if (!mine.txs.includes(tx)) mine.txs.push(tx); } else out.push({ key, at: rec.at, txs: [...rec.txs] });
    }
    // newest matches first, at most HINT_MAX of them: a busy host's day must not become every peer's heartbeat
    return out.sort((a, b) => b.at - a.at).slice(0, HINT_MAX).map(({ key, txs }) => ({ key, txs }));
  };
  /** A peer's hints are hashes we have not verified: cap what one envelope may enqueue and how much may wait,
   *  so a hostile peer can make us read a few receipts, not flood the gateway on our behalf. */
  const absorbHints = (list) => {
    let taken = 0;
    for (const h of Array.isArray(list) ? list.slice(0, HINT_MAX) : []) for (const tx of Array.isArray(h?.txs) ? h.txs.slice(0, 8) : []) {
      if (taken >= HINT_TAKE_PER_ENVELOPE || pendingReceipts.size >= RECEIPTS_MAX_PENDING) return;
      if (typeof tx === 'string' && /^0x[0-9a-f]{64}$/i.test(tx) && !ingested.has(tx) && !pendingReceipts.has(tx)) { pendingReceipts.set(tx, { since: Date.now(), tries: 0 }); taken++; }
    }
  };

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
      if (onFirst) ledgers.set(s.matchId, ledger); // a seat keeps what it verified: it may have to feed the escalation
      const res = await settlement.cosign(delta, ledger);
      const ours = res.ok ? delta.resultHash : res.ours;
      if (!ours) throw new Error(`could not verify: ${res.reason}`);
      attested.add(s.matchId);
      const tx = await trySend(mb.attestCalldata(delta.matchId, nodeId, ours), res.ok ? 'attest' : 'dispute', delta.matchId);
      emit('attested', { matchId: delta.matchId, agrees: res.ok, reason: res.ok ? null : res.reason, tx, escalation: !!onNine && !onFirst });
    } catch (e) { log(`matchbook: witness ${s.matchId.slice(0, 12)}: ${e.message}`); emit('witness-failed', { matchId: s.matchId, reason: e.message }); }
    finally { witnessing.delete(s.matchId); }
  };

  /** Drive every match this node has a duty on through its windows: the host first, each seat one stagger later
   *  if the chain still shows the match where the host should have moved it. A call the host already made
   *  reverts here with WrongStatus at estimateGas — one read, no transaction. */
  const drive = async () => {
    if (!driving || duties.size === 0) return;
    const now = Date.now();
    const order = (d) => (d.role === 'host' ? 0 : d.seat + 1);
    // the clock a window runs on is the block's, once stamped (a restarted node re-reads old events at 'now')
    const since = (d, local) => (d.block != null && blockTs.has(d.block) ? blockTs.get(d.block) * 1000 : local);
    let head = null;
    const headBlock = async () => head ?? (head = parseInt(await call('eth_blockNumber', []), 16));
    for (const d of [...duties.values()]) {
      const late = order(d) * SEAT_STAGGER_MS;
      const once = async (what, calldata) => {
        if (d.tried[what]) return;
        d.tried[what] = now;
        const tx = await trySend(calldata, what, d.matchId);
        if (!tx) d.tried[what] = null; // WindowOpen, a hiccup, or the host got there first: the next event or window decides
        else if (d.role === 'seat') emit('backstop', { matchId: d.matchId, what, seat: d.seat, tx });
      };
      if (d.status === 'committed' && d.role === 'seat' && now - since(d, d.committedAt) > (windows.settleWindow + WINDOW_MARGIN_S) * 1000 + late) {
        await once('expire', mb.expireCalldata(d.matchId)); // the host committed and never settled: void it, so it is not "pending" for ever
      }
      if (d.status === 'settled') {
        // the host finalizes as soon as all three answered; otherwise host, then seats, once the window has passed
        const answered = d.role === 'host' ? decoded.filter((e) => e.event === 'Attested' && e.matchId === d.key && !e.escalation).length : 0;
        if (answered >= 3 || now - since(d, d.settledAt) > (windows.attestWindow + WINDOW_MARGIN_S) * 1000 + late) await once('finalize', mb.finalizeCalldata(d.matchId));
      }
      if (d.status === 'escalating' && d.drawBlock != null && (await headBlock()) > d.drawBlock + order(d) * FEED_STAGGER_BLOCKS) {
        const ledger = ledgers.get(d.key) ?? settlement.ledger?.(d.matchId) ?? settlement.ledger?.(d.key) ?? null;
        if (ledger) await once('escalate', mb.escalateCalldata(d.matchId, ledger));
        else if (!d.tried.noLedger) { d.tried.noLedger = now; log(`matchbook: ${d.matchId.slice(0, 12)} is escalating and this ${d.role} holds no ledger to feed it`); }
      }
      if (d.status === 'escalated' && now - since(d, d.escalatedAt) > (windows.escalationWindow + WINDOW_MARGIN_S) * 1000 + late) await once('resolve', mb.resolveCalldata(d.matchId));
    }
  };

  let lastPoll = 0;
  const poll = async () => {
    if (polling || Date.now() - lastPoll < POLL_MS) return;
    polling = true; lastPoll = Date.now();
    try {
      if (delegated === null || !funded) await checkDelegate();
      else if (Date.now() - balanceAt > BALANCE_TTL) await readBalance();
      await readParams();
      await autoEnrol();
      await readReceipts();
      void scan();
      for (const s of settled.values()) {
        const st = statusOf(s.matchId);
        // a seat is worth answering while the contract still counts the answer: attest window (one extension) or
        // escalation window, plus a margin — not every two seconds forever for a host that went dark
        const open = st === 'settled' ? Date.now() - s.seenAt < (2 * windows.attestWindow + 60) * 1000
          : st === 'escalated' ? Date.now() - (escalation.get(s.matchId)?.at ?? 0) < (windows.escalationWindow + 60) * 1000 : false;
        if (open) void witness(s);
      }
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

  const replayed = replayEvents();
  if (replayed) log(`matchbook: ${replayed} event(s) replayed from disk — ${duties.size} dut${duties.size === 1 ? 'y' : 'ies'} outstanding`);

  return {
    address, commit, settle, poll, ladder, statusOf, epoch, propose, hints, absorbHints, ingestReceipt,
    // What this key sent, newest last (receipt outcome once read): the operator's ledger of settlement work.
    sent: (n = 50) => sentLog.slice(-n),
    // The last n decided matches this node holds events for, newest last — the dashboard's "recent" strip.
    recent: (n = 20) => decoded.filter((e) => e.event === 'Finalized').slice(-n).map((e) => ({ matchId: e.matchId, status: e.status, block: e.block, tx: e.tx ?? null, at: blockTs.get(e.block) ? new Date(blockTs.get(e.block) * 1000).toISOString() : null })),
    proof: (matchId) => { const key = mb.matchIdBytes32(matchId); const fin = decoded.find((e) => e.event === 'Finalized' && e.matchId === key); if (!fin) return null; const ts = blockTs.get(fin.block); if (ts == null) return null; return mb.chainProof(epoch(hourOf(ts * 1000)), key); },
    chainStatus: (matchId) => ({ matchId, key: mb.matchIdBytes32(matchId), status: statusOf(mb.matchIdBytes32(matchId)), panel: panels.get(mb.matchIdBytes32(matchId))?.panel ?? null, events: decoded.filter((e) => e.matchId === mb.matchIdBytes32(matchId)) }),
    status: () => ({ contract, epochAnchor, delegate: address, delegated, funded, enrolled, purse: purse(), cursor, scanRange, scanMs, scanError, receipts: ingested.size, pendingReceipts: pendingReceipts.size, events: decoded.length, sends, lastTx, lastError, hosting: [...duties.values()].filter((d) => d.role === 'host').length, seated: [...duties.values()].filter((d) => d.role === 'seat').length, windows: { ...windows }, attested: attested.size, proposed: [...proposedHours] }),
  };
}

