/** The cabinet's contract with the node. docs/NODE-CABINET-SYNC.md §1 lists
 *  the fields the deployed dashboard reads BY NAME from five endpoints; a node
 *  change that drops or renames one breaks a page nobody redeploys. This test
 *  is that list, plus: the node serves the cabinet at /, the vendored protocol
 *  copies match source, and the cabinet's rating trajectory reaches the same
 *  number as /leaderboard.
 *    node --test demo/cabinet.test.mjs */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair } from '../protocol/keys.js';
import { createLog, ledgerBody, signLedger } from '../protocol/log.js';
import { agent, hydrationManifest } from '../protocol/erc6699.js';
import { h } from '../protocol/canonical.js';
import { applyDelta, sortDeltas } from '../cabinet/protocol/derive.js';
import { checkVendored } from '../tools/vendor-cabinet.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);
const tmp = mkdtempSync(join(tmpdir(), 'litnode-cabinet-'));

/** Same helper as settle.test.mjs: a full match with the built-in AI, signed by both players. */
async function playSigned(matchId, kps) {
  const P = kps.map((k) => k.publicKey);
  const agents = { [P[0]]: agent({ tokenId: 1, stats: { strength: 30000, agility: 58000, resilience: 20000, intelligence: 40000 }, manifest: { soulManifestHash: 'aa' } }),
                   [P[1]]: agent({ tokenId: 2, stats: { strength: 65535, agility: 5000, resilience: 60000, intelligence: 1000 }, manifest: { soulManifestHash: 'bb' } }) };
  const s = title.init(h('seed', matchId), P, { agents });
  const ai = [engine.createAi(0, 60, 11), engine.createAi(1, 60, 99)];
  const log = createLog();
  while (!title.done(s)) { const fr = [engine.aiPoll(ai[0], s), engine.aiPoll(ai[1], s)]; log.append(fr); title.step(s, { [P[0]]: fr[0], [P[1]]: fr[1] }); }
  const hm = hydrationManifest({ agents: [agents[P[0]], agents[P[1]]], mode: 'casual', balanceVersion: balance.version });
  const body = ledgerBody({ matchId, ticks: log.length, head: log.head, buildHash: manifest.buildHash, hydrationHash: hm.manifestHash });
  const signatures = Object.fromEntries(await Promise.all(kps.map(async (k) => [k.publicKey, await signLedger(body, k)])));
  return { matchId, rulesetId: 'agent-fighter.v1', buildHash: manifest.buildHash, mode: 'casual', participants: P, entries: log.entries(), signatures, hydration: { agents } };
}

/** assert every (name → typeof) in `shape` is present on `obj`. */
const hasFields = (obj, shape, where) => {
  for (const [k, t] of Object.entries(shape)) {
    const v = k.split('.').reduce((o, p) => o?.[p], obj);
    assert.ok(v !== undefined, `${where}: missing field "${k}"`);
    if (t === 'array') assert.ok(Array.isArray(v), `${where}: "${k}" should be an array`);
    else if (t !== 'any') assert.equal(typeof v, t, `${where}: "${k}" should be ${t}`);
  }
};

