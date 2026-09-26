/** Season Zero reward points (protocol/rewards.js, protocol/rewards-chain.js,
 *  docs/REWARDS.md): the gate opens at minActive operators and pauses below
 *  it; emission, gas-first refunds and the split are exact to the wei and the
 *  books always balance; quality weights, caps, reliability and forfeits do
 *  what the rules say; the fold is order-independent; the chain side decodes
 *  every event, splits timed-out log requests, caches incrementally; and the
 *  real Liteforge history folds to the facts the contracts report.
 *    node --test demo/rewards.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeRewards, rewardParams, toWei, formatWei, weekOf, WEI } from '../protocol/rewards.js';
import { decodeRewardLog, rewardTopic, entriesFromRows, rpcClient, scanLogs, syncRows, REWARD_CONTRACTS } from '../protocol/rewards-chain.js';
import { rulesetIdBytes32, topic as mbTopic } from '../protocol/matchbook.js';

// ------------------------------------------------------------------ a small synthetic chain
const HOUR = 3600, DAY = 86_400;
const T0 = Date.UTC(2026, 8, 28) / 1000; // Monday 28 Sep 2026 00:00Z
const RULESET = 'agent-fighter.v1';
const hex64 = (tag, i) => (tag + String(i)).split('').map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64);
const wallet = (tag, i) => '0x' + hex64(tag, i).slice(0, 40);
const nodeKey = (i) => hex64('node', i), operator = (i) => wallet('op', i), delegate = (i) => wallet('dg', i);
const playerKey = (i) => hex64('player', i), playerOwner = (i) => wallet('pl', i);
const PUBLISHER = wallet('pub', 0);

function chain() {
  let block = 1;
  const entries = [];
  const add = (contract, event, ts, fields = {}) => { const e = { contract, event, block: block++, logIndex: 0, ts, tx: '0x' + block.toString(16).padStart(64, '0'), gasCost: 0n, from: null, ...fields }; entries.push(e); return e; };
  const c = {
    entries,
    stake(i, ts = T0 - DAY, op = operator(i)) { add('NodeStake', 'Staked', ts, { nodeKey: nodeKey(i), operator: op }); add('NodeStake', 'DelegateSet', ts, { nodeKey: nodeKey(i), delegate: delegate(i) }); return c; },
    title(ts = T0 - DAY, publisher = PUBLISHER) { add('TitleRegistry', 'Registered', ts, { titleId: hex64('title', 0), rulesetId: RULESET, publisher }); return c; },
    profile(i, ts = T0 - DAY, owner = playerOwner(i)) { add('PlayerProfile', 'Transfer', ts, { tokenId: hex64('tok', i), to: owner }); add('PlayerProfile', 'KeyBound', ts, { tokenId: hex64('tok', i), key: playerKey(i) }); return c; },
    propose(i, ts) { add('EpochAnchor', 'Proposed', ts, { epoch: Math.floor(ts / HOUR), nodeKey: nodeKey(i), sender: delegate(i) }); return c; },
    slash(i, ts) { add('NodeStake', 'Slashed', ts, { nodeKey: nodeKey(i) }); return c; },
    /** A whole match: commit at `ts`, settle +60 s, attests +90 s, finalize +400 s by the host's delegate. */
    match(id, ts, { host = 0, panel = [1, 2, 3], players = [0, 1], agree = [true, true, true], attest = [true, true, true], status = 'final', gas = {}, overturn = false } = {}) {
      const matchId = hex64('match', id), rulesetKey = rulesetIdBytes32(RULESET), resultHash = hex64('result', id);
      add('MatchBook', 'Committed', ts, { matchId, rulesetKey, hostKey: nodeKey(host), panel: panel.map(nodeKey), gasCost: gas.commit ?? 0n });
      add('MatchBook', 'Settled', ts + 60, { matchId, rulesetKey, hostKey: nodeKey(host), resultHash, participants: players.map(playerKey), scores: players.map(() => 0), gasCost: gas.settle ?? 0n });
      panel.forEach((w, i) => { if (attest[i]) add('MatchBook', 'Attested', ts + 90, { matchId, witnessKey: nodeKey(w), resultHash: agree[i] ? resultHash : hex64('lie', id), agrees: agree[i], escalation: false, gasCost: gas.attest ?? 0n }); });
      add('MatchBook', 'Finalized', ts + 400, { matchId, rulesetKey, finalHash: overturn ? hex64('other', id) : status === 'final' ? resultHash : '0'.repeat(64), status, from: delegate(host), gasCost: gas.finalize ?? 0n });
      return c;
    },
  };
  return c;
}
/** n operators with one node each, a title, profiles for `players` players. */
const world = (n, players = 8) => { const c = chain().title(); for (let i = 0; i < n; i++) c.stake(i); for (let i = 0; i < players; i++) c.profile(i); return c; };
const NOW = T0 + 2 * DAY;
const run = (c, params = {}, now = NOW) => computeRewards(c.entries, { seasonStart: new Date(T0 * 1000).toISOString(), ...params }, { now: now * 1000 });
const balanced = (r) => {
  for (const h of r.hours) assert.equal(h.paid + h.rolledBack, h.released, `hour ${h.at}: paid + rolled back = released`);
  const rows = r.operators.reduce((s, o) => s + o.total, 0n) + r.publishers.reduce((s, x) => s + x.total, 0n);
  assert.equal(rows, r.totals.paid, 'every paid wei is on someone’s row');
  assert.equal(r.pool.left, r.pool.start - r.totals.paid, 'pool left = start − paid');
  assert.ok(r.pool.left >= 0n);
};
/** Ten operators become active at T0 by proposing an epoch (work between matches). */
const tenActive = (c, n = 10, ts = T0 + 60) => { for (let i = 0; i < n; i++) c.propose(i, ts); return c; };

