/** Durable custody (audit finding 7): a host settles and freezes; its
 *  evidence is exported, the host is SHUT DOWN, and a third node started
 *  from the archive alone re-verifies every commitment and serves the
 *  delta, the ledger and the finalized proof.
 *    node --test demo/custody.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createNode } from '../node/litnode.js';
import { generateKeypair } from '../protocol/keys.js';
import { verifyProof } from '../protocol/epoch.js';
import { resultHash } from '../protocol/result.js';
import { placeMatch, playPlaced, until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'agent-fighter.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { default: title, engine, balance } = await import(pathToFileURL(RULESET).href);

test('custody: export → host down → import elsewhere → verify → serve proof', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-custody-'));
  const nodes = [];
  const spawn = (opts) => createNode({ dataDir: opts.dataDir ?? join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const host = await spawn({ operator: 'publisher', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET] });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], seeds: [host.addr] });
  assert.ok(await until(() => wit.rulesets()['agent-fighter.v1']));
  const kps = await Promise.all([generateKeypair(), generateKeypair()]);
  const desc = await placeMatch(host.addr, kps, { rulesetId: 'agent-fighter.v1', mode: 'ranked' });
  const sub = await playPlaced(desc, kps, { title, engine, manifest, balance });
  const r = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(sub) });
  assert.equal(r.status, 200, await r.clone().text());
  const delta = await r.json();
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/${desc.matchId}`)).json()).cosigners.length === 1, 30_000));
  host.settlement.freeze(delta.epoch);
  const proofBefore = await (await fetch(`${host.addr}/proof/${desc.matchId}`)).json();
  assert.equal(proofBefore.status, 'finalized');

  // export, then the host is gone
  const archive = join(tmp, 'host.tar');
  const out = execFileSync(process.execPath, [join(process.cwd(), 'tools', 'custody.mjs'), 'export', join(tmp, 'publisher'), archive], { encoding: 'utf8' });
  assert.match(out, /1 ledger\(s\), 1 delta\(s\), 1 frozen epoch\(s\)/);
  await host.stop(); nodes.splice(nodes.indexOf(host), 1);
  await assert.rejects(fetch(`${host.addr}/health`), 'the host is down');

  // a keeper imports it into an empty data dir and verifies offline
  const keeperDir = join(tmp, 'keeper');
  mkdirSync(keeperDir);
  assert.match(execFileSync(process.execPath, [join(process.cwd(), 'tools', 'custody.mjs'), 'import', archive, keeperDir], { encoding: 'utf8' }), /imported \d+ file\(s\)/);
  const v = execFileSync(process.execPath, [join(process.cwd(), 'tools', 'custody.mjs'), 'verify', keeperDir], { encoding: 'utf8' });
  assert.match(v, /1 delta\(s\), 1 frozen epoch\(s\), 0 problem\(s\)/);
  assert.match(v, / ok .* verified/);

  // a node started on the archive alone (no seeds, no host) serves the record and the finalized proof
  const keeper = await spawn({ operator: 'keeper', dataDir: keeperDir, roles: ['mesh'], titleTrust: 'open' });
  const d2 = await (await fetch(`${keeper.addr}/delta/${desc.matchId}`)).json();
  assert.equal(d2.resultHash, delta.resultHash); assert.equal(resultHash(d2), d2.resultHash);
  assert.deepEqual(d2.cosigners, [wit.nodeId]); assert.equal(d2.verification, 'verified');
  const l2 = await (await fetch(`${keeper.addr}/ledger/${desc.matchId}`)).json();
  assert.equal(l2.entries.length, sub.entries.length); assert.ok(l2.descriptor?.sig, 'the placement envelope travelled with the ledger');
  const p2 = await (await fetch(`${keeper.addr}/proof/${desc.matchId}`)).json();
  assert.equal(p2.status, 'finalized'); assert.equal(p2.root, proofBefore.root); assert.equal(p2.leaf, proofBefore.leaf);
  assert.ok(verifyProof(p2.leaf, p2.path, p2.root));
  assert.equal(Object.keys(keeper.rulesets()).length, 0, 'the keeper holds the build (cached) without advertising it as current');
  assert.equal((await (await fetch(`${keeper.addr}/health`)).json()).buildsHeld, 1);
});