test('cabinet contract: fields by name, cabinet served at /, vendored protocol in sync, trajectory == ladder', { timeout: 60_000 }, async (t) => {
  const node = await createNode({ dataDir: join(tmp, 'n'), offline: true, heartbeatMs: 200, operator: 'publisher', roles: ['mesh', 'host', 'witness', 'settler'], rulesets: [RULESET] });
  t.after(async () => { await node.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const get = async (p) => { const r = await fetch(`${node.addr}${p}`); assert.equal(r.status, 200, p); return r; };
  const json = async (p) => (await get(p)).json();

  // vendored copies are the source bytes
  assert.deepEqual(checkVendored(), [], 'cabinet/protocol drifted from protocol/ — run node tools/vendor-cabinet.mjs');
  // the cabinet knows which release it is (cabinet/version.js): a copy served from elsewhere can show how far behind the node it is
  const { CABINET_VERSION } = await import('../cabinet/version.js');
  assert.equal(CABINET_VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'cabinet/version.js ≠ package.json — npm version keeps them equal (tools/sync-version.mjs)');
  assert.equal((await json('/health')).cabinet.version, CABINET_VERSION, 'the node reports the cabinet version it serves');

  // the node is a frontend host: the cabinet at /, its files at the root, the protocol modules it imports
  const page = await get('/'); assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /LIT GAMES/);
  for (const f of ['/app.js', '/client.js', '/wallet.js', '/seeds.js', '/protocol/directory.js', '/protocol/abi.js', '/config.js', '/style.css', '/sw.js', '/manifest.webmanifest', '/protocol/keys.js', '/protocol/derive.js', '/protocol/profile.js', '/cabinet/protocol/keys.js'])
    assert.equal((await fetch(`${node.addr}${f}`)).status, 200, f);
  // every script the page loads must PARSE: a stray quote in app.js shipped in 0.11.1 and blanked the cabinet on every node
  for (const f of ['/app.js', '/client.js', '/wallet.js', '/seeds.js', '/nodeops.js', '/config.js', '/sdk-client.js', '/roster.js', '/avatar.js', '/bg.js', '/uptime.js', '/chain.js']) {
    const src = await (await fetch(`${node.addr}${f}`)).text();
    const tmpFile = join(tmpdir(), `cabinet-parse-${process.pid}-${f.slice(1)}.mjs`);
    writeFileSync(tmpFile, src);
    try { execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' }); }
    catch (e) { assert.fail(`${f} does not parse: ${String(e.stderr).split(/\r?\n/).slice(0, 3).join(' ')}`); }
    finally { rmSync(tmpFile, { force: true }); }
  }
  assert.equal((await fetch(`${node.addr}/protocol/../package.json`)).status, 404, 'no path escape');
  assert.equal((await fetch(`${node.addr}/nope.js`)).status, 404);
  // CORS + Private Network Access on JSON and on the preflight an https page sends first
  const pre = await fetch(`${node.addr}/health`, { method: 'OPTIONS' });
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/, 'preflight must allow POST or every write fails in a browser');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /content-type/i);

  // settle one real match so every table has a row
  const kps = await Promise.all([generateKeypair(), generateKeypair()]);
  const sub = await playSigned('cab-1', kps);
  const r = await fetch(`${node.addr}/ledger`, { method: 'POST', body: JSON.stringify(sub) });
  assert.equal(r.status, 200, await r.text());

  // /health — SYNC §1.3
  const health = await json('/health');
  hasFields(health, { nodeId: 'string', operator: 'string', roles: 'array', region: 'string', addr: 'string', epoch: 'number', peers: 'number', rulesets: 'object', buildsHeld: 'number', staking: 'string', bonded: 'any', 'chain.offline': 'boolean', 'chain.rpc': 'string', 'chain.head': 'any', 'chain.lastError': 'any', startedAt: 'string', uptimeMs: 'number', 'inbound.peers': 'number', 'inbound.reachable': 'any', profiles: 'string' }, '/health');
  assert.equal(health.profiles, 'unset', 'no PlayerProfile configured → keys are players, and it says so');
  assert.equal(health.inbound.reachable, null, 'no peers known → reachability is unknown, not false');
  assert.equal(health.rulesets['agent-fighter.v1'], manifest.buildHash);
  assert.ok(health.uptimeMs >= 0 && !Number.isNaN(Date.parse(health.startedAt)));

  // /peers
  const peers = await json('/peers');
  hasFields(peers, { peers: 'array' }, '/peers');
  hasFields(peers.peers[0], { nodeId: 'string', operator: 'string', addr: 'string', region: 'string', roles: 'array', fresh: 'boolean', bonded: 'any', clockSkewS: 'number', rulesets: 'array' }, '/peers[0]');

  // /snapshot — the cabinet folds with the manifest's services and verifies placement against peers
  const snap = await json('/snapshot');
  hasFields(snap, { epoch: 'number', peers: 'array', manifests: 'object', root: 'string', staking: 'string' }, '/snapshot');
  hasFields(snap.manifests['agent-fighter.v1'], { buildHash: 'string', services: 'object' }, '/snapshot.manifests');

  // /leaderboard — official by default (ranked, placed, verified): this unplaced casual fixture is not on it
  const official = await json('/leaderboard?ruleset=agent-fighter.v1');
  hasFields(official, { rulesetId: 'string', scope: 'string', deriveVersion: 'number', digest: 'string', skipped: 'array', leaderboard: 'array' }, '/leaderboard');
  assert.equal(official.scope, 'official'); assert.equal(official.leaderboard.length, 0, 'an unplaced, unwitnessed casual result is not an official standing');
  const lb = await json('/leaderboard?ruleset=agent-fighter.v1&scope=all');
  assert.equal(lb.scope, 'all');
  hasFields(lb.leaderboard[0], { rank: 'number', player: 'string', rating: 'number' }, '/leaderboard[0]');

  // /stats — keyed by playerId
  const st = await json('/stats?ruleset=agent-fighter.v1&scope=all');
  hasFields(st[kps[0].publicKey], { matches: 'number', wins: 'number', ticks: 'number' }, '/stats[player]');

  // /seeds — the bootstrap list this node last read from NodeDirectory (unset in this offline node)
  const sd = await json('/seeds');
  hasFields(sd, { source: 'string', seeds: 'array' }, '/seeds');
  assert.equal(sd.source, 'unset');

  // /profile — what the cabinet's profile card asks about this browser's key
  const prof = await json(`/profile?player=${kps[0].publicKey}`);
  hasFields(prof, { player: 'string', profiles: 'string', owner: 'any', tokenId: 'any', active: 'any', name: 'any' }, '/profile');

  // /deltas — what the history table and the rating chart are built from
  const ds = await json('/deltas?ruleset=agent-fighter.v1');
  hasFields(ds, { deltas: 'array' }, '/deltas');
  hasFields(ds.deltas[0], { matchId: 'string', rulesetId: 'string', buildHash: 'string', mode: 'string', participants: 'array', scores: 'object', ticks: 'number', hostId: 'string', cosigners: 'array', disputes: 'array', settledAt: 'string', epoch: 'number', attestation: 'string', placed: 'boolean', resultHash: 'string', hydrationSource: 'string', verification: 'string', official: 'boolean', protocol: 'number' }, '/deltas[0]');
  assert.equal(ds.deltas[0].verification, 'unverified'); assert.equal(ds.deltas[0].placed, false);
  assert.equal((await json('/deltas?ruleset=agent-fighter.v1&scope=official')).deltas.length, 0);

  // the cabinet's rating trajectory (applyDelta step by step) ends where /leaderboard says
  const tables = { rating: {}, credits: {}, stats: {} };
  for (const d of sortDeltas(ds.deltas)) applyDelta(tables, d, snap.manifests['agent-fighter.v1'].services);
  for (const row of lb.leaderboard) assert.equal(tables.rating[row.player], row.rating, `trajectory for ${row.player.slice(0, 8)} ≠ ladder`);
});
