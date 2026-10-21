/** Settlement v4 (docs/SETTLEMENT-STANDARD.md): proof levels derived by the node, commitments and stats lifted from a
 *  court's signed report, the log held content-addressed and fetched by the custody set, verifier bundles granting
 *  `checkable`, stats folded per schema into an hourly root paired with the results root, and a court authorized by
 *  its title's manifest alone (no COURTS anywhere).
 *    node --test demo/settlement-v4.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createNode } from '../node/litnode.js';
import { ATTEST_TAG, MAX_LOG_BYTES } from '../node/settle.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import { createLog } from '../protocol/log.js';
import { resultHash, resultFields, proofOf } from '../protocol/result.js';
import { schemaProblem, cleanStats, foldStats, statsLeaves, statsLeaf } from '../protocol/stats.js';
import { buildTree, proofFor, verifyProof, anchorRoot, withStatsStep, withResultsStep } from '../protocol/epoch.js';
import { bundleTitle } from '../sdk/bundle.mjs';
import { packBundle, openBundle, bundleHash, serverHash, verifierHash, manifestProblem } from '../node/server-bundle.js';
import { until } from './lib/mesh.mjs';

const root = process.cwd();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-v4-'));
const nodes = [];
test.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, updates: false, ...opts }).then((n) => (nodes.push(n), n));
const post = (node, path, body, headers = {}) => fetch(`${node.addr}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const titlePath = (p) => join(root, p).replace(/\\/g, '/');

test('v4 pure: proof levels, versioned commitment, stats checks and folds, the paired root', () => {
  // proof is derived from evidence, never from a claim
  assert.equal(proofOf({ kind: 'replayable', attestation: 'players' }), 'verified');
  assert.equal(proofOf({ kind: 'replayable', attestation: 'relay' }), 'checkable');
  assert.equal(proofOf({ kind: 'replayable', attestation: 'host' }), 'host');
  const c = { inputsHash: 'a'.repeat(64), verifierHash: 'b'.repeat(64) };
  assert.equal(proofOf({ kind: 'attested', attestation: 'attested', commitments: c, logHeld: true, verifierActive: true }), 'checkable');
  assert.equal(proofOf({ kind: 'attested', attestation: 'attested', commitments: c, logHeld: false, verifierActive: true }), 'attested', 'no log held: attested');
  assert.equal(proofOf({ kind: 'attested', attestation: 'attested', commitments: c, logHeld: true, verifierActive: false }), 'attested', 'no registered verifier: attested');
  assert.equal(proofOf({ kind: 'attested', attestation: 'attested', commitments: null }), 'attested', 'a v3-shaped report');

  // a protocol-3 delta keeps its field set: extra v4 fields never move its hash
  const d3 = { protocol: 3, matchId: 'm', rulesetId: 'r.v1', buildHash: 'b', mode: 'casual', participants: ['a', 'b'], finalStateRoot: 'f', hydrationHash: 'h', scores: { a: 1, b: 0 }, attestation: 'host', hostId: 'x', epoch: 1 };
  assert.equal(resultHash(d3), resultHash({ ...d3, proof: 'host', stats: { a: { k: 1 } } }));
  assert.ok(!('proof' in resultFields(d3)));
  const d4 = { ...d3, protocol: 4, proof: 'host', stats: null, statsSchema: null };
  assert.notEqual(resultHash(d4), resultHash({ ...d4, stats: { a: { k: 1 } } }), 'v4 commits stats');
  assert.notEqual(resultHash(d4), resultHash({ ...d4, proof: 'attested' }), 'v4 commits proof');

  // schema and values
  assert.equal(schemaProblem({ rescued: 'sum', bestChain: 'max' }), null);
  assert.match(schemaProblem({ wins: 'sum' }), /reserved/);
  assert.match(schemaProblem({ '9x': 'sum' }), /must match/);
  assert.match(schemaProblem({ a: 'avg' }), /op must be/);
  assert.match(schemaProblem(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, 'sum']))), /at most 32/);
  const schema = { kos: 'sum', best: 'max', fastest: 'min', last: 'last' };
  assert.deepEqual(cleanStats({ a: { kos: 2, other: 9 } }, ['a', 'b'], schema), { a: { kos: 2 } }, 'only schema names');
  assert.equal(cleanStats({ a: { other: 1 } }, ['a'], schema), null);
  assert.throws(() => cleanStats({ a: { kos: -1 } }, ['a'], schema), /non-negative integer/);
  assert.throws(() => cleanStats({ a: { kos: 1.5 } }, ['a'], schema), /non-negative integer/);
  assert.throws(() => cleanStats({ z: { kos: 1 } }, ['a'], schema), /not a participant/);
  const folds = foldStats([{ stats: { a: { kos: 2, best: 5, fastest: 90, last: 1 } } }, { stats: { a: { kos: 3, best: 4, fastest: 70, last: 7 } } }], schema);
  assert.deepEqual(folds.a, { kos: 5, best: 5, fastest: 70, last: 7 });

  // the paired root: a results leaf and a stats leaf both prove against one anchored root
  const results = buildTree(['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)]);
  const leaves = statsLeaves({ 't.v1': folds }, 100);
  const stats = buildTree(leaves.map((l) => l.leaf));
  const anchored = anchorRoot(results.root, stats.root);
  assert.ok(verifyProof('22'.repeat(32), withStatsStep(proofFor(results, '22'.repeat(32)), stats.root), anchored));
  assert.ok(verifyProof(leaves[0].leaf, withResultsStep(proofFor(stats, leaves[0].leaf), results.root), anchored));
  assert.equal(leaves[0].leaf, statsLeaf('t.v1', 'a', folds.a, 100));
});

test('v4 verifier bundles: a third kind in its own hash domain, packed and opened like a server bundle', () => {
  const files = { 'verify.mjs': 'export function verify(log) { return { finalHash: "x", result: null }; }\n' };
  const v = packBundle({ rulesetId: 'flood-control.v1', entry: 'verify.mjs', exports: ['verify'] }, files, { kind: 'verifier' });
  assert.equal(v.manifest.kind, 'verifier');
  assert.equal(v.hash, verifierHash(v.tar));
  assert.notEqual(v.hash, serverHash(v.tar), 'the kind is in the hash domain');
  assert.equal(bundleHash('verifier', v.tar), v.hash);
  assert.equal(openBundle(v.gz, v.hash, { kind: 'verifier' }).manifest.rulesetId, 'flood-control.v1');
  assert.throws(() => openBundle(v.gz, v.hash), /hash mismatch|kind must be "server"/, 'a verifier never opens as a server');
  assert.match(manifestProblem({ kind: 'verifier', rulesetId: 'x.v1', entry: 'verify.mjs', portRange: [9000, 9001] }, files, { kind: 'verifier' }), /runs no server/);
  assert.throws(() => bundleHash('ruleset', v.tar), /unknown bundle kind/);
});

test('v4 node: a court authorized by its manifest alone settles v3- and v4-shaped reports; the log is held, served and fetched by the custody set; a registered verifier makes it checkable', { timeout: 120_000 }, async () => {
  const court = await generateKeypair(), stranger = await generateKeypair();
  const src = join(tmp, 'v4court.v1.mjs');
  writeFileSync(src, `import { defineAttestedTitle, eloLeaderboard } from '${titlePath('titles/title.js')}';
export default defineAttestedTitle({
  rulesetId: 'v4court.v1', modes: ['casual', 'ranked'], participants: [2], teams: 2,
  services: { leaderboard: eloLeaderboard(), stats: { track: ['matches', 'wins', 'ticks'], schema: { rescued: 'sum', bestChain: 'max' } } },
  attestors: ['${court.publicKey}'],
  validate: (r) => (r && (r.winner === 0 || r.winner === 1 || r.winner === null) ? null : 'winner must be 0, 1 or null'),
  scores: (r, participants) => Object.fromEntries(participants.map((p, i) => [p, r.winner === i ? 1 : 0])),
  display: { title: 'V4 Court' },
});
`);
  const ruleset = join(tmp, 'v4court.v1.js');
  writeFileSync(ruleset, await bundleTitle(src));
  const verifierTar = Buffer.from('a stand-in verifier bundle');
  const verifierHash = createHash('sha256').update('verifier\0').update(verifierTar).digest('hex');

  // No COURTS on either node: the manifest's attestors are enough. The host accepts this verifier (VERIFIERS); so does
  // the witness — each checks for itself.
  const verifiers = { 'v4court.v1': [verifierHash] };
  const host = await spawn({ operator: 'studio', roles: ['mesh', 'settler'], rulesets: [ruleset], verifiers });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], rulesets: [ruleset], seeds: [host.addr], verifiers });
  assert.equal((await (await fetch(`${host.addr}/health`)).json()).settlement.v, 4);
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/peers`)).json()).peers.some((p) => p.nodeId === wit.nodeId), 15_000), 'host sees the witness');

  const P = ['pa', 'pb'];
  const envelope = async (matchId, report, key = court) => ({
    kind: 'attested', matchId, rulesetId: 'v4court.v1', mode: 'casual', participants: P, teams: [['pa'], ['pb']], report,
    attestor: { id: key.publicKey, sig: await sign(ATTEST_TAG, { matchId, rulesetId: 'v4court.v1', report }, key.privateKey) },
  });

  // 1. v3-shaped: no commitments. Settles at `attested`; stats from the report, schema names only.
  let r = await post(host, '/ledger', await envelope('v3-1', { winner: 0, ticks: 100, stats: { pa: { rescued: 4, bestChain: 2, junk: 9 }, pb: { rescued: 1 } } }));
  let d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.protocol, 4); assert.equal(d.proof, 'attested'); assert.equal(d.commitments, null);
  assert.deepEqual(d.stats, { pa: { bestChain: 2, rescued: 4 }, pb: { rescued: 1 } });
  assert.deepEqual(d.statsSchema, { rescued: 'sum', bestChain: 'max' });
  assert.equal(d.resultHash, resultHash(d));

  // a stranger's valid signature is still not a court's word
  r = await post(host, '/ledger', await envelope('v3-x', { winner: 0, ticks: 1 }, stranger));
  assert.equal(r.status, 400); assert.match((await r.json()).error, /not an authorized court/);

  // 2. v4: commitments + log + a registered verifier → checkable; the log is served by hash.
  const logBytes = Buffer.from(JSON.stringify({ format: 'arc-runlog@1', cmds: Array.from({ length: 50 }, (_, i) => ({ hour: i, cmd: i % 3 })) }));
  const inputsHash = sha(logBytes);
  const commitments = { logFormat: 'arc-runlog@1', inputsHash, finalHash: 'f00d', verifierHash };
  r = await post(host, '/ledger', { ...(await envelope('v4-1', { winner: 1, ticks: 200, commitments, stats: { pa: { rescued: 2, bestChain: 7 }, pb: { rescued: 5, bestChain: 1 } } })), log: logBytes.toString('base64') });
  d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.proof, 'checkable');
  assert.deepEqual(d.commitments, commitments);
  const served = await fetch(`${host.addr}/log/${inputsHash}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), logBytes);
  assert.equal((await fetch(`${host.addr}/log/${'0'.repeat(64)}`)).status, 404);
  const ledger = await (await fetch(`${host.addr}/ledger/v4-1`)).json();
  assert.equal(ledger.log, undefined, 'the stored ledger never carries the log bytes');

  // the custody set (here: the witness) fetches the log, recomputes `checkable` itself, and co-signs
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/v4-1`)).json()).cosigners.length === 1, 30_000), 'the witness co-signs the checkable result');
  assert.ok(existsSync(join(tmp, 'guild-a', 'logs', inputsHash)), 'and holds the log');
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/v3-1`)).json()).cosigners.length === 1, 30_000), 'a v3-shaped attested result is custodied too');

  // 3. the same report without a registered verifier is only attested
  const unregistered = { ...commitments, verifierHash: 'c'.repeat(64) };
  r = await post(host, '/ledger', { ...(await envelope('v4-2', { winner: 0, ticks: 1, commitments: unregistered })), log: logBytes.toString('base64') });
  assert.equal((await r.json()).proof, 'attested');

  // 4. refusals: a log that does not hash to the commitment, a log with no commitment, a log too large, a bad stat
  const bad = async (id, report, extra = {}) => { const x = await post(host, '/ledger', { ...(await envelope(id, report)), ...extra }); return [x.status, (await x.json()).error]; };
  let [code, err] = await bad('bad-1', { winner: 0, commitments }, { log: Buffer.from('other bytes').toString('base64') });
  assert.equal(code, 400); assert.match(err, /does not match commitments.inputsHash/);
  [code, err] = await bad('bad-2', { winner: 0 }, { log: logBytes.toString('base64') });
  assert.equal(code, 400); assert.match(err, /needs report.commitments.inputsHash/);
  const huge = Buffer.alloc(MAX_LOG_BYTES + 1, 1);
  [code, err] = await bad('bad-3', { winner: 0, commitments: { ...commitments, inputsHash: sha(huge) } }, { log: huge.toString('base64') });
  assert.equal(code, 400); assert.match(err, /exceeds/);
  [code, err] = await bad('bad-4', { winner: 0, stats: { pa: { rescued: -1 } } });
  assert.equal(code, 400); assert.match(err, /non-negative integer/);
  [code, err] = await bad('bad-5', { winner: 0, commitments: { inputsHash: 'XYZ' } });
  assert.equal(code, 400); assert.match(err, /64 lowercase hex/);

  // 5. stats fold into the title's tables, and prove against this node's local hour root
  const st = await (await fetch(`${host.addr}/stats?ruleset=v4court.v1&scope=all`)).json();
  assert.equal(st.pa.rescued, 6); assert.equal(st.pa.bestChain, 7); assert.equal(st.pb.rescued, 6);
  const sp = await (await fetch(`${host.addr}/proof/stats?ruleset=v4court.v1&player=pa`)).json();
  assert.deepEqual(sp.stats, { bestChain: 7, rescued: 6 });
  assert.equal(sp.source, 'local');
  assert.ok(verifyProof(sp.leaf, sp.path, sp.root), 'the stats leaf proves against the hour root');
  const ep = await (await fetch(`${host.addr}/epoch`)).json();
  assert.equal(ep.root, sp.root); assert.equal(ep.root, anchorRoot(ep.resultsRoot, ep.statsRoot));
  const mp = await (await fetch(`${host.addr}/proof/v4-1`)).json();
  assert.equal(mp.proof, 'checkable');
  assert.ok(verifyProof(mp.leaf, mp.path, mp.root), 'a results leaf proves against the same root');
});

test('v4 node: a replayable title computes stats(state) in the sandbox and commits them', { timeout: 120_000 }, async () => {
  const dir = join(tmp, 'tug-src');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(root, 'tools', 'create-title.mjs'), 'tug-v4.v1', 'Tug V4', '--out', dir], { cwd: root });
  const ruleset = join(tmp, 'tug-v4.v1.js');
  writeFileSync(ruleset, await bundleTitle(join(dir, 'tug-v4.v1.mjs')));
  const host = await spawn({ operator: 'tug-host', roles: ['mesh', 'host'], rulesets: [ruleset] });
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const log = createLog();
  for (let k = 0; k < 40; k++) log.append([k % 2 ? 1 : 0, k % 3 ? 0 : 1]);
  const r = await post(host, '/ledger', { matchId: 'tug-1', rulesetId: 'tug-v4.v1', mode: 'casual', participants: [a, b], entries: log.entries() });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.proof, 'host', 'unsigned casual: one node\'s word');
  assert.deepEqual(Object.keys(d.stats).sort(), [a, b].sort());
  assert.equal(d.stats[a].pulls, 20); assert.equal(d.stats[b].pulls, 14);
  assert.ok(Number.isInteger(d.stats[a].bestPull));
  assert.deepEqual(d.statsSchema, { pulls: 'sum', bestPull: 'max' });
  assert.equal(d.resultHash, resultHash(d));
  // host-level results fold into the casual tables but never into the stats root
  const st = await (await fetch(`${host.addr}/stats?ruleset=tug-v4.v1&scope=all`)).json();
  assert.equal(st[a].pulls, 20);
  assert.equal((await fetch(`${host.addr}/proof/stats?ruleset=tug-v4.v1&player=${a}`)).status, 404);
});
