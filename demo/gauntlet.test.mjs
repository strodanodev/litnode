/** Gauntlet loops (node/gauntlet.js): the node runs a title's headless
 *  match server for each match it hosts. Tickets and seats are what Pickle
 *  Brawl's court verifies; the gateway serves tickets and proxies WebSocket
 *  rooms on one port; a placement on this node starts the process, the
 *  match's settlement ends it, so does its TTL; unknown rooms go upstream;
 *  a process that crashes or never listens is reported, not hidden.
 *    node --test demo/gauntlet.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createNode } from '../node/litnode.js';
import { mintTicket, verifyTicket, seatsFor, loadGauntletConfigs, createGauntlets } from '../node/gauntlet.js';
import { generateKeypair, seal } from '../protocol/keys.js';
import { QUEUE_TAG, bucketOf, roomCodeFor } from '../protocol/pairing.js';

const ROOT = process.cwd();
const PB = join(ROOT, 'rulesets', 'pickle-brawl.v1.js');
const FAKE = join(ROOT, 'demo', 'fixtures', 'fake-court.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (m) => process.env.GAUNTLET_TEST_TRACE && console.log(`[trace ${new Date().toISOString().slice(11, 19)}] ${m}`);
const until = async (pred, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(100); } return false; };

/** A WebSocket client on Node's global WebSocket: connect, exchange text, collect messages. */
const wsClient = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url); const got = [];
  setTimeout(() => rej(new Error(`ws ${url}: no open within 10 s`)), 10_000).unref?.();
  ws.onopen = () => res({ ws, got, send: (t) => ws.send(t), next: (pred = () => true, ms = 10_000) => until(() => got.some(pred), ms).then((ok) => ok ? got.find(pred) : null) });
  ws.onmessage = (e) => got.push(String(e.data));
  ws.onerror = () => rej(new Error(`ws ${url} failed`));
});

test('gauntlet: tickets verify like Pickle Brawl\'s gate; seats follow placement order; configs load', () => {
  const t = mintTicket({ sub: 'a', matchId: 'm', team: 1, slot: 0, mode: 'singles', exp: 9e12 }, 's3cret');
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(verifyTicket(t, 's3cret').team, 1);
  assert.equal(verifyTicket(t, 'other'), null);
  assert.equal(verifyTicket(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), 's3cret'), null);
  assert.deepEqual(seatsFor(['p', 'q']), { mode: 'singles', seats: [{ sub: 'p', team: 0, slot: 0 }, { sub: 'q', team: 1, slot: 0 }] });
  assert.deepEqual(seatsFor(['p', 'q', 'r', 's']).seats.map((s) => `${s.team}${s.slot}`), ['00', '01', '10', '11']);
  const dir = mkdtempSync(join(tmpdir(), 'litg-'));
  writeFileSync(join(dir, 'pb.json'), JSON.stringify({ command: 'node', args: ['x.mjs'], env: { PORT: '${port}' } }));
  const cfgs = loadGauntletConfigs(`pickle-brawl.v1=${join(dir, 'pb.json')}`, { root: dir });
  assert.equal(cfgs['pickle-brawl.v1'].command, 'node'); assert.deepEqual(cfgs['pickle-brawl.v1'].portRange, [7777, 7787]);
  assert.throws(() => loadGauntletConfigs('nope', { root: dir }), /expected <rulesetId>=<path>/);
  assert.throws(() => loadGauntletConfigs(`x.v1=${join(dir, 'missing.json')}`, { root: dir }), /not found/);
  assert.deepEqual(loadGauntletConfigs('', { root: dir }), {});
  rmSync(dir, { recursive: true, force: true });
});

