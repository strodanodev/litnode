/** RPC fallback (node/chain.js, M4): a node given more than one endpoint keeps reading the chain while its
 *  preferred one fails, comes back to it once it answers, never moves a reverted call, and never takes logs for a
 *  range from an endpoint that has not reached the range's end.
 *    node --test demo/rpc-fallback.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChain, redactRpc, rpcList } from '../node/chain.js';
import { createNode } from '../node/litnode.js';

/** Endpoints by URL: each a function (method, params) → result, or throws { status } for an HTTP failure. */
const fakeFetch = (eps, seen = []) => async (url, init) => {
  const { id, method, params } = JSON.parse(init.body);
  seen.push(`${url} ${method}`);
  const ep = eps[url];
  if (!ep) throw new TypeError('fetch failed');
  let out;
  try { out = await ep(method, params); } catch (e) {
    if (e.status) return { status: e.status, text: async () => (e.status === 429 ? '{"jsonrpc":"2.0","error":{"code":-32005,"message":"rate limited"}}' : '<html>bad gateway</html>') };
    if (e.revert) return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } }) };
    throw e;
  }
  return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result: out }) };
};
const http = (status) => () => { throw Object.assign(new Error('http'), { status }); };
const block = (n) => ({ number: '0x' + n.toString(16), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + n.toString(16).padStart(64, '0') });

test('rpc fallback: a failing preferred endpoint is benched, calls move at once, and come back when it answers', async (t) => {
  let primaryUp = false;
  const seen = [];
  const chain = createChain({
    rpc: 'https://a.example/http,https://b.example/http',
    fetchImpl: fakeFetch({
      'https://a.example/http': (m) => { if (!primaryUp) throw Object.assign(new Error('x'), { status: 502 }); return m === 'eth_blockNumber' ? '0x64' : block(100); },
      'https://b.example/http': (m) => (m === 'eth_blockNumber' ? '0x63' : block(99)),
    }, seen),
  });
  const t0 = Date.now();
  assert.equal((await chain.pollBlock()).number, 99, 'answered by the fallback');
  assert.ok(Date.now() - t0 < 900, 'no pause before trying the fallback');
  let st = chain.status();
  assert.equal(st.rpc, 'https://b.example/http');
  assert.equal(st.rpcEndpoints[0].down, true);
  assert.match(st.rpcEndpoints[0].lastError, /502/);
  assert.equal(st.rpcEndpoints[1].active, true);

  // benched: the next call goes straight to the fallback, the preferred endpoint is not asked again
  seen.length = 0;
  await chain.blockNumber();
  assert.deepEqual(seen, ['https://b.example/http eth_blockNumber']);

  // the bench ends (a minute later): the preferred endpoint is asked first again, and answers
  primaryUp = true;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  assert.equal(await chain.blockNumber(), 100);
  st = chain.status();
  assert.equal(st.rpc, 'https://a.example/http');
  assert.equal(st.rpcEndpoints[0].down, false);
  assert.equal(st.rpcEndpoints[0].failures, 0);
});

test('rpc fallback: a revert is an answer — thrown at once, the endpoint not benched, the fallback not asked', async () => {
  const seen = [];
  const chain = createChain({
    rpc: ['https://a.example/http', 'https://b.example/http'],
    fetchImpl: fakeFetch({ 'https://a.example/http': () => { throw Object.assign(new Error('r'), { revert: true }); }, 'https://b.example/http': () => '0x1' }, seen),
  });
  await assert.rejects(chain.rpc('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest']), /execution reverted/);
  assert.deepEqual(seen, ['https://a.example/http eth_call']);
  assert.equal(chain.status().rpcEndpoints[0].down, false);
});

test('rpc fallback: a 429 moves the call; a refused connection moves the call', async () => {
  for (const failing of [http(429), () => { throw new TypeError('fetch failed'); }]) {
    const chain = createChain({ rpc: ['https://a.example/http', 'https://b.example/http'], fetchImpl: fakeFetch({ 'https://a.example/http': failing, 'https://b.example/http': () => '0x2a' }) });
    assert.equal(await chain.blockNumber(), 42);
    assert.equal(chain.status().rpcEndpoints[1].active, true);
  }
});

test('rpc fallback: logs for a range are never taken from an endpoint behind its end (the cursor would skip events)', async () => {
  let bHead = 95;
  const seen = [];
  const chain = createChain({
    rpc: ['https://a.example/http', 'https://b.example/http'],
    fetchImpl: fakeFetch({
      'https://a.example/http': http(503),
      'https://b.example/http': (m) => (m === 'eth_blockNumber' ? '0x' + bHead.toString(16) : m === 'eth_getLogs' ? [] : null),
    }, seen),
  });
  const filter = { address: '0x' + '22'.repeat(20), fromBlock: '0x5a', toBlock: '0x64' }; // 90..100
  await assert.rejects(chain.rpc('eth_getLogs', [filter], 1), /behind 100/, 'b is at 95: refused, not an empty answer');
  assert.ok(!seen.some((s) => s.endsWith('eth_getLogs') && s.startsWith('https://b')), 'b was never asked for the logs');
  bHead = 120;
  assert.deepEqual(await chain.rpc('eth_getLogs', [filter], 1), [], 'b caught up: its answer counts');
  // one endpoint: no head check, the call goes as before
  const single = createChain({ rpc: 'https://b.example/http', fetchImpl: fakeFetch({ 'https://b.example/http': (m) => (m === 'eth_getLogs' ? [] : '0x0') }, seen) });
  seen.length = 0;
  await single.rpc('eth_getLogs', [filter]);
  assert.deepEqual(seen, ['https://b.example/http eth_getLogs']);
});

