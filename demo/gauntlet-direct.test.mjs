/** Direct gauntlets (node/gauntlet.js startDirect, node/litnode.js POST /gauntlet/start): a publisher's own
 *  matchmaker, running as a publisher service on the node, starts a court for a match IT formed - a friends'
 *  lobby - and gets the run's per-match ticket secret back to seat its own players. Only the services the
 *  bundle names get the token; only this machine may call; only for the bundle's titles; the seats it names
 *  are validated; a repeat is idempotent and a conflicting one refused; direct seats are never claimable at
 *  the gateway; the publisher can stop its own run.
 *    node --test demo/gauntlet-direct.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createNode } from '../node/litnode.js';
import { mintTicket, directSeatsProblem } from '../node/gauntlet.js';
import { loadServiceBundles } from '../node/publisher-services.js';

const ROOT = process.cwd();
const PB = join(ROOT, 'rulesets', 'pickle-brawl.v1.js');
const FAKE_COURT = join(ROOT, 'demo', 'fixtures', 'fake-court.mjs');
const FAKE_SERVICE = join(ROOT, 'demo', 'fixtures', 'fake-service.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await pred()) return true; } catch { /* not yet */ } await sleep(100); } return false; };
const matchId = (label) => createHash('sha256').update(label).digest('hex');

test('direct gauntlets: seat rules', () => {
  const seat = (sub, team, slot) => ({ sub, team, slot });
  assert.equal(directSeatsProblem('singles', [seat('a', 0, 0), seat('b', 1, 0)]), null);
  assert.equal(directSeatsProblem('doubles', [seat('a', 0, 0), seat('b', 1, 0)]), null, 'two humans in doubles: NPC partners');
  assert.equal(directSeatsProblem('doubles', [seat('a', 0, 0), seat('b', 0, 1), seat('c', 1, 0), seat('d', 1, 1)]), null);
  assert.match(directSeatsProblem('singles', [seat('a', 0, 0)]), /takes 2/);
  assert.match(directSeatsProblem('singles', [seat('a', 0, 0), seat('b', 1, 1)]), /slot/);
  assert.match(directSeatsProblem('doubles', [seat('a', 0, 0), seat('a', 1, 0)]), /twice/);
  assert.match(directSeatsProblem('doubles', [seat('a', 0, 0), seat('b', 0, 1)]), /both teams/);
  assert.match(directSeatsProblem('squash', []), /singles or doubles/);
});

