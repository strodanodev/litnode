/** AFC (Robot Fighting Championship), an attested title at L2: titles/afc.adapter.js as handed back by the AFC
 *  session, run on real nodes against a real bout (demo/fixtures/afc-bout.json). The court is authorized by the
 *  manifest's `attestors` alone; the match file the report commits is held and served; a registered verifier makes
 *  the result `checkable`, an unregistered one leaves it `attested`; validate() refuses what the report contradicts.
 *  The adapter is bundled here with a test court key in `attestors` (the real key's private half lives only in the
 *  AFC court's managed env); the committed build in rulesets/ names the real key.
 *    node --test demo/afc.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode, rulesetHash } from '../node/litnode.js';
import { ATTEST_TAG } from '../node/settle.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import { bundleTitle } from '../sdk/bundle.mjs';

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'litnode-afc-'));
const nodes = [];
test.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, updates: false, ...opts }).then((n) => (nodes.push(n), n));
const post = (node, body) => fetch(`${node.addr}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const bout = JSON.parse(readFileSync(join(root, 'demo', 'fixtures', 'afc-bout.json'), 'utf8'));
const VERIFIER = bout.report.commitments.verifierHash; // 14336181… — the afc.v1 verifier packed from notsedano/afc 4dc1f8b
const KEY = bout.participants[0];

/** The adapter exactly as committed, with `attestors` set to `court` and its one import made absolute. */
async function adapterWith(court) {
  const src = readFileSync(join(root, 'titles', 'afc.adapter.js'), 'utf8')
    .replace(/attestors: \[[^\]]*\]/, `attestors: ['${court.publicKey}']`)
    .replace("from './title.js'", `from '${join(root, 'titles', 'title.js').replace(/\\/g, '/')}'`);
  const entry = join(tmp, `afc-${court.publicKey.slice(0, 8)}.mjs`);
  writeFileSync(entry, src);
  const out = join(tmp, `afc-${court.publicKey.slice(0, 8)}.v1.js`);
  writeFileSync(out, await bundleTitle(entry));
  return out;
}
const envelope = async (report, court, { log = true, matchId = report.matchId } = {}) => ({
  kind: 'attested', matchId, rulesetId: 'afc.v1', mode: 'casual', participants: bout.participants, teams: bout.teams, report,
  attestor: { id: court.publicKey, sig: await sign(ATTEST_TAG, { matchId, rulesetId: 'afc.v1', report }, court.privateKey) },
  ...(log ? { log: bout.log } : {}),
});

test('afc.v1: the committed build pins a real court key, a stat schema and casual-only modes', async () => {
  const built = join(root, 'rulesets', 'afc.v1.js');
  assert.ok(existsSync(built), 'rulesets/afc.v1.js is built (npm run bundle:title -- titles/afc.adapter.js)');
  const { default: t } = await import(pathToFileURL(built).href);
  assert.equal(t.manifest.rulesetId, 'afc.v1');
  assert.equal(t.manifest.kind, 'attested');
  assert.deepEqual(t.manifest.modes, ['casual'], 'ranked attested AFC waits for keys plus a gear-sterility rule');
  assert.equal(t.manifest.attestors.length, 1);
  assert.match(t.manifest.attestors[0], /^[0-9a-f]{64}$/, 'the court key, not the hand-back placeholder');
  assert.deepEqual(Object.keys(t.manifest.services.stats.schema).sort(), ['damageDealt', 'fastestKoTicks', 'hits', 'kos', 'maxCombo', 'parries', 'roundsWon']);
  const sidecar = JSON.parse(readFileSync(join(root, 'rulesets', 'afc.v1.json'), 'utf8'));
  assert.equal(sidecar.buildHash, rulesetHash(readFileSync(built, 'utf8')), 'the sidecar names the build it sits beside');
});

test('afc.v1 on a node: a court in `attestors` settles the real bout `checkable` with its verifier, `attested` without; the match file is held and served', { timeout: 120_000 }, async () => {
  const court = await generateKeypair();
  const ruleset = await adapterWith(court);
  const host = await spawn({ operator: 'studio', roles: ['mesh', 'settler'], rulesets: [ruleset], verifiers: { 'afc.v1': [VERIFIER] } });
  const plain = await spawn({ operator: 'other', roles: ['mesh', 'settler'], rulesets: [ruleset] });

  const r = await post(host, await envelope(bout.report, court));
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.kind, 'attested'); assert.equal(d.attestor, court.publicKey);
  assert.equal(d.proof, 'checkable', 'log held + verifier registered: L2');
  assert.equal(d.placed, false); assert.equal(d.mode, 'casual');
  assert.deepEqual(d.scores, { [KEY]: 1 }, 'a win is 1 to the seat that holds it');
  assert.deepEqual(d.stats[KEY], bout.report.stats[KEY], 'the court\'s counters, schema names only');
  assert.deepEqual(d.commitments, bout.report.commitments);
  const served = Buffer.from(await (await fetch(`${host.addr}/log/${bout.report.commitments.inputsHash}`)).arrayBuffer());
  assert.equal(served.toString('base64'), bout.log, 'GET /log serves the exact match-file bytes');

  // the same evidence on a node that does not hold the verifier as registered: attested, never checkable
  const r2 = await post(plain, await envelope(bout.report, court));
  assert.equal((await r2.json()).proof, 'attested');
  // and without the log, the commitment alone is attested too
  const noLog = await post(plain, await envelope({ ...bout.report, matchId: 'afc-nolog' }, court, { log: false, matchId: 'afc-nolog' }));
  assert.equal((await noLog.json()).proof, 'attested');
});

test('afc.v1 refuses what the report contradicts, and a court the manifest does not name', { timeout: 120_000 }, async () => {
  const court = await generateKeypair(), stranger = await generateKeypair();
  const ruleset = await adapterWith(court);
  const host = await spawn({ operator: 'refuser', roles: ['mesh', 'settler'], rulesets: [ruleset] });
  const refused = async (report, why, key = court) => {
    const r = await post(host, await envelope(report, key, { log: false }));
    const j = await r.json();
    assert.equal(r.status, 400, JSON.stringify(j)); assert.match(j.error, why);
  };
  const R = bout.report;
  await refused({ ...R, matchId: 'afc-bad-1', replayVerified: false }, /only replay-verified bouts settle/);
  await refused({ ...R, matchId: 'afc-bad-2', hp: [30, 5] }, /a KO leaves the loser at 0 hp/);
  await refused({ ...R, matchId: 'afc-bad-3', stats: { [KEY]: { ...R.stats[KEY], kos: 0 } } }, /kos disagrees with the result/);
  await refused({ ...R, matchId: 'afc-bad-4', ticks: 5000 }, /ticks must be 1\.\.4350/);
  await refused({ ...R, matchId: 'afc-bad-5', commitments: { ...R.commitments, logFormat: 'hmc-match@1' } }, /logFormat must be hmc-match@2/);
  await refused({ ...R, matchId: 'afc-bad-6' }, /not an authorized court/, stranger);
});
