/** Custody before settle (0.12.2; handoff/mesh-gaps/REPORT.md gap 3 option a): a ranked host holds its settle until
 *  two of its seats hold the ledger, and never waits for seats that cannot take custody.
 *
 *    1. all 0.12.2: the seats pull the ledger from the host's custody advert, send signed receipts, the host settles
 *       at the second; the Settled event names the holders, a seat serves the ledger, the match goes Final.
 *    2. a 0.12.2 host, 0.12.0/0.12.1 seats (matchBookCustody: false = a node that predates custody): no seat says it
 *       takes custody, so the host settles at once, as before, naming every seat; the old seats finalize it.
 *    3. a 0.12.1 host, 0.12.2 seats: the host never asks; the seats witness from the Settled event as before.
 *    4. the bound: two capable seats die mid-match; one receipt comes, the host waits out custodyHold and settles
 *       naming the one holder.
 *
 *  Four operators on a real NodeStake + MatchBook (demo/lib/rpc-evm.mjs).
 *    node --test demo/custody-before-settle.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair } from '../protocol/keys.js';
import * as mb from '../protocol/matchbook.js';
import { createSim, createRecorder, localSigner, settle, matchSeed, externalAgents } from '../sdk/client.js';
import { createRpcEvm } from './lib/rpc-evm.mjs';
import { placeMatch, until } from './lib/mesh.mjs';

const ROOT = process.cwd();
const RULESET = join(ROOT, 'rulesets', 'tug.v1.js');
const manifest = JSON.parse(readFileSync(join(ROOT, 'rulesets', 'tug.v1.json'), 'utf8'));
const title = (await import(pathToFileURL(join(ROOT, 'titles', 'tug.v1.mjs')).href)).default;
const ONE = 10n ** 18n;

/** Four bonded, delegated operators; node 1 hosts. `custody`: [host, seat, seat, seat] matchBookCustody flags. */
async function mesh(t, { custody = [true, true, true, true], custodyHold = 40, attestWindow = 30 } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-custody-'));
  const chain = await createRpcEvm({ logsUnavailable: true }); // as on Liteforge: events travel as receipts the host hints
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  t.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const book = await chain.deploy('MatchBook.sol', 'MatchBook', [stake, { settleWindow: 120n, attestWindow: BigInt(attestWindow), escalationWindow: 30n, drawDelay: 1n, hostSlashBps: 1000, witnessSlashBps: 500 }, chain.addressOf(0)]);
  await chain.send(0, stake, 'setAdjudicator', [book, true]);
  const dirs = [];
  for (let i = 1; i <= 4; i++) {
    const kp = await generateKeypair();
    const dir = join(tmp, `n${i}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(kp));
    writeFileSync(join(dir, 'announcer.json'), JSON.stringify({ privateKey: chain.keyOf(10 + i) }));
    await chain.send(i, token, 'faucet', []);
    await chain.send(i, token, 'approve', [stake, 10n * ONE]);
    await chain.bondNode(i, stake, kp, ONE);
    await chain.send(i, stake, 'setDelegate', ['0x' + kp.publicKey, chain.addressOf(10 + i)]);
    dirs.push(dir);
  }
  chain.warp(2);
  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, matchBook: book, matchBookWindows: { attestWindow, escalationWindow: 30, custodyHold }, chainId: 4441, heartbeatMs: 200, updates: false, announce: false };
  const events = { host: [], seats: [[], [], []] };
  const spawn = (opts) => createNode({ ...common, ...opts }).then((n) => (nodes.push(n), n));
  const host = await spawn({ dataDir: dirs[0], operator: 'op1', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET], matchBookCustody: custody[0], onEvent: (ev) => events.host.push({ ...ev, at: Date.now() }) });
  const seats = [];
  for (let i = 1; i < 4; i++) seats.push(await spawn({ dataDir: dirs[i], operator: `op${i + 1}`, roles: ['mesh', 'witness'], seeds: [host.addr], matchBookCustody: custody[i], onEvent: (ev) => events.seats[i - 1].push({ ...ev, at: Date.now() }) }));
  assert.ok(await until(() => seats.every((w) => w.rulesets()['tug.v1'] === manifest.buildHash), 30_000), 'every seat holds the build');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/health`)).json()).matchBook?.delegated === true, 20_000));
  assert.ok(await until(async () => { const s = await (await fetch(`${host.addr}/snapshot`)).json(); return seats.every((w) => s.peers.some((p) => p.nodeId === w.nodeId)); }, 20_000), 'the host counts all three seats as fresh');
  const ev = (key, name) => chain.logs().map(mb.decodeLog).filter((e) => e?.event === name && e.matchId === key);
  return { chain, host, seats, events, ev };
}

/** Place, commit, play and sign a ranked tug.v1 match on the host; `beforeSettle` runs once Committed is on chain. */
async function playRanked(m, { beforeSettle = async () => {} } = {}) {
  const [a, b] = [await generateKeypair(), await generateKeypair()];
  const d = await placeMatch(m.host.addr, [a, b], { rulesetId: 'tug.v1', mode: 'ranked', timeoutMs: 40_000 });
  assert.deepEqual([...d.panel].sort(), m.seats.map((s) => s.nodeId).sort(), 'the three seats are the panel');
  const key = mb.matchIdBytes32(d.matchId);
  assert.ok(await until(() => m.ev(key, 'Committed').length === 1, 30_000), 'committed');
  await beforeSettle(key);
  const P = d.participants;
  const rec = createRecorder({ matchId: d.matchId, participants: P, rulesetId: 'tug.v1', buildHash: manifest.buildHash, mode: 'ranked' });
  const sim = createSim(title, { seed: matchSeed(d), participants: P, ctx: { agents: externalAgents(P) } });
  while (!sim.done() && sim.tick < 3000) { const inputs = { [P[0]]: 1, [P[1]]: sim.tick % 3 ? 2 : 0 }; sim.step(inputs); rec.record(inputs); }
  const t0 = Date.now();
  const delta = await settle({ nodeUrl: m.host.addr, recorder: rec, signers: { [a.publicKey]: await localSigner(a), [b.publicKey]: await localSigner(b) }, hydration: { agents: externalAgents(P) } });
  return { d, key, delta, t0, answeredInMs: Date.now() - t0 };
}

