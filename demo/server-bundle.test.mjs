/** Server bundles (node/server-bundle.js): a gauntlet title's match server as a hashed artifact.
 *
 *    the publisher packs its server → registers the hash under the title → serves it from its node →
 *    an operator's node that OPTED IN (GAUNTLET_SERVERS=<id>) fetches it from the mesh by hash, verifies the
 *    hash and the publisher's word, unpacks it under its data dir, and runs it for the matches it hosts;
 *    a node that did not opt in never fetches; an unvouched bundle is refused; a cached bundle is re-held on
 *    restart without any peer.
 *
 *  The last test runs the real tool over an Agent Fighter checkout and plays a bundled match with the title's
 *  own bots; it is skipped without the checkout (demo/lib/af-bot.mjs) or esbuild.
 *    node --test demo/server-bundle.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { packTar, unpackTar, packBundle, openBundle, serverHash, manifestProblem, pathProblem, parseServerOptIns, configFromBundle, runtimeOk, gzip } from '../node/server-bundle.js';
import { generateKeypair, seal, sign } from '../protocol/keys.js';
import { QUEUE_TAG, bucketOf, roomCodeFor } from '../protocol/pairing.js';
import { signSeat } from '../protocol/challenge.js';
import { AF, haveAf, claimSeat, runBot } from './lib/af-bot.mjs';

const ROOT = process.cwd();
const PB = join(ROOT, 'rulesets', 'pickle-brawl.v1.js');
const RID = 'pickle-brawl.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(100); } return false; };
const wsClient = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url); const got = [];
  setTimeout(() => rej(new Error(`ws ${url}: no open within 10 s`)), 10_000).unref?.();
  ws.onopen = () => res({ ws, got, send: (t) => ws.send(t), next: (pred = () => true, ms = 10_000) => until(() => got.some(pred), ms).then((ok) => ok ? got.find(pred) : null) });
  ws.onmessage = (e) => got.push(String(e.data));
  ws.onerror = () => rej(new Error(`ws ${url} failed`));
});

/** The stand-in bundle: the fixture server with protocol/keys.js + canonical.js beside it. */
const standIn = (extra = {}) => packBundle({ rulesetId: RID, entry: 'run.mjs', runtime: { node: '>=20' }, env: { STAND_IN: 'yes' }, portRange: [7870, 7879], readyMs: 20_000, ttlMs: 60_000, ticketTtlMs: 60_000, settledGraceMs: 500, builtAt: '2026-10-19T00:00:00.000Z', ...extra }, {
  'run.mjs': "import './server/bundled-server.mjs';\n",
  'package.json': '{ "type": "module" }\n', // the .js files beside it are ES modules (a bundle has no litnode package.json above it)
  'server/bundled-server.mjs': readFileSync(join(ROOT, 'demo', 'fixtures', 'bundled-server.mjs'), 'utf8').replace("'./protocol/keys.js'", "'../protocol/keys.js'"),
  'protocol/keys.js': readFileSync(join(ROOT, 'protocol', 'keys.js')),
  'protocol/canonical.js': readFileSync(join(ROOT, 'protocol', 'canonical.js')),
});
/** sidecar + file on disk as tools/bundle-server.mjs + sign-build.mjs leave them */
const writeBundle = async (dir, b, publisher = null) => {
  mkdirSync(dir, { recursive: true });
  const tgz = join(dir, `${RID}.server.tgz`);
  writeFileSync(tgz, b.gz);
  const att = publisher ? { publisher: publisher.publicKey, sig: await sign('build', { rulesetId: RID, buildHash: b.hash }, publisher.privateKey) } : {};
  writeFileSync(join(dir, `${RID}.server.json`), JSON.stringify({ kind: 'server', rulesetId: RID, serverHash: b.hash, ...att }));
  return tgz;
};