// ------------------------------------------------------------------ parameters and units
test('rewards: parameters validate; wei parse/format; Monday weeks', () => {
  assert.equal(rewardParams().minActive, 10);
  assert.throws(() => rewardParams({ split: { host: 4000 } }), /10000 bps/);
  assert.throws(() => rewardParams({ countBy: 'wallet' }), /countBy/);
  assert.throws(() => rewardParams({ minActive: 0 }), /minActive/);
  assert.throws(() => rewardParams({ reliability: { full: 0.5, zero: 0.9 } }), /exceed/);
  assert.throws(() => rewardParams({ pool: '-1' }), /not an amount/);
  assert.equal(toWei('200'), 200n * WEI);
  assert.equal(toWei('0.000000000000000001'), 1n);
  assert.equal(formatWei(toWei('1.2345679')), '1.234567', 'truncates, never rounds up');
  assert.equal(formatWei(0n), '0');
  assert.equal(formatWei(-toWei('2.5')), '-2.5');
  assert.equal(weekOf(T0) - weekOf(T0 - 1), 1, 'a week starts Monday 00:00 UTC');
  assert.equal(weekOf(T0 + 7 * DAY - 1), weekOf(T0));
});

// ------------------------------------------------------------------ the gate
test('rewards: nothing is released below 10 active operators; exactly 10 opens the gate; activity older than 24 h lapses', () => {
  const nine = tenActive(world(10), 9).match(1, T0 + 600, { players: [0, 1] });
  const r9 = run(nine);
  assert.equal(r9.totals.released, 0n, 'paused at 9');
  assert.equal(r9.pool.left, r9.pool.start, 'the pool keeps everything while paused');
  assert.ok(r9.hours.every((h) => !h.gate));
  assert.equal(r9.matches.qualifying, 1, 'the match still counts — the gate stops the release, not the record');

  const ten = tenActive(world(10), 10).match(1, T0 + 600, { players: [0, 1] });
  const r10 = run(ten);
  const h0 = r10.hours.find((h) => h.hour === Math.floor(T0 / HOUR));
  assert.equal(h0.active, 10); assert.equal(h0.gate, true);
  assert.ok(r10.totals.released > 0n, 'open at exactly 10');
  balanced(r10);
  // A day later nobody has worked since: the gate is shut again and the report says so.
  assert.equal(r10.gate.activeNow, 0); assert.equal(r10.gate.open, false);
  const late = r10.hours.find((h) => h.hour === Math.floor((T0 + DAY + HOUR) / HOUR));
  assert.equal(late.gate, false, 'activity older than activeWindowH no longer counts');
});

test('rewards: the gate counts operator wallets, not machines — one wallet with ten nodes stays paused (countBy "node" counts machines)', () => {
  const c = chain().title();
  for (let i = 0; i < 10; i++) c.stake(i, T0 - DAY, operator(0));
  for (let i = 0; i < 8; i++) c.profile(i);
  tenActive(c).match(1, T0 + 600);
  assert.equal(run(c).totals.released, 0n);
  assert.equal(run(c).hours[0].active, 1);
  assert.ok(run(c, { countBy: 'node' }).totals.released > 0n);
});

