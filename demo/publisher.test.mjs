/** The two publisher paths, end to end against real nodes:
 *
 *  BRING YOUR BACKEND (sdk/bridge): an attested title's server posts an
 *  outcome report to the bridge's HTTP intake; the bridge signs it as the
 *  court and the node settles it `attested`. A replayable title's backend
 *  appends input ledgers to a JSON-lines file; the bridge watcher signs and
 *  settles each once — player-signed logs settle `players`, unsigned ones
 *  `relay` — and never re-sends what the node holds. `check` says what the
 *  mesh made of each. The CLI is JSON-clean.
 *
 *  BUILD FROM SCRATCH (sdk/client.js): a client runs the TUG title module
 *  locally, records inputs, both players sign the ledger head (one through
 *  a simulated cabinet shell, one locally) and the ledger settles
 *  `players` on the host; the delta's scores agree with the local sim.
 *    node --test demo/publisher.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createNode } from '../node/litnode.js';
import { generateKeypair } from '../protocol/keys.js';
import { loadOrCreateKey, prepare, submit, check, createBridge, loadAdapter, createIntake, playerBody, signAsPlayer, validateReplayable, validateAttested, nodeEnvLine, ROOT } from '../sdk/bridge/index.mjs';
import { parseLaunch, connectShell, localSigner, createSim, createRecorder, headMatches, settle, matchSeed, externalAgents } from '../sdk/client.js';

const TUG = join(ROOT, 'rulesets', 'tug.v1.js');
const PB = join(ROOT, 'rulesets', 'pickle-brawl.v1.js');
const tugManifest = JSON.parse(await import('node:fs').then((m) => m.readFileSync(join(ROOT, 'rulesets', 'tug.v1.json'), 'utf8')));
const tugTitle = (await import(pathToFileURL(join(ROOT, 'titles', 'tug.v1.mjs')).href)).default;
const { seats } = await import(pathToFileURL(PB).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(100); } return false; };

/** A finished TUG ledger: player a pulls every tick, b braces every other tick. */
const tugLedger = ({ matchId, a, b, buildHash = tugManifest.buildHash }) => {
  const rec = createRecorder({ matchId, participants: [a, b], rulesetId: 'tug.v1', buildHash, mode: 'casual' });
  const sim = createSim(tugTitle, { seed: matchSeed({ matchId }), participants: [a, b], ctx: { agents: externalAgents([a, b]) } });
  while (!sim.done() && sim.tick < 2000) { const inputs = { [a]: 1, [b]: sim.tick % 2 ? 2 : 0 }; sim.step(inputs); rec.record(inputs); }
  return { rec, sim };
};

test('bridge: shapes validate; the node.env line names what the operator must add', async () => {
  assert.deepEqual(validateReplayable({ matchId: 'm', rulesetId: 'x.v1', participants: ['a', 'b'], entries: [{ k: 0, inputs: [1, 0] }] }), []);
  assert.ok(validateReplayable({ matchId: 'm', rulesetId: 'bad', participants: ['a', 'a'], entries: [{ k: 1, inputs: [1] }], mode: 'ranked' }).length >= 4);
  assert.deepEqual(validateAttested({ kind: 'attested', matchId: 'm', rulesetId: 'x.v1', participants: ['a', 'b'], teams: [['a'], ['b']], report: {} }), []);
  assert.ok(validateAttested({ kind: 'attested', matchId: 'm', rulesetId: 'x.v1', participants: ['a', 'b'], teams: [['a'], ['c']], report: {} }).some((e) => /partition/.test(e)));
  assert.equal(nodeEnvLine('attested', 'pb.v1', 'ab'), 'COURTS=pb.v1:ab');
  assert.equal(nodeEnvLine('replayable', 'x.v1', 'ab'), 'RELAY_KEYS=ab');
});

