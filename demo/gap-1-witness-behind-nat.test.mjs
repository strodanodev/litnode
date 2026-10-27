/** Gap 1 (handoff/mesh-gaps/REPORT.md): the cheapest node that counts toward ranked quorum.
 *
 *  A witness-only node needs no inbound reachability and no tunnel. Here the three panel nodes advertise an
 *  address nobody can open (what a laptop behind NAT or CGNAT advertises), and seed only from the host. They
 *  still learn the placement, the Committed/Settled hints and the build from the REPLIES to their own gossip
 *  pushes (node/litnode.js POST /gossip answers with everything it pushes), fetch the ledger outbound from the
 *  host, and attest from their own hot keys over RPC. The match goes Final.
 *
 *  This is today's behaviour and the desired one: the test pins it so a change that starts requiring inbound
 *  reachability of a witness fails here.
 *    node --test demo/gap-1-witness-behind-nat.test.mjs */
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
const NOWHERE = 'http://127.0.0.1:9'; // refuses every connection: the address a NAT'd witness advertises, as far as anyone else can tell

test('gap 1: three witnesses nobody can reach inbound still seat, attest and finalize a ranked match', { timeout: 240_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-gap1-'));
  const chain = await createRpcEvm({ logsUnavailable: true }); // as on Liteforge: the seats learn of events from receipts the host hints
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  t.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const params = { settleWindow: 120n, attestWindow: 30n, escalationWindow: 30n, drawDelay: 1n, hostSlashBps: 1000, witnessSlashBps: 500 };
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

  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, matchBook: book, matchBookWindows: { attestWindow: 30, escalationWindow: 30 }, chainId: 4441, heartbeatMs: 200, updates: false, announce: false };
  const spawn = (opts) => createNode({ ...common, ...opts }).then((n) => (nodes.push(n), n));
  const host = await spawn({ dataDir: ids[0].dir, operator: 'op1', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET] });
  const seats = [];
  for (let i = 1; i < 4; i++) seats.push(await spawn({ dataDir: ids[i].dir, operator: `op${i + 1}`, roles: ['mesh', 'witness'], seeds: [host.addr], publicAddr: NOWHERE }));
  assert.equal((await fetch(`${NOWHERE}/health`).catch(() => null))?.ok ?? false, false, 'nothing answers at the address the witnesses advertise');
  assert.ok(await until(() => seats.every((w) => w.rulesets()['tug.v1'] === manifest.buildHash), 30_000), 'each witness fetched the build outbound');
  assert.ok(await until(async () => { const s = await (await fetch(`${host.addr}/snapshot`)).json(); return seats.every((w) => s.peers.some((p) => p.nodeId === w.nodeId)); }, 20_000), 'the host counts all three as fresh peers');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/health`)).json()).matchBook?.delegated === true, 20_000));

  const [a, b] = [await generateKeypair(), await generateKeypair()];
  const d = await placeMatch(host.addr, [a, b], { rulesetId: 'tug.v1', mode: 'ranked', timeoutMs: 40_000 });
  assert.deepEqual([...d.panel].sort(), seats.map((s) => s.nodeId).sort(), 'the three unreachable witnesses are the panel');
  const key = mb.matchIdBytes32(d.matchId);
  const ev = (name) => chain.logs().map(mb.decodeLog).filter((e) => e?.event === name && e.matchId === key);
  assert.ok(await until(() => ev('Committed').length === 1, 30_000), 'committed');
  const P = d.participants;
  const rec = createRecorder({ matchId: d.matchId, participants: P, rulesetId: 'tug.v1', buildHash: manifest.buildHash, mode: 'ranked' });
  const sim = createSim(title, { seed: matchSeed(d), participants: P, ctx: { agents: externalAgents(P) } });
  while (!sim.done() && sim.tick < 3000) { const inputs = { [P[0]]: 1, [P[1]]: sim.tick % 3 ? 2 : 0 }; sim.step(inputs); rec.record(inputs); }
  const delta = await settle({ nodeUrl: host.addr, recorder: rec, signers: { [a.publicKey]: await localSigner(a), [b.publicKey]: await localSigner(b) }, hydration: { agents: externalAgents(P) } });
  assert.ok(await until(() => ev('Settled').length === 1, 30_000), 'settled');
  assert.ok(await until(() => ev('Attested').length === 3, 60_000), 'all three NAT\'d witnesses attested from their own keys');
  assert.ok(ev('Attested').every((x) => x.agrees));
  const fin = await until(() => ev('Finalized')[0] ?? null, 60_000);
  assert.ok(fin); assert.equal(fin.status, 'final'); assert.equal(fin.finalHash, delta.resultHash);
});
