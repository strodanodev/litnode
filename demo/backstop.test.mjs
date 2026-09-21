/** The liveness backstop: a match whose host does not drive it still
 *  reaches its end. Every window call on MatchBook is permissionless; the
 *  host acts first and each panel seat one stagger later. Here the host
 *  settles and then does nothing (drive: false — what a crashed host looks
 *  like from the chain), and a seat finalizes; a second match is committed
 *  and never settled, and a seat expires it. Both verified on the chain and
 *  on the seats' own duty lists.
 *    node --test demo/backstop.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

test('backstop: a seat finalizes a settled match its host abandoned, and expires a committed one it never settled', { timeout: 240_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-backstop-'));
  const chain = await createRpcEvm({ logsUnavailable: true });
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  t.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const params = { settleWindow: 6n, attestWindow: 4n, escalationWindow: 6n, drawDelay: 1n, hostSlashBps: 1000, witnessSlashBps: 500 };
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
    await chain.send(i, stake, 'stake', ['0x' + kp.publicKey, ONE]);
    await chain.send(i, stake, 'setDelegate', ['0x' + kp.publicKey, chain.addressOf(10 + i)]);
    ids.push({ kp, dir });
  }
  chain.warp(2);

  // the windows the nodes are TOLD are wrong on purpose: they must read the contract's (npm run params changes them live)
  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, matchBook: book, matchBookWindows: { attestWindow: 900, escalationWindow: 900 }, chainId: 4441, heartbeatMs: 200, updates: false, announce: false };
  const spawn = (opts) => createNode({ ...common, ...opts }).then((n) => (nodes.push(n), n));
  const host = await spawn({ dataDir: ids[0].dir, operator: 'op1', roles: ['mesh', 'host', 'settler', 'witness'], rulesets: [RULESET], matchBookDrive: false });
  const seats = [];
  for (let i = 1; i < 4; i++) seats.push(await spawn({ dataDir: ids[i].dir, operator: `op${i + 1}`, roles: ['mesh', 'witness'], seeds: [host.addr] }));
  assert.ok(await until(() => seats.every((w) => w.rulesets()['tug.v1'] === manifest.buildHash), 30_000), 'every seat holds the build');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/health`)).json()).matchBook?.delegated === true, 20_000));
  const windows = await until(async () => { const w = (await (await fetch(`${seats[0].addr}/health`)).json()).matchBook?.windows; return w?.attestWindow === 4 ? w : null; }, 20_000);
  assert.deepEqual(windows, { settleWindow: 6, attestWindow: 4, escalationWindow: 6 }, 'the windows come from the contract, not from the file');

  // ---- match 1: placed, committed, played, settled — and then the host does nothing
  const [a, b] = [await generateKeypair(), await generateKeypair()];
  const d = await placeMatch(host.addr, [a, b], { rulesetId: 'tug.v1', mode: 'ranked', timeoutMs: 40_000 });
  assert.equal(d.panel.length, 3);
  const P = d.participants;
  const rec = createRecorder({ matchId: d.matchId, participants: P, rulesetId: 'tug.v1', buildHash: manifest.buildHash, mode: 'ranked' });
  const sim = createSim(title, { seed: matchSeed(d), participants: P, ctx: { agents: externalAgents(P) } });
  while (!sim.done() && sim.tick < 3000) { const inputs = { [P[0]]: 1, [P[1]]: sim.tick % 3 ? 2 : 0 }; sim.step(inputs); rec.record(inputs); }
  const signers = { [a.publicKey]: await localSigner(a), [b.publicKey]: await localSigner(b) };
  const delta = await settle({ nodeUrl: host.addr, recorder: rec, signers, hydration: { agents: externalAgents(P) } });
  const key = mb.matchIdBytes32(d.matchId);
  const ev = (name) => chain.logs().map(mb.decodeLog).filter((e) => e?.event === name && e.matchId === key);
  assert.ok(await until(() => ev('Settled').length === 1, 30_000), 'Settled on chain');
  assert.ok(await until(() => ev('Attested').length >= 3, 60_000), 'three attests');

  // ---- match 2: placed and committed, never settled
  const [c, e] = [await generateKeypair(), await generateKeypair()];
  const d2 = await placeMatch(host.addr, [c, e], { rulesetId: 'tug.v1', mode: 'ranked', timeoutMs: 40_000 });
  const key2 = mb.matchIdBytes32(d2.matchId);
  const ev2 = (name) => chain.logs().map(mb.decodeLog).filter((e) => e?.event === name && e.matchId === key2);
  assert.ok(await until(() => ev2('Committed').length === 1, 30_000), 'match 2 Committed on chain');

  // ---- the seats hold the duties; the host, told not to drive, never finalizes
  const seatHealth = async (i) => (await (await fetch(`${seats[i].addr}/health`)).json()).matchBook;
  assert.ok(await until(async () => (await seatHealth(0)).seated >= 1, 20_000), 'a seat lists its duty');
  const f1 = await until(() => ev('Finalized')[0] ?? null, 90_000);
  assert.ok(f1, 'match 1 Finalized without its host');
  assert.equal(f1.status, 'final'); assert.equal(f1.finalHash, delta.resultHash);
  const finTx = chain.logs().find((l) => mb.decodeLog(l)?.event === 'Finalized' && mb.decodeLog(l).matchId === key);
  const hostDelegate = chain.addressOf(11).toLowerCase();
  const sender = (await chain.rpc('eth_getTransactionByHash', [finTx.transactionHash]))?.from?.toLowerCase();
  assert.notEqual(sender, hostDelegate, 'a seat, not the host, sent finalize');
  const f2 = await until(() => ev2('Finalized')[0] ?? null, 90_000);
  assert.ok(f2, 'match 2 expired without its host'); assert.equal(f2.status, 'void');

  // ---- afterwards: no duty lingers on any seat, the host still holds none it drives, and the duty file is clean
  assert.ok(await until(async () => { for (let i = 0; i < 3; i++) if ((await seatHealth(i)).seated !== 0) return false; return true; }, 30_000), 'every seat dropped both duties');
  for (const id of ids.slice(1)) { const p = join(id.dir, 'matchbook-duties.json'); if (existsSync(p)) assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), [], 'persisted duties are empty once final'); }
  // the host's file keeps nothing either: Finalized cleared its own hosted duty
  const hp = join(ids[0].dir, 'matchbook-duties.json');
  if (existsSync(hp)) assert.deepEqual(JSON.parse(readFileSync(hp, 'utf8')), []);
});
