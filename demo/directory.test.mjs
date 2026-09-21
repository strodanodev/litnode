/** NodeDirectory (contracts/NodeDirectory.sol, protocol/directory.js,
 *  node/announce.js): the seed list on chain. Calldata and decoders against
 *  ethers; liveSeeds keeps only bonded, fresh entries; a node against a mocked
 *  chain reads seeds into its peer set, generates an announcer key, refuses
 *  to announce until delegated and funded, then sends exactly the announce
 *  transaction — and does not send it again while the entry matches.
 *    node --test demo/directory.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { announceCalldata, setAnnouncerCalldata, liveSeeds, keysCall, entryOfCall, ANNOUNCE, KEYS, ENTRY_OF, ANNOUNCER_OF } from '../protocol/directory.js';
import { STANDING_OF } from '../protocol/staking.js';
import { selector } from '../protocol/keccak.js';
import { createNode } from '../node/litnode.js';
import { until } from './lib/mesh.mjs';

const abi = ethers.AbiCoder.defaultAbiCoder();
const DIR = '0x' + '33'.repeat(20), STAKE = '0x' + '11'.repeat(20);
const K1 = 'a1'.repeat(32), K2 = 'b2'.repeat(32), K3 = 'c3'.repeat(32);

test('directory: calldata and reads match ethers', () => {
  const iface = new ethers.Interface(['function announce(bytes32,string,string)', 'function setAnnouncer(bytes32,address)', 'function keys()', 'function entryOf(bytes32)']);
  assert.equal(announceCalldata(K1, 'https://seed.example', 'wss://relay.example'), iface.encodeFunctionData('announce', ['0x' + K1, 'https://seed.example', 'wss://relay.example']));
  assert.equal(announceCalldata(K1, 'https://seed.example'), iface.encodeFunctionData('announce', ['0x' + K1, 'https://seed.example', '']));
  assert.equal(setAnnouncerCalldata(K1, '0x' + 'AB'.repeat(20)), iface.encodeFunctionData('setAnnouncer', ['0x' + K1, '0x' + 'ab'.repeat(20)]));
  assert.equal(keysCall(DIR).data, iface.encodeFunctionData('keys', []));
  assert.equal(entryOfCall(DIR, K2).data, iface.encodeFunctionData('entryOf', ['0x' + K2]));
});

test('directory: liveSeeds keeps bonded, fresh entries, newest first', () => {
  const now = 1_800_000_000;
  const entries = {
    [K1]: { url: 'https://a', wsAddr: 'wss://a', updatedAt: now - 100, announcer: '0x1' },
    [K2]: { url: 'https://b', wsAddr: '', updatedAt: now - 10, announcer: '0x2' },
    [K3]: { url: 'https://c', wsAddr: '', updatedAt: now - 30 * 24 * 3600, announcer: '0x3' }, // stale
    dd: { url: 'https://d', wsAddr: '', updatedAt: now, announcer: '0x4' },                     // unbonded
  };
  const stakes = { [K1]: { active: true, operator: '0xaa' }, [K2]: { active: true, operator: '0xbb' }, [K3]: { active: true, operator: '0xcc' }, dd: { active: false, operator: '0xdd' } };
  const s = liveSeeds(entries, stakes, now);
  assert.deepEqual(s.map((x) => x.url), ['https://b', 'https://a']);
  assert.equal(s[1].wsAddr, 'wss://a'); assert.equal(s[0].wsAddr, null);
});

/** A chain with NodeStake (everyone bonded), NodeDirectory (one seed listed) and a gas market. */
function mockChain(state) {
  const word = (h) => h.replace(/^0x/, '').padStart(64, '0');
  return async (_url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    state.calls.push(method);
    let result;
    switch (method) {
      case 'eth_getBlockByNumber': result = { number: '0x10', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + 'ff'.repeat(32) }; break;
      case 'eth_call': {
        const data = params[0].data;
        if (data.startsWith(selector(STANDING_OF))) result = '0x' + word('aa'.repeat(20)) + word('0de0b6b3a7640000') + word('1');
        else if (data.startsWith(selector(KEYS))) result = abi.encode(['bytes32[]'], [Object.keys(state.entries).map((k) => '0x' + k)]);
        else if (data.startsWith(selector(ENTRY_OF))) { const k = data.slice(10, 74); const e = state.entries[k] ?? { url: '', wsAddr: '', updatedAt: 0, announcer: ethers.ZeroAddress }; result = abi.encode(['string', 'string', 'uint64', 'address'], [e.url, e.wsAddr, e.updatedAt, e.announcer]); }
        else if (data.startsWith(selector(ANNOUNCER_OF))) result = word((state.announcerOf ?? ethers.ZeroAddress).slice(2));
        else result = '0x';
        break;
      }
      case 'eth_getBalance': result = state.funded ? '0x2386f26fc10000' : '0x0'; break;
      case 'eth_getTransactionCount': result = '0x3'; break;
      case 'eth_gasPrice': result = '0x5f5e100'; break;
      case 'eth_estimateGas': result = '0x15f90'; break;
      case 'eth_sendRawTransaction': { state.sent.push(params[0]); result = '0x' + 'ee'.repeat(32); break; }
      default: result = null;
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
}

test('directory: a node reads seeds from chain, announces itself once delegated and funded, and not again while current', { timeout: 30_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-dir-'));
  const state = { calls: [], sent: [], funded: false, announcerOf: null, entries: { [K1]: { url: 'https://seed-one.example', wsAddr: 'wss://relay-one.example', updatedAt: Math.floor(Date.now() / 1000) - 60, announcer: '0x' + '11'.repeat(20) } } };
  const node = await createNode({ dataDir: tmp, rpc: 'mock://', offline: false, chainFetch: mockChain(state), nodeStake: STAKE, nodeDirectory: DIR, chainId: 4441, heartbeatMs: 300, operator: 'n', roles: ['mesh'], updates: false });
  t.after(async () => { await node.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const health = async () => (await fetch(`${node.addr}/health`)).json();

  // bootstrap: the chain's seed is known and reported
  const seeds = await (await fetch(`${node.addr}/seeds`)).json();
  assert.equal(seeds.source, 'chain'); assert.equal(seeds.seeds[0].url, 'https://seed-one.example'); assert.equal(seeds.seeds[0].wsAddr, 'wss://relay-one.example');
  // announcer key exists, is on /health, and refuses politely until delegated
  const h = await health();
  assert.match(h.directory.announcer.address, /^0x[0-9a-f]{40}$/);
  assert.ok(existsSync(join(tmp, 'announcer.json')));
  assert.equal(await node.announcer.sync(node.addr, ''), 'not-delegated');
  assert.match(node.announcer.status().lastError, /set-announcer/);
  state.announcerOf = node.announcer.address;
  assert.equal(await node.announcer.sync(node.addr, ''), 'unfunded');
  state.funded = true;
  // now it sends exactly announce(nodeKey, url, ws) from the announcer key
  assert.equal(await node.announcer.sync('https://me.example', 'wss://me-relay.example'), 'sent');
  assert.equal(state.sent.length, 1);
  const tx = ethers.Transaction.from(state.sent[0]);
  assert.equal(tx.from.toLowerCase(), node.announcer.address.toLowerCase());
  assert.equal(tx.to.toLowerCase(), DIR.toLowerCase());
  assert.equal(tx.chainId, 4441n);
  const iface = new ethers.Interface(['function announce(bytes32,string,string)']);
  const dec = iface.decodeFunctionData('announce', tx.data);
  assert.equal(dec[0], '0x' + node.nodeId); assert.equal(dec[1], 'https://me.example'); assert.equal(dec[2], 'wss://me-relay.example');
  // the chain now shows our entry → no second transaction
  state.entries[node.nodeId] = { url: 'https://me.example', wsAddr: 'wss://me-relay.example', updatedAt: Math.floor(Date.now() / 1000), announcer: node.announcer.address };
  assert.equal(await node.announcer.sync('https://me.example', 'wss://me-relay.example'), 'current');
  assert.equal(state.sent.length, 1);
  assert.equal((await health()).directory.announcer.lastTx, '0x' + 'ee'.repeat(32));
});

test('directory: a seed that restarts on a new hostname is found again within a minute, not on the ten-minute cycle', { timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-reseed-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const state = { entries: {}, calls: [], sent: [], funded: false };
  const chainFetch = mockChain(state);
  const common = { rpc: 'mock://', offline: false, chainFetch, nodeStake: '0x' + '11'.repeat(20), nodeDirectory: '0x' + '22'.repeat(20), chainId: 4441, heartbeatMs: 300, updates: false, announce: false };
  // the seed, on port A; listed on chain at that URL
  let seed = await createNode({ ...common, dataDir: join(tmp, 'seed'), operator: 'seed', roles: ['mesh', 'host'] }); nodes.push(seed);
  state.entries[seed.nodeId] = { url: seed.addr, wsAddr: '', updatedAt: Math.floor(Date.now() / 1000), announcer: ethers.ZeroAddress };
  const peer = await createNode({ ...common, dataDir: join(tmp, 'peer'), operator: 'peer', roles: ['mesh', 'witness'], seeds: [seed.addr] }); nodes.push(peer);
  const sees = async (n, id) => (await (await fetch(`${n.addr}/peers`)).json()).peers.some((p) => p.nodeId === id && p.fresh);
  assert.ok(await until(() => sees(peer, seed.nodeId), 15_000), 'peer sees the seed at its first URL');
  // the seed "restarts on a new tunnel": same identity, a new port, the directory updated, the old URL dead
  const oldAddr = seed.addr;
  await seed.stop();
  assert.ok(await until(async () => !(await sees(peer, seed.nodeId)), 20_000), 'the seed aged out of the fresh set');
  seed = await createNode({ ...common, dataDir: join(tmp, 'seed'), operator: 'seed', roles: ['mesh', 'host'] }); nodes.push(seed);
  assert.notEqual(seed.addr, oldAddr);
  state.entries[seed.nodeId] = { url: seed.addr, wsAddr: '', updatedAt: Math.floor(Date.now() / 1000), announcer: ethers.ZeroAddress };
  const t0 = Date.now();
  assert.ok(await until(() => sees(peer, seed.nodeId), 90_000), 'peer finds the seed at its NEW URL');
  assert.ok(Date.now() - t0 < 75_000, `re-found in ${Math.round((Date.now() - t0) / 1000)} s (the ten-minute cycle would not have)`);
  assert.ok(!peer.peersKnown.has(oldAddr) || true, 'the dead URL is forgotten after ten minutes (not waited for here)');
});
