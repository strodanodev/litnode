/** The cabinet's client (cabinet/client.js) against a two-node mesh: identity persists, a signed
 *  queue entry pairs, the client recomputes placement and ACCEPTS the host the
 *  rule produced, and REFUSES a descriptor naming another host. The node also
 *  serves the lobby page and the protocol modules it imports.
 *    node --test demo/client.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { loadPlayer, createClient } from '../cabinet/client.js';
import { roomCodeFor } from '../protocol/pairing.js';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-arcade-'));
const nodes = [];
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));
const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('arcade: lobby served, identity persists, queue → pair → client verifies placement', { timeout: 60_000 }, async (t) => {
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const a = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'witness'], rulesets: [RULESET] });
  const b = await spawn({ operator: 'guild-a', roles: ['mesh', 'host', 'witness'], seeds: [a.addr] });

  const page = await fetch(`${a.addr}/`); assert.equal(page.status, 200); assert.match(await page.text(), /LIT GAMES/);
  const mod = await fetch(`${a.addr}/protocol/placement.js`); assert.equal(mod.status, 200); assert.match(mod.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${a.addr}/protocol/../package.json`)).status, 404, 'no path escape');

  const store = memStorage();
  const p1 = await loadPlayer(store); assert.deepEqual(await loadPlayer(store), p1, 'identity persists in storage');
  const p2 = await loadPlayer(memStorage());
  const c1 = createClient({ nodeUrl: a.addr, player: p1 });
  const c2 = createClient({ nodeUrl: b.addr, player: p2 });
  await new Promise((r) => setTimeout(r, 1500)); // let the mesh converge

  await c1.queue({ rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  await c2.queue({ rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  const ev1 = [];
  const hooks = (ev) => ({ onTick: (m) => ev.push(['tick', m?.matchId ?? null]), onPaired: (m) => ev.push(['paired', m.matchId]) });
  const [r1, r2] = await Promise.all([c1.waitForMatch({ timeoutMs: 20_000, ...hooks(ev1) }), c2.waitForMatch({ timeoutMs: 20_000 })]);
  assert.ok(r1 && r2, 'both paired');
  // onPaired fires once, with the match returned, right after the tick that saw it and before the slow checks.
  assert.deepEqual(ev1.filter(([k]) => k === 'paired'), [['paired', r1.match.matchId]]);
  assert.deepEqual(ev1.slice(-2), [['tick', r1.match.matchId], ['paired', r1.match.matchId]]);
  assert.ok(ev1.slice(0, -2).every(([k, id]) => k === 'tick' && id === null), 'earlier ticks carry no match');
  assert.equal(r1.match.matchId, r2.match.matchId, 'same match at different nodes');
  assert.equal(r1.check.ok, true, r1.check.reason);
  assert.equal(r2.check.ok, true, r2.check.reason);
  assert.equal(r1.check.host, r1.match.host);
  assert.equal(r1.check.snapshotVerified, true, 'the client rebuilt the snapshot from signed heartbeats');
  assert.equal(r1.snapshot.signed >= 2, true);
  assert.equal(r1.check.beacon.source, 'local'); assert.equal(r1.check.beacon.ok, true, 'offline mesh: local beacon, labelled');
  assert.equal(r1.match.protocol, PROTOCOL_VERSION);
  // the relay rendezvous code both players derive from the same match
  assert.equal(roomCodeFor(r1.match.matchId), roomCodeFor(r2.match.matchId));
  assert.match(roomCodeFor(r1.match.matchId), /^[A-Z0-9-]{3,40}$/, "fits Agent Fighter's room-code rule");

  // A node that lies about the host is refused by the client.
  const other = r1.snapshot.peers.find((p) => p.nodeId !== r1.match.host)?.nodeId;
  const lie = c1.verifyPlacement({ ...r1.match, host: other }, r1.snapshot);
  assert.equal(lie.ok, false);
  assert.match(lie.reason, /did not produce/);

  const st = await c1.stats('agent-fighter.v1'); assert.equal(st.matches, 0);
});

test('confirmWithHost: a host that says it will not commit ends the wait at once (casual-only)', { timeout: 10_000 }, async () => {
  const p = await loadPlayer(memStorage());
  const m = { matchId: 'm1', rulesetId: 'pickle-brawl.v1', mode: 'ranked', host: 'h1', participants: [p.publicKey, 'other'] };
  const s = { peers: [{ nodeId: 'h1', addr: 'http://host.test' }] };
  const reply = (entry) => async () => ({ ok: true, json: async () => ({ matches: [entry] }) });

  // Skipped: answered on the first ask, not after the 15 s deadline.
  const skipped = createClient({ nodeUrl: 'http://node.test', player: p, fetchImpl: reply({ ...m, commitTx: null, commitSkipped: 'the draw seated 2 witnesses, MatchBook needs 3: casual-only' }) });
  const t0 = Date.now();
  const r = await skipped.confirmWithHost(m, s, { deadlineMs: 15_000 });
  assert.ok(Date.now() - t0 < 2000, 'no wait for a commit that is never sent');
  assert.equal(r.confirmedByHost, true);
  assert.match(r.casualOnly, /casual-only/);

  // Committed: the transaction wins, as before.
  const committed = createClient({ nodeUrl: 'http://node.test', player: p, fetchImpl: reply({ ...m, commitTx: '0xabc', commitSkipped: null }) });
  assert.equal((await committed.confirmWithHost(m, s)).commitTx, '0xabc');

  // An older host with neither field: waits to the deadline, then the placement stands unconfirmed.
  const older = createClient({ nodeUrl: 'http://node.test', player: p, fetchImpl: reply({ ...m, commitTx: null }) });
  assert.equal(await older.confirmWithHost(m, s, { deadlineMs: 800 }), null);
});

test('waitForMatch: no pair, a pre-aborted signal, and an abort mid-wait never fire onPaired', { timeout: 10_000 }, async () => {
  const p = await loadPlayer(memStorage());
  let polls = 0;
  const empty = async () => { polls++; return { ok: true, json: async () => ({ matches: [] }) }; };
  const c = createClient({ nodeUrl: 'http://node.test', player: p, fetchImpl: empty });
  const paired = [];
  let ticks = 0;
  const hooks = { onTick: (m) => { assert.equal(m, null); ticks++; }, onPaired: (m) => paired.push(m) };

  // Timeout: polls several times, returns null, never pairs.
  const t0 = Date.now();
  assert.equal(await c.waitForMatch({ timeoutMs: 600, intervalMs: 100, ...hooks }), null);
  assert.ok(Date.now() - t0 >= 600 && Date.now() - t0 < 2000, 'returns near the timeout');
  assert.ok(ticks >= 3 && ticks === polls, `one tick per poll (${ticks}/${polls})`);

  // Already aborted: no poll at all.
  polls = 0; ticks = 0;
  assert.equal(await c.waitForMatch({ timeoutMs: 5000, signal: AbortSignal.abort(), ...hooks }), null);
  assert.equal(polls, 0); assert.equal(ticks, 0);

  // Aborted while waiting (the Stop button): ends within one interval, not at the timeout.
  const ac = new AbortController(); setTimeout(() => ac.abort(), 250);
  const t1 = Date.now();
  assert.equal(await c.waitForMatch({ timeoutMs: 5000, intervalMs: 100, signal: ac.signal, ...hooks }), null);
  assert.ok(Date.now() - t1 < 1000, 'Stop ends the wait promptly');
  assert.deepEqual(paired, [], 'onPaired never fired');
});

test('waitForMatch: a stale-bucket match is ignored; transient node errors are ridden out, an outage rejects', { timeout: 10_000 }, async () => {
  const p = await loadPlayer(memStorage());
  const paired = [];
  const stale = createClient({ nodeUrl: 'http://node.test', player: p,
    fetchImpl: async () => ({ ok: true, json: async () => ({ matches: [{ matchId: 'old', bucket: 5 }] }) }) });
  assert.equal(await stale.waitForMatch({ timeoutMs: 300, intervalMs: 50, sinceBucket: 6, onPaired: (m) => paired.push(m) }), null);
  assert.deepEqual(paired, [], 'a match from before this queue entry is not ours');

  // Three failed polls in a row are ridden out and the wait still pairs...
  let calls = 0;
  const blip = createClient({ nodeUrl: 'http://node.test', player: p, fetchImpl: async () => (++calls <= 3
    ? { ok: false, status: 503 } : { ok: true, json: async () => ({ matches: [{ matchId: 'm9', bucket: 1 }] }) }) });
  const got = [];
  await blip.waitForMatch({ timeoutMs: 2000, intervalMs: 20, onPaired: (m) => { got.push(m.matchId); throw new Error('stop after pairing'); } })
    .catch((e) => assert.match(e.message, /stop after pairing/));
  assert.deepEqual(got, ['m9'], 'paired on the fourth poll');

  // ...a fourth failure in a row is an outage and rejects, never pairing.
  let downCalls = 0;
  const down = createClient({ nodeUrl: 'http://node.test', player: p, fetchImpl: async () => (downCalls++, { ok: false, status: 503 }) });
  await assert.rejects(down.waitForMatch({ timeoutMs: 5000, intervalMs: 20, onPaired: (m) => paired.push(m) }), /\/match\?playerId=.*: 503/);
  assert.equal(downCalls, 4);
  assert.deepEqual(paired, []);
});
