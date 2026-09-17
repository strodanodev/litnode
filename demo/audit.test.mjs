/** The build audit's four probes (audit/litnode-probes.mjs, 17 Sep 2026),
 *  each asserted fail-closed. If any of these passes the way it did in the
 *  audit, the fix has regressed.
 *    node --test demo/audit.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../sdk/conformance.mjs';
import { createSandbox } from '../node/sandbox.js';
import { createSettlement, HOST_TAG } from '../node/settle.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import { resultHash } from '../protocol/result.js';

const source = readFileSync(join(process.cwd(), 'rulesets', 'tug.v1.js'), 'utf8');
const sandbox = createSandbox();

test('probe 1 — a purity failure is decided before any title code runs, and never in this process', async () => {
  const r = await check('globalThis.__litAuditMarker = true; void Math.random();\n' + source, { sandbox });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'static', 'refused by the static stage: nothing was handed to any runtime');
  assert.equal(globalThis.__litAuditMarker, undefined, 'the marker never executed here');
  // and a title that passes static still executes only in the sandbox
  const r2 = await check('globalThis.__litAuditMarker2 = true;\n' + source, { sandbox });
  assert.equal(r2.ok, true);
  assert.equal(globalThis.__litAuditMarker2, undefined, 'top-level title code ran in the sandbox child, not the node');
});

test('probe 2 — bracket access to randomness is not a bypass: the sandbox has nothing to call', async () => {
  const r = await check("void Math['random']();\n" + source, { sandbox });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'sandbox');
  assert.ok(r.checks.some((c) => !c.ok && /Math\.random is not available/.test(c.detail)), JSON.stringify(r.checks.filter((c) => !c.ok)));
});

test('probe 3 — an empty, unsigned, unplaced ranked submission with expected:{} is refused; no ladder rows', async (t) => {
  const hostKey = await generateKeypair();
  const root = mkdtempSync(join(tmpdir(), 'litnode-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const man = await sandbox.one(source, { kind: 'manifest' });
  const build = { rulesetId: man.manifest.rulesetId, buildHash: 'audit-build', source, manifest: man.manifest, kind: man.manifest.kind };
  const loaded = new Map([[build.rulesetId, build]]), builds = new Map([['audit-build', build]]);
  const host = createSettlement({ dataDir: join(root, 'host'), nodeId: hostKey.publicKey, identity: hostKey, loaded, builds, sandbox });
  const P = ['a'.repeat(64), 'b'.repeat(64)];
  const sub = { matchId: 'audit-empty-match', rulesetId: build.rulesetId, mode: 'ranked', participants: P, entries: [], expected: {} };
  await assert.rejects(host.intake(sub), /no placement descriptor/);
  await assert.rejects(host.intake({ ...sub, mode: 'casual' }), /empty log/);
  // the audit's original participants were not even keys
  await assert.rejects(host.intake({ ...sub, participants: ['audit-player-a', 'audit-player-b'] }), /participants must be player keys/);
  assert.equal(host.derived(build.rulesetId, { scope: 'all' }).leaderboard.length, 0);
  assert.equal(host.derived(build.rulesetId).leaderboard.length, 0);
});

test('probe 4 — a host-signed delta with altered scores is refused by the witness and disputed', async (t) => {
  const hostKey = await generateKeypair(), witnessKey = await generateKeypair();
  const root = mkdtempSync(join(tmpdir(), 'litnode-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const man = await sandbox.one(source, { kind: 'manifest' });
  const build = { rulesetId: man.manifest.rulesetId, buildHash: 'audit-build', source, manifest: man.manifest, kind: man.manifest.kind };
  const loaded = new Map([[build.rulesetId, build]]), builds = new Map([['audit-build', build]]);
  const host = createSettlement({ dataDir: join(root, 'host'), nodeId: hostKey.publicKey, identity: hostKey, loaded, builds, sandbox });
  const witness = createSettlement({ dataDir: join(root, 'witness'), nodeId: witnessKey.publicKey, identity: witnessKey, loaded, builds, sandbox });
  const P = ['a'.repeat(64), 'b'.repeat(64)];
  // a casual, unplaced, host-attested match (the weakest thing that settles at all)
  const entries = Array.from({ length: 1200 }, (_, k) => ({ k, inputs: [1, 0] }));
  const sub = { matchId: 'audit-scores', rulesetId: build.rulesetId, mode: 'casual', participants: P, entries };
  const delta = await host.intake(sub);
  assert.equal(delta.attestation, 'host'); assert.equal(delta.official, false);
  assert.equal((await witness.cosign(delta, sub)).ok, true, 'the honest delta verifies');
  const { hostSig, cosigners, cosigs, disputes, verification, official, ...body } = delta;
  const changed = { ...body, scores: { [P[0]]: 999999, [P[1]]: 0 } };
  // (a) altered scores under the OLD commitment: refused as inconsistent
  const stale = { ...changed, hostSig: await sign(HOST_TAG, changed, hostKey.privateKey), cosigners: [], cosigs: {}, disputes: [] };
  const r1 = await witness.cosign(stale, sub);
  assert.equal(r1.ok, false); assert.match(r1.reason, /commitment does not match/);
  // (b) altered scores with a re-computed commitment and a fresh host signature: the witness replays, disagrees, files a dispute
  changed.resultHash = resultHash(changed);
  const forged = { ...changed, hostSig: await sign(HOST_TAG, changed, hostKey.privateKey), cosigners: [], cosigs: {}, disputes: [] };
  const r2 = await witness.cosign(forged, sub);
  assert.equal(r2.ok, false); assert.match(r2.reason, /result differs: scores/);
  assert.ok(r2.dispute?.sig);
  assert.equal(r2.fields.includes('scores'), true);
});