test('custody 1: two seats take custody, the host settles at the second receipt, naming the holders', { timeout: 300_000 }, async (t) => {
  const m = await mesh(t, { custodyHold: 60 });
  const { key, delta, answeredInMs } = await playRanked(m);
  assert.ok(answeredInMs < 20_000, `the player's POST /ledger does not wait out the custody window (${answeredInMs} ms)`);
  const wait = await until(() => m.events.host.find((e) => e.type === 'custody-wait'), 10_000);
  assert.ok(wait, 'the host holds its settle for custody'); assert.equal(wait.need, 2);
  const st = await until(() => m.ev(key, 'Settled')[0] ?? null, 50_000);
  assert.ok(st, 'settled');
  const holders = st.custodians.slice(1);
  assert.equal(st.custodians[0], m.host.nodeId, 'the host first');
  assert.ok(holders.length >= 2 && holders.every((k) => m.seats.some((s) => s.nodeId === k)), `the Settled event names the seats that hold it (${holders.length})`);
  assert.ok(!m.events.host.some((e) => e.type === 'custody-short'), 'settled on receipts, not on the timeout');
  const holder = m.seats.find((s) => s.nodeId === holders[0]);
  const served = await (await fetch(`${holder.addr}/ledger/${key}`)).json();
  assert.equal(mb.ledgerHash(served), st.ledgerHash, 'a seat serves the ledger it holds, the one on chain');
  assert.equal((await (await fetch(`${holder.addr}/delta/${key}`)).json()).resultHash, delta.resultHash, 'and the host-signed delta');
  const fin = await until(() => m.ev(key, 'Finalized')[0] ?? null, 60_000);
  assert.ok(fin); assert.equal(fin.status, 'final'); assert.equal(fin.finalHash, delta.resultHash);
});

test('custody 2: a 0.12.2 host with 0.12.0/0.12.1 seats settles at once, as before', { timeout: 300_000 }, async (t) => {
  const m = await mesh(t, { custody: [true, false, false, false] });
  const { key, delta, t0 } = await playRanked(m);
  const st = await until(() => m.ev(key, 'Settled')[0] ?? null, 30_000);
  assert.ok(st, 'settled');
  assert.ok(!m.events.host.some((e) => e.type === 'custody-wait'), 'no seat takes custody: the host does not wait');
  const sent = m.events.host.find((e) => e.type === 'tx' && e.what === 'settle');
  assert.ok(sent.at - t0 < 15_000, 'the settle went out with the ledger, not after a custody window');
  assert.deepEqual([...st.custodians].sort(), [m.host.nodeId, ...m.seats.map((s) => s.nodeId)].sort(), 'custodians as before: the host and its panel');
  const fin = await until(() => m.ev(key, 'Finalized')[0] ?? null, 60_000);
  assert.ok(fin); assert.equal(fin.status, 'final'); assert.equal(fin.finalHash, delta.resultHash, 'the old seats witness the new host');
});

test('custody 3: 0.12.2 seats with a 0.12.1 host witness from Settled, as before', { timeout: 300_000 }, async (t) => {
  const m = await mesh(t, { custody: [false, true, true, true] });
  const { key, delta } = await playRanked(m);
  const st = await until(() => m.ev(key, 'Settled')[0] ?? null, 30_000);
  assert.ok(st, 'settled');
  assert.ok(!m.events.host.some((e) => e.type === 'custody-wait'), 'the old host does not ask');
  assert.ok(!m.events.seats.flat().some((e) => e.type === 'custody-held'), 'nothing to take');
  const fin = await until(() => m.ev(key, 'Finalized')[0] ?? null, 60_000);
  assert.ok(fin); assert.equal(fin.status, 'final'); assert.equal(fin.finalHash, delta.resultHash);
});

test('custody 4: seats that die mid-match cannot stall the host: it settles after custodyHold, naming the one holder', { timeout: 300_000 }, async (t) => {
  const HOLD = 8;
  const m = await mesh(t, { custodyHold: HOLD });
  let alive = null;
  const { key } = await playRanked(m, { beforeSettle: async () => { await m.seats[0].stop(); await m.seats[1].stop(); alive = m.seats[2]; } });
  const wait = await until(() => m.events.host.find((e) => e.type === 'custody-wait'), 10_000);
  assert.ok(wait, 'the host holds its settle'); assert.equal(wait.need, 2, 'both dead seats said they take custody: the host counts them');
  const st = await until(() => m.ev(key, 'Settled')[0] ?? null, 40_000);
  assert.ok(st, 'settled anyway');
  const sent = m.events.host.find((e) => e.type === 'tx' && e.what === 'settle');
  assert.ok(sent.at - wait.at >= (HOLD - 1) * 1000, `the host waited out the hold (${sent.at - wait.at} ms)`);
  assert.ok(m.events.host.some((e) => e.type === 'custody-short' && e.holders === 1), 'one of two seats took custody in time');
  assert.deepEqual(st.custodians, [m.host.nodeId, alive.nodeId], 'the custodians are the host and the seat that holds it');
});