test('server bundle: a deterministic tar round-trips; paths are checked; the manifest is checked; the hash is over the tar, tagged', () => {
  const files = { 'b/two.txt': 'two', 'a.txt': Buffer.from('one'), 'manifest.json': '{}', ['x/'.repeat(60) + 'deep.txt']: 'deep' };
  const tar = packTar(files);
  assert.equal(tar.length % 512, 0);
  assert.equal(packTar(files).equals(tar), true, 'the same files give the same bytes');
  assert.equal(packTar({ 'a.txt': 'one', 'b/two.txt': 'two', 'manifest.json': '{}', ['x/'.repeat(60) + 'deep.txt']: 'deep' }).equals(tar), true, 'insertion order does not matter');
  const back = unpackTar(tar);
  assert.deepEqual(Object.keys(back), Object.keys(files).sort());
  assert.equal(back['b/two.txt'].toString(), 'two'); assert.equal(back['x/'.repeat(60) + 'deep.txt'].toString(), 'deep', 'a long path uses the ustar prefix');
  assert.throws(() => packTar({ '../escape': 'x' }), /bad path segment/);
  assert.throws(() => packTar({ '/abs': 'x' }), /absolute/);
  assert.throws(() => packTar({ 'a\\b': 'x' }), /backslash/);
  for (const [p, why] of [['', 'empty'], ['a/./b', 'segment'], ['a//b', 'segment']]) assert.match(pathProblem(p), new RegExp(why));
  // A hand-made header with a symlink type refuses the archive; a corrupted checksum too.
  const bad = Buffer.from(tar); bad.write('2', 156); assert.throws(() => unpackTar(bad), /not a regular file|checksum/);
  const corrupt = Buffer.from(tar); corrupt[0] ^= 1; assert.throws(() => unpackTar(corrupt), /checksum/);
  assert.equal(serverHash(tar), serverHash(Buffer.from(tar)));
  assert.notEqual(serverHash(tar), serverHash(packTar({ 'a.txt': 'one!' })));
  // manifest
  const ok = { kind: 'server', rulesetId: 'x.v1', entry: 'run.mjs' };
  assert.equal(manifestProblem(ok, { 'run.mjs': true }), null);
  assert.match(manifestProblem({ ...ok, kind: 'ruleset' }), /kind/);
  assert.match(manifestProblem({ ...ok, rulesetId: 'Nope' }), /rulesetId/);
  assert.match(manifestProblem({ ...ok, entry: '../run.mjs' }), /entry/);
  assert.match(manifestProblem({ ...ok, entry: 'run.ts' }), /entry must be/);
  assert.match(manifestProblem(ok, { 'other.mjs': true }), /not in the archive/);
  assert.match(manifestProblem({ ...ok, env: { OPERATOR_KEY: 'x' } }), /operator secret/);
  assert.match(manifestProblem({ ...ok, env: { lower: 'x' } }), /UPPER_SNAKE/);
  assert.match(manifestProblem({ ...ok, portRange: [80, 90] }), /portRange/);
  assert.match(manifestProblem({ ...ok, runtime: { node: '22' } }), /runtime/);
  assert.equal(runtimeOk({ runtime: { node: '>=20' } }, '22.1.0'), true); assert.equal(runtimeOk({ runtime: { node: '>=30' } }, '22.1.0'), false); assert.equal(runtimeOk({}), true);
  // openBundle: hash pinned, then content
  const b = packBundle({ rulesetId: 'x.v1', entry: 'run.mjs' }, { 'run.mjs': 'console.log(1)' });
  assert.equal(openBundle(b.gz, b.hash).manifest.rulesetId, 'x.v1');
  assert.throws(() => openBundle(b.gz, 'f'.repeat(64)), /hash mismatch/);
  assert.throws(() => openBundle(Buffer.from('nope')), /not a gzip/);
  const noManifest = gzip(packTar({ 'run.mjs': 'x' }));
  let err; try { openBundle(noManifest); } catch (e) { err = e; }
  assert.match(err.message, /no manifest/); assert.equal(err.permanent, true, 'a bundle wrong in its own bytes is refused for good');
  assert.throws(() => packBundle({ rulesetId: 'x.v1', entry: 'missing.mjs' }, { 'run.mjs': '' }), /not in the archive/);
  // opt-ins and the config a bundle becomes
  assert.deepEqual(parseServerOptIns('agent-fighter.v1, pickle-brawl.v1=C:/x/pb.tgz', { root: '/r' }), { 'agent-fighter.v1': null, 'pickle-brawl.v1': 'C:/x/pb.tgz' });
  assert.deepEqual(parseServerOptIns('a.v1=servers/a.tgz', { root: '/r' }), { 'a.v1': '/r/servers/a.tgz' });
  assert.throws(() => parseServerOptIns('Agent Fighter'), /not a rulesetId/);
  assert.deepEqual(parseServerOptIns(''), {});
  const cfg = configFromBundle({ dir: '/d', manifest: { entry: 'run.mjs', env: { A: '${port}' }, portRange: [1, 2] }, hash: 'h' }, { stateDir: '/s' });
  assert.equal(cfg.command, '${node}'); assert.equal(cfg.cwd, '/d'); assert.deepEqual(cfg.portRange, [1, 2]); assert.equal(cfg.stateDir, '/s'); assert.equal(cfg.bundle, 'h'); assert.equal(cfg.readyMs, 60_000);
});