test('direct gauntlets: a publisher service starts, seats and stops a court for its own match', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litgd-'));
  const bundle = {
    prefix: 'demo-game', cwd: ROOT, portRange: [8870, 8879],
    gauntletCallers: ['mm'], gauntletRulesets: ['pickle-brawl.v1'],
    services: {
      mm: { command: '${node}', args: [FAKE_SERVICE], env: { PORT: '${port}' } },
      api: { command: '${node}', args: [FAKE_SERVICE], env: { PORT: '${port}' } },
    },
  };
  writeFileSync(join(tmp, 'bundle.json'), JSON.stringify(bundle));
  const cfg = { command: process.execPath, args: [FAKE_COURT], cwd: ROOT, env: { PORT: '${port}', COURT_TICKET_SECRET: '${secret}', LITNODE_SEATS: '${seats}', API_URL: '${gateway}/svc/demo-game.api' }, portRange: [7900, 7905], readyMs: 20_000, ttlMs: 60_000, ticketTtlMs: 60_000 };
  const node = await createNode({ dataDir: join(tmp, 'n'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'host'], rulesets: [PB], gauntlets: { 'pickle-brawl.v1': cfg }, gauntletPort: 0, services: loadServiceBundles(join(tmp, 'bundle.json')) });
  t.after(async () => { await node.stop(); rmSync(tmp, { recursive: true, force: true }); });
  const gw = `http://127.0.0.1:${node.gauntlet.port}`;
  assert.ok(await until(async () => (await (await fetch(`${gw}/svc`)).json()).services.every((s) => s.state === 'up')), 'services up');

  // Only the named caller holds the token.
  const mm = await (await fetch(`${gw}/svc/demo-game.mm/`)).json();
  const api = await (await fetch(`${gw}/svc/demo-game.api/`)).json();
  assert.match(mm.gauntletToken ?? '', /^[0-9a-f]{64}$/, 'the matchmaker got a token');
  assert.equal(api.gauntletToken, null, 'the API did not');
  const token = mm.gauntletToken;
  const post = (path, body, headers = {}) => fetch(`${node.addr}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

  const id = matchId('lobby-1');
  const seats = [{ sub: 'air|alice', team: 0, slot: 0 }, { sub: 'air|bob', team: 1, slot: 0 }];
  const ask = { rulesetId: 'pickle-brawl.v1', matchId: id, mode: 'singles', seats };

  assert.equal((await post('/gauntlet/start', ask, { authorization: 'Bearer nope' })).status, 401, 'a wrong token');
  assert.equal((await post('/gauntlet/start', ask, { 'x-forwarded-for': '203.0.113.9' })).status, 403, 'a caller through the tunnel');
  assert.equal((await post('/gauntlet/start', { ...ask, rulesetId: 'agent-fighter.v1' })).status, 403, 'a title the bundle does not own');
  assert.equal((await post('/gauntlet/start', { ...ask, matchId: 'short' })).status, 400, 'a bad match id');
  assert.equal((await post('/gauntlet/start', { ...ask, seats: [seats[0]] })).status, 400, 'singles with one seat');

  const started = await post('/gauntlet/start', ask);
  assert.equal(started.status, 200);
  const run = await started.json();
  assert.match(run.secret, /^[0-9a-f]{64}$/);
  assert.match(run.room, /^LIT-[0-9A-F]{32}$/);
  assert.equal(run.ws, `ws://127.0.0.1:${node.gauntlet.port}/${run.room}`, 'no tunnel: the room on the gateway');
  assert.equal(run.mode, 'singles');

  const again = await (await post('/gauntlet/start', ask)).json();
  assert.equal(again.room, run.room, 'the same start is answered with the same run');
  assert.equal(again.secret, run.secret);
  assert.equal((await post('/gauntlet/start', { ...ask, seats: [seats[0], { sub: 'air|mallory', team: 1, slot: 0 }] })).status, 409, 'the same match id with other seats');

  // The gateway never hands out a direct seat, and never names its account ids.
  const claim = await fetch(`${gw}/${run.room}/ticket?player=air%7Calice`);
  assert.equal(claim.status, 403);
  assert.equal((await claim.json()).seats, undefined);
  const gateway = await (await fetch(`${gw}/gateway`)).json();
  assert.equal(gateway.active.find((r) => r.room === run.room).direct, true);
  assert.ok(!JSON.stringify(gateway).includes('air|alice'), 'subs are not public');

  // The publisher seats its own player with the per-match secret, through the public room.
  const ticket = mintTicket({ sub: 'air|alice', matchId: id, team: 0, slot: 0, mode: 'singles', exp: Date.now() + 60_000 }, run.secret);
  const seated = await new Promise((res, rej) => {
    const ws = new WebSocket(run.ws);
    const to = setTimeout(() => rej(new Error('no answer from the court')), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ ticket }));
    ws.onmessage = (e) => { clearTimeout(to); ws.close(); res(String(e.data)); };
    ws.onerror = () => { clearTimeout(to); rej(new Error('ws failed')); };
  });
  assert.equal(seated, 'seated:air|alice:0:0:singles');

  // ${gateway}: the court reaches the publisher's own services through this node's gateway, on loopback.
  const courtPort = gateway.active.find((r) => r.room === run.room).port;
  const court = await (await fetch(`http://127.0.0.1:${courtPort}/`)).json();
  assert.equal(court.apiUrl, `${gw}/svc/demo-game.api`);
  assert.equal((await (await fetch(`${court.apiUrl}/`)).json()).name, 'demo-game.api', 'and it answers');

  // Only its own runs can be stopped, by its own token.
  assert.equal((await post('/gauntlet/stop', { matchId: matchId('somebody else') })).status, 404);
  assert.equal((await post('/gauntlet/stop', { matchId: id })).status, 200);
  assert.ok(await until(async () => !(await (await fetch(`${gw}/gateway`)).json()).active.some((r) => r.room === run.room), 5000), 'the run is gone');
});

