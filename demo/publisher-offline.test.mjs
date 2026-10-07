/** M5 of the Agent Fighter MVP: the publisher can vanish. Five litnodes bonded from five operator wallets on a
 *  real NodeStake v3 and MatchBook (demo/lib/rpc-evm.mjs, eth_getLogs unavailable as on Liteforge), with a funded
 *  GasRefund. The publisher's node is the only one started with Agent Fighter's ruleset; the others fetch it by
 *  hash. Then the publisher's node STOPS, and with it gone:
 *
 *    a non-publisher node serves the arcade and the title's build → two players queue RANKED there → the mesh
 *    places the match on the operator node that runs Agent Fighter's per-match server, with a panel of three
 *    other operators → the host commits on chain before play → the title's own match server plays it with two
 *    headless players who each sign the head of their own log → the host settles on chain → the panel replays
 *    and attests from their own hot keys → final → XP and Elo, folded from the chain, move on every node → the
 *    treasury's GasRefund pays the host and the panel back, claimed by the nodes themselves.
 *
 *  No publisher node, server, key or signature takes part after the stop. Needs an Agent Fighter checkout
 *  (demo/lib/af-bot.mjs); skipped otherwise.
 *    node --test demo/publisher-offline.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { loadGauntletConfigs } from '../node/gauntlet.js';
import { generateKeypair } from '../protocol/keys.js';
import { roomCodeFor } from '../protocol/pairing.js';
import * as mb from '../protocol/matchbook.js';
import { createRpcEvm } from './lib/rpc-evm.mjs';
import { placeMatch, until } from './lib/mesh.mjs';
import { AF, haveAf, afGauntlet, claimSeat, runBot } from './lib/af-bot.mjs';

const ROOT = process.cwd();
const RULESET = join(ROOT, 'rulesets', 'agent-fighter.v1.js');
const RID = 'agent-fighter.v1';
const ONE = 10n ** 18n;
const get = async (url) => (await fetch(url)).json();

test('M5: with the publisher offline, a ranked Agent Fighter match is placed, played, settled, attested and final; progression moves; operators are refunded', { skip: !haveAf && `no Agent Fighter checkout with node_modules at ${AF}`, timeout: 420_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-m5-'));
  const chain = await createRpcEvm({ logsUnavailable: true });
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  t.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

  // ---- the chain: token, NodeStake v3, MatchBook with short windows, a funded GasRefund
  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const book = await chain.deploy('MatchBook.sol', 'MatchBook', [stake, { settleWindow: 120n, attestWindow: 4n, escalationWindow: 6n, drawDelay: 1n, hostSlashBps: 1000, witnessSlashBps: 500 }, chain.addressOf(0)]);
  await chain.send(0, stake, 'setAdjudicator', [book, true]);
  const refund = await chain.deploy('GasRefund.sol', 'GasRefund', [book, stake, { hostGas: 445_000n, witnessGas: 77_000n, claimGas: 260_000n, refundBps: 8000, maxPriceWei: 10n ** 10n, dailyCapWei: ONE }, chain.addressOf(0)]);
  await chain.fund(refund, ONE);

  // ---- five operators, five node keys: [0] the publisher, [1] the operator running Agent Fighter's match server, [2..4] witnesses
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const kp = await generateKeypair();
    const dir = join(tmp, `n${i}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(kp));
    writeFileSync(join(dir, 'announcer.json'), JSON.stringify({ privateKey: chain.keyOf(10 + i) }));
    await chain.send(i, token, 'faucet', []);
    await chain.send(i, token, 'approve', [stake, 10n * ONE]);
    await chain.send(i, stake, 'stake', ['0x' + kp.publicKey, ONE]);
    await chain.send(i, stake, 'setDelegate', ['0x' + kp.publicKey, chain.addressOf(10 + i)]);
    await chain.send(10 + i, book, 'enroll', ['0x' + kp.publicKey]);
    ids.push({ kp, dir });
  }
  chain.warp(2); // past eligibilityAge

  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, matchBook: book, gasRefund: refund, matchBookWindows: { attestWindow: 4, escalationWindow: 6 }, chainId: 4441, heartbeatMs: 200, updates: false, announce: false };
  const spawn = (opts) => createNode({ ...common, ...opts }).then((n) => (nodes.push(n), n));
  const publisher = await spawn({ dataDir: ids[0].dir, operator: 'publisher', roles: ['mesh', 'host', 'settler', 'witness'], rulesets: [RULESET] });
  const [cfg] = Object.values(loadGauntletConfigs(`${RID}=${join(ROOT, 'gauntlets', 'agent-fighter.json')}`, { root: ROOT }));
  const host = await spawn({ dataDir: ids[1].dir, operator: 'guild-a', roles: ['mesh', 'host', 'settler'], seeds: [publisher.addr], gauntlets: { [RID]: afGauntlet(cfg) }, gauntletPort: 0, relayPort: null });
  const witnesses = [];
  for (let i = 2; i < 5; i++) witnesses.push(await spawn({ dataDir: ids[i].dir, operator: `guild-${'bcd'[i - 2]}`, roles: ['mesh', 'witness'], seeds: [publisher.addr] }));
  const build = publisher.rulesets()[RID];
  assert.ok(build, 'the publisher runs the title');
  assert.ok(await until(() => [host, ...witnesses].every((n) => n.rulesets()[RID] === build), 60_000), 'every operator fetched the build by hash from the publisher');
  assert.ok(await until(async () => (await get(`${host.addr}/health`)).matchBook?.delegated === true, 20_000), 'the host\'s hot key is delegated');
  assert.ok(await until(async () => { const s = await get(`${host.addr}/snapshot`); return witnesses.every((w) => s.peers.some((p) => p.nodeId === w.nodeId)); }, 20_000), 'the host sees the three witnesses');

  // ---- the publisher goes offline
  await publisher.stop(); nodes.splice(nodes.indexOf(publisher), 1);
  assert.ok(await until(async () => !(await get(`${host.addr}/snapshot`)).peers.some((p) => p.nodeId === ids[0].kp.publicKey), 20_000), 'the publisher has dropped out of the mesh');
  assert.equal((await fetch(publisher.addr + '/health').catch(() => null))?.ok ?? false, false, 'nothing answers at the publisher\'s address');

  // ---- what a new player reaches instead: a non-publisher node serves the arcade and the title's build
  const front = witnesses[0];
  const page = await fetch(`${front.addr}/`);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type') ?? '', /text\/html/, 'the arcade from an operator\'s node');
  const rs = await fetch(`${front.addr}/ruleset/${RID}`);
  assert.equal(rs.status, 200); assert.equal(rs.headers.get('x-build-hash'), build, 'the same build, served by an operator');

  // ---- ranked: queue at an operator's node; placed on the node that runs the match server, panel of three
  const [p1, p2] = await Promise.all([generateKeypair(), generateKeypair()]);
  const d = await placeMatch(front.addr, [p1, p2], { rulesetId: RID, mode: 'ranked', timeoutMs: 60_000, fields: { tokenId: '1', region: 'lan' } });
  assert.equal(d.host, host.nodeId, 'hosted by the operator that runs Agent Fighter\'s match server');
  assert.deepEqual([...d.panel].sort(), witnesses.map((w) => w.nodeId).sort(), 'the panel is the three other operators');
  assert.ok(!d.panel.includes(ids[0].kp.publicKey) && d.host !== ids[0].kp.publicKey, 'the publisher is nowhere in it');
  assert.ok(await until(async () => (await get(`${host.addr}/match?playerId=${p1.publicKey}`)).matches.find((m) => m.matchId === d.matchId)?.commitTx, 30_000), 'the host committed before play');
  const id32 = mb.matchIdBytes32(d.matchId);
  const ev = (name) => chain.logs().map(mb.decodeLog).filter((e) => e?.event === name && e.matchId === id32);
  assert.equal(ev('Committed').length, 1);

  // ---- play: the title's own server for this match, two headless players, each signs its own log's head
  const room = roomCodeFor(d.matchId);
  assert.ok(await until(() => host.gauntlet.status().active.some((a) => a.matchId === d.matchId && a.state === 'up'), 90_000), `the match server is up: ${JSON.stringify(host.gauntlet.status())}`);
  const gw = `http://127.0.0.1:${host.gauntlet.port}`;
  const [s1, s2] = await Promise.all([claimSeat(gw, room, p1), claimSeat(gw, room, p2)]);
  const [r1, r2] = await Promise.all([
    runBot({ kp: p1, ws: s1.ws, ticket: s1.ticket, room, name: 'P1', char: 'analog', seed: 11, match: d }),
    runBot({ kp: p2, ws: s2.ws, ticket: s2.ticket, room, name: 'P2', char: 'vector', seed: 22, match: d }),
  ]);
  assert.equal(r1.reason, 'verified'); assert.equal(r2.reason, 'verified');
  assert.ok(r1.signedHead && r1.signedHead === r2.signedHead, 'both players signed the same head, each from its own log');

  // ---- settled by the host as the players', on chain; attested by the panel; final
  let delta = null;
  assert.ok(await until(async () => { const r = await fetch(`${host.addr}/delta/${d.matchId}`); if (r.ok) delta = await r.json(); return !!delta?.matchId; }, 60_000), 'settled on the host');
  assert.equal(delta.attestation, 'players'); assert.equal(delta.mode, 'ranked'); assert.equal(delta.complete, true);
  assert.ok(await until(() => ev('Settled').length === 1, 60_000), 'Settled on chain');
  assert.equal(ev('Settled')[0].resultHash, delta.resultHash);
  const attests = await until(() => { const xs = ev('Attested'); return xs.length >= 3 ? xs : null; }, 90_000);
  assert.ok(attests, 'three attests');
  assert.ok(attests.every((x) => x.agrees), 'every panel node replayed it to the same result');
  const fin = await until(() => ev('Finalized')[0], 60_000);
  assert.ok(fin, 'Finalized'); assert.equal(fin.status, 'final'); assert.equal(fin.finalHash, delta.resultHash);

  // ---- progression from the chain, the same on every node: winner +60 XP, loser +20
  const prog = (n, kp) => get(`${n.addr}/progress?ruleset=${RID}&player=${kp.publicKey}`);
  const views = await until(async () => {
    const out = [];
    for (const n of [host, ...witnesses]) { const [a, b] = await Promise.all([prog(n, p1), prog(n, p2)]); if (a.matches !== 1 || b.matches !== 1) return null; out.push([a, b]); }
    return out;
  }, 60_000);
  assert.ok(views, 'every remaining node counts the match');
  for (const [a, b] of views) {
    assert.equal(a.source, 'chain', 'folded from the chain, not from the host\'s files'); assert.equal(a.scope, 'official');
    assert.deepEqual([a.xpTotal, b.xpTotal].sort((x, y) => x - y), [20, 60]);
    assert.deepEqual([a.wins + b.wins, a.losses + b.losses], [1, 1]);
  }
  assert.equal(new Set(views.map(([a]) => a.rating)).size, 1, 'one rating for the player on every node');
  const boards = await Promise.all([host, ...witnesses].map((n) => get(`${n.addr}/progress?ruleset=${RID}`)));
  assert.equal(new Set(boards.map((b) => b.digest)).size, 1, 'one progression digest on all four nodes');

  // ---- the treasury pays the gas back: the host and the three agreeing seats, claimed by the nodes
  const REFUNDED = ethers.id('Refunded(bytes32,bytes32,address,uint8,uint256)');
  const refunded = await until(() => { const xs = chain.logs().filter((l) => l.address.toLowerCase() === refund.toLowerCase() && l.topics[0] === REFUNDED && l.topics[1] === '0x' + id32.replace(/^0x/, '')); return xs.length >= 4 ? xs : null; }, 60_000);
  assert.ok(refunded, 'four refunds');
  assert.deepEqual(refunded.map((l) => l.topics[2].toLowerCase()).sort(), [host.nodeId, ...d.panel].map((k) => '0x' + k).sort());
});