test('rewards: an allowlist restricts both earning and the gate count', () => {
  const c = tenActive(world(10)).match(1, T0 + 600);
  const list = Array.from({ length: 9 }, (_, i) => operator(i));
  assert.equal(run(c, { allowlist: list }).totals.released, 0n, 'nine listed operators cannot open a gate of ten');
  const r = run(c, { allowlist: list, minActive: 9 });
  assert.ok(r.totals.released > 0n);
  const all = run(c, { minActive: 9 });
  assert.ok(r.operators.every((o) => o.address !== operator(9) || o.total === 0n), 'operator 9 is not on the list');
  assert.equal(r.totals.released, all.totals.released);
  balanced(r);
});

// ------------------------------------------------------------------ emission and the split
test('rewards: emission is pool × ln2/(180·24) × (1 + 2√(Q̄/400)), exact to the wei', () => {
  const c = tenActive(world(10, 4));
  // players 0 and 1 have met three opponents each by now, so their match weighs 1
  c.match(1, T0 + 100, { players: [0, 2] }).match(2, T0 + 200, { players: [0, 3] }).match(3, T0 + 300, { players: [1, 2] }).match(4, T0 + 400, { players: [1, 3] });
  const r = run(c, { quality: { requireProfiles: true, diversityOpponents: 1 } });
  const h = r.hours.find((x) => x.hour === Math.floor(T0 / HOUR));
  assert.equal(h.matches, 4); assert.equal(h.qEff, 4);
  const m = 1 + 2 * Math.sqrt((4 / 24) / 400);
  assert.equal(h.m, m);
  const expected = toWei('200') * BigInt(Math.round((Math.LN2 / (180 * 24)) * m * 1e12)) / 10n ** 12n;
  assert.equal(h.released, expected);
  balanced(r);
});

test('rewards: gas is refunded first, then host 35 · witness 10 × 3 · publisher 20 · guardian 15', () => {
  const gas = { commit: 3n * 10n ** 12n, settle: 2n * 10n ** 12n, attest: 10n ** 12n, finalize: 10n ** 12n };
  const c = tenActive(world(10)).match(1, T0 + 600, { gas });
  const r = run(c, { quality: { diversityOpponents: 1 } });
  const alloc = r.totals.released;
  const gasTotal = gas.commit + gas.settle + 3n * gas.attest + gas.finalize;
  const profit = alloc - gasTotal, cut = (bps) => profit * BigInt(bps) / 10_000n;
  const row = (i) => r.operators.find((o) => o.address === operator(i));
  assert.equal(row(0).gas, gas.commit + gas.settle + gas.finalize, 'the host sent commit, settle and finalize');
  assert.equal(row(0).host, cut(3500));
  assert.equal(row(0).guardian, cut(1500), 'the host finalized it, through its delegate');
  for (const w of [1, 2, 3]) { assert.equal(row(w).gas, gas.attest); assert.equal(row(w).witness, cut(1000)); }
  assert.equal(r.publishers[0].address, PUBLISHER);
  assert.equal(r.publishers[0].total, cut(2000));
  assert.equal(r.publishers[0].matches, 1);
  assert.ok(r.totals.rolledBack < 10n, 'only rounding dust rolls back');
  balanced(r);
});

test('rewards: when the allocation cannot cover gas, refunds are prorated and nobody profits', () => {
  const gas = { commit: 10n ** 18n, settle: 10n ** 18n, attest: 10n ** 18n, finalize: 10n ** 18n };
  const c = tenActive(world(10)).match(1, T0 + 600, { gas });
  const r = run(c, { quality: { diversityOpponents: 1 } });
  assert.ok(r.totals.released > 0n && r.totals.released < 6n * 10n ** 18n);
  assert.ok(r.operators.every((o) => o.host === 0n && o.witness === 0n && o.guardian === 0n));
  assert.equal(r.publishers.length, 0);
  const host = r.operators.find((o) => o.address === operator(0)).gas, witness = r.operators.find((o) => o.address === operator(1)).gas;
  assert.ok(host > 2n * witness && host <= 3n * witness + 3n, 'the host sent 3 of the 6 gas units');
  balanced(r);
});

