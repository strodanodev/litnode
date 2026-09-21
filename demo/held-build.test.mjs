/** A witness that restarts with a build in its cache advertises it again
 *  without fetching it from anyone — a witness on 22 Sep 2026 re-fetched a
 *  build it held, from peers it could not reach, and advertised nothing
 *  meanwhile, so no panel could seat it.
 *    node --test demo/held-build.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { until } from './lib/mesh.mjs';

const RULESET = join(process.cwd(), 'rulesets', 'tug.v1.js');
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'rulesets', 'tug.v1.json'), 'utf8'));

test('a restarted witness makes a held build current from disk, with no fetch', { timeout: 90_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-held-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const host = await createNode({ dataDir: join(tmp, 'host'), offline: true, heartbeatMs: 200, operator: 'pub', roles: ['mesh', 'host'], rulesets: [RULESET], updates: false }); nodes.push(host);
  let events = [];
  const spawnWitness = () => createNode({ dataDir: join(tmp, 'w'), offline: true, heartbeatMs: 200, operator: 'w', roles: ['mesh', 'witness'], seeds: [host.addr], updates: false, onEvent: (e) => events.push(e) });
  let w = await spawnWitness(); nodes.push(w);
  assert.ok(await until(() => w.rulesets()['tug.v1'] === manifest.buildHash, 20_000), 'first boot: fetched from the host');
  assert.equal(events.find((e) => e.type === 'ruleset')?.origin, 'peer');
  await w.stop(); nodes.pop();
  // second boot: the build is in data/rulesets; it must become current from there
  events = [];
  w = await spawnWitness(); nodes.push(w);
  assert.ok(await until(() => w.rulesets()['tug.v1'] === manifest.buildHash, 20_000), 'restart: current again');
  const made = events.filter((e) => e.type === 'ruleset' && e.current);
  assert.equal(made.length, 1);
  assert.equal(made[0].held, true, 'made current from what it held, not fetched');
  const hb = (await (await fetch(`${w.addr}/health`)).json());
  assert.equal(hb.rulesets['tug.v1'], manifest.buildHash, 'advertised on /health, so a panel can seat it');
});
