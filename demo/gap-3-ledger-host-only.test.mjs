/** Gap 3 (handoff/mesh-gaps/REPORT.md): the panel can fetch a ranked match's ledger only from its host.
 *
 *  Characterizes TODAY's behaviour, so the suite stays green; a fix flips the marked assertions.
 *  Four operators on a real NodeStake + MatchBook (demo/lib/rpc-evm.mjs, eth_getLogs answering so the seats
 *  learn of Settled without the host). The host plays and settles a ranked tug.v1 match and stops the moment
 *  its settle transaction is sent. Nothing else holds the ledger: off-chain custody skips placed ranked results
 *  when MatchBook is on (node/litnode.js adverts), and witness() asks only hostAddr(hostKey) (node/matchbook.js).
 *
 *    seats fail to fetch → no attest → the attest window is extended once → still none → Escalating →
 *    no seat holds the ledger to feed escalate() → nobody calls expire() on an unfed escalation (drive() has no
 *    such branch) → the match sits in Escalating until an outsider expires it → Void, the host's bond untouched.
 *
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
import { placeMatch, until, sleep } from './lib/mesh.mjs';

const ROOT = process.cwd();
const RULESET = join(ROOT, 'rulesets', 'tug.v1.js');
const manifest = JSON.parse(readFileSync(join(ROOT, 'rulesets', 'tug.v1.json'), 'utf8'));
const title = (await import(pathToFileURL(join(ROOT, 'titles', 'tug.v1.mjs')).href)).default;
const ONE = 10n ** 18n;
const STATUS = ['None', 'Committed', 'Settled', 'Final', 'Void', 'Escalating', 'Escalated'];

test('gap 3: a host that stops right after settle leaves its panel without a ledger; the match ends Void, nobody slashed', { timeout: 300_000 }, async (t) => {
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

  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, matchBook: book, matchBookWindows: { attestWindow: 4, escalationWindow: 6 }, chainId: 4441, heartbeatMs: 200, updates: false, announce: false };
  const spawn = (opts) => createNode({ ...common, ...opts }).then((n) => (nodes.push(n), n));
  let host = null, stopped = null;
  // the host stops the moment its settle transaction is out: what a crash, a power cut or a withheld ledger look like
  const onHostEvent = (ev) => { if (ev.type === 'tx' && ev.what === 'settle' && !stopped) stopped = new Promise((r) => setImmediate(() => host.stop().catch(() => {}).finally(r))); };
  host = await spawn({ dataDir: ids[0].dir, operator: 'op1', roles: ['mesh', 'host', 'settler', 'witness'], rulesets: [RULESET], onEvent: onHostEvent });
  const seatEvents = [], seatLogs = [];
  const seats = [];
  for (let i = 1; i < 4; i++) seats.push(await spawn({ dataDir: ids[i].dir, operator: `op${i + 1}`, roles: ['mesh', 'witness'], seeds: [host.addr], onEvent: (ev) => seatEvents.push(ev), log: (s) => seatLogs.push(String(s)) }));
  assert.ok(await until(() => seats.every((w) => w.rulesets()['tug.v1'] === manifest.buildHash), 30_000), 'every seat holds the build');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/health`)).json()).matchBook?.delegated === true, 20_000));

  // ---- placed, committed, played and signed by both players, settled on the host
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
  assert.ok(await until(() => ev('Settled').length === 1, 30_000), 'Settled on chain');
  assert.ok(stopped, 'the host stopped as its settle went out'); await stopped;
  assert.equal((await fetch(`${host.addr}/health`).catch(() => null))?.ok ?? false, false, 'nothing answers at the host');

  // ---- the panel tries, and every seat can ask only the host
  assert.ok(await until(() => seatEvents.some((e) => e.type === 'witness-failed' && e.matchId === key), 30_000), 'a seat tried to witness and failed');
  // TODAY: no seat ever attests, because the ledger lives only on the host. A fix (any holder serves it, or it was pushed to the panel before settle) flips this.
  const extended = await until(() => ev('Extended')[0] ?? null, 90_000);
  assert.ok(extended, 'zero attests in the window: extended once for liveness');
  const escalating = await until(() => ev('Escalating')[0] ?? null, 90_000);
  assert.ok(escalating, 'still none after the extension: escalating');
  assert.equal(ev('Attested').length, 0, 'TODAY: not one seat could attest (fix: ≥ 2 agreeing attests, Final)');
  assert.ok(await until(() => seatLogs.some((s) => s.includes('holds no ledger to feed it')), 60_000), 'TODAY: no seat holds the ledger escalate() needs');

  // ---- nobody voids it: drive() expires an unsettled commit, not an unfed escalation
  const chainNow = () => Math.floor(Date.now() / 1000) + 2; // the chain's clock: wall time + the warp above
  while (chainNow() < escalating.feedBy + 30) await sleep(500); // the feed window, plus more than a seat stagger
  const st = await chain.read(book, 'statusOf', ['0x' + key]);
  assert.equal(STATUS[Number(st[0])], 'Escalating', 'TODAY: an unfed escalation is never expired by the mesh (fix: seats call expire() after feedBy)');
  assert.equal(ev('Finalized').length, 0);

  // ---- anyone may void it, and nobody is slashed: the abort cost the host nothing
  const before = await chain.read(stake, 'standingOf', ['0x' + ids[0].kp.publicKey]);
  await chain.send(5, book, 'expire', ['0x' + key]);
  const fin = ev('Finalized')[0];
  assert.ok(fin, 'expired'); assert.equal(fin.status, 'void');
  const after = await chain.read(stake, 'standingOf', ['0x' + ids[0].kp.publicKey]);
  assert.equal(after[1], before[1], 'the host that withheld the ledger keeps its whole bond');
  assert.equal(after[2], true, 'and stays active');
});
