/** Release zips are whole: every npm script a zip ships resolves to a file in it, and everything those files import
 *  resolves too (audit 2026-10-21 §4.4: 0.11.29's portable zip lacked tools/lib/rpc.mjs, its operator zip named
 *  four scripts whose files were never copied). Stages both kinds into a temp folder; zips nothing.
 *    node --test demo/pack.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage, checkStage, scriptsFor, closure } from '../tools/lib/pack-plan.mjs';

const root = process.cwd();

test('pack: both zips stage whole — every script resolves and its import graph is in the zip', { timeout: 120_000 }, (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-pack-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  for (const kind of ['portable', 'operator']) {
    const { stage: dir, scripts, files } = stage(kind, { root, dist: tmp, name: `litnode-${kind}-test` });
    assert.deepEqual(checkStage(dir), [], `${kind} is whole`);
    for (const cmd of Object.values(scripts)) assert.ok(existsSync(join(dir, cmd.split(' ')[1])), `${kind}: ${cmd}`);
    assert.ok(files.includes('tools/lib/rpc.mjs'), `${kind}: bond-node's rpc helper ships with it`);
    assert.ok(!existsSync(join(dir, 'cabinet', '.vercel')), `${kind}: git-ignored files stay out`);
  }
  // The operator zip names the operator steps the docs teach; maintainer tools stay in the checkout.
  const op = scriptsFor('operator');
  for (const s of ['bond', 'delegate', 'enroll', 'announcer', 'host']) assert.ok(op[s], `operator script ${s}`);
  for (const s of ['deploy:testnet', 'release:registry', 'params']) assert.equal(op[s], undefined, `maintainer script ${s} is not shipped`);
});

test('pack: the check catches a missing import and an undeclared package', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-pack-bad-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { a: 'node a.mjs', b: 'node gone.mjs' }, dependencies: {} }));
  writeFileSync(join(tmp, 'a.mjs'), "import './lib/missing.mjs';\nimport { x } from 'ethers';\n// import 'in-a-comment';\nconsole.log('http://example.test/');\n");
  const problems = checkStage(tmp, { extraEntries: [] });
  assert.ok(problems.some((p) => /gone\.mjs is not in the zip/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /lib\/missing\.mjs, not in the zip/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /package ethers/.test(p)), problems.join('; '));
  assert.ok(!problems.some((p) => /in-a-comment/.test(p)), 'an import in a comment is not an import');
  assert.throws(() => closure(tmp, ['nope.mjs']), /does not exist/);
});
