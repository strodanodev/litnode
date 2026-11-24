/** Durability (audit of 10 Nov 2026, audit/audit-2026-11-10.md §3): state files are written whole or not at all, a
 *  file that does not parse is moved aside instead of stopping the node at start, and every sender for one signing
 *  key stands in one line.
 *    node --test demo/durability.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, readJsonOr } from '../node/atomic.js';
import { keyQueue, isNonceError } from '../node/sender.js';
import { createNode } from '../node/litnode.js';

const RULESET = join(process.cwd(), 'rulesets', 'tug.v1.js');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-durable-'));
const nodes = [];
test.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

test('writeAtomic: the target is replaced in one step, a failed write leaves the old file and no temp behind', () => {
  const dir = join(tmp, 'atomic'); mkdirSync(dir);
  const f = join(dir, 'state.json');
  writeAtomic(f, JSON.stringify({ v: 1 }));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { v: 1 });
  writeAtomic(f, Buffer.from(JSON.stringify({ v: 2 })));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { v: 2 }, 'a Buffer too, over the existing file');
  assert.deepEqual(readdirSync(dir), ['state.json'], 'no temp file left');
  // a write that cannot finish (its target is a directory): throws, and nothing of it remains
  mkdirSync(join(dir, 'taken.json'));
  assert.throws(() => writeAtomic(join(dir, 'taken.json'), 'x'));
  assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'taken.json']);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { v: 2 }, 'the neighbour is untouched');
  assert.throws(() => writeAtomic(join(dir, 'no-such-folder', 'x.json'), 'x'));
});

test('readJsonOr: a torn file is moved aside and reported; a missing one is just the fallback', () => {
  const dir = join(tmp, 'read'); mkdirSync(dir);
  assert.equal(readJsonOr(join(dir, 'absent.json'), 'fallback'), 'fallback');
  writeFileSync(join(dir, 'torn.json'), '{"matchId":"abc","sco'); // what a crash mid-write left under an older build
  const seen = [];
  assert.equal(readJsonOr(join(dir, 'torn.json'), null, (file, e, moved) => seen.push({ file, moved, e: e.message })), null);
  assert.equal(seen.length, 1);
  assert.ok(!existsSync(join(dir, 'torn.json')), 'out of the way of the next start');
  assert.ok(seen[0].moved && existsSync(seen[0].moved) && /torn\.json\.corrupt-\d+$/.test(seen[0].moved), 'kept beside it, not deleted');
  assert.equal(readFileSync(seen[0].moved, 'utf8'), '{"matchId":"abc","sco');
});

test('a node whose store holds a torn delta and an empty ledger still starts, and serves what is whole', { timeout: 30_000 }, async () => {
  const dir = join(tmp, 'torn-store');
  for (const d of ['deltas', 'ledgers', 'epochs']) mkdirSync(join(dir, d), { recursive: true });
  const good = { matchId: 'whole-match', rulesetId: 'tug.v1', kind: 'replayable', mode: 'casual', placed: false, attestation: 'players', settledAt: new Date().toISOString(), participants: ['a', 'b'], cosigners: [], disputes: [] };
  writeFileSync(join(dir, 'deltas', 'whole-match.json'), JSON.stringify(good));
  writeFileSync(join(dir, 'ledgers', 'whole-match.json'), JSON.stringify({ matchId: 'whole-match', entries: [] }));
  writeFileSync(join(dir, 'deltas', 'torn-match.json'), JSON.stringify({ ...good, matchId: 'torn-match' }).slice(0, 90)); // cut off mid-document
  writeFileSync(join(dir, 'ledgers', 'empty-ledger.json'), '');                                                          // truncated, never written
  writeFileSync(join(dir, 'deltas', 'empty-ledger.json'), JSON.stringify({ ...good, matchId: 'empty-ledger' }));
  writeFileSync(join(dir, 'epochs', '1.json'), 'null');                                                                    // parses, but is not a record
  const logged = [];
  const a = await createNode({ dataDir: dir, offline: true, heartbeatMs: 200, operator: 'ts', roles: ['mesh', 'host'], rulesets: [RULESET], updates: false, log: (m) => logged.push(m) });
  nodes.push(a);
  assert.equal((await (await fetch(`${a.addr}/health`)).json()).nodeId, a.nodeId, 'the node is up');
  const ids = (await (await fetch(`${a.addr}/deltas`)).json()).deltas.map((d) => d.matchId);
  assert.ok(ids.includes('whole-match') && ids.includes('empty-ledger') && !ids.includes('torn-match'), `served: ${ids}`);
  assert.equal((await fetch(`${a.addr}/delta/whole-match`)).status, 200);
  assert.equal((await fetch(`${a.addr}/ledger/whole-match`)).status, 200);
  assert.equal((await fetch(`${a.addr}/ledger/empty-ledger`)).status, 404, 'a ledger that does not parse is not served, and does not throw');
  assert.ok(!existsSync(join(dir, 'deltas', 'torn-match.json')));
  assert.ok(readdirSync(join(dir, 'deltas')).some((n) => n.startsWith('torn-match.json.corrupt-')), 'the torn delta is kept aside for the operator');
  assert.ok(logged.some((m) => /store: .*torn-match\.json does not parse/.test(m)), 'and the log says so');
});

test('keyQueue: one line per signing key; a sender learns when another module sent before it; a failure does not stop the line', async () => {
  const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
  const order = [];
  const slow = (tag, ms) => async ({ foreign }) => { order.push(`${tag}:start${foreign ? ':foreign' : ''}`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}:end`); return tag; };
  const q = keyQueue(A);
  const results = await Promise.all([
    q.run('matchbook', slow('m1', 30)),
    keyQueue(A.toUpperCase().replace('0X', '0x')).run('announce', slow('a1', 5)),   // the same key, asked for again and in another case
    q.run('matchbook', slow('m2', 5)),
    keyQueue(B).run('matchbook', slow('other-key', 1)),                             // another key never waits
  ]);
  assert.deepEqual(results, ['m1', 'a1', 'm2', 'other-key']);
  const a = order.filter((x) => !x.startsWith('other-key'));
  assert.deepEqual(a, ['m1:start', 'm1:end', 'a1:start:foreign', 'a1:end', 'm2:start:foreign', 'm2:end'], 'strictly one at a time, in order; each told the previous send was not its own');
  assert.ok(order.indexOf('other-key:end') < order.indexOf('m1:end'), 'the other key finished while the first was still busy');
  // two in a row from the same owner: the local nonce count is still good
  const flags = [];
  await q.run('matchbook', async ({ foreign }) => flags.push(foreign));
  await q.run('matchbook', async ({ foreign }) => flags.push(foreign));
  assert.deepEqual(flags, [false, false]);
  // a send that throws rejects for its caller only
  await assert.rejects(q.run('proxy', async () => { throw new Error('nonce too low'); }), /nonce too low/);
  assert.equal(await q.run('matchbook', async ({ foreign }) => (foreign ? 'recount' : 'keep')), 'recount');
});

test('isNonceError: the refusals worth one more try with a fresh count, and not the others', () => {
  for (const m of ['nonce too low', 'Nonce too high', 'already known', 'replacement transaction underpriced', 'transaction underpriced']) assert.ok(isNonceError(new Error(m)), m);
  for (const m of ['execution reverted: WrongStatus', 'insufficient funds for gas * price + value', 'fee above MAX_FEE_GWEI', 'HTTP 429 from the RPC gateway']) assert.ok(!isNonceError(new Error(m)), m);
});
