// Lite guardian: checks on a real settled match, the node's /guardian intake, and the worker CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNode } from '../node/litnode.js';
import { generateKeypair } from '../protocol/keys.js';
import { checkDelta, reportBody, signReport } from '../protocol/guardian.js';
import { placeMatch, playPlaced, until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);

test('guardian: checks a settled match, reports advisory verdicts, CLI is zero-config', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-guardian-'));
  const nodes = [], events = [];
  const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const host = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET], onEvent: (e) => e.type.startsWith('guardian') && events.push(e) });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], seeds: [host.addr] });
  assert.ok(await until(() => wit.rulesets()['agent-fighter.v1']));

  const kps = await Promise.all([generateKeypair(), generateKeypair()]);
  const desc = await placeMatch(host.addr, kps, { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  const sub = await playPlaced(desc, kps, { title, engine, manifest, balance });
  const settled = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(sub) });
  assert.equal(settled.status, 200, await settled.clone().text());

  const delta = await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json();
  const ledger = await (await fetch(`${host.addr}/ledger/${desc.matchId}`)).json();

  // The checks agree with the node's own signing and commitment (catches drift from node/settle.js).
  assert.deepEqual(await checkDelta(delta, ledger), { verdict: 'consistent', failed: [] });
  const listed = (await (await fetch(`${host.addr}/deltas`)).json()).deltas.find((d) => d.matchId === desc.matchId);
  assert.deepEqual(await checkDelta(listed, ledger), { verdict: 'consistent', failed: [] }, '/deltas items are checkable as-is');

  // Tampering is caught.
  const forged = { ...delta, scores: { ...delta.scores, [delta.participants[0]]: 999 } };
  assert.deepEqual((await checkDelta(forged, ledger)).failed, ['hostSig', 'commitment']);
  assert.deepEqual(await checkDelta(delta, { ...ledger, entries: ledger.entries.slice(0, -1) }), { verdict: 'inconsistent', failed: ['head'] });
  assert.equal((await checkDelta(delta, null)).verdict, 'unavailable');

  // Intake: a signed report counts; it is advisory and never changes the result's standing.
  const g = await generateKeypair();
  const post = (env) => fetch(`${host.addr}/guardian`, { method: 'POST', body: JSON.stringify(env) });
  // A witness may co-sign just after settlement. Wait for that independent
  // transition before checking that an advisory report leaves it alone.
  const before = await until(async () => {
    const d = await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json();
    return d.verification === 'verified' ? d.verification : null;
  }, 30_000);
  assert.equal(before, 'verified', 'witness completed before the advisory check');
  const ok = await post(await signReport(reportBody(delta, { verdict: 'inconsistent', failed: ['head'] }), g));
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, counted: true });
  const reports = (await (await fetch(`${host.addr}/guardian?matchId=${desc.matchId}`)).json()).reports;
  assert.equal(reports.length, 1); assert.equal(reports[0].guardianId, g.publicKey); assert.equal(reports[0].verdict, 'inconsistent');
  assert.equal((await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json()).verification, before, 'advisory only');
  assert.deepEqual((await (await fetch(`${host.addr}/guardian`)).json()).flagged, [desc.matchId]);
  assert.equal((await (await fetch(`${host.addr}/health`)).json()).guardian.reports, 1);
  assert.equal(events.at(-1).verdict, 'inconsistent');
  const fleet = await (await fetch(`${host.addr}/fleet`)).json();
  assert.equal(fleet.guardian.reports, 1); assert.equal(fleet.guardian.guardiansLastHour, 1); assert.deepEqual(fleet.guardian.flagged, [desc.matchId]);
  assert.equal(fleet.guardian.recent.at(-1).guardianId, g.publicKey);
  assert.ok(fleet.events.some((e) => e.type === 'guardian' && e.matchId === desc.matchId), 'a flag reaches the dashboard feed');

  // Refusals.
  const good = await signReport(reportBody(delta, { verdict: 'consistent', failed: [] }), g);
  assert.equal((await post({ ...good, sig: good.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) })).status, 400, 'bad signature');
  assert.equal((await post(await signReport({ ...good.body, resultHash: 'ff'.repeat(32) }, g))).status, 409, 'another result');
  assert.equal((await post(await signReport({ ...good.body, matchId: 'nope' }, g))).status, 404, 'unknown match');
  assert.equal((await post(await signReport({ ...good.body, at: Date.now() - 3_600_000 }, g))).status, 400, 'stale');

  // Worker CLI: zero config beyond the node URL; creates its own key.
  const { stdout } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'tools', 'guardian.mjs'), '--node', host.addr, '--once', '--data', join(tmp, 'g1')]);
  assert.match(stdout, new RegExp(`${desc.matchId}\\s+consistent\\s+reported`));
  assert.ok(readFileSync(join(tmp, 'g1', 'guardian-key.json'), 'utf8').includes('publicKey'));
  assert.equal((await (await fetch(`${host.addr}/guardian?matchId=${desc.matchId}`)).json()).reports.length, 2);

  // Rate limit per guardian key: 30/min. Signature and freshness are checked first, so only the
  // 200 / 409 / 404 above counted against this key.
  const statuses = [];
  for (let i = 0; i < 28; i++) statuses.push((await post(good)).status);
  assert.equal(statuses.at(-2), 200); assert.equal(statuses.at(-1), 429);
});