test('rpc fallback: every endpoint failing is retried with pauses and then throws; URLs on the dashboard are redacted', async () => {
  const chain = createChain({ rpc: ['https://a.example/http', 'https://b.example/http'], fetchImpl: fakeFetch({ 'https://a.example/http': http(502), 'https://b.example/http': http(530) }) });
  await assert.rejects(chain.rpc('eth_blockNumber', [], 2), /HTTP 530/);
  assert.equal(redactRpc('https://user:pw@eth.example.com/v2/abcdefghijklmnop1234?key=x'), 'https://eth.example.com/v2/…');
  assert.equal(redactRpc('https://liteforge.rpc.caldera.xyz/http'), 'https://liteforge.rpc.caldera.xyz/http');
  assert.deepEqual(rpcList(' https://a , https://b,,'), ['https://a', 'https://b']);
  assert.deepEqual(rpcList(['https://a']), ['https://a']);
});

test('rate limits: a 429 pauses the endpoint, calls fail at once without the network, and resume after the pause', async (t) => {
  let limitedNow = true;
  const seen = [];
  const chain = createChain({ rpc: 'https://a.example/http', fetchImpl: fakeFetch({ 'https://a.example/http': (m) => { if (limitedNow) throw Object.assign(new Error('x'), { status: 429 }); return '0x10'; } }, seen) });
  await assert.rejects(chain.blockNumber(), /429/);
  assert.equal(seen.length, 1, 'a rate limit is never retried');
  for (let i = 0; i < 5; i++) await assert.rejects(chain.blockNumber(), /rate-limited; calls paused until/);
  assert.equal(seen.length, 1, 'nothing is sent while paused');
  const st = chain.status();
  assert.ok(st.rateLimitedUntil, 'the pause shows on the dashboard');
  assert.ok(st.rpcEndpoints[0].limitedUntil);
  limitedNow = false;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31_000 });
  assert.equal(await chain.blockNumber(), 16, 'asked again once the pause is over');
  assert.equal(chain.status().rateLimitedUntil, null);
});

test('rate limits: the pause doubles while the limit lasts, and a JSON "Bandwidth limit exceeded" counts as one', async (t) => {
  const seen = [];
  const f = async (url, init) => {
    const { id } = JSON.parse(init.body); seen.push(url);
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32005, message: 'Bandwidth limit exceeded' } }) };
  };
  const chain = createChain({ rpc: 'https://a.example/http', fetchImpl: f });
  const t0 = Date.now();
  await assert.rejects(chain.blockNumber(), /Bandwidth limit exceeded \(rate limited\)/);
  const first = Date.parse(chain.status().rateLimitedUntil) - t0;
  assert.ok(first >= 29_000 && first <= 31_000, `first pause about 30 s (${first} ms)`);
  t.mock.timers.enable({ apis: ['Date'], now: t0 + 31_000 });
  await assert.rejects(chain.blockNumber(), /Bandwidth/);
  const second = Date.parse(chain.status().rateLimitedUntil) - (t0 + 31_000);
  assert.ok(second >= 59_000 && second <= 61_000, `second pause about 60 s (${second} ms)`);
  assert.equal(seen.length, 2);
});

test('rate limits: with a fallback, a rate-limited endpoint is skipped and the other answers', async () => {
  const seen = [];
  const chain = createChain({ rpc: ['https://a.example/http', 'https://b.example/http'], fetchImpl: fakeFetch({ 'https://a.example/http': http(429), 'https://b.example/http': () => '0x2a' }, seen) });
  assert.equal(await chain.blockNumber(), 42);
  seen.length = 0;
  assert.equal(await chain.blockNumber(), 42);
  assert.deepEqual(seen, ['https://b.example/http eth_blockNumber'], 'the limited endpoint is not asked during its pause');
});

test('a slow chain does not pile up calls: the chain half of a tick waits for the one before, gossip does not', { timeout: 30_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-slowrpc-'));
  let inFlight = 0, maxInFlight = 0, calls = 0;
  const slow = async (_url, init) => {
    const { id, method } = JSON.parse(init.body);
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1200));
    inFlight--;
    const result = method === 'eth_getBlockByNumber' ? { number: '0x' + (100 + calls).toString(16), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + calls.toString(16).padStart(64, '0') } : method === 'eth_blockNumber' ? '0x64' : '0x';
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
  };
  const node = await createNode({ dataDir: join(tmp, 'n'), rpc: 'mock://', offline: false, chainFetch: slow, heartbeatMs: 100, operator: 'slow', roles: ['mesh'], updates: false, announce: false });
  t.after(async () => { await node.stop(); rmSync(tmp, { recursive: true, force: true }); });
  const before = calls;
  await new Promise((r) => setTimeout(r, 3000)); // 30 ticks
  const h = await (await fetch(`${node.addr}/health`)).json();
  assert.equal(maxInFlight, 1, 'one chain call at a time, not one per tick');
  assert.ok(calls - before <= 4, `3 s of 1.2 s calls: a handful, not 30 (${calls - before})`);
  assert.ok(h.chainTicksSkipped >= 20, `ticks skipped their chain half while it ran (${h.chainTicksSkipped})`);
  const snap = await (await fetch(`${node.addr}/snapshot`)).json();
  assert.ok(snap.peers.some((p) => p.nodeId === node.nodeId), 'its own heartbeat stayed fresh: gossip did not wait on the chain');
});