test('gauntlet: placement on this node spawns the court; players fetch tickets and join through the gateway; the court\'s report settles the match and ends the process; unknown rooms go upstream', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litg-'));
  const court = await generateKeypair();
  writeFileSync(join(tmp, 'court.json'), JSON.stringify(court));
  // An "upstream" relay: a trivial WebSocket echo, standing in for a title's own relay on this machine.
  const up = createServer((_, res) => res.end('up'));
  const upSockets = new Set();
  up.on('upgrade', (req, socket) => { upSockets.add(socket); socket.on('close', () => upSockets.delete(socket)); const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); socket.on('data', (d) => { const len = d[1] & 127; const mask = d.subarray(2, 6); const data = Buffer.from(d.subarray(6, 6 + len)); for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; const out = Buffer.from(`upstream:${data}`); socket.write(Buffer.concat([Buffer.from([0x81, out.length]), out])); }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cfg = { command: process.execPath, args: [FAKE], cwd: ROOT, env: { PORT: '${port}', COURT_TICKET_SECRET: '${secret}', COURT_PUBLIC_URL: '${publicUrl}', LITNODE_SEATS: '${seats}', LITNODE_URL: '${nodeUrl}', COURT_IDENTITY: join(tmp, 'court.json') }, portRange: [7890, 7899], readyMs: 20_000, ttlMs: 60_000, ticketTtlMs: 60_000 };
  const host = await createNode({ dataDir: join(tmp, 'host'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'host', 'witness', 'settler'], rulesets: [PB], courts: { 'pickle-brawl.v1': [court.publicKey] }, gauntlets: { 'pickle-brawl.v1': cfg }, gauntletUpstream: `ws://127.0.0.1:${up.address().port}`, relayPort: null });
  const events = [];
  t.after(async () => { mark('after: stopping host'); await host.stop(); mark('after: host stopped'); for (const s of upSockets) s.destroy(); up.closeAllConnections?.(); await new Promise((r) => up.close(r)); mark('after: upstream closed'); rmSync(tmp, { recursive: true, force: true }); });
  const gw = host.gauntlet.port;
  assert.ok(gw > 0, 'gateway listening');
  const h = await (await fetch(`${host.addr}/health`)).json();
  assert.deepEqual(h.gauntlet.titles, ['pickle-brawl.v1']); assert.equal(h.gauntlet.port, gw);

  // A real placement: two players queue on this (only) node; the pair closes, the host is this node.
  const [p1, p2] = await Promise.all([generateKeypair(), generateKeypair()]);
  // One bucket for both: two entries that straddle a 2 s bucket boundary never pair.
  const bucket = bucketOf(Date.now());
  const enqueue = async (kp) => { const env = await seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: 'pickle-brawl.v1', tokenId: '1', mode: 'casual', bucket, region: 'lan' }, kp); const r = await fetch(`${host.addr}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) }); assert.ok(r.status === 200 || r.status === 202, `queue: ${r.status}`); };
  await enqueue(p1); await enqueue(p2);
  let match = null;
  assert.ok(await until(async () => { const r = await (await fetch(`${host.addr}/match?playerId=${p1.publicKey}`)).json(); match = r.matches?.[0] ?? null; return !!match; }, 40_000), 'placed');
  assert.equal(match.host, host.nodeId);
  const room = roomCodeFor(match.matchId);
  assert.ok(await until(() => host.gauntlet.status().active.some((a) => a.matchId === match.matchId && a.state === 'up'), 30_000), `court up: ${JSON.stringify(host.gauntlet.status())}`);
  const st = host.gauntlet.status().active[0];
  assert.equal(st.room, room); assert.equal(st.mode, 'singles'); assert.equal(st.seats, 2);

  mark('tickets');
  // Tickets: one per placed player, from the gateway, by room.
  const gwUrl = `http://127.0.0.1:${gw}`;
  const t1 = await (await fetch(`${gwUrl}/${room}/ticket?player=${p1.publicKey}`)).json();
  const t2 = await (await fetch(`${gwUrl}/${room}/ticket?player=${p2.publicKey}`)).json();
  // Seats follow the PLACEMENT's participant order, not who queued first.
  const teamOf = (kp) => match.participants.indexOf(kp.publicKey);
  assert.equal(t1.team, teamOf(p1)); assert.equal(t2.team, teamOf(p2)); assert.notEqual(t1.team, t2.team); assert.equal(t1.mode, 'singles'); assert.equal(t1.matchId, match.matchId);
  assert.equal(t1.ws, `ws://127.0.0.1:${gw}/${room}`, 'no relay tunnel in the test: the gateway names itself');
  assert.equal((await fetch(`${gwUrl}/${room}/ticket?player=${'ab'.repeat(32)}`)).status, 403, 'not a placed player');
  assert.equal((await fetch(`${gwUrl}/LIT-${'0'.repeat(32)}/ticket?player=x`)).status, 404, 'no such room');
  const claims = verifyTicket(t1.ticket, host.gauntlet.active.get(match.matchId).secret);
  assert.equal(claims.sub, p1.publicKey);

  mark('join');
  // Join through the gateway: the court verifies the tickets it was given the secret for.
  const c1 = await wsClient(t1.ws);
  c1.send(JSON.stringify({ ticket: t1.ticket }));
  assert.equal(await c1.next((m) => m.startsWith('seated:')), `seated:${p1.publicKey}:${t1.team}:0:singles`);
  const c2 = await wsClient(t2.ws);
  c2.send(JSON.stringify({ ticket: 'forged.ticket' }));
  assert.equal(await c2.next((m) => m.startsWith('refused:')), 'refused:bad_ticket');
  const c2b = await wsClient(t2.ws);
  c2b.send(JSON.stringify({ ticket: t2.ticket }));
  assert.equal(await c2b.next((m) => m.startsWith('seated:')), `seated:${p2.publicKey}:${t2.team}:0:singles`);
  c1.send('hello'); assert.equal(await c2b.next((m) => m === 'echo:hello'), 'echo:hello', 'traffic crosses the proxy both ways');

  mark('upstream');
  // Unknown room → upstream relay.
  const cu = await wsClient(`ws://127.0.0.1:${gw}/some/other/path`);
  cu.send('ping'); assert.equal(await cu.next((m) => m.startsWith('upstream:')), 'upstream:ping');

  mark('end');
  // The court ends the match: it signs the outcome and posts it to the node over loopback.
  c1.send('end:11-6');
  mark('sent end');
  assert.equal(await c1.next((m) => m.startsWith('settled:')), 'settled:200:attested');
  mark('got settled msg');
  const delta = await (await fetch(`${host.addr}/delta/${match.matchId}`, { signal: AbortSignal.timeout(10_000) })).json();
  mark('got delta');
  assert.equal(delta.attestation, 'attested'); assert.equal(delta.attestor, court.publicKey);
  assert.equal(delta.placed, true, 'the court reported the mesh match id and the placed keys, so the delta binds to the placement');
  assert.deepEqual(delta.participants, match.participants);
  assert.equal(delta.scores[match.participants[0]], 11, 'team A (the first placed participant) scored 11');
  assert.ok(await until(() => !host.gauntlet.status().active.length, 10_000), 'the process is gone once the match settled');
  mark('process gone');
  assert.equal((await fetch(`${gwUrl}/${room}`)).status, 404, 'the room is gone with it');
  mark('room gone');
  for (const c of [c1, c2b, cu]) c.ws.close();
  mark('done');
});

test('gauntlet: a crashing court and one that never listens are reported as failed; TTL ends a court nobody finished; stopAll ends everything', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litg-'));
  const base = { command: process.execPath, args: [FAKE], cwd: ROOT, env: { PORT: '${port}', COURT_TICKET_SECRET: '${secret}', LITNODE_SEATS: '${seats}' }, portRange: [7890, 7899], readyMs: 3000, ttlMs: 1500, ticketTtlMs: 60_000 };
  const g = createGauntlets({ configs: { 'crash.v1': { ...base, env: { ...base.env, FAKE_COURT_CRASH: '1' } }, 'slow.v1': { ...base, env: { ...base.env, FAKE_COURT_SLOW_MS: '10000' } }, 'ok.v1': base }, port: 0, nodeUrl: 'http://127.0.0.1:1', log: () => {} });
  await g.listen();
  t.after(async () => { await g.stopAll(); rmSync(tmp, { recursive: true, force: true }); });
  const crashed = await g.start({ matchId: 'c'.repeat(64), rulesetId: 'crash.v1', participants: ['a', 'b'] });
  assert.equal(crashed.state, 'failed'); assert.match(crashed.lastError, /ended before listening/);
  const slow = await g.start({ matchId: 's'.repeat(64), rulesetId: 'slow.v1', participants: ['a', 'b'] });
  assert.equal(slow.state, 'failed'); assert.match(slow.lastError, /not listening/);
  const ok = await g.start({ matchId: 'd'.repeat(64), rulesetId: 'ok.v1', participants: ['a', 'b', 'c', 'd'] });
  assert.equal(ok.state, 'up'); assert.equal(ok.mode, 'doubles');
  assert.equal(await g.start({ matchId: 'd'.repeat(64), rulesetId: 'ok.v1', participants: ['a', 'b'] }), ok, 'idempotent per match');
  assert.ok(await until(() => !g.status().active.some((a) => a.matchId === 'd'.repeat(64)), 10_000), 'TTL ended it');
  assert.equal(g.start({ matchId: 'x', rulesetId: 'unknown.v1', participants: [] }) instanceof Promise, true);
  assert.equal(await g.start({ matchId: 'x', rulesetId: 'unknown.v1', participants: [] }), null, 'no config: nothing to run');
});

