/** The verifier runner (node/verifier.js; docs/SETTLEMENT-ARCHITECTURE.md §4, Amendment 1 B1): a witness or custodian
 *  re-runs an attested result's committed log with the title's verifier bundle and co-signs only what it reproduces.
 *
 *    - pure: the judge (finalHash only), the manifest ceilings
 *    - the child: network builtins refused, writes denied, a spin killed at the deadline (a runner failure, never a
 *      dispute), a title's `refused:` counted against the court
 *    - the mesh: the publisher's node serves its bundle (VERIFIER_BUNDLES) and advertises it; the custodian fetches it
 *      by hash, co-signs the honest result as `verifier`, disputes the forged one with reason `verifier: …`
 *    - FLOOD CONTROL: its real bundle (56cfff04) on a real run (demo/fixtures/flood-control-run.json) agrees with the
 *      court's finalHash and refuses a forged one. Needs the game checkout (FC_ROOT); skipped otherwise.
 *    node --test demo/verifier.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createNode } from '../node/litnode.js';
import { ATTEST_TAG } from '../node/settle.js';
import { packBundle } from '../node/server-bundle.js';
import { createVerifiers, judge, runtimeProblem, limitsOf, disputeHash, CEILINGS } from '../node/verifier.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import { bundleTitle } from '../sdk/bundle.mjs';
import { until } from './lib/mesh.mjs';

const root = process.cwd();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-verifier-'));
const nodes = [];
test.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, updates: false, ...opts }).then((n) => (nodes.push(n), n));
const post = (node, path, body) => fetch(`${node.addr}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const titlePath = (p) => join(root, p).replace(/\\/g, '/');

// A stand-in verifier: the log is JSON { format: 'demo-log@1', cmds: [n…] }, the judged result their sum.
const DEMO_VERIFY = `import { createHash } from 'node:crypto';
export async function verify(bytes) {
  const log = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (log.format !== 'demo-log@1') throw new Error('refused: not a demo log');
  const sum = log.cmds.reduce((a, c) => a + c, 0);
  return { finalHash: createHash('sha256').update('final\\0' + sum).digest('hex'), result: { sum } };
}
`;
const demoFinal = (cmds) => sha(`final\0${cmds.reduce((a, c) => a + c, 0)}`);
const pack = (rulesetId, source, runtime = { node: '>=20' }) => packBundle({ rulesetId, entry: 'verify.mjs', exports: ['verify'], logFormat: 'demo-log@1', runtime, source: { entry: 'verify.mjs' } }, { 'verify.mjs': source }, { kind: 'verifier' });
const store = (dir) => { const m = new Map(); return { hasLog: (h) => m.has(h), readLog: (h) => m.get(h), holdLog: (b, h) => { if (sha(b) !== h) throw new Error('mismatch'); m.set(h, b); }, m, dir }; };

test('judge: agreement is the committed finalHash; a refusal or another hash disagrees', () => {
  const report = { winner: 0, points: 27, commitments: { finalHash: 'aa', inputsHash: 'b'.repeat(64), verifierHash: 'c'.repeat(64) } };
  assert.deepEqual(judge(report, { ok: true, finalHash: 'aa', result: { points: 0.27 } }), { ok: true, reason: null, fields: [] }, 'units may differ: only the commitment is compared');
  assert.match(judge(report, { ok: true, finalHash: 'ab' }).reason, /finalHash differs/);
  assert.match(judge(report, { ok: false, error: 'refused: header' }).reason, /refused the log \(refused: header\)/);
  assert.equal(judge(report, null).ok, false);
  assert.notEqual(disputeHash('r'.repeat(64), 'ab'), 'r'.repeat(64), 'a verifier dispute never attests the disputed hash');
});

test('manifest: verify() exported, limits within the ceilings, defaults when absent', () => {
  assert.equal(runtimeProblem({ exports: ['verify'], runtime: { node: '>=20' } }), null);
  assert.match(runtimeProblem({ exports: [] }), /verify/);
  assert.match(runtimeProblem({ exports: ['verify'], runtime: { memoryMb: CEILINGS.memoryMb + 1 } }), /memoryMb/);
  assert.match(runtimeProblem({ exports: ['verify'], runtime: { timeoutS: CEILINGS.timeoutS + 1 } }), /timeoutS/);
  assert.deepEqual(limitsOf({ runtime: { memoryMb: 1024, timeoutS: 600 } }), { memoryMb: 1024, timeoutS: 600 });
  assert.deepEqual(limitsOf({}), { memoryMb: 512, timeoutS: 120 });
  const v = createVerifiers({ dataDir: join(tmp, 'ceil') });
  const big = pack('demo.v1', DEMO_VERIFY, { node: '>=20', memoryMb: 4096 });
  assert.throws(() => v.install(big.gz, big.hash, { rulesetId: 'demo.v1' }), /memoryMb/);
  const ok = pack('demo.v1', DEMO_VERIFY);
  assert.throws(() => v.install(ok.gz, ok.hash, { rulesetId: 'other.v1' }), /demo\.v1's, not other\.v1's/);
});

test('the child: verify() runs isolated; a spin is the runner\'s failure, a refusal is the court\'s', { timeout: 120_000 }, async () => {
  const v = createVerifiers({ dataDir: join(tmp, 'child') });
  const run = async (src, bytes, runtime) => { const b = pack('demo.v1', src, runtime); return v.run(v.install(b.gz, b.hash, { rulesetId: 'demo.v1', origin: 'local' }), bytes, null); };
  const good = Buffer.from(JSON.stringify({ format: 'demo-log@1', cmds: [1, 2, 3] }));
  const r = await run(DEMO_VERIFY, good);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.finalHash, demoFinal([1, 2, 3])); assert.deepEqual(r.result, { sum: 6 });
  assert.match((await run(DEMO_VERIFY, Buffer.from('nope'))).error, /JSON|refused/);
  const net = await run(`export async function verify() { await import('node:net'); return { finalHash: 'x' }; }`, good);
  assert.match(net.error, /refused: a verifier may not import node:net/);
  const req = await run(`import { createRequire } from 'node:module'; export async function verify() { createRequire(import.meta.url)('http'); return { finalHash: 'x' }; }`, good);
  assert.match(req.error, /may not import http/, 'require() is refused too');
  const fetchy = await run(`export async function verify() { return { finalHash: typeof fetch } ; }`, good);
  assert.equal(fetchy.finalHash, 'undefined', 'no fetch global');
  const write = await run(`import { writeFileSync } from 'node:fs'; export async function verify() { writeFileSync('owned.txt', 'x'); return { finalHash: 'x' }; }`, good);
  assert.match(write.error, /ERR_ACCESS_DENIED|permission|Access to this API has been restricted/i);
  const spin = await run(`export async function verify() { for (;;) {} }`, good, { node: '>=20', timeoutS: 1 });
  assert.equal(spin.ok, false); assert.equal(spin.runner, true, 'killed at the deadline: the runner failed, the court did not');
  assert.match(spin.error, /deadline of 1 s/);
});

test('check: nothing to run, no log, untrusted or over budget → not checked (null)', { timeout: 60_000 }, async () => {
  const b = pack('demo.v1', DEMO_VERIFY);
  const log = Buffer.from(JSON.stringify({ format: 'demo-log@1', cmds: [4] }));
  const delta = { kind: 'attested', matchId: 'm1', rulesetId: 'demo.v1', commitments: { inputsHash: sha(log), finalHash: demoFinal([4]), verifierHash: b.hash } };
  const ledger = { report: { commitments: delta.commitments } };
  const logs = store();
  const off = createVerifiers({ dataDir: join(tmp, 'off'), budgetMin: 0, verifierActive: async () => true });
  off.install(b.gz, b.hash, { rulesetId: 'demo.v1', origin: 'local' });
  logs.holdLog(log, sha(log));
  assert.equal(await off.check(delta, ledger, { logs }), null, 'VERIFY_BUDGET_MIN=0: the runner is off');
  const untrusted = createVerifiers({ dataDir: join(tmp, 'untrusted'), verifierActive: async () => false });
  untrusted.install(b.gz, b.hash, { rulesetId: 'demo.v1', origin: 'peer' });
  assert.equal(await untrusted.check(delta, ledger, { logs }), null, 'a held bundle the title no longer registers is not run');
  const on = createVerifiers({ dataDir: join(tmp, 'on'), verifierActive: async () => true });
  on.install(b.gz, b.hash, { rulesetId: 'demo.v1', origin: 'peer' });
  assert.equal(await on.check(delta, ledger, { logs: store() }), null, 'no log held and nobody to fetch it from');
  assert.equal(await on.check({ ...delta, commitments: { ...delta.commitments, verifierHash: null } }, ledger, { logs }), null, 'no verifier named');
  const v = await on.check(delta, ledger, { logs });
  assert.equal(v.ok, true); assert.equal(v.verifierHash, b.hash);
  assert.ok(on.status().usedMsToday > 0, 'the run is counted against the day');
});

test('mesh: the custodian fetches the publisher\'s verifier by hash, co-signs the honest result and disputes the forged one', { timeout: 180_000 }, async () => {
  const court = await generateKeypair();
  const src = join(tmp, 'vcourt.v1.mjs');
  writeFileSync(src, `import { defineAttestedTitle } from '${titlePath('titles/title.js')}';
export default defineAttestedTitle({
  rulesetId: 'vcourt.v1', modes: ['casual'], participants: [2], teams: 2, attestors: ['${court.publicKey}'],
  validate: (r) => (r && (r.winner === 0 || r.winner === 1) ? null : 'winner must be 0 or 1'),
  scores: (r, participants) => Object.fromEntries(participants.map((p, i) => [p, r.winner === i ? 1 : 0])),
  display: { title: 'Verifier Court' },
});
`);
  const ruleset = join(tmp, 'vcourt.v1.js');
  writeFileSync(ruleset, await bundleTitle(src));
  const b = pack('vcourt.v1', DEMO_VERIFY);
  mkdirSync(join(tmp, 'publisher-files'), { recursive: true });
  const tgz = join(tmp, 'publisher-files', 'vcourt.v1.verifier.tgz');
  writeFileSync(tgz, b.gz);
  writeFileSync(tgz.replace(/\.tgz$/, '.json'), JSON.stringify({ kind: 'verifier', rulesetId: 'vcourt.v1', verifierHash: b.hash }));

  // Offline mesh, so VERIFIERS stands in for TitleRegistry on both. Only the publisher's node holds the bundle.
  const verifiers = { 'vcourt.v1': [b.hash] };
  const host = await spawn({ operator: 'publisher', roles: ['mesh', 'settler'], rulesets: [ruleset], verifiers, verifierBundles: { 'vcourt.v1': tgz } });
  const wit = await spawn({ operator: 'operator-b', roles: ['mesh', 'witness'], rulesets: [ruleset], seeds: [host.addr], verifiers });
  assert.ok(await until(async () => (await (await fetch(`${wit.addr}/peers`)).json()).peers.some((p) => p.nodeId === host.nodeId), 15_000), 'the witness sees the publisher');

  // the publisher serves its bundle by hash, nothing else
  const got = await fetch(`${host.addr}/verifier/vcourt.v1?build=${b.hash}`);
  assert.equal(got.status, 200);
  assert.equal(sha(Buffer.concat([Buffer.from('verifier\0'), (await import('node:zlib')).gunzipSync(Buffer.from(await got.arrayBuffer()))])), b.hash);
  assert.equal((await fetch(`${host.addr}/verifier/vcourt.v1?build=${'0'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${wit.addr}/verifier/vcourt.v1?build=${b.hash}`)).status, 404, 'the witness holds nothing yet');

  const P = ['pa', 'pb'];
  const settle = async (matchId, cmds, finalHash) => {
    const log = Buffer.from(JSON.stringify({ format: 'demo-log@1', cmds }));
    const report = { winner: 0, ticks: cmds.length, commitments: { logFormat: 'demo-log@1', inputsHash: sha(log), finalHash, verifierHash: b.hash } };
    const env = { kind: 'attested', matchId, rulesetId: 'vcourt.v1', mode: 'casual', participants: P, teams: [['pa'], ['pb']], report,
      attestor: { id: court.publicKey, sig: await sign(ATTEST_TAG, { matchId, rulesetId: 'vcourt.v1', report }, court.privateKey) }, log: log.toString('base64') };
    const r = await post(host, '/ledger', env);
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d));
    assert.equal(d.proof, 'checkable');
    return d;
  };

  // 1. honest: the court's finalHash is what the verifier reproduces
  await settle('honest-1', [5, 6, 7], demoFinal([5, 6, 7]));
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/honest-1`)).json()).cosigners.length === 1, 60_000), 'the custodian co-signs after re-running it');
  const runner = async () => (await (await fetch(`${wit.addr}/health`)).json()).settlement.verifiers.runner;
  assert.ok(await until(async () => (await runner()).agreed === 1, 10_000), 'counted as agreed');
  assert.ok((await runner()).held.some((e) => e.verifierHash === b.hash && e.origin === 'peer'), 'the witness fetched the bundle from the publisher');
  assert.equal((await fetch(`${wit.addr}/verifier/vcourt.v1?build=${b.hash}`)).status, 200, 'and serves it on');

  // 2. forged: the court signs a finalHash its own verifier does not reproduce
  await settle('forged-1', [1, 1, 1], demoFinal([9, 9, 9]));
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/forged-1`)).json()).disputes?.length === 1, 60_000), 'the custodian disputes it');
  const forged = await (await fetch(`${host.addr}/delta/forged-1`)).json();
  assert.equal(forged.cosigners.length, 0);
  assert.match(forged.disputes[0].reason, /^verifier: finalHash differs/);
  assert.equal(forged.disputes[0].witnessId, wit.nodeId);
  assert.equal(forged.verification, 'disputed');
  assert.equal((await runner()).disagreed, 1);
});

const FC_ROOT = process.env.FC_ROOT ?? 'E:/NPC/06 AERIS GAME/bagyogame';
const FC_BUNDLE = join(FC_ROOT, '.deploy', 'verifier', 'flood-control.v1.verifier.tgz');
test('FLOOD CONTROL: the real verifier bundle reproduces a real run\'s finalHash and refuses a forgery', { skip: !existsSync(FC_BUNDLE) && `no FLOOD CONTROL verifier bundle at ${FC_BUNDLE}`, timeout: 600_000 }, async () => {
  const fx = JSON.parse(readFileSync(join(root, 'demo', 'fixtures', 'flood-control-run.json'), 'utf8'));
  const log = Buffer.from(fx.log, 'base64');
  assert.equal(sha(log), fx.report.commitments.inputsHash, 'the fixture is the committed log');
  const v = createVerifiers({ dataDir: join(tmp, 'fc') });
  const e = v.install(readFileSync(FC_BUNDLE), fx.report.commitments.verifierHash, { rulesetId: 'flood-control.v1', origin: 'local' });
  const r = await v.run(e, log, fx.report);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(judge(fx.report, r), { ok: true, reason: null, fields: [] }, 'honest run: agrees');
  assert.equal(r.result.points, fx.report.points);
  const forged = { ...fx.report, commitments: { ...fx.report.commitments, finalHash: 'f'.repeat(64) } };
  assert.match(judge(forged, r).reason, /finalHash differs/, 'forged finalHash: disagrees');
  const other = { ...fx.report, levelId: 'manila' };
  const r2 = await v.run(e, log, other);
  assert.equal(r2.ok, false); assert.match(r2.error, /refused: the spec's levelId is not the log's/, 'a report about another run is refused by the verifier itself');
});
