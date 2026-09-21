/** The chain's beacon cache: a bucket's beacon is pinned the first time the
 *  block window yields it, and survives the window rolling on.
 *    node --test demo/beacon.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain } from '../node/chain.js';
import { bucketOf, bucketEnd } from '../protocol/pairing.js';

const hex = (n) => '0x' + n.toString(16);
const fakeRpc = (blocks) => async (_url, init) => {
  const { method } = JSON.parse(init.body);
  if (method !== 'eth_getBlockByNumber') throw new Error(`unexpected ${method}`);
  const b = blocks.shift();
  return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { number: hex(b.number), timestamp: hex(b.timestamp), hash: b.hash } }) };
};

test('chain.beaconFor pins a bucket\'s beacon; a window that starts after the bucket end knows nothing', async () => {
  const bucket = bucketOf(Date.now()) - 10;
  const end = bucketEnd(bucket) / 1000;
  const feed = [
    { number: 100, timestamp: end - 1, hash: '0x' + 'a'.repeat(64) },
    { number: 101, timestamp: end + 1, hash: '0x' + 'b'.repeat(64) },
    { number: 102, timestamp: end + 2, hash: '0x' + 'c'.repeat(64) },
  ];
  const chain = createChain({ rpc: 'http://fake', fetchImpl: fakeRpc(feed) });
  await chain.pollBlock();
  assert.equal(chain.beaconFor(bucket), null, 'only the pre-end block: not known yet');
  await chain.pollBlock();
  const first = chain.beaconFor(bucket);
  assert.equal(first.block, 101);
  assert.equal(first.source, 'chain');
  await chain.pollBlock();
  assert.deepEqual(chain.beaconFor(bucket), first, 'later blocks do not change it');

  // A node that starts polling after the bucket ended has no pre-end block.
  const late = createChain({ rpc: 'http://fake', fetchImpl: fakeRpc([{ number: 102, timestamp: end + 2, hash: '0x' + 'c'.repeat(64) }, { number: 103, timestamp: end + 3, hash: '0x' + 'd'.repeat(64) }]) });
  await late.pollBlock(); await late.pollBlock();
  assert.equal(late.beaconFor(bucket), null);
});

test('two nodes that sampled different blocks around the bucket end name the SAME beacon: the exact first block, found by number', async () => {
  const bucket = bucketOf(Date.now()) - 10;
  const end = bucketEnd(bucket) / 1000;
  // the chain: blocks a quarter second apart, timestamps in whole seconds as the chain reports them; 201 is the first at or after the end
  const chainBlocks = { 199: end - 0.5, 200: end - 0.25, 201: end + 0.0, 202: end + 0.25, 203: end + 0.5, 204: end + 0.75 };
  const hashOf = (n) => '0x' + n.toString(16).padStart(64, '0');
  const rpcOf = (sampled) => async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method !== 'eth_getBlockByNumber') throw new Error(`unexpected ${method}`);
    const n = params[0] === 'latest' ? sampled.shift() : parseInt(params[0], 16);
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { number: hex(n), timestamp: hex(Math.floor(chainBlocks[n])), hash: hashOf(n) } }) };
  };
  // node A sampled 199 then 203; node B sampled 200 then 204; neither saw 201
  const A = createChain({ rpc: 'http://fake', fetchImpl: rpcOf([199, 203]) });
  const B = createChain({ rpc: 'http://fake', fetchImpl: rpcOf([200, 204]) });
  await A.pollBlock(); await A.pollBlock(); await B.pollBlock(); await B.pollBlock();
  assert.equal(A.beaconFor(bucket), null, 'A brackets the end but is not sure which block was first: waits');
  assert.equal(B.beaconFor(bucket), null);
  await new Promise((r) => setTimeout(r, 50));
  const a = A.beaconFor(bucket), b = B.beaconFor(bucket);
  assert.ok(a && b, 'both resolved');
  assert.equal(a.beacon, b.beacon, 'the same beacon on both');
  assert.equal(a.source, 'chain');
  assert.equal(a.block, 201, 'the first block of the second the bucket ended in — by number, not by who sampled what');
});