test('direct gauntlets: only a court that is still running holds one of the title\'s slots', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litgd-'));
  const bundle = {
    prefix: 'demo-game', cwd: ROOT, portRange: [8880, 8889],
    gauntletCallers: ['mm'], gauntletRulesets: ['pickle-brawl.v1'],
    services: { mm: { command: '${node}', args: [FAKE_SERVICE], env: { PORT: '${port}' } } },
  };
  writeFileSync(join(tmp, 'bundle.json'), JSON.stringify(bundle));
  // One slot, and a court that ends by itself 1.5 s after it starts, without ever settling.
  const cfg = { command: process.execPath, args: [FAKE_COURT], cwd: ROOT, env: { PORT: '${port}', COURT_TICKET_SECRET: '${secret}', FAKE_COURT_EXIT_MS: '1500' }, portRange: [7910, 7915], maxDirect: 1, readyMs: 20_000, ttlMs: 60_000, ticketTtlMs: 60_000 };
  const node = await createNode({ dataDir: join(tmp, 'n'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'host'], rulesets: [PB], gauntlets: { 'pickle-brawl.v1': cfg }, gauntletPort: 0, services: loadServiceBundles(join(tmp, 'bundle.json')) });
  t.after(async () => { await node.stop(); rmSync(tmp, { recursive: true, force: true }); });
  const gw = `http://127.0.0.1:${node.gauntlet.port}`;
  assert.ok(await until(async () => (await (await fetch(`${gw}/svc`)).json()).services.every((s) => s.state === 'up')), 'services up');
  const token = (await (await fetch(`${gw}/svc/demo-game.mm/`)).json()).gauntletToken;
  const start = (label) => fetch(`${node.addr}/gauntlet/start`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ rulesetId: 'pickle-brawl.v1', matchId: matchId(label), mode: 'singles', seats: [{ sub: `${label}|a`, team: 0, slot: 0 }, { sub: `${label}|b`, team: 1, slot: 0 }] }) });

  assert.equal((await start('first')).status, 200);
  assert.equal((await start('second')).status, 429, 'the one slot is taken');
  // The first court ends on its own and is never settled, so it stays on the books - but not in the slot.
  assert.ok(await until(async () => node.gauntlet.active.get(matchId('first'))?.state === 'exited', 10_000), 'the first court ended');
  assert.equal((await start('second')).status, 200, 'an ended court gives its slot back');
});

test('direct gauntlets: a bundle cannot name callers outside itself, or callers without titles', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'litgd-'));
  try {
    const write = (b) => { writeFileSync(join(tmp, 'b.json'), JSON.stringify(b)); return join(tmp, 'b.json'); };
    const services = { mm: { command: 'x' } };
    assert.throws(() => loadServiceBundles(write({ prefix: 'g', services, gauntletCallers: ['other'], gauntletRulesets: ['t.v1'] })), /must name services/);
    assert.throws(() => loadServiceBundles(write({ prefix: 'g', services, gauntletCallers: ['mm'] })), /gauntletRulesets/);
    assert.equal(loadServiceBundles(write({ prefix: 'g', services, gauntletCallers: ['mm'], gauntletRulesets: ['t.v1'] }))[0].gauntletCallers[0], 'mm');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
