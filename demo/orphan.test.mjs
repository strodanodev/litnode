/** A node whose launcher dies keeps working (m16, 4 Oct 2026). The Control Plane runs the node with its
 *  output in pipes; when the Control Plane went away, the node's next log line failed with EPIPE, the
 *  keep-alive handler logged that to the same dead pipe, and the loop left the node answering GETs but never
 *  finishing a request body: gossip, /queue and /ledger all hung. Now the first write error moves the log to
 *  <dataDir>/litnode.log and the node carries on.
 *    node --test demo/orphan.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeypair, seal } from '../protocol/keys.js';
import { QUEUE_TAG, bucketOf } from '../protocol/pairing.js';

const PORT = 7951;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });

test('a node keeps answering request bodies after its launcher dies', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'lit-orphan-'));
  const pid = Number(execFileSync(process.execPath, [join('demo', 'fixtures', 'orphan-parent.mjs'), String(PORT), tmp], { encoding: 'utf8', windowsHide: true }).trim());
  t.after(() => { try { process.kill(pid); } catch { /* gone */ } rmSync(tmp, { recursive: true, force: true }); });
  assert.ok(pid > 0, 'the launcher started a node and died');

  // Make the orphan write: every accepted queue entry is a log line into the pipe nobody reads.
  for (let i = 0; i < 25; i++) {
    const kp = await generateKeypair();
    const env = await seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: 'nothing.v1', tokenId: '1', mode: 'casual', bucket: bucketOf(Date.now()), region: 'lan' }, kp);
    const r = await post('/queue', JSON.stringify(env));
    assert.ok(r.status === 202 || r.status === 200, `queue entry ${i}: ${r.status}`);
  }
  await sleep(2000);
  for (let i = 0; i < 5; i++) {
    const r = await post('/queue', '{}');
    assert.equal(r.status, 400, 'a request body still arrives and is answered');
    assert.equal((await post('/gossip', '{}')).status, 200);
    await sleep(500);
  }
  const log = join(tmp, 'litnode.log');
  assert.ok(existsSync(log) && /console output stopped/.test(readFileSync(log, 'utf8')), 'the log moved to the data directory');
});

test('a blocked event loop is noticed, logged and reported on /health', { timeout: 60_000 }, async (t) => {
  const { createNode } = await import('../node/litnode.js');
  const tmp = mkdtempSync(join(tmpdir(), 'lit-stall-'));
  const lines = [];
  const node = await createNode({ dataDir: tmp, offline: true, heartbeatMs: 200, operator: 'stall', roles: ['mesh'], updates: false, log: (m) => lines.push(m) });
  t.after(async () => { await node.stop(); rmSync(tmp, { recursive: true, force: true }); });
  assert.equal((await (await fetch(`${node.addr}/health`)).json()).stalls.count, 0);
  const end = Date.now() + 1600; while (Date.now() < end) { /* block the loop, as a synchronous call would */ }
  await sleep(600);
  const { stalls } = await (await fetch(`${node.addr}/health`)).json();
  assert.equal(stalls.count, 1);
  assert.ok(stalls.maxMs >= 1200 && stalls.last.ms === stalls.maxMs, JSON.stringify(stalls));
  assert.ok(lines.some((l) => /^event loop stalled \d+ ms/.test(l)));
});
