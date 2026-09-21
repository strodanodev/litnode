/** The migration, dry-run: tools/deploy-contracts.mjs — the same script the
 *  operator runs against Liteforge — executed unchanged against the
 *  in-process chain served over HTTP (demo/lib/rpc-evm.mjs listen()).
 *  It must compile every contract, deploy the v3 set, refuse an unbonding
 *  period shorter than MatchBook's windows, name MatchBook an adjudicator,
 *  bond the local node with a lock that has started, and write a
 *  deployed.testnet.json a node can boot from and report on /health.
 *    node --test demo/deploy.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createRpcEvm } from './lib/rpc-evm.mjs';
import { createNode } from '../node/litnode.js';
import { until } from './lib/mesh.mjs';

const ROOT = process.cwd();
const run = (env, args = ['--fresh', '--quorum', '2']) => new Promise((resolve) => execFile(process.execPath, [join(ROOT, 'tools', 'deploy-contracts.mjs'), ...args], { cwd: ROOT, env: { ...process.env, ...env }, maxBuffer: 1e7 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr })));

test('deploy tool: refuses windows the bond cannot cover; deploys v3 + registry + MatchBook; a node boots on the result', { timeout: 300_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-deploy-'));
  const chain = await createRpcEvm();
  const http = await chain.listen();
  t.after(async () => { await http.close(); rmSync(tmp, { recursive: true, force: true }); });
  const base = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deploy.testnet.json'), 'utf8'));
  const cfgPath = join(tmp, 'deploy.json'), outPath = join(tmp, 'deployed.json');
  const env = { DEPLOYER_KEY: chain.keyOf(0), DEPLOY_CONFIG: cfgPath, DEPLOY_OUT: outPath, LITNODE_DATA: join(tmp, 'node') };

  // 1. an unbonding period that does not cover settle + 2×attest + 2×escalation is refused before anything is sent
  writeFileSync(cfgPath, JSON.stringify({ ...base, rpc: http.url, NodeStake: { ...base.NodeStake, unbondingPeriod: 10 } }));
  let r = await run(env);
  assert.notEqual(r.code, 0);
  const windows = base.MatchBook.settleWindowS + 2 * base.MatchBook.attestWindowS + 2 * base.MatchBook.escalationWindowS; // the tool's formula, over the live config
  assert.match(r.out, new RegExp(`unbondingPeriod \\(10s\\) must exceed the MatchBook windows \\(${windows}s\\)`));
  assert.ok(!existsSync(outPath), 'nothing written');

  // 2. the real parameters deploy the whole set — starting from a v2 file that carries `migratedFrom` (the v1 → v2
  //    move left one), which the old resume test mistook for a half-deployed new set on 22 Sep 2026
  writeFileSync(cfgPath, JSON.stringify({ ...base, rpc: http.url }));
  const v2 = { chainId: 4441, rpc: http.url, deployedAt: '2026-09-19T00:00:00.000Z', migratedFrom: { NodeStake: '0x' + '11'.repeat(20) }, NodeStake: { address: '0x' + '22'.repeat(20), version: 2 }, EpochAnchor: { address: '0x' + '33'.repeat(20), version: 2 }, TestLITVM: { address: '0x' + '44'.repeat(20) } };
  writeFileSync(outPath, JSON.stringify(v2));
  r = await run(env);
  assert.doesNotMatch(r.out, /resuming/, 'a v2 file is archived, not resumed');
  assert.equal(readdirSync(tmp).filter((f) => f.startsWith('deployed.testnet.')).length, 1, 'the v2 file was archived');
  { const d0 = JSON.parse(readFileSync(outPath, 'utf8')); assert.equal(d0.generation, 3); assert.equal(d0.migratedFrom.generation, 2); assert.notEqual(d0.NodeStake.address.toLowerCase(), v2.NodeStake.address, 'a NEW NodeStake'); assert.notEqual(d0.TestLITVM.address.toLowerCase(), v2.TestLITVM.address, 'a NEW token too: --fresh means the whole set'); }
  assert.equal(r.code, 0, r.out.slice(-3000));
  assert.match(r.out, /WARNING: admin = the deployer wallet/);
  assert.match(r.out, /MatchBook named an adjudicator on NodeStake/);
  assert.match(r.out, /locked until .* witness-eligible from/);
  const d = JSON.parse(readFileSync(outPath, 'utf8'));
  for (const c of ['TestLITVM', 'NodeStake', 'ERC6699Registry', 'EpochAnchor', 'PlayerProfile', 'NodeBadge', 'NodeDirectory', 'ReleaseRegistry', 'MatchBook']) assert.match(d[c]?.address ?? '', /^0x[0-9a-fA-F]{40}$/, `${c} deployed`);
  assert.equal(d.NodeStake.version, 3); assert.equal(d.NodeStake.lockTerm, 600); assert.equal(d.NodeStake.eligibilityAge, 120);
  assert.equal(d.MatchBook.attestWindowS, 120); assert.equal(d.MatchBook.hostSlashBps, 1000);
  assert.equal(d.ReleaseRegistry.activationDelay, 60);
  assert.equal(d.chainId, 4441);
  assert.ok(existsSync(join(tmp, 'node', 'identity.json')), 'the local node identity was created and bonded');

  // 3. a plain re-run is idempotent (every contract "already at"); a second --fresh would archive and redeploy, by design
  r = await run(env, ['--quorum', '2']);
  assert.equal(r.code, 0, r.out.slice(-2000));
  const deployedCount = Object.keys(d).filter((k) => d[k]?.address && d[k]?.tx).length; // every contract the tool deploys (TitleRegistry belongs to the publisher-auth work)
  assert.equal((r.out.match(/: already at/g) ?? []).length, deployedCount, `every contract skipped (${deployedCount})`);
  assert.equal(readdirSync(tmp).filter((f) => f.startsWith('deployed.testnet.')).length, 1, 'nothing more archived on a plain re-run');
  // a plain run against a file of another generation is refused with a pointer to --fresh
  writeFileSync(join(tmp, 'v2.json'), JSON.stringify(v2));
  r = await run({ ...env, DEPLOY_OUT: join(tmp, 'v2.json') }, ['--quorum', '5000']);
  assert.notEqual(r.code, 0); assert.match(r.out, /holds generation 2; this tool deploys generation 3. Run with --fresh/);

  // 4. a node boots on the written set and reports the v3 facts on /health
  const node = await createNode({ dataDir: join(tmp, 'node'), rpc: http.url, offline: false, chainFetch: globalThis.fetch, nodeStake: d.NodeStake.address, releaseRegistry: d.ReleaseRegistry.address, matchBook: d.MatchBook.address, matchBookWindows: { attestWindow: d.MatchBook.attestWindowS, escalationWindow: d.MatchBook.escalationWindowS }, chainId: d.chainId, heartbeatMs: 300, operator: 'op', roles: ['mesh', 'host', 'settler'], updates: false, announce: false });
  t.after(() => node.stop().catch(() => {}));
  const h = await until(async () => { const j = await (await fetch(`${node.addr}/health`)).json(); return j.bond && j.admin ? j : null; }, 30_000);
  assert.ok(h, 'health reports the bond');
  assert.equal(h.bonded, true);
  assert.equal(h.bond.eligible, false, 'a fresh bond is not yet witness-eligible');
  assert.equal(h.admin, 'eoa', 'the deployer is an EOA admin, and the node says so');
  assert.equal(h.matchBook.contract, d.MatchBook.address);
  assert.equal(h.matchBook.delegated, false, 'no delegate set yet: the node reports it rather than sending');
  assert.equal(h.update.registry, 'unchecked', 'registry configured, no release looked at yet');
});
