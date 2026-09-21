/** Phase 2, end to end, on the in-process chain: five litnodes bonded on a
 *  real NodeStake v3 with delegated keys, a real MatchBook they are enrolled
 *  in, and the RPC they talk to answered by demo/lib/rpc-evm.mjs. Two
 *  players queue, the mesh places the match, the drawn host COMMITS on chain
 *  before play (panel of three, stake-weighted, on chain), the players play
 *  and sign, the host SETTLES on chain, the three panel nodes read the log,
 *  fetch the ledger, replay and ATTEST from their own delegates, the host
 *  FINALIZES, and every node — host or witness — answers /leaderboard with
 *  the same digest folded from the chain, not from its own files. Gossip
 *  carries no delta advertisements.
 *    node --test demo/matchbook-node.test.mjs */
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

test('phase 2: commit → settle → three attests → final on the chain, and every node folds the same ladder from the log', { timeout: 180_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-matchbook-'));
  // eth_getLogs is UNAVAILABLE, as on Liteforge's public gateway: every event below must reach the nodes through receipts and gossip hints
  const chain = await createRpcEvm({ logsUnavailable: true });
  const ticker = setInterval(() => chain.mine(), 250); // Liteforge makes blocks on demand; the beacon needs them to flow
  const nodes = [];
  t.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

  // ---- the chain: token, NodeStake v3 (eligible after 1 s), MatchBook with short windows, adjudicator wired
  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const params = { settleWindow: 60n, attestWindow: 4n, escalationWindow: 6n, drawDelay: 1n, hostSlashBps: 1000, witnessSlashBps: 500 };
  const book = await chain.deploy('MatchBook.sol', 'MatchBook', [stake, params, chain.addressOf(0)]);
  await chain.send(0, stake, 'setAdjudicator', [book, true]);
  const anchor = await chain.deploy('EpochAnchor.sol', 'EpochAnchor', [stake, 1400, chain.addressOf(0)]); // 14 % of stake: the host's 1 of 7 tokens (one witness bonds 3) is just enough

  // ---- five identities, bonded from five operator wallets, each with a delegated + funded hot key (its announcer key)
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const kp = await generateKeypair();
    const dir = join(tmp, `n${i}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(kp));
    writeFileSync(join(dir, 'announcer.json'), JSON.stringify({ privateKey: chain.keyOf(10 + i) })); // the delegate = a funded harness account
    await chain.send(i, token, 'faucet', []);
    await chain.send(i, token, 'approve', [stake, 10n * ONE]);
    await chain.send(i, stake, 'stake', ['0x' + kp.publicKey, (i === 2 ? 3n : 1n) * ONE]);
    await chain.send(i, stake, 'setDelegate', ['0x' + kp.publicKey, chain.addressOf(10 + i)]);
    if (i !== 5) await chain.send(10 + i, book, 'enroll', ['0x' + kp.publicKey]); // node 5 enrols ITSELF once it sees its delegation
    ids.push({ kp, dir });
  }
  chain.warp(2); // past eligibilityAge

  // ---- five nodes: one host/settler with the title, four witnesses that fetch it by hash
  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, matchBook: book, epochAnchor: anchor, matchBookWindows: { attestWindow: 4, escalationWindow: 6 }, chainId: 4441, heartbeatMs: 200, updates: false, announce: false };
  const spawn = (opts) => createNode({ ...common, ...opts }).then((n) => (nodes.push(n), n));
  const host = await spawn({ dataDir: ids[0].dir, operator: 'op1', roles: ['mesh', 'host', 'settler', 'witness'], rulesets: [RULESET] });
  const witnesses = [];
  for (let i = 1; i < 5; i++) witnesses.push(await spawn({ dataDir: ids[i].dir, operator: `op${i + 1}`, roles: ['mesh', 'witness'], seeds: [host.addr] }));
  assert.ok(await until(() => witnesses.every((w) => w.rulesets()['tug.v1'] === manifest.buildHash), 30_000), 'every witness holds the build');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/health`)).json()).matchBook?.delegated === true, 20_000), 'the host knows its delegate is accepted');
  assert.ok(await until(async () => (await chain.read(book, 'pool', []))[0].map((k) => k.toLowerCase()).includes('0x' + ids[4].kp.publicKey), 20_000), 'a delegated, funded witness enrols itself in the pool');
  assert.equal((await (await fetch(`${witnesses[3].addr}/health`)).json()).matchBook.enrolled, true);

  // ---- place: two players queue at the host; the drawn host commits BEFORE play
  const [a, b] = [await generateKeypair(), await generateKeypair()];
  const d = await placeMatch(host.addr, [a, b], { rulesetId: 'tug.v1', mode: 'ranked', timeoutMs: 40_000 });
  assert.equal(d.host, host.nodeId, 'the only host-role node hosts');
  assert.equal(d.panel.length, 3, 'a panel of three');
  assert.ok(d.panel.every((k) => witnesses.some((w) => w.nodeId === k)), 'seats are witness nodes');
  const placed = await until(async () => { const { matches } = await (await fetch(`${host.addr}/match?playerId=${a.publicKey}`)).json(); const m = matches.find((x) => x.matchId === d.matchId); return m?.commitTx ? m : null; }, 30_000);
  assert.ok(placed, 'commit transaction sent');
  const committed = chain.logs().map(mb.decodeLog).find((e) => e?.event === 'Committed' && e.matchId === mb.matchIdBytes32(d.matchId));
  assert.ok(committed, 'Committed on chain');
  assert.deepEqual(committed.panel, d.panel, 'the panel on chain is the panel the mesh drew');
  assert.equal(committed.hostKey, host.nodeId);
  const onChain = await until(async () => { const j = await (await fetch(`${host.addr}/match/${d.matchId}/chain`)).json(); return j.status === 'committed' ? j : null; }, 15_000);
  assert.ok(onChain, 'the host read its own commit back from the log');
  assert.deepEqual(onChain.panel, d.panel);

  // ---- play from the placement's seed, both sign, settle on the host
  const P = d.participants;
  const rec = createRecorder({ matchId: d.matchId, participants: P, rulesetId: 'tug.v1', buildHash: manifest.buildHash, mode: 'ranked' });
  const sim = createSim(title, { seed: matchSeed(d), participants: P, ctx: { agents: externalAgents(P) } });
  while (!sim.done() && sim.tick < 3000) { const inputs = { [P[0]]: 1, [P[1]]: sim.tick % 3 ? 2 : 0 }; sim.step(inputs); rec.record(inputs); }
  assert.ok(sim.done(), 'the match ended');
  const signers = { [a.publicKey]: await localSigner(a), [b.publicKey]: await localSigner(b) };
  const delta = await settle({ nodeUrl: host.addr, recorder: rec, signers, hydration: { agents: externalAgents(P) } });
  assert.equal(delta.attestation, 'players'); assert.equal(delta.placed, true);

  // ---- the chain: Settled by the host, then three Attested from the panel's own delegates, then Finalized
  const settledEv = await until(() => chain.logs().map(mb.decodeLog).find((e) => e?.event === 'Settled' && e.matchId === mb.matchIdBytes32(d.matchId)), 30_000);
  assert.ok(settledEv, 'Settled on chain');
  assert.equal(settledEv.resultHash, delta.resultHash, 'the chain carries the result commitment');
  const served = await (await fetch(`${host.addr}/ledger/${d.matchId}`)).json();
  assert.equal(settledEv.ledgerHash, mb.ledgerHash(served), 'ledgerHash = sha256 of the ledger the host serves');
  assert.deepEqual(settledEv.participants, P);
  const attests = await until(() => { const xs = chain.logs().map(mb.decodeLog).filter((e) => e?.event === 'Attested' && e.matchId === mb.matchIdBytes32(d.matchId)); return xs.length >= 3 ? xs : null; }, 60_000);
  assert.ok(attests, 'three attests');
  assert.ok(attests.every((x) => x.agrees), 'every panel node replayed to the same hash');
  assert.deepEqual(attests.map((x) => x.witnessKey).sort(), [...d.panel].sort(), 'exactly the panel attested');
  const fin = await until(() => chain.logs().map(mb.decodeLog).find((e) => e?.event === 'Finalized' && e.matchId === mb.matchIdBytes32(d.matchId)), 60_000);
  assert.ok(fin, 'Finalized'); assert.equal(fin.status, 'final'); assert.equal(fin.finalHash, delta.resultHash);

  // ---- the ladder: folded from the chain on every node, same digest; the loser is not on the pending-only view once final
  const boards = await until(async () => { const out = []; for (const n of [host, ...witnesses]) { const j = await (await fetch(`${n.addr}/leaderboard?ruleset=tug.v1`)).json(); if (j.source !== 'chain' || !j.leaderboard?.length) return null; out.push(j); } return new Set(out.map((x) => x.digest)).size === 1 ? out : null; }, 30_000);
  assert.ok(boards, 'every node serves a chain ladder');
  assert.equal(new Set(boards.map((x) => x.digest)).size, 1, 'one digest on all five nodes');
  assert.equal(boards[0].scope, 'official'); assert.equal(boards[0].counts.official, 1);
  const winner = Object.entries(delta.scores).sort((x, y) => y[1] - x[1])[0][0];
  assert.equal(boards[0].leaderboard[0].player, winner);
  // gossip carries no delta advertisements now that the chain is the index
  const g = await (await fetch(`${host.addr}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.deepEqual(g.deltas, []);
  const h = await (await fetch(`${host.addr}/health`)).json();
  assert.equal(h.matchBook.hosting, 0, 'nothing left to drive once final'); assert.ok(h.matchBook.sends >= 3, `host sent commit, settle, finalize (${h.matchBook.sends})`);
  assert.equal(chain.logs().map(mb.decodeLog).filter((e) => e?.event === 'Committed').length, 1, 'ONE commit for one match: placed players are not paired again while their placement lives');
  assert.match(h.matchBook.scanError ?? '', /timed out/, 'the log scan is failing, as on Liteforge, and says so');
  assert.ok(h.matchBook.receipts >= 3, `the host read its own transactions back from receipts (${h.matchBook.receipts})`);
  const wr = (await (await fetch(`${witnesses[0].addr}/health`)).json()).matchBook;
  assert.ok(wr.receipts >= 2, `a witness learned commit + settle from hinted receipts (${wr.receipts})`);
  const wh = await (await fetch(`${witnesses[0].addr}/health`)).json();
  assert.equal(wh.matchBook.delegated, true);
  // the local record agrees with the chain: one answer on the screen (the v0.2 flag read official:false for a chain-final match)
  const ld = (await (await fetch(`${host.addr}/deltas?scope=all`)).json()).deltas.find((x) => x.matchId === d.matchId);
  assert.equal(ld.chain, 'final'); assert.equal(ld.official, true); assert.equal(ld.verification, 'verified');
  const fl = await (await fetch(`${host.addr}/fleet`)).json();
  const room = fl.rooms.find((r) => r.matchId === d.matchId);
  assert.ok(room, 'the match is a room on /fleet while its placement lives');
  assert.equal(room.state, 'final'); assert.equal(room.ours, true); assert.equal(room.attests, 3); assert.equal(room.room, `LIT-${d.matchId}`);
  assert.equal(fl.recent.at(-1).matchId, mb.matchIdBytes32(d.matchId), 'the final is the newest on the recent strip');
  assert.equal(fl.chain.matchBook.purse.txType, 2, 'the host signed type-2 transactions');
  assert.ok(Number(fl.chain.matchBook.purse.balance) > 0 && fl.chain.matchBook.purse.matchesLeft > 0, 'the purse is read');

  // ---- the hour's root over the chain-finalized set: the same tree on a witness as on the host; the settler proposes it and it finalizes by stake
  const ep = await until(async () => { const e = await (await fetch(`${host.addr}/epoch`)).json(); return e.count >= 1 ? e : null; }, 20_000);
  assert.ok(ep, 'the host sees the finalized match in this hour'); assert.equal(ep.source, 'chain');
  const epW = await until(async () => { const e = await (await fetch(`${witnesses[1].addr}/epoch?epoch=${ep.epoch}`)).json(); return e.count >= 1 ? e : null; }, 20_000);
  assert.equal(epW.root, ep.root, 'a witness computes the same root from the same log');
  const proof = await (await fetch(`${host.addr}/proof/${d.matchId}`)).json();
  assert.equal(proof.root, ep.root); assert.equal(proof.status, 'final');
  const tx = await host.matchBook.propose(ep.epoch, { force: true }); // the hour has not frozen yet; the settler would wait
  assert.ok(tx, 'proposed from the delegate');
  const finalEv = await until(() => chain.logs().find((l) => l.address.toLowerCase() === anchor && l.topics[0] === chain.iface(anchor).getEvent('EpochFinalized').topicHash), 10_000);
  assert.ok(finalEv, 'the root finalized: one node holds more than quorumBps of the stake');
  const rootOnChain = (await chain.read(anchor, 'rootOf', [ep.epoch]))[0];
  assert.equal(rootOnChain.toLowerCase(), '0x' + ep.root);
  const ok = (await chain.read(anchor, 'verifyInclusion', [ep.epoch, '0x' + proof.leaf, proof.path.map((p) => '0x' + p.hash), proof.path.map((p) => p.left)]))[0];
  assert.equal(ok, true, 'the node\'s proof verifies against the root on chain');

  // ---- a restart keeps the ladder: the events are on disk, not only the cursor (the first final match vanished from every node when all four restarted for 0.11.10)
  const w3 = witnesses[3]; await w3.stop(); nodes.splice(nodes.indexOf(w3), 1);
  const again = await spawn({ dataDir: ids[4].dir, operator: 'op5', roles: ['mesh', 'witness'], seeds: [] }); // no peers: no hints; no scan (logs unavailable) — what it knows, it read from disk
  const cs = again.matchBook.chainStatus(d.matchId);
  assert.equal(cs.status, 'final', 'the match is final on the restarted node');
  assert.equal(cs.events.map((e) => e.event).sort().join(','), 'Attested,Attested,Attested,Committed,Finalized,Settled', 'every event it saw before is back');
  const full = (await (await fetch(`${host.addr}/snapshot`)).json()).manifests['tug.v1']; // the conformance manifest (services), as the node folds with
  const lb = again.matchBook.ladder('tug.v1', full);
  assert.equal(lb.counts.official, 1, 'the final match is still on the ladder');
  assert.equal(lb.digest, boards[0].digest, 'the same digest as before the restart');
  assert.equal((await (await fetch(`${again.addr}/health`)).json()).matchBook.seated, 0, 'no duty outstanding for a final match');
});