test('server bundle: an operator node that opted in fetches the publisher\'s bundle by hash, verifies it, and hosts a placed match with it; a node without the opt-in never fetches; an unvouched bundle is refused; a restart re-holds from disk', { timeout: 180_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'lit-sb-'));
  const publisher = await generateKeypair(); // the key that vouches for the bundle (TRUSTED_PUBLISHERS on the operator's node)
  const court = await generateKeypair();     // the operator node's own court key, provisioned in the bundle's state dir
  const bundle = standIn();
  const tgz = await writeBundle(join(tmp, 'pub'), bundle, publisher);
  const nodes = [];
  const stopAll = async () => { for (const n of nodes.splice(0)) await n.stop().catch(() => {}); };
  t.after(async () => { await stopAll(); rmSync(tmp, { recursive: true, force: true }); });

  // The publisher's node: serves the bundle (and could run it, but has no host role, so placements go elsewhere).
  const pub = await createNode({ dataDir: join(tmp, 'pubnode'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'witness'], rulesets: [PB], gauntletServers: { [RID]: tgz }, gauntletPort: 0 });
  nodes.push(pub);
  const ph = await (await fetch(`${pub.addr}/health`)).json();
  assert.equal(ph.gauntletServers.current[RID].serverHash, bundle.hash); assert.equal(ph.gauntletServers.current[RID].origin, 'local');
  assert.deepEqual(ph.gauntlet.titles, [RID], 'the publisher node runs the title as a gauntlet from its own bundle');
  assert.equal(ph.gauntlet.bundles[RID], bundle.hash);
  assert.ok(existsSync(join(tmp, 'pubnode', 'servers', bundle.hash, 'manifest.json')), 'unpacked under the data dir by hash');
  const served = await fetch(`${pub.addr}/server/${RID}?build=${bundle.hash}`);
  assert.equal(served.headers.get('x-build-hash'), bundle.hash); assert.equal(served.headers.get('x-build-publisher'), publisher.publicKey);
  assert.equal(openBundle(Buffer.from(await served.arrayBuffer()), bundle.hash).manifest.env.STAND_IN, 'yes');
  assert.equal((await fetch(`${pub.addr}/server/${RID}?build=${'0'.repeat(64)}`)).status, 404);
  assert.equal((await (await fetch(`${pub.addr}/server/${RID}?manifest=1`)).json()).manifest.entry, 'run.mjs');

  // The operator's node: opted in, trusts the publisher's key, has the court key in the state dir the bundle gets.
  mkdirSync(join(tmp, 'op', 'gauntlet-state', RID), { recursive: true });
  writeFileSync(join(tmp, 'op', 'gauntlet-state', RID, 'court.json'), JSON.stringify(court));
  const opOpts = { dataDir: join(tmp, 'op'), offline: true, heartbeatMs: 200, operator: 'guild', roles: ['mesh', 'host', 'witness', 'settler'], rulesets: [PB], courts: { [RID]: [court.publicKey] }, gauntletServers: { [RID]: null }, trustedPublishers: [publisher.publicKey], gauntletPort: 0, seeds: [pub.addr] };
  let op = await createNode(opOpts);
  nodes.push(op);
  assert.deepEqual((await (await fetch(`${op.addr}/health`)).json()).gauntlet.titles, [], 'opted in, nothing held yet: no gauntlet to advertise');
  assert.ok(await until(() => op.servers().current[RID]?.serverHash === bundle.hash, 30_000), `fetched from the publisher's node: ${JSON.stringify(op.servers())}`);
  assert.equal(op.servers().current[RID].origin, 'peer'); assert.equal(op.servers().current[RID].publisher, publisher.publicKey);
  assert.ok(existsSync(join(tmp, 'op', 'servers', `${bundle.hash}.tgz`)) && existsSync(join(tmp, 'op', 'servers', bundle.hash, 'server', 'bundled-server.mjs')), 'the bytes and the unpacked tree, by hash');
  assert.deepEqual((await (await fetch(`${op.addr}/health`)).json()).gauntlet.titles, [RID], 'the title joined the gauntlets this node runs');
  assert.ok(await until(async () => { const s = await (await fetch(`${pub.addr}/snapshot?envelopes=1`)).json(); const b = s.envelopes.find((e) => e.body.nodeId === op.nodeId)?.body; return b?.gauntlets?.[0] === RID && b?.servers?.[RID] === bundle.hash; }, 20_000), 'the operator node advertises the title and the hash');

  // A third node, NOT opted in, holds the title's ruleset and hears the same heartbeats: it never fetches.
  const bystander = await createNode({ dataDir: join(tmp, 'by'), offline: true, heartbeatMs: 200, operator: 'other', roles: ['mesh', 'host'], rulesets: [PB], trustedPublishers: [publisher.publicKey], seeds: [pub.addr] });
  nodes.push(bystander);
  await sleep(1500);
  assert.equal(existsSync(join(tmp, 'by', 'servers', `${bundle.hash}.tgz`)), false, 'no opt-in, no fetch');
  assert.equal((await (await fetch(`${bystander.addr}/health`)).json()).gauntletServers, null);
  // A fourth node, opted in but trusting nobody and with no registry: the bundle is refused, remembered, not run.
  const wary = await createNode({ dataDir: join(tmp, 'wary'), offline: true, heartbeatMs: 200, operator: 'wary', roles: ['mesh', 'host'], rulesets: [PB], trustedPublishers: [], titleTrust: 'open', gauntletServers: { [RID]: null }, gauntletPort: 0, seeds: [pub.addr] });
  nodes.push(wary);
  assert.ok(await until(() => Object.keys(wary.servers().refused).includes(bundle.hash), 20_000), 'refused for trust');
  assert.match(wary.servers().refused[bundle.hash], /not signed by a trusted publisher/);
  assert.equal(existsSync(join(tmp, 'wary', 'servers', `${bundle.hash}.tgz`)), false, 'nothing written for a refused bundle (TITLE_TRUST=open does not admit a server)');
  assert.deepEqual((await (await fetch(`${wary.addr}/health`)).json()).gauntlet.titles, []);
  // A bundle whose bytes verify but whose manifest names ANOTHER title is refused for good.
  const wrong = standIn({ rulesetId: 'other.v1' });
  await assert.rejects(op.installServer(wrong.gz, wrong.hash, { rulesetId: RID, origin: 'peer' }), /is other.v1's, not pickle-brawl.v1's/);
  await assert.rejects(op.installServer(wrong.gz, 'a'.repeat(64)), /hash mismatch/);

  // A placement on the operator node: two players queue there; the mesh draws the node that runs the server.
  const [p1, p2] = await Promise.all([generateKeypair(), generateKeypair()]);
  const bucket = bucketOf(Date.now());
  for (const kp of [p1, p2]) {
    const env = await seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: RID, tokenId: '1', mode: 'casual', bucket, region: 'lan' }, kp);
    const r = await fetch(`${op.addr}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
    assert.ok(r.status === 200 || r.status === 202, `queue: ${r.status}`);
  }
  let match = null;
  assert.ok(await until(async () => { match = (await (await fetch(`${op.addr}/match?playerId=${p1.publicKey}`)).json()).matches?.[0] ?? null; return !!match; }, 40_000), 'placed');
  assert.equal(match.host, op.nodeId, 'the node that runs the bundled server hosts it (not the publisher, not the bystander)');
  const room = roomCodeFor(match.matchId);
  assert.ok(await until(() => op.gauntlet.status().active.some((a) => a.matchId === match.matchId && a.state === 'up'), 30_000), `the bundled server is up: ${JSON.stringify(op.gauntlet.status())}`);
  const run = op.gauntlet.active.get(match.matchId);
  const about = await (await fetch(`http://127.0.0.1:${run.port}/`)).json();
  assert.equal(about.bundled, true); assert.equal(about.server, bundle.hash, 'the process knows which bundle it is (GAUNTLET_SERVER)'); assert.equal(about.court, court.publicKey, 'it found the court key in its state dir');
  assert.equal(about.cwd.replace(/\\/g, '/'), join(tmp, 'op', 'servers', bundle.hash).replace(/\\/g, '/'), 'runs from the unpacked bundle');
  assert.ok(about.argv1.endsWith('run.mjs'));
  // Seats, traffic, the outcome report, settlement, the process gone.
  const gw = `http://127.0.0.1:${op.gauntlet.port}`;
  const claim = async (kp) => { const { challenge } = await (await fetch(`${gw}/${room}/ticket?player=${kp.publicKey}`)).json(); const sig = await signSeat(challenge, kp.privateKey); return (await fetch(`${gw}/${room}/ticket?player=${kp.publicKey}&nonce=${challenge.nonce}&sig=${sig}`)).json(); };
  const [t1, t2] = [await claim(p1), await claim(p2)];
  const c1 = await wsClient(t1.ws); c1.send(JSON.stringify({ ticket: t1.ticket }));
  assert.equal(await c1.next((m) => m.startsWith('seated:')), `seated:${p1.publicKey}:${t1.team}:0:singles`);
  const c2 = await wsClient(t2.ws); c2.send(JSON.stringify({ ticket: t2.ticket }));
  assert.equal(await c2.next((m) => m.startsWith('seated:')), `seated:${p2.publicKey}:${t2.team}:0:singles`);
  c1.send('hi'); assert.equal(await c2.next((m) => m === 'echo:hi'), 'echo:hi');
  c1.send('end:11-6');
  assert.equal(await c1.next((m) => m.startsWith('settled:')), 'settled:200:attested');
  const delta = await (await fetch(`${op.addr}/delta/${match.matchId}`)).json();
  assert.equal(delta.attestation, 'attested'); assert.equal(delta.attestor, court.publicKey); assert.equal(delta.placed, true);
  assert.equal(delta.scores[match.participants[0]], 11);
  assert.ok(await until(() => !op.gauntlet.status().active.some((a) => a.state === 'up'), 10_000), 'the process is gone once the match settled');
  for (const c of [c1, c2]) c.ws.close();

  // Restart the operator node with the publisher GONE: the bundle is re-held from disk and current again.
  await pub.stop(); nodes.splice(nodes.indexOf(pub), 1);
  await op.stop(); nodes.splice(nodes.indexOf(op), 1);
  op = await createNode({ ...opOpts, seeds: [] });
  nodes.push(op);
  assert.equal(op.servers().current[RID]?.serverHash, bundle.hash, 're-held from the data dir, no peer needed');
  assert.equal(op.servers().current[RID].origin, 'cache');
  assert.deepEqual((await (await fetch(`${op.addr}/health`)).json()).gauntlet.titles, [RID]);
});

