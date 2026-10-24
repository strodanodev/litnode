/** Gap 3 (handoff/mesh-gaps/REPORT.md): a ranked match's ledger must outlive its host. Fixed in 0.12.2.
 *
 *  Until 0.12.1 the panel could fetch the ledger only from the host, so a host that stopped right after its settle
 *  left the match unattested, then Escalating with nobody able to feed it, and the mesh never expired that: it sat
 *  in Escalating until an outsider called expire(). Now:
 *    1. custody before settle: the seats hold the ledger before the host settles, so its death changes nothing —
 *       they attest from their own copies and the match goes Final.
 *    2. with no holder at all (seats that predate custody, matchBookCustody: false), the seats still answer what the
 *       chain leaves them: they expire the unfed escalation themselves once its feed window is over. Void, nobody
 *       slashed, no outsider needed.
 *  Four operators on a real NodeStake + MatchBook (demo/lib/rpc-evm.mjs, eth_getLogs answering so the seats learn of
 *  Settled without the host). The host stops the moment its settle transaction is sent.
 *    node --test demo/gap-3-ledger-host-only.test.mjs */
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

/** Four operators; the host settles a ranked tug.v1 match signed by both players and stops as its settle goes out. */
async function hostDiesAfterSettle(t, { seatCustody }) {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-gap3-'));
  const chain = await createRpcEvm(); // eth_getLogs answers: the seats see Settled from the chain, not from the host's hints
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  t.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const params = { settleWindow: 60n, attestWindow: 4n, escalationWindow: 6n, drawDelay: 1n, hostSlashBps: 1000, witnessSlashBps: 500 };
  const book = await chain.deploy('MatchBook.sol', 'MatchBook', [stake, params, chain.addressOf(0)]);
  await chain.send(0, stake, 'setAdjudicator', [book, true]);

  const ids = [];
  for (let i = 1; i <= 4; i++) {
    const kp = await generateKeypair();
    const dir = join(tmp, `n${i}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(kp));
    writeFileSync(join(dir, 'announcer.json'), JSON.stringify({ privateKey: chain.keyOf(10 + i) }));
    await chain.send(i, token, 'faucet', []);
    await chain.send(i, token, 'approve', [stake, 10n * ONE]);
    await chain.bondNode(i, stake, kp, ONE);
    await chain.send(i, stake, 'setDelegate', ['0x' + kp.publicKey, chain.addressOf(10 + i)]);
    ids.push({ kp, dir });
  }
  chain.warp(2);

  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, matchBook: book, matchBookWindows: { attestWindow: 4, escalationWindow: 6, custodyHold: 20 }, chainId: 4441, heartbeatMs: 200, updates: false, announce: false };
  const spawn = (opts) => createNode({ ...common, ...opts }).then((n) => (nodes.push(n), n));
  let host = null, stopped = null;
  // the host stops the moment its settle transaction is out: what a crash, a power cut or a withheld ledger look like
  const onHostEvent = (ev) => { if (ev.type === 'tx' && ev.what === 'settle' && !stopped) stopped = new Promise((r) => setImmediate(() => host.stop().catch(() => {}).finally(r))); };
  host = await spawn({ dataDir: ids[0].dir, operator: 'op1', roles: ['mesh', 'host', 'settler', 'witness'], rulesets: [RULESET], onEvent: onHostEvent });
  const seatEvents = [], seatLogs = [];
  const seats = [];
  for (let i = 1; i < 4; i++) seats.push(await spawn({ dataDir: ids[i].dir, operator: `op${i + 1}`, roles: ['mesh', 'witness'], seeds: [host.addr], matchBookCustody: seatCustody, onEvent: (ev) => seatEvents.push(ev), log: (s) => seatLogs.push(String(s)) }));
  assert.ok(await until(() => seats.every((w) => w.rulesets()['tug.v1'] === manifest.buildHash), 30_000), 'every seat holds the build');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/health`)).json()).matchBook?.delegated === true, 20_000));
  assert.ok(await until(async () => { const s = await (await fetch(`${host.addr}/snapshot`)).json(); return seats.every((w) => s.peers.some((p) => p.nodeId === w.nodeId)); }, 20_000), 'the host counts all three seats');

  const [a, b] = [await generateKeypair(), await generateKeypair()];
  const d = await placeMatch(host.addr, [a, b], { rulesetId: 'tug.v1', mode: 'ranked', timeoutMs: 40_000 });
  assert.equal(d.panel.length, 3);
  const key = mb.matchIdBytes32(d.matchId);
  const ev = (name) => chain.logs().map(mb.decodeLog).filter((e) => e?.event === name && e.matchId === key);
  assert.ok(await until(() => ev('Committed').length === 1, 30_000), 'Committed before play');
  const P = d.participants;
  const rec = createRecorder({ matchId: d.matchId, participants: P, rulesetId: 'tug.v1', buildHash: manifest.buildHash, mode: 'ranked' });
  const sim = createSim(title, { seed: matchSeed(d), participants: P, ctx: { agents: externalAgents(P) } });
  while (!sim.done() && sim.tick < 3000) { const inputs = { [P[0]]: 1, [P[1]]: sim.tick % 3 ? 2 : 0 }; sim.step(inputs); rec.record(inputs); }
  const signers = { [a.publicKey]: await localSigner(a), [b.publicKey]: await localSigner(b) };
  await settle({ nodeUrl: host.addr, recorder: rec, signers, hydration: { agents: externalAgents(P) } }).catch(() => null); // the host may die mid-answer
  assert.ok(await until(() => ev('Settled').length === 1, 40_000), 'Settled on chain');
  assert.ok(stopped, 'the host stopped as its settle went out'); await stopped;
  assert.equal((await fetch(`${host.addr}/health`).catch(() => null))?.ok ?? false, false, 'nothing answers at the host');
  return { chain, stake, book, ids, host, seats, seatEvents, seatLogs, key, ev };
}