test('gauntlet: with no upstream relay the gateway answers the node\'s root WebSocket probe itself, so a node hosting only gauntlet titles still gets a verified wsAddr', async (t) => {
  const g = createGauntlets({ configs: {}, port: 0, nodeUrl: 'http://127.0.0.1:1' });
  await g.listen();
  t.after(() => g.stopAll());
  const opened = await new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${g.port}`); const to = setTimeout(() => res(false), 5000); ws.onopen = () => { clearTimeout(to); res(true); }; ws.onerror = () => { clearTimeout(to); res(false); }; });
  assert.equal(opened, true, 'the relay verification (a WebSocket at the root) succeeds');
  const room = await new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${g.port}/LIT-${'0'.repeat(32)}`); ws.onopen = () => res('open'); ws.onerror = () => res('refused'); });
  assert.equal(room, 'refused', 'an unknown room is still refused');
});

test('placement: for a gauntlet title the nodes that run its court come first, outranking relay and seed order; other titles are untouched', async () => {
  const { placement } = await import('../protocol/placement.js');
  const manifest = { buildHash: 'b'.repeat(64), standingFloor: 0 };
  const node = (id, extra = {}) => ({ nodeId: id.repeat(64), operator: `op-${id}`, roles: ['mesh', 'host', 'witness'], region: 'x', standing: 1, buildHashes: { 'pickle-brawl.v1': manifest.buildHash, 'tug.v1': manifest.buildHash }, ...extra });
  const nodes = [node('a', { wsAddr: 'wss://a' }), node('b', { wsAddr: 'wss://b' }), node('c', { wsAddr: 'wss://c', gauntlets: ['pickle-brawl.v1'] }), node('d')];
  for (let i = 0; i < 40; i++) {
    const p = placement({ nodes, manifest, rulesetId: 'pickle-brawl.v1', matchId: `m${i}`, beacon: `beacon${i}` });
    assert.equal(p.host.nodeId, 'c'.repeat(64), 'the only node that runs the court hosts every draw');
  }
  const hostsTug = new Set(Array.from({ length: 40 }, (_, i) => placement({ nodes, manifest, rulesetId: 'tug.v1', matchId: `m${i}`, beacon: `beacon${i}` }).host.nodeId[0]));
  assert.ok(hostsTug.size > 1 && !hostsTug.has('d'), `a title nobody runs as a gauntlet keeps the seeded, relay-first draw: ${[...hostsTug]}`);
});