test('server bundle: npm run bundle:server packs Agent Fighter\'s real server; a second node fetches it by hash and plays a match with the title\'s own bots', { skip: !haveAf && `no Agent Fighter checkout with node_modules at ${AF}`, timeout: 420_000 }, async (t) => {
  const { bundleServer } = await import('../tools/bundle-server.mjs');
  const shipped = JSON.parse(readFileSync(join(ROOT, 'gauntlets', 'agent-fighter.server.json'), 'utf8'));
  // The bots play faster than real time, which Agent Fighter's pace limits stop: past 20x the server drops a PvP
  // input, the lockstep bots wait on it, and the 30 s idle check settles the match 'incomplete'. AF_NO_PACE_CHECK
  // lifts them, and it rides in THIS test's bundle: a title's process inherits only the OS basics (node/gauntlet.js
  // INHERITED_ENV, since 0.12.0) and a bundle passes only its manifest's env, so the flag in this process never
  // reached the server. The shipped spec leaves it out: those limits guard every operator's matches.
  assert.equal(shipped.env?.AF_NO_PACE_CHECK, undefined, 'the shipped spec keeps Agent Fighter\'s pace limits on');
  const spec = { ...shipped, env: { ...shipped.env, AF_NO_PACE_CHECK: '1' } };
  const tmp = mkdtempSync(join(tmpdir(), 'lit-sbaf-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes.splice(0)) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const b = await bundleServer(spec, { checkout: AF });
  assert.ok(b.files.includes('run.mjs') && b.files.includes('packages/server/src/gauntlet-server.mjs'), `bundled at the entry's own path: ${b.files.slice(0, 4)}`);
  assert.ok(b.files.some((f) => /^characters\/[^/]+\/character\.json$/.test(f)), 'the character JSON the server reads rides along');
  assert.ok(!b.files.some((f) => /\.(png|webp|wav|ogg)$/.test(f)), 'no sprites: the server never reads them');
  const again = await bundleServer(spec, { checkout: AF });
  assert.equal(again.hash, b.hash, 'the same checkout and esbuild give the same serverHash: the tar is deterministic');
  const publisher = await generateKeypair();
  const dir = join(tmp, 'pub'); mkdirSync(dir, { recursive: true });
  const tgz = join(dir, 'agent-fighter.v1.server.tgz');
  writeFileSync(tgz, b.gz);
  writeFileSync(join(dir, 'agent-fighter.v1.server.json'), JSON.stringify({ kind: 'server', rulesetId: 'agent-fighter.v1', serverHash: b.hash, publisher: publisher.publicKey, sig: await sign('build', { rulesetId: 'agent-fighter.v1', buildHash: b.hash }, publisher.privateKey) }));
  const RULESET = join(ROOT, 'rulesets', 'agent-fighter.v1.js');
  const pub = await createNode({ dataDir: join(tmp, 'pubnode'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'witness'], rulesets: [RULESET], gauntletServers: { 'agent-fighter.v1': tgz }, gauntletPort: 0 });
  nodes.push(pub);
  // The operator: no checkout, no config file, just the opt-in. The bundle it fetches carries its own env.
  const op = await createNode({ dataDir: join(tmp, 'op'), offline: true, heartbeatMs: 200, operator: 'guild', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET], gauntletServers: { 'agent-fighter.v1': null }, trustedPublishers: [publisher.publicKey], gauntletPort: 0, seeds: [pub.addr] });
  nodes.push(op);
  assert.ok(await until(() => op.servers().current['agent-fighter.v1']?.serverHash === b.hash, 60_000), `fetched: ${JSON.stringify(op.servers())}`);
  const [p1, p2] = await Promise.all([generateKeypair(), generateKeypair()]);
  const bucket = bucketOf(Date.now());
  for (const kp of [p1, p2]) {
    const env = await seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: 'agent-fighter.v1', tokenId: '1', mode: 'ranked', bucket, region: 'lan' }, kp);
    const r = await fetch(`${op.addr}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
    assert.ok(r.status === 200 || r.status === 202, `queue: ${r.status}`);
  }
  let match = null;
  assert.ok(await until(async () => { match = (await (await fetch(`${op.addr}/match?playerId=${p1.publicKey}`)).json()).matches?.[0] ?? null; return !!match; }, 40_000), 'placed');
  assert.equal(match.host, op.nodeId);
  const room = roomCodeFor(match.matchId);
  assert.ok(await until(() => op.gauntlet.status().active.some((a) => a.matchId === match.matchId && a.state === 'up'), 90_000), `Agent Fighter's bundled server is up: ${JSON.stringify(op.gauntlet.status())}`);
  const gw = `http://127.0.0.1:${op.gauntlet.port}`;
  const [s1, s2] = await Promise.all([claimSeat(gw, room, p1), claimSeat(gw, room, p2)]);
  const [r1, r2] = await Promise.all([
    runBot({ kp: p1, ws: s1.ws, ticket: s1.ticket, room, name: 'P1', char: 'analog', seed: 11, match }),
    runBot({ kp: p2, ws: s2.ws, ticket: s2.ticket, room, name: 'P2', char: 'vector', seed: 22, match }),
  ]);
  assert.equal(r1.reason, 'verified'); assert.equal(r2.reason, 'verified');
  let delta = null;
  assert.ok(await until(async () => { const r = await fetch(`${op.addr}/delta/${match.matchId}`); if (r.ok) delta = await r.json(); return !!delta?.matchId; }, 60_000), 'settled on the operator node');
  assert.equal(delta.attestation, 'players'); assert.equal(delta.placed, true); assert.equal(delta.complete, true);
  assert.equal(delta.head, r1.signedHead);
  assert.ok(await until(() => !op.gauntlet.status().active.some((a) => a.matchId === match.matchId && a.state === 'up'), 30_000), 'the per-match server ended');
});