// ------------------------------------------------------------------ what counts, and how much
test('rewards: repeat pairs decay 1, ½, ¼, ⅛, 1/16, then stop; the sixth is excluded', () => {
  const c = tenActive(world(10));
  for (let i = 0; i < 6; i++) c.match(i + 1, T0 + 600 + i * 30, { players: [0, 1] });
  const r = run(c, { quality: { diversityOpponents: 1 } });
  const h = r.hours.find((x) => x.hour === Math.floor(T0 / HOUR));
  assert.equal(h.qEff, 1 + 0.5 + 0.25 + 0.125 + 0.0625);
  assert.equal(r.matches.qualifying, 5);
  assert.deepEqual(r.matches.excluded, { 'pair-cap': 1 });
});

test('rewards: diversity — a player who met one opponent counts ⅓; three distinct opponents count in full', () => {
  const one = run(tenActive(world(10)).match(1, T0 + 600, { players: [0, 1] }));
  assert.equal(one.hours[0].qEff, Math.round(1e6 / 3) / 1e6);
  // A match weighs its LESS varied player: a veteran cannot lift a match against a fresh account.
  const c = tenActive(world(10, 6));
  c.match(1, T0 + 600, { players: [0, 1] }).match(2, T0 + 700, { players: [0, 2] }).match(3, T0 + 800, { players: [0, 3] }); // ⅓ each: 1, 2, 3 are new
  c.match(4, T0 + 900, { players: [1, 2] }).match(5, T0 + 1000, { players: [1, 3] });                                       // ⅔ each
  c.match(6, T0 + 1100, { players: [0, 4] });                                                                                // ⅓: 4 is new
  const before = run(c).hours[0].qEff;
  assert.ok(Math.abs(before - (4 * 333333 + 2 * 666667) / 1e6) < 1e-9, `hour weight ${before}`);
  c.match(7, T0 + 1200, { players: [2, 3] }); // both have now met three different players
  assert.ok(Math.abs(run(c).hours[0].qEff - before - 1) < 1e-9, 'two varied players weigh in full');
});

test('rewards: a player past 30 counted matches in a day adds nothing', () => {
  const c = tenActive(world(10, 40));
  for (let i = 1; i <= 31; i++) c.match(i, T0 + 600 + i * 20, { players: [0, i] });
  const r = run(c);
  assert.equal(r.matches.excluded['player-cap'], 1);
  assert.equal(r.matches.qualifying, 30);
});

test('rewards: void, overturned, under-attested, profile-less and self-played matches do not count', () => {
  const c = tenActive(world(10, 8));
  c.match(1, T0 + 600, { status: 'void' });
  c.match(2, T0 + 700, { overturn: true });
  c.match(3, T0 + 800, { attest: [true, false, false] });
  c.match(4, T0 + 900, { players: [0, 99] }); // player 99 has no profile
  const r = run(c);
  assert.deepEqual(r.matches.excluded, { void: 1, 'host-overturned': 1, 'under-attested': 1, 'no-profile': 1 });
  assert.equal(r.totals.released, 0n, 'nothing qualified, nothing released');
  assert.equal(run(c, { quality: { requireProfiles: false } }).matches.excluded['no-profile'], undefined);
  // The host's operator owns a player's profile: it is judging its own match.
  const s = tenActive(world(10, 8)); s.profile(7, T0 - DAY, operator(0)); s.match(5, T0 + 600, { players: [7, 1] });
  assert.deepEqual(run(s).matches.excluded, { 'self-play': 1 });
});

test('rewards: wash trading — sixty bot matches between two accounts weigh about 1 % of an hour of real play', () => {
  const c = tenActive(world(10, 62));
  const real = (j) => 2 + (((j % 60) + 60) % 60); // players 2..61
  let id = 0;
  // Before the season, each real player met three different opponents (real players have a history).
  for (let j = 0; j < 60; j++) for (const d of [1, 2, 3]) c.match(++id, T0 - 2 * DAY + id * 10, { players: [real(j), real(j + d)] });
  // In the hour: 60 real matches, every pair new that day, and 60 bot matches between accounts 0 and 1.
  for (let j = 0; j < 60; j++) c.match(++id, T0 + 300 + j * 5, { players: [real(j), real(j + 10)] });
  for (let i = 0; i < 60; i++) c.match(++id, T0 + 400 + i * 5, { players: [0, 1] });
  const r = run(c);
  const h = r.hours.find((x) => x.hour === Math.floor(T0 / HOUR));
  const bots = Math.round(1e6 / 3) / 1e6 * (1 + 0.5 + 0.25 + 0.125 + 0.0625);
  assert.ok(Math.abs(h.qEff - (60 + bots)) < 1e-5, `hour weight ${h.qEff}: sixty real matches at 1, the bots at ${bots}`);
  assert.ok(bots / h.qEff < 0.011, `bots hold ${(100 * bots / h.qEff).toFixed(2)} % of the hour's weight — and of its release`);
  assert.equal(r.matches.excluded['pair-cap'], 55);
  balanced(r);
});

