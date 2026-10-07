/** RPC fallback (node/chain.js, M4): a node given more than one endpoint keeps reading the chain while its
 *  preferred one fails, comes back to it once it answers, never moves a reverted call, and never takes logs for a
 *  range from an endpoint that has not reached the range's end.
 *    node --test demo/rpc-fallback.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain, redactRpc, rpcList } from '../node/chain.js';

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