test('gauntlet: GAUNTLET_GATEWAY_PORT puts the gateway on its own port, sends unknown rooms to the title relay on RELAY_PORT, and the heartbeat advertises the titles this node runs', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litg-'));
  const relaySockets = new Set();
  const relay = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ relay: true, path: req.url, method: req.method })); });
  relay.on('upgrade', (req, socket) => { relaySockets.add(socket); const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const relayPort = relay.address().port;
  const cfg = { command: process.execPath, args: [FAKE], cwd: ROOT, env: { PORT: '${port}' }, portRange: [7890, 7899] };
  const host = await createNode({ dataDir: join(tmp, 'n'), offline: true, heartbeatMs: 200, operator: 'g', roles: ['mesh', 'host'], rulesets: [PB], gauntlets: { 'pickle-brawl.v1': cfg }, gauntletPort: 0, relayPort });
  t.after(async () => { await host.stop(); for (const s of relaySockets) s.destroy(); await new Promise((r) => relay.close(r)); rmSync(tmp, { recursive: true, force: true }); });
  assert.notEqual(host.gauntlet.port, relayPort, 'the gateway has its own port');
  assert.equal(host.gauntlet.status().upstream, `ws://127.0.0.1:${relayPort}`, 'unknown rooms default to the title relay on RELAY_PORT');
  const opened = await new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${host.gauntlet.port}/`); const to = setTimeout(() => res(false), 5000); ws.onopen = () => { clearTimeout(to); ws.close(); res(true); }; ws.onerror = () => { clearTimeout(to); res(false); }; });
  assert.ok(opened); assert.equal(relaySockets.size, 1, 'the root WebSocket reached the title relay through the gateway');
  const gw = `http://127.0.0.1:${host.gauntlet.port}`;
  assert.deepEqual(await (await fetch(`${gw}/leaderboard?limit=5`)).json(), { relay: true, path: '/leaderboard?limit=5', method: 'GET' }, "the relay's own HTTP API passes through");
  assert.equal((await (await fetch(`${gw}/health`)).json()).relay, true, "with a relay behind it, /health is the relay's");
  assert.equal((await (await fetch(`${gw}/.well-known/jwks.json`)).json()).path, '/.well-known/jwks.json');
  assert.equal((await (await fetch(`${gw}/gateway`)).json()).upstream, `ws://127.0.0.1:${relayPort}`, 'the gateway answers at /gateway');
  const snap = await (await fetch(`${host.addr}/snapshot?envelopes=1`)).json();
  const mine = snap.envelopes.find((e) => e.body.nodeId === host.nodeId).body;
  assert.deepEqual(mine.gauntlets, ['pickle-brawl.v1'], 'the heartbeat says which titles this node runs');
});