// ------------------------------------------------------------------ reliability and forfeits
test('rewards: reliability — 7 of 10 seats answered halves a witness’s share; 9 of 10 pays in full; 5 of 10 pays nothing', () => {
  const share = (answered) => {
    const c = tenActive(world(10, 8));
    for (let i = 0; i < 10; i++) c.match(i + 1, T0 + 600 + i * 30, { players: [i % 4, 4 + (i % 4)], attest: [i < answered, true, true] });
    const r = run(c);
    balanced(r);
    return r.operators.find((o) => o.address === operator(1));
  };
  const full = share(9), half = share(7), none = share(5);
  assert.equal(full.reliability, 1); assert.equal(half.reliability, 0.5); assert.equal(none.reliability, 0);
  assert.ok(full.witness > 0n && half.witness > 0n && none.witness === 0n);
  assert.deepEqual(half.duties, { drawn: 10, answered: 7 });
});

test('rewards: a placement that never settles is not held against the host', () => {
  const c = tenActive(world(10));
  c.entries.push({ contract: 'MatchBook', event: 'Committed', block: 10_000, logIndex: 0, ts: T0 + 500, tx: '0xab', gasCost: 0n, from: null, matchId: hex64('abandoned', 1), rulesetKey: rulesetIdBytes32(RULESET), hostKey: nodeKey(0), panel: [1, 2, 3].map(nodeKey) });
  c.match(1, T0 + 600);
  const host = run(c).operators.find((o) => o.address === operator(0));
  assert.equal(host.reliability, 1);
  assert.deepEqual(host.duties, { drawn: 1, answered: 1 });
});

test('rewards: a lone dissent on a voided match forfeits the week and counts two misses — unless waived', () => {
  const c = tenActive(world(10, 8));
  c.match(1, T0 + 600, { players: [0, 1] });
  c.match(2, T0 + 900, { players: [2, 3], agree: [false, true, true], status: 'void' });
  const r = run(c);
  const w = r.operators.find((o) => o.address === operator(1));
  assert.equal(w.total, 0n, 'its earnings that week roll back');
  assert.deepEqual(w.duties, { drawn: 3, answered: 1 });
  assert.deepEqual(r.forfeits, [`${operator(1)}:${weekOf(T0)}`]);
  balanced(r);
  const waived = run(c, { waivers: [hex64('match', 2)] });
  assert.ok(waived.operators.find((o) => o.address === operator(1)).total > 0n);
  assert.deepEqual(waived.forfeits, []);
});

test('rewards: a slashed node’s operator forfeits that week', () => {
  const c = tenActive(world(10)).match(1, T0 + 600).slash(2, T0 + 3 * DAY);
  const r = run(c, {}, T0 + 4 * DAY);
  assert.equal(r.operators.find((o) => o.address === operator(2)).total, 0n);
  assert.ok(r.operators.find((o) => o.address === operator(3)).total > 0n);
  balanced(r);
});

// ------------------------------------------------------------------ determinism
test('rewards: the same logs in any order give the same report', () => {
  const c = tenActive(world(10, 8));
  for (let i = 0; i < 12; i++) c.match(i + 1, T0 + 600 + i * 400, { players: [i % 4, 4 + ((i * 3) % 4)], gas: { settle: BigInt(1000 + i) } });
  const a = run(c);
  const shuffled = c.entries.map((e, i) => [((i * 7919) % 101), e]).sort((x, y) => x[0] - y[0]).map(([, e]) => e);
  const b = computeRewards(shuffled, { seasonStart: new Date(T0 * 1000).toISOString() }, { now: NOW * 1000 });
  assert.deepEqual(b, a);
});

