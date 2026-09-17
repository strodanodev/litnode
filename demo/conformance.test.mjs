/** The harness: a title scaffolded from the template bundles, passes
 *  conformance, and a node hosts it; a title that reads the clock or rolls
 *  Math.random fails conformance and the node refuses it at load — the same
 *  suite, the same answer, wherever it runs.
 *    node --test demo/conformance.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, checkFile } from '../sdk/conformance.mjs';
import { bundleTitle } from '../sdk/bundle.mjs';
import { createNode } from '../node/litnode.js';

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'litnode-conf-'));
const failed = (r) => r.checks.filter((c) => !c.ok && !c.warn).map((c) => c.name);

test('shipped rulesets conform (Agent Fighter replayable, Pickle Brawl attested)', async () => {
  for (const f of ['agent-fighter.v1.js', 'pickle-brawl.v1.js']) {
    const r = await checkFile(join(root, 'rulesets', f));
    assert.ok(r.ok, `${f}: ${failed(r).join(', ')}`);
  }
});

test('create-title → bundle → conformant artifact with display', { timeout: 60_000 }, async () => {
  // scaffold into a temp titles/ (the tool writes next to the repo's sdk/ so the import path resolves)
  const id = `conf-${Date.now().toString(36)}.v1`;
  execFileSync(process.execPath, [join(root, 'tools', 'create-title.mjs'), id, 'Conformance Sample'], { cwd: root });
  const src = join(root, 'titles', `${id}.mjs`);
  try {
    assert.ok(existsSync(src));
    assert.ok(!(await check(readFileSync(src, 'utf8'))).ok, 'unbundled source imports the SDK — not yet an artifact');
    const bundled = await bundleTitle(src);
    const r = await check(bundled);
    assert.ok(r.ok, failed(r).join(', '));
    assert.equal(r.checks.filter((c) => !c.ok).length, 0, 'template carries display, so no warning either');
    writeFileSync(join(tmp, 'good.js'), bundled);
  } finally { rmSync(src, { force: true }); }
});

test('a title that reads the world fails conformance and the node refuses it — static or in the sandbox, never in-process', { timeout: 120_000 }, async (t) => {
  const good = readFileSync(join(tmp, 'good.js'), 'utf8');
  // 1. the lint catches the obvious spelling: refused STATICALLY, nothing executed anywhere
  const dirty = good.replace(/gust: \(?rnd\(\) % 7\)? - 3/, 'gust: Math.floor(Math.random() * 7) - 3');
  assert.notEqual(dirty, good);
  const r = await check(dirty);
  assert.ok(!r.ok); assert.equal(r.stage, 'static');
  assert.ok(failed(r).some((n) => n.startsWith('purity')), failed(r).join(', '));
  // 2. the audit's bypass: bracket access walks past any regex — the SANDBOX has no Math.random to call
  const bracket = good.replace(/gust: \(?rnd\(\) % 7\)? - 3/, "gust: Math['ran' + 'dom']() * 7 | 0");
  const r2 = await check(bracket);
  assert.ok(!r2.ok); assert.equal(r2.stage, 'sandbox');
  assert.ok(r2.checks.some((c) => !c.ok && /Math\.random is not available/.test(c.detail)), JSON.stringify(r2.checks.filter((c) => !c.ok)));
  // 3. the clock, the network, the process: none exist inside the sandbox
  const world = good.replace(/gust: \(?rnd\(\) % 7\)? - 3/, "gust: [typeof globalThis['Da'+'te'], typeof globalThis['fe'+'tch'], typeof globalThis['pro'+'cess'], typeof globalThis['req'+'uire']].join('/')");
  const { createSandbox } = await import('../node/sandbox.js');
  const probe = await createSandbox().one(world, { kind: 'replay', seed: 'ab'.repeat(32), participants: ['p0'.padEnd(64, '0'), 'p1'.padEnd(64, '1')], entries: [{ k: 0, inputs: [0, 0] }] });
  assert.equal(JSON.parse(probe.serialized).gust, 'undefined/undefined/undefined/undefined', 'Date, fetch, process and require do not exist where a title runs');
  // 4. the audit's first probe: a marker set at module top level never lands in THIS process
  const marker = 'globalThis.__litAuditMarker = true;' + String.fromCharCode(10) + good;
  await check(marker);
  assert.equal(globalThis.__litAuditMarker, undefined, 'title top-level code must not execute in the node process');

  writeFileSync(join(tmp, 'dirty.js'), dirty); writeFileSync(join(tmp, 'bracket.js'), bracket);
  await assert.rejects(createNode({ dataDir: join(tmp, 'n-dirty'), offline: true, heartbeatMs: 200, operator: 'x', roles: ['mesh', 'host'], rulesets: [join(tmp, 'dirty.js')] }), /refused \(static, nothing executed\): purity/);
  await assert.rejects(createNode({ dataDir: join(tmp, 'n-bracket'), offline: true, heartbeatMs: 200, operator: 'x', roles: ['mesh', 'host'], rulesets: [join(tmp, 'bracket.js')] }), /refused \(sandbox\)/);

  // the good one loads, is advertised, and /titles lists it with its display
  const node = await createNode({ dataDir: join(tmp, 'n-good'), offline: true, heartbeatMs: 200, operator: 'x', roles: ['mesh', 'host'], rulesets: [join(tmp, 'good.js')] });
  t.after(async () => { await node.stop().catch(() => {}); });
  const rid = Object.keys(node.rulesets())[0];
  assert.match(rid, /^conf-.*\.v1$/);
  const { titles } = await (await fetch(`${node.addr}/titles`)).json();
  assert.equal(titles.length, 1);
  assert.equal(titles[0].rulesetId, rid);
  assert.equal(titles[0].display.title, 'Conformance Sample');
  assert.deepEqual(titles[0].hosts, [node.nodeId]);
  const health = await (await fetch(`${node.addr}/health`)).json();
  assert.equal(health.sandbox.flag, '--permission');
  assert.ok(health.sandbox.runs >= 2, 'manifest job + the determinism pair ran in the sandbox');
  // a peer offering a refused build over the wire gets the same answer, and a second offer is refused from memory
  await assert.rejects(node.installRuleset(bracket, null, { current: false }), /refused \(sandbox\)/);
  await assert.rejects(node.installRuleset(bracket, null, { current: false }), /refused earlier/);
  // a peer's build under the default trust policy needs a publisher attestation
  const other = good.replace('"Conformance Sample"', '"Untrusted Sample"');
  await assert.rejects(node.installRuleset(other, null, { current: false, origin: 'peer' }), /not signed by a trusted publisher/);
});

test('sandbox limits are enforced: a spinning title is killed, a hungry one aborts, neither blocks the node', { timeout: 60_000 }, async (t) => {
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { createSandbox } = await import('../node/sandbox.js');
  const sb = createSandbox({ timeoutMs: 1500, memoryMb: 64 });
  const good = readFileSync(join(tmp, 'good.js'), 'utf8');
  const P = ['p0'.padEnd(64, '0'), 'p1'.padEnd(64, '1')];
  const job = { kind: 'replay', seed: 'ab'.repeat(32), participants: P, entries: [{ k: 0, inputs: [1, 1] }] };
  const t0 = Date.now();
  await assert.rejects(sb.run(good.replace('if (state.over) return state;', 'for (;;) {}'), [job]), /deadline of 1500 ms/);
  assert.ok(Date.now() - t0 < 5000, 'the deadline is the deadline');
  const [bomb] = await sb.run(good.replace('if (state.over) return state;', 'const xs = []; for (;;) xs.push(new Array(1e6).fill(1));'), [job], { timeoutMs: 30_000 });
  assert.equal(bomb.ok, false); assert.match(bomb.error, /out of memory|exited/);
  assert.equal(sb.status().killed, 1);
});