test('bridge: attested title — HTTP intake signs as the court, node settles `attested`, second post is `already`, bad token refused', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litbridge-'));
  const court = await loadOrCreateKey(join(tmp, 'court.json'));
  assert.deepEqual(await loadOrCreateKey(join(tmp, 'court.json')), court, 'key file is stable');
  const node = await createNode({ dataDir: join(tmp, 'studio'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'settler'], rulesets: [PB], courts: { 'pickle-brawl.v1': [court.publicKey] } });
  const intake = createIntake({ nodeUrl: node.addr, key: court, token: 'a-token-of-sixteen-chars', port: 0, rulesetId: 'pickle-brawl.v1', kind: 'attested' });
  const addr = await intake.listen();
  const url = `http://127.0.0.1:${addr.port}`;
  t.after(async () => { await intake.close(); await node.stop(); rmSync(tmp, { recursive: true, force: true }); });

  const report = { matchId: 'pb-bridge-1', mode: 'singles', scoreA: 11, scoreB: 6, winnerTeam: 0, courtUrl: 'wss://court.example', ticks: 4000, claims: [{ sub: 'air:ana', team: 0, slot: 0 }, { sub: 'air:bo', team: 1, slot: 0 }] };
  const { participants, teams } = seats(report);
  const body = { matchId: report.matchId, rulesetId: 'pickle-brawl.v1', mode: 'casual', participants, teams, report }; // what a backend posts: unsigned, no `kind` needed when the bridge is told
  const post = (b, token = 'a-token-of-sixteen-chars') => fetch(`${url}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(b) });

  assert.equal((await post(body, 'wrong')).status, 401);
  const r1 = await post(body);
  const j1 = await r1.json();
  assert.equal(r1.status, 200, JSON.stringify(j1));
  assert.equal(j1.status, 'settled');
  assert.equal(j1.delta.attestation, 'attested'); assert.equal(j1.delta.attestor, court.publicKey);
  assert.equal(j1.delta.scores['pb:air:ana'], 11);
  const j2 = await (await post(body)).json();
  assert.equal(j2.status, 'already', 'idempotent: the node already holds it');
  const c = await (await fetch(`${url}/check/pb-bridge-1`)).json();
  assert.equal(c.found, true); assert.equal(c.attestation, 'attested'); assert.equal(c.official, false);
  assert.match(c.verdict, /court-attested/);
  const bad = await (await post({ ...body, matchId: 'pb-bad', report: { ...report, matchId: 'pb-bad', scoreA: 11, scoreB: 10 } })).json();
  assert.equal(bad.status, 'refused'); assert.match(bad.error, /win by two/);
  const other = await (await post({ ...body, rulesetId: 'tug.v1' })).json();
  assert.match(other.error, /signs for pickle-brawl.v1 only/);
});

test('bridge: replayable title — jsonl watcher settles player-signed logs `players` and unsigned ones `relay`, once; backfill is idempotent; CLI is JSON-clean', { timeout: 90_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litbridge-'));
  const relay = await loadOrCreateKey(join(tmp, 'relay.json'));
  const node = await createNode({ dataDir: join(tmp, 'host'), offline: true, heartbeatMs: 200, operator: 'host', roles: ['mesh', 'host', 'settler'], rulesets: [TUG], relayKeys: [relay.publicKey] });
  t.after(async () => { await node.stop(); rmSync(tmp, { recursive: true, force: true }); });

  const [p1, p2, p3, p4] = await Promise.all([generateKeypair(), generateKeypair(), generateKeypair(), generateKeypair()]);
  const signed = tugLedger({ matchId: 'tug-signed', a: p1.publicKey, b: p2.publicKey });
  const body = signed.rec.body();
  const signatures = { [p1.publicKey]: await signAsPlayer(body, p1), [p2.publicKey]: await signAsPlayer(body, p2) };
  assert.deepEqual(playerBody(signed.rec.submission()), body, 'bridge and client agree on what players sign');
  const unsigned = tugLedger({ matchId: 'tug-relay', a: p3.publicKey, b: p4.publicKey });
  const source = join(tmp, 'results.jsonl');
  writeFileSync(source, JSON.stringify({ id: 'row-1', submission: signed.rec.submission({ signatures }) }) + '\n');
  appendFileSync(source, JSON.stringify({ id: 'row-2', submission: unsigned.rec.submission({ expected: { endTick: unsigned.rec.ticks } }) }) + '\n');

  const adapter = await loadAdapter('jsonl');
  const stateFile = join(tmp, 'state.json');
  const bridge = createBridge({ nodeUrl: node.addr, key: relay, adapter, stateFile, adapterOptions: { source, kind: 'replayable', rulesetId: 'tug.v1' } });
  const did = await bridge.once();
  assert.deepEqual(did.map((d) => [d.id, d.status, d.attestation]), [['row-1', 'settled', 'players'], ['row-2', 'settled', 'relay']], JSON.stringify(did));
  assert.ok(existsSync(stateFile));
  assert.deepEqual(await bridge.once(), [], 'nothing new: nothing sent');
  appendFileSync(source, JSON.stringify({ id: 'row-1', submission: signed.rec.submission({ signatures }) }) + '\n');
  assert.deepEqual(await bridge.once(), [], 'a duplicate row id is skipped by the cursor state');

  const fresh = createBridge({ nodeUrl: node.addr, key: relay, adapter, stateFile: join(tmp, 'state2.json'), adapterOptions: { source, kind: 'replayable', rulesetId: 'tug.v1' } });
  const again = await fresh.once();
  assert.ok(again.every((d) => d.status === 'already'), `backfill from scratch re-sends nothing: ${JSON.stringify(again)}`);

  const c = await check(node.addr, 'tug-signed');
  assert.equal(c.attestation, 'players'); assert.equal(c.placed, false); assert.equal(c.official, false);
  assert.match(c.verdict, /not placed/);
  assert.deepEqual(c.scores, signed.sim.scores(), 'the node replayed to the same result the client computed');
  assert.equal((await check(node.addr, 'nope')).found, false);

  // A wrong relay key is refused with the fix spelled out.
  const stranger = await loadOrCreateKey(join(tmp, 'stranger.json'));
  const r = await submit(node.addr, await prepare(tugLedger({ matchId: 'tug-stranger', a: p3.publicKey, b: p4.publicKey }).rec.submission(), stranger));
  assert.equal(r.status, 'refused'); assert.match(r.error, /not a relay this host trusts/);

  // CLI: key, assess, body, submit, check — one JSON object each.
  // The node lives in THIS process, so the CLI must be spawned asynchronously: a
  // spawnSync would block the event loop the node answers from.
  const cli = (args, env = {}) => new Promise((res) => { const x = spawn(process.execPath, [join(ROOT, 'sdk', 'bridge', 'cli.mjs'), ...args, '--json'], { cwd: ROOT, env: { ...process.env, BRIDGE_KEY_FILE: join(tmp, 'relay.json'), LITNODE_URL: node.addr, ...env } }); let stdout = '', stderr = ''; x.stdout.on('data', (d) => (stdout += d)); x.stderr.on('data', (d) => (stderr += d)); x.on('close', (code) => { let json = null; try { json = JSON.parse(stdout); } catch {} res({ code, json, stdout, stderr }); }); });
  let x = await cli(['key', '--kind', 'replayable', '--ruleset', 'tug.v1']);
  assert.equal(x.code, 0, x.stdout + x.stderr); assert.equal(x.json.publicKey, relay.publicKey); assert.equal(x.json.nodeEnv, `RELAY_KEYS=${relay.publicKey}`);
  x = await cli(['assess', '--input-log', 'yes', '--deterministic', 'no']);
  assert.equal(x.json.kind, 'attested'); assert.ok(x.json.plan.some((p) => /path to replayable/.test(p)));
  x = await cli(['assess', '--input-log', 'yes', '--deterministic', 'yes', '--engine-open', 'yes']);
  assert.equal(x.json.kind, 'replayable');
  x = await cli(['assess']);
  assert.equal(x.code, 2); assert.equal(x.json.questions.length, 3);
  const subFile = join(tmp, 'sub.json');
  writeFileSync(subFile, JSON.stringify(tugLedger({ matchId: 'tug-cli', a: p1.publicKey, b: p2.publicKey }).rec.submission()));
  x = await cli(['body', subFile]);
  assert.equal(x.json.body.matchId, 'tug-cli'); assert.equal(x.json.body.buildHash, tugManifest.buildHash);
  x = await cli(['submit', subFile]);
  assert.equal(x.code, 0, x.stdout + x.stderr); assert.equal(x.json.status, 'settled'); assert.equal(x.json.check.attestation, 'relay');
  x = await cli(['check', 'tug-cli']);
  assert.equal(x.code, 0); assert.equal(x.json.attestation, 'relay');
  x = await cli(['watch', '--adapter', 'jsonl', '--source', source, '--kind', 'replayable', '--ruleset', 'tug.v1', '--once', '--state', join(tmp, 'state3.json')]);
  assert.equal(x.code, 0, x.stdout + x.stderr); assert.equal(x.json.counts.already, 2);
});

test('client sdk: parseLaunch, a simulated shell signs only its own match, sim + recorder + settle → `players` delta with the sim\'s scores', { timeout: 60_000 }, async (t) => {
  assert.deepEqual(parseLaunch('?ws=wss%3A%2F%2Fr&room=LIT-X&player=ab&match=m1&build=bb'), { ws: 'wss://r', room: 'LIT-X', player: 'ab', matchId: 'm1', buildHash: 'bb', placed: true });
  assert.equal(parseLaunch('').placed, false);
  assert.match(parseLaunch('?match=' + 'a'.repeat(40)).room, /^LIT-/, 'room derives from the match when the shell sent none');

  // A fake cabinet: the parent window answers hello with init and signs only the match it launched.
  const shellKp = await generateKeypair();
  const launched = { matchId: 'tug-shell', buildHash: tugManifest.buildHash };
  const listeners = new Set();
  const win = { addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f), parent: { postMessage: async (m) => {
    const reply = (data) => { for (const f of listeners) f({ data }); };
    if (m.type === 'cabinet:hello') reply({ type: 'cabinet:init', version: 1, player: { id: shellKp.publicKey, guest: true, name: 'p' }, node: { url: 'http://node', online: true }, game: { id: 'tug', title: 'TUG' }, match: launched });
    if (m.type === 'cabinet:sign') { const b = m.body; if (b.matchId !== launched.matchId || b.buildHash !== launched.buildHash) return reply({ type: 'cabinet:signed', matchId: b.matchId, error: 'not the match this shell launched' }); const s = await localSigner(shellKp); reply({ type: 'cabinet:signed', matchId: b.matchId, player: shellKp.publicKey, sig: (await s.sign(b)).sig }); }
  } } };
  const shell = await connectShell({ win });
  assert.equal(shell.player.id, shellKp.publicKey); assert.equal(shell.match.matchId, 'tug-shell');
  await assert.rejects(shell.sign({ matchId: 'other', ticks: 1, head: 'x', buildHash: launched.buildHash }), /not the match/);

  const tmp = mkdtempSync(join(tmpdir(), 'litclient-'));
  const node = await createNode({ dataDir: join(tmp, 'host'), offline: true, heartbeatMs: 200, operator: 'host', roles: ['mesh', 'host', 'settler'], rulesets: [TUG] });
  t.after(async () => { shell.close(); await node.stop(); rmSync(tmp, { recursive: true, force: true }); });

  const other = await localSigner();
  const a = shellKp.publicKey, b = other.publicKey;
  const rec = createRecorder({ matchId: 'tug-shell', participants: [a, b], rulesetId: 'tug.v1', buildHash: tugManifest.buildHash, mode: 'casual' });
  const sim = createSim(tugTitle, { seed: matchSeed({ matchId: 'tug-shell' }), participants: [a, b], ctx: { agents: externalAgents([a, b]) } });
  while (!sim.done()) { const inputs = { [a]: sim.tick % 3 ? 1 : 3, [b]: 1 }; sim.step(inputs); rec.record(inputs); }
  assert.ok(headMatches(rec));
  assert.ok(rec.ticks > 10);
  const delta = await settle({ nodeUrl: node.addr, recorder: rec, signers: { [a]: shell, [b]: other } });
  assert.equal(delta.attestation, 'players');
  assert.equal(delta.ticks, rec.ticks);
  assert.deepEqual(delta.scores, sim.scores());
  assert.equal(delta.finalStateRoot, sim.root(), 'the client\'s local sim reached the exact state root the node committed');
});

test('bridge: resolveNode picks the freshest bonded seed that proves its key, hosts the ruleset and settles — from a mocked chain', async () => {
  const { resolveNode } = await import('../sdk/bridge/index.mjs');
  const { answerChallenge } = await import('../protocol/challenge.js');
  const [good, stale, noRule] = await Promise.all([generateKeypair(), generateKeypair(), generateKeypair()]);
  const now = Math.floor(Date.now() / 1000);
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  // ABI (string url, string wsAddr, uint256 updatedAt, address announcer).
  const enc = (url, at) => { const u = Buffer.from(url, 'utf8'); const s1 = w(u.length) + u.toString('hex').padEnd(Math.ceil(u.length / 32) * 64, '0'); return '0x' + w(0x80) + w(0x80 + s1.length / 2) + w(at) + w(0) + s1 + w(0); };
  const keysRet = '0x' + w(0x20) + w(3) + good.publicKey + stale.publicKey + noRule.publicKey;
  const urls = { [good.publicKey]: 'http://good.test', [stale.publicKey]: 'http://stale.test', [noRule.publicKey]: 'http://norule.test' };
  const ages = { [good.publicKey]: now - 100, [stale.publicKey]: now - 30 * 24 * 3600, [noRule.publicKey]: now - 10 };
  const fetchImpl = async (url, init) => {
    const json = (b) => ({ ok: true, json: async () => b });
    if (String(url) === 'http://rpc.test') {
      const data = JSON.parse(init.body).params[0].data;
      if (data.startsWith('0x307540f6')) return json({ result: keysRet });                                  // keys()
      const key = data.slice(10);
      if (data.startsWith('0x82fb8643')) return json({ result: enc(urls[key], ages[key]) });                // entryOf
      if (data.startsWith('0x43aa9ad3')) return json({ result: '0x' + w(0) + w(10n ** 18n) + w(1) });    // standingOf: active
    }
    const u = new URL(url);
    const kp = [good, stale, noRule].find((k) => urls[k.publicKey] === u.origin);
    if (u.pathname === '/whoami') return json(await answerChallenge({ nodeId: kp.publicKey, nonce: u.searchParams.get('nonce'), addr: u.origin }, kp.privateKey));
    if (u.pathname === '/health') return json({ nodeId: kp.publicKey, roles: ['mesh', 'settler'], rulesets: kp === noRule ? {} : { 'pickle-brawl.v1': 'x' } });
    throw new Error(`unexpected ${url}`);
  };
  const args = { rpc: 'http://rpc.test', nodeDirectory: '0x' + '11'.repeat(20), nodeStake: '0x' + '22'.repeat(20), fetchImpl };
  const r = await resolveNode({ rulesetId: 'pickle-brawl.v1', ...args });
  assert.equal(r.url, 'http://good.test');
  assert.equal(r.candidates, 2, 'the stale entry is not a seed');
  assert.deepEqual(r.tried.map((t) => t.url), ['http://norule.test'], 'the newer seed that does not host the title is skipped, with the reason');
  await assert.rejects(resolveNode({ rulesetId: 'tug.v1', ...args }), /no live node hosting tug.v1/);
});