test('rewards: a month of traffic (20 operators, 5,760 matches) folds in seconds and balances', () => {
  const c = world(20, 60);
  let id = 0;
  for (let hr = 0; hr < 30 * 24; hr++) {
    const ts = T0 + hr * HOUR;
    for (let i = 0; i < 20; i++) c.propose(i, ts + 5);
    for (let k = 0; k < 8; k++) { const h = (hr + k) % 20; c.match(++id, ts + 60 + k * 300, { host: h, panel: [(h + 1) % 20, (h + 2) % 20, (h + 3) % 20], players: [(hr * 3 + k) % 60, (hr * 7 + k * 11 + 1) % 60] }); }
  }
  const t = Date.now();
  const r = computeRewards(c.entries, { seasonStart: new Date(T0 * 1000).toISOString() }, { now: (T0 + 30 * DAY) * 1000 });
  const ms = Date.now() - t;
  assert.ok(ms < 15_000, `${ms} ms for ${c.entries.length} logs`);
  assert.equal(r.hours.length, 30 * 24 + 1);
  assert.ok(r.hours.slice(0, -1).every((h) => h.gate), 'twenty operators keep the gate open all month');
  assert.ok(r.totals.paid > 0n && r.pool.left < r.pool.start);
  balanced(r);
});

// ------------------------------------------------------------------ the chain side
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const topicAddr = (a) => '0x' + a.replace(/^0x/, '').padStart(64, '0');
const row = (contract, event, topics, data = '', extra = {}) => ({ address: '0x0', blockNumber: '0x10', logIndex: '0x1', blockTimestamp: '0x6ab1cfac', transactionHash: '0xAB', topics: [rewardTopic(contract, event), ...topics], data: '0x' + data, from: '0xABCD', gasUsed: '0x100', effectiveGasPrice: '0x3', ...extra });

test('rewards chain: every event the fold reads decodes from its raw log', () => {
  const k = '11'.repeat(32), a = '0x' + '22'.repeat(20), b = '0x' + '33'.repeat(20);
  const staked = decodeRewardLog('NodeStake', row('NodeStake', 'Staked', ['0x' + k, topicAddr(a)], word(5) + word(5) + word(1) + word(1)));
  assert.equal(staked.event, 'Staked'); assert.equal(staked.nodeKey, k); assert.equal(staked.operator, a);
  assert.equal(staked.ts, 0x6ab1cfac); assert.equal(staked.gasCost, 0x300n); assert.equal(staked.from, '0xabcd'); assert.equal(staked.tx, '0xab');
  assert.equal(decodeRewardLog('NodeStake', row('NodeStake', 'OperatorTransferred', ['0x' + k, topicAddr(a), topicAddr(b)])).operator, b);
  assert.equal(decodeRewardLog('NodeStake', row('NodeStake', 'DelegateSet', ['0x' + k, topicAddr(b)])).delegate, b);
  assert.equal(decodeRewardLog('NodeStake', row('NodeStake', 'Slashed', ['0x' + k, '0x' + '44'.repeat(32), topicAddr(b)], word(7) + word(1000))).bps, 1000);
  const name = 'pickle-brawl.v1', bytes = Buffer.from(name).toString('hex').padEnd(64, '0');
  const reg = decodeRewardLog('TitleRegistry', row('TitleRegistry', 'Registered', ['0x' + word(9), topicAddr(a), '0x' + '55'.repeat(32)], word(32) + word(name.length) + bytes));
  assert.equal(reg.rulesetId, name); assert.equal(reg.publisher, a); assert.equal(reg.titleId, word(9));
  const tr = decodeRewardLog('PlayerProfile', row('PlayerProfile', 'Transfer', [topicAddr('0x' + '00'.repeat(20)), topicAddr(b), '0x' + word(4)]));
  assert.equal(tr.event, 'Transfer'); assert.equal(tr.to, b); assert.equal(tr.tokenId, word(4));
  assert.equal(decodeRewardLog('PlayerProfile', row('PlayerProfile', 'KeyBound', ['0x' + word(4), '0x' + k])).key, k);
  const prop = decodeRewardLog('EpochAnchor', row('EpochAnchor', 'Proposed', ['0x' + word(497226), '0x' + '66'.repeat(32), '0x' + k], word(BigInt(a)) + word(1) + word(1) + word(1)));
  assert.equal(prop.epoch, 497226); assert.equal(prop.nodeKey, k); assert.equal(prop.sender, a);
  const fin = decodeRewardLog('MatchBook', { ...row('NodeStake', 'Staked', []), topics: [mbTopic('Finalized'), '0x' + '77'.repeat(32), '0x' + rulesetIdBytes32(RULESET)], data: '0x' + '88'.repeat(32) + word(3) });
  assert.equal(fin.event, 'Finalized'); assert.equal(fin.status, 'final'); assert.equal(fin.from, '0xabcd'); assert.equal(fin.gasCost, 0x300n);
  assert.equal(decodeRewardLog('NodeStake', row('TitleRegistry', 'Registered', [])), null, 'a foreign topic is ignored');
  const routed = entriesFromRows([{ ...row('NodeStake', 'DelegateSet', ['0x' + k, topicAddr(b)]), address: '0xAAAA' }], { NodeStake: { address: '0xaaaa' } });
  assert.equal(routed.length, 1, 'rows are routed by contract address, case-insensitively');
});