test('gap 3 (fixed): a host that stops right after settle — its seats already hold the ledger, attest and finalize', { timeout: 300_000 }, async (t) => {
  const m = await hostDiesAfterSettle(t, { seatCustody: true });
  const st = m.ev('Settled')[0];
  assert.ok(st.custodians.length >= 3, 'the host settled once at least two seats held the ledger');
  assert.ok(await until(() => m.ev('Attested').length >= 2, 60_000), 'the seats attest from their own copies, the host gone');
  assert.ok(m.ev('Attested').every((x) => x.agrees));
  const fin = await until(() => m.ev('Finalized')[0] ?? null, 90_000);
  assert.ok(fin, 'a seat finalized in the dead host\'s place'); assert.equal(fin.status, 'final'); assert.equal(fin.finalHash, st.resultHash);
  assert.equal(m.ev('Escalating').length, 0, 'nothing to escalate');
});

test('gap 3 (fixed): with no holder at all, the seats expire the unfed escalation themselves — Void, nobody slashed', { timeout: 300_000 }, async (t) => {
  const m = await hostDiesAfterSettle(t, { seatCustody: false }); // seats that predate custody: nobody but the host held it
  assert.ok(await until(() => m.seatEvents.some((e) => e.type === 'witness-failed' && e.matchId === m.key), 30_000), 'a seat tried every holder and failed');
  const escalating = await until(() => m.ev('Escalating')[0] ?? null, 120_000);
  assert.ok(escalating, 'no attest, extended once, still none: escalating');
  assert.equal(m.ev('Attested').length, 0);
  assert.ok(await until(() => m.seatLogs.some((s) => s.includes('holds no ledger to feed it')), 60_000), 'no seat can feed escalate()');
  const before = await m.chain.read(m.stake, 'standingOf', ['0x' + m.ids[0].kp.publicKey]);
  const fin = await until(() => m.ev('Finalized')[0] ?? null, 120_000);
  assert.ok(fin, 'expired by the mesh, not by an outsider'); assert.equal(fin.status, 'void');
  assert.ok(m.seatEvents.some((e) => e.type === 'backstop' && e.what === 'expire' && e.matchId === m.key), 'a seat sent the expire');
  const after = await m.chain.read(m.stake, 'standingOf', ['0x' + m.ids[0].kp.publicKey]);
  assert.equal(after[1], before[1], 'nobody slashed: the host keeps its bond (gap 2 counts the abort, not this fix)');
  assert.equal(after[2], true, 'and stays active');
});