/** A fake Liteforge: logs by block, receipts by tx, and eth_getLogs that times out over `limit` blocks. */
function fakeRpc({ logs = [], head = 10_000, limit = 1000, batches = true } = {}) {
  const calls = { getLogs: [], batch: 0 };
  const answer = ({ id, method, params }) => {
    if (method === 'eth_blockNumber') return { id, result: '0x' + head.toString(16) };
    if (method === 'eth_getLogs') {
      const from = parseInt(params[0].fromBlock, 16), to = parseInt(params[0].toBlock, 16);
      calls.getLogs.push([from, to]);
      if (to - from + 1 > limit) return { id, error: { code: -32002, message: 'request timed out' } };
      return { id, result: logs.filter((l) => l.block >= from && l.block <= to).map((l) => ({ address: l.address, blockNumber: '0x' + l.block.toString(16), logIndex: '0x0', blockTimestamp: '0x' + (T0 + l.block).toString(16), transactionHash: l.tx, topics: l.topics, data: '0x', removed: false })) };
    }
    if (method === 'eth_getTransactionReceipt') return { id, result: { transactionHash: params[0], from: '0xFEED', gasUsed: '0x2', effectiveGasPrice: '0x5' } };
    return { id, error: { code: -32601, message: 'no such method' } };
  };
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) { calls.batch++; return { ok: true, status: 200, json: async () => (batches ? body.map(answer) : { error: { message: 'batch not supported' } }) }; }
    return { ok: true, status: 200, json: async () => answer(body) };
  };
  return { fetchImpl, calls };
}
const CONTRACTS = Object.fromEntries(REWARD_CONTRACTS.map((n, i) => [n, { address: '0x' + String(i + 1).repeat(40), block: 100 }]));
const logAt = (block, contract = 'NodeStake') => ({ block, address: CONTRACTS[contract].address, tx: '0x' + block.toString(16).padStart(64, '0'), topics: [rewardTopic('NodeStake', 'DelegateSet'), '0x' + word(block), topicAddr('0x' + '99'.repeat(20))] });

test('rewards chain: a timed-out log request is split until it fits; nothing is lost or doubled', async () => {
  const logs = [150, 999, 1000, 1001, 2500, 4096].map((b) => logAt(b));
  const { fetchImpl, calls } = fakeRpc({ logs, limit: 700 });
  const client = rpcClient('http://rpc.test', { fetchImpl, delayMs: 1 });
  const got = await scanLogs(client, [CONTRACTS.NodeStake.address], 100, 5000, { chunk: 2000, concurrency: 3 });
  assert.deepEqual(got.map((l) => parseInt(l.blockNumber, 16)).sort((a, b) => a - b), [150, 999, 1000, 1001, 2500, 4096]);
  assert.ok(calls.getLogs.every(([a, b]) => a >= 100 && b <= 5000));
  assert.ok(calls.getLogs.some(([a, b]) => b - a + 1 > 700), 'the big request was tried');
  await assert.rejects(scanLogs(rpcClient('http://rpc.test', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32000, message: 'invalid params' } }) }), delayMs: 1 }), ['0x1'], 1, 10), /invalid params/, 'other errors are not split away');
});

test('rewards chain: a request that hangs is abandoned and retried; a 5xx is retried; a 4xx is not', async () => {
  let n = 0;
  const hangsOnce = async (_url, init) => {
    if (++n === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x2a' }) };
  };
  assert.equal(await rpcClient('http://rpc.test', { fetchImpl: hangsOnce, delayMs: 1, timeoutMs: 50 }).call('eth_blockNumber', []), '0x2a');
  assert.equal(n, 2);
  let m = 0;
  const flaky = async () => (++m < 3 ? { ok: false, status: 502 } : { ok: true, status: 200, json: async () => ({ result: '0x1' }) });
  assert.equal(await rpcClient('http://rpc.test', { fetchImpl: flaky, delayMs: 1 }).call('eth_blockNumber', []), '0x1');
  assert.equal(m, 3);
  let k = 0;
  await assert.rejects(rpcClient('http://rpc.test', { fetchImpl: async () => (k++, { ok: false, status: 403 }), delayMs: 1 }).call('eth_blockNumber', []), /HTTP 403/);
  assert.equal(k, 1, 'a 4xx is final');
});

test('rewards chain: receipts are fetched in batches, one by one when the node refuses batches', async () => {
  for (const batches of [true, false]) {
    const { fetchImpl, calls } = fakeRpc({ logs: [logAt(200), logAt(300)], batches });
    const client = rpcClient('http://rpc.test', { fetchImpl, delayMs: 1 });
    const got = await client.many('eth_getTransactionReceipt', [['0x1'], ['0x2'], ['0x3']]);
    assert.deepEqual(got.map((r) => r.transactionHash), ['0x1', '0x2', '0x3']);
    assert.equal(calls.batch, 1);
  }
});

test('rewards chain: the cache grows by new blocks only, and resets for another contract generation', async () => {
  const logs = [logAt(150), logAt(400)];
  const rpc = fakeRpc({ logs, head: 520 });
  const client = rpcClient('http://rpc.test', { fetchImpl: rpc.fetchImpl, delayMs: 1 });
  const first = await syncRows(client, { contracts: CONTRACTS, chainId: 4441, confirmations: 20 });
  assert.equal(first.scannedTo, 500); assert.equal(first.added, 2);
  assert.equal(first.rows[0].from, '0xFEED'); assert.equal(first.rows[0].gasUsed, '0x2');
  logs.push(logAt(505), logAt(600));
  const again = await syncRows(client, { contracts: CONTRACTS, chainId: 4441, cache: first, confirmations: 20 });
  assert.equal(again.added, 0, 'block 505 is inside the confirmation margin until the head moves');
  const moved = fakeRpc({ logs, head: 700 });
  const next = await syncRows(rpcClient('http://rpc.test', { fetchImpl: moved.fetchImpl, delayMs: 1 }), { contracts: CONTRACTS, chainId: 4441, cache: first, confirmations: 20 });
  assert.equal(next.added, 2); assert.equal(next.rows.length, 4);
  assert.ok(moved.calls.getLogs.every(([a]) => a >= 501), 'only blocks after the cache were read');
  const other = { ...CONTRACTS, MatchBook: { address: '0x' + 'f'.repeat(40), block: 100 } };
  const reset = await syncRows(rpcClient('http://rpc.test', { fetchImpl: moved.fetchImpl, delayMs: 1 }), { contracts: other, chainId: 4441, cache: next, confirmations: 20 });
  assert.equal(reset.rows.length, 4, 'a new generation re-reads from its own deploy block');
  assert.ok(entriesFromRows(reset.rows, other).length === 4);
});

// ------------------------------------------------------------------ the real Liteforge history
const FIXTURE = join(process.cwd(), 'demo', 'fixtures', 'rewards-liteforge.json');
test('rewards: the real Liteforge history (RPC, fixture) folds to what the contracts report', { skip: !existsSync(FIXTURE) && 'no fixture' }, () => {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const entries = entriesFromRows(fx.rows, fx.contracts);
  const staked = new Map(entries.filter((e) => e.event === 'Staked').map((e) => [e.nodeKey, e.operator]));
  // Facts read from the contracts on 27 Sep 2026 (NodeStake.nodeOf, TitleRegistry.titleOf) that the explorer's index lacked.
  const ally = [...staked].find(([k]) => k.startsWith('9054aac9'));
  assert.ok(ally && ally[1].startsWith('0xb2361a4b'), 'rog-ally’s node and its operator');
  assert.ok([...staked.values()].includes('0xea09e9b9acf53462dc4490c9174fdb41b3f62ef2'), 'the node bonded by 0xeA09… is there');
  const titles = entries.filter((e) => e.event === 'Registered').map((e) => e.rulesetId).sort();
  assert.deepEqual(titles.filter((t) => t !== 'gods.v1'), ['agent-fighter.v1', 'pickle-brawl.v1']);
  const now = (Math.max(...entries.map((e) => e.ts)) + 3600) * 1000;
  const paused = computeRewards(entries, {}, { now });
  assert.equal(paused.totals.released, 0n, 'fewer than ten operators ever worked: nothing released');
  assert.equal(paused.pool.left, toWei('200'));
  const open = computeRewards(entries, { minActive: 1 }, { now });
  const m = entries.find((e) => e.event === 'Finalized' && e.status === 'final' && e.matchId.startsWith('524cd42d'));
  assert.ok(m, 'match 524cd42d… finalized on chain');
  assert.ok(open.totals.paid > 0n);
  balanced(open);
});
