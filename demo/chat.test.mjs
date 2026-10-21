/** Node chat (docs/NODE-CHAT.md): one public line between operators, riding the gossip. A message posted on one
 *  node's loopback is held by every peer within a few ticks and echoed back as its receipt; a forgery, an oversized
 *  or future-dated line and a burst are refused and never forwarded; a node that is behind gets the whole ring in
 *  its first reply; the ring has a ceiling; with NodeStake, only bonded keys travel.
 *    node --test demo/chat.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { seal, generateKeypair } from '../protocol/keys.js';
import { CHAT_TAG, CHAT_RING, CHAT_BURST, CHAT_PUSH_WINDOW_MS, chatId, chatBody, chatProblem, chatRateOk } from '../protocol/chat.js';
import { HEARTBEAT_TAG, epochOf } from '../protocol/snapshot.js';
import { STANDING_OF } from '../protocol/staking.js';
import { selector } from '../protocol/keccak.js';
import { readFleet } from '../tools/fleet.mjs';
import { until, sleep } from './lib/mesh.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'litnode-chat-'));
const nodes = [];
test.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
const spawn = async (name, opts = {}) => { const n = await createNode({ dataDir: join(tmp, name), offline: true, heartbeatMs: 200, operator: name, roles: ['mesh'], updates: false, ...opts }); nodes.push(n); return n; };
const post = (node, text) => fetch(`${node.addr}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
const gossip = async (node, msg) => (await fetch(`${node.addr}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })).json();
const health = async (node) => (await fetch(`${node.addr}/health`)).json();
const say = (kp, text, at = Date.now()) => seal(CHAT_TAG, { v: 1, at, text }, kp);

test('chat: pure parts — body, id, refusals, the order-independent rate limit', () => {
  const b = chatBody('  hello  ', 1000);
  assert.deepEqual(b, { v: 1, at: 1000, text: 'hello' });
  assert.throws(() => chatBody(''), /1\.\.280/);
  assert.throws(() => chatBody('x'.repeat(281)), /1\.\.280/);
  assert.throws(() => chatBody('a\u0007b'), /1\.\.280/);
  assert.equal(chatProblem({ body: { v: 1, at: 1000, text: 'two\nlines' }, signer: 's', sig: 'x' }, { now: 1000 }), null, 'a newline is allowed');
  assert.equal(chatProblem({ body: { v: 1, at: 1000 + 61_000, text: 'soon' }, signer: 's', sig: 'x' }, { now: 1000 }), 'window');
  assert.equal(chatProblem({ body: { v: 1, at: 1000 - 25 * 3600_000, text: 'old' }, signer: 's', sig: 'x' }, { now: 1000 }), 'window');
  assert.equal(chatProblem({ body: { v: 2, at: 1000, text: 'v2' }, signer: 's', sig: 'x' }, { now: 1000 }), 'malformed');
  const e1 = { body: { v: 1, at: 5, text: 'a' }, signer: 'k' }, e2 = { body: { v: 1, at: 5, text: 'a' }, signer: 'j' };
  assert.notEqual(chatId(e1), chatId(e2), 'same words from another key is another message');
  assert.equal(chatId(e1), chatId({ ...e1, sig: 'whatever' }), 'the id is over signer, time and text — not the signature');
  assert.equal(chatRateOk([0, 1000, 2000], 3000), false, 'three within fifteen seconds: a fourth is refused');
  assert.equal(chatRateOk([0, 1000, 2000], 20_000), true);
  assert.equal(chatRateOk([12_000, 1000, 2000], 0), false, 'whatever order they arrived in');
  assert.equal(chatRateOk([20_000, 1000, 2000], 0), true, 'twenty seconds away is outside the window');
});

test('chat: a line travels the mesh and comes back as its own receipt; /fleet carries the ring, signed', { timeout: 60_000 }, async () => {
  const a = await spawn('a');
  const b = await spawn('b', { seeds: [a.addr] });
  const c = await spawn('c', { seeds: [a.addr] });
  assert.ok(await until(() => [a, b, c].every((n) => n.snapshot().peers.length === 3)), 'three peers everywhere');

  const r = await post(a, '  gm mesh  ');
  assert.equal(r.status, 202);
  const { id, at, envelope } = await r.json();
  assert.equal(envelope.body.text, 'gm mesh', 'trimmed');
  assert.equal(envelope.signer, a.nodeId, 'signed by the node key');
  assert.equal(id, chatId(envelope));

  assert.ok(await until(() => b.chat().some((l) => l.id === id) && c.chat().some((l) => l.id === id), 5_000), 'b and c hold it within a few ticks');
  assert.ok(await until(() => a.chat().find((l) => l.id === id)?.seenBy >= 1, 5_000), 'a peer echoed it back: the receipt');
  const onB = b.chat().find((l) => l.id === id);
  assert.equal(onB.operator, 'a'); assert.equal(onB.mine, false); assert.equal(onB.at, at); assert.equal(onB.bonded, null, 'no stake table: bonded unknown');
  assert.equal(a.chat().find((l) => l.id === id).mine, true);
  // seen-by counts peer NODES, not sockets: b reaches a by push and by reply, and is one peer
  await sleep(1500);
  assert.ok(a.chat().find((l) => l.id === id).seenBy <= 2, `two peers at most, got ${a.chat().find((l) => l.id === id).seenBy}`);

  const f = await readFleet(b.addr, { expectNodeId: b.nodeId });
  assert.ok(Array.isArray(f.chat) && f.chat.some((l) => l.id === id && l.text === 'gm mesh'), '/fleet.chat, under the signed digest');
  assert.ok(f.events.some((e) => e.type === 'chat' && e.id === id && e.operator === 'a'), 'and an event for the Logs stream');
  assert.equal(f.events.filter((e) => e.type === 'chat' && e.id === id).length, 1, 'held once, emitted once, even when push and reply raced');

  // the window and the catch-up rule: a ten-minute-old line is held but not in the push window; a pusher that is behind gets the ring
  const old = await generateKeypair();
  const stale = await say(old, 'from ten minutes ago', Date.now() - 10 * 60_000);
  await gossip(a, { heartbeats: [], chat: [stale] });
  assert.ok(a.chat().some((l) => l.text === 'from ten minutes ago'), 'held: within a day');
  const fresh = await gossip(a, { chatNewest: Date.now() });
  assert.ok(!fresh.chat.some((e) => e.body.text === 'from ten minutes ago'), 'a peer that is current gets the two-minute window only');
  assert.ok(fresh.chat.some((e) => e.body.text === 'gm mesh'), 'which has the fresh line');
  const behind = await gossip(a, { chatNewest: 0 });
  assert.ok(behind.chat.some((e) => e.body.text === 'from ten minutes ago'), 'a peer with nothing gets the whole ring');
  assert.equal(typeof behind.chatNewest, 'number');
  const legacy = await gossip(a, {});
  assert.ok(Array.isArray(legacy.chat), 'a node that knows no chat still gets a well-formed reply');
});

test('chat: forgeries, oversize, future, bursts and strangers past the cap are refused and never forwarded', { timeout: 60_000 }, async () => {
  const d = await spawn('d');
  const kp = await generateKeypair();
  const real = await say(kp, 'real');
  const forged = { ...real, body: { ...real.body, text: 'forged' } };
  const long = await say(kp, 'x'.repeat(281));
  const future = await say(kp, 'from the future', Date.now() + 5 * 60_000);
  const padded = { ...(await say(kp, 'padded')), body: { ...(await say(kp, 'padded')).body, text: ' padded' } };
  const reply = await gossip(d, { chat: [forged, long, future, padded, real] });
  assert.deepEqual(reply.chat.map((e) => e.body.text), ['real'], 'only the real one is held and echoed');
  let g = (await health(d)).gossipLimits;
  assert.equal(g.chat, 1);
  assert.deepEqual(g.refused.chat, { badSig: 1, malformed: 2, window: 1, rate: 0, full: 0, unbonded: 0, unknown: 0 });

  // a burst from one key: the first CHAT_BURST within fifteen seconds stand, whatever order they arrive in
  const t0 = Date.now() - 60_000;
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => say(kp, `burst ${i}`, t0 + i * 1000)));
  await gossip(d, { chat: [...burst].reverse() });
  g = (await health(d)).gossipLimits;
  assert.equal(g.chat, 1 + CHAT_BURST);
  assert.equal(g.refused.chat.rate, 6 - CHAT_BURST);
  // and on loopback the node tells its own operator
  for (let i = 0; i < CHAT_BURST; i++) assert.equal((await post(d, `mine ${i}`)).status, 202);
  const fourth = await post(d, 'one too many');
  assert.equal(fourth.status, 429);
  assert.match((await fourth.json()).error, /too fast/);
  assert.equal((await post(d, '')).status, 400);
  assert.equal((await post(d, 'y'.repeat(281))).status, 400);

  // the ring has a ceiling: the oldest go first
  const keys = await Promise.all(Array.from({ length: 80 }, generateKeypair));
  const base = Date.now() - 2 * 3600_000;
  const many = [];
  for (let k = 0; k < keys.length; k++) for (let j = 0; j < 3; j++) many.push(await say(keys[k], `k${k} m${j}`, base + k * 60_000 + j * 6000));
  for (let i = 0; i < many.length; i += 50) await gossip(d, { chat: many.slice(i, i + 50) });
  g = (await health(d)).gossipLimits;
  assert.equal(g.chat, CHAT_RING, 'full, not past full');
  assert.equal(g.refused.chat.rate, 6 - CHAT_BURST + 1, 'three per key within fifteen seconds is within the limit (the +1 is the loopback fourth above)');
  const held = d.chat();
  assert.ok(!held.some((l) => l.text === 'k0 m0'), 'the oldest line is gone');
  assert.ok(held.some((l) => l.text === `k${keys.length - 1} m2`), 'the newest stays');
  assert.deepEqual(held.map((l) => l.at), [...held.map((l) => l.at)].sort((x, y) => x - y), 'served oldest first, newest last');
  const tooOld = await say(kp, 'older than the whole ring', base - 3600_000);
  await gossip(d, { chat: [tooOld] });
  assert.equal((await health(d)).gossipLimits.refused.chat.full, 1, 'a line older than everything a full ring holds is refused, not swapped in');
  // a reply never carries more than the ring, and a tick's push only the window
  const all = await gossip(d, { chatNewest: 0 });
  assert.equal(all.chat.length, CHAT_RING);
  assert.ok(all.chat.every((e) => chatProblem(e) === null));
  const win = await gossip(d, { chatNewest: Date.now() });
  assert.ok(win.chat.every((e) => e.body.at > Date.now() - CHAT_PUSH_WINDOW_MS - 1000));
});

/** NodeStake where only `bonded` keys are active (as demo/gossip-limits.test.mjs does it). */
function stakeChain(bonded) {
  const word = (h) => h.replace(/^0x/, '').padStart(64, '0');
  return async (_url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    let result = null;
    if (method === 'eth_getBlockByNumber') result = { number: '0x10', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + 'ff'.repeat(32) };
    else if (method === 'eth_blockNumber') result = '0x10';
    else if (method === 'eth_call' && params[0].data.startsWith(selector(STANDING_OF))) {
      const key = params[0].data.slice(10, 74);
      result = '0x' + word('aa'.repeat(20)) + word('0de0b6b3a7640000') + word(bonded.has(key) ? '1' : '0');
    } else if (method === 'eth_call') result = '0x';
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
}

test('chat: with NodeStake, a bonded key travels, an unbonded one is held but not forwarded, a stranger is dropped, and an unbonded node cannot speak', { timeout: 60_000 }, async () => {
  const bondedKp = await generateKeypair(), unbondedKp = await generateKeypair(), stranger = await generateKeypair();
  const e = await createNode({ dataDir: join(tmp, 'e'), rpc: 'mock://', offline: false, chainFetch: stakeChain(new Set([bondedKp.publicKey])), nodeStake: '0x' + '11'.repeat(20), chainId: 4441, heartbeatMs: 200, operator: 'e', roles: ['mesh'], updates: false, announce: false });
  nodes.push(e);
  const heartbeat = (kp) => seal(HEARTBEAT_TAG, { nodeId: kp.publicKey, operator: 'peer-' + kp.publicKey.slice(0, 4), roles: ['mesh'], region: 'local', addr: 'http://127.0.0.1:9', wsAddr: null, standing: 0, version: '0.0.0', protocol: PROTOCOL_VERSION, buildHashes: {}, manifests: {}, epoch: epochOf(Date.now()) }, kp);
  await gossip(e, { heartbeats: [await heartbeat(bondedKp), await heartbeat(unbondedKp)] });
  assert.ok(await until(async () => { const p = (await (await fetch(`${e.addr}/peers`)).json()).peers; return p.find((x) => x.nodeId === bondedKp.publicKey)?.bonded === true && p.find((x) => x.nodeId === unbondedKp.publicKey)?.bonded === false; }, 20_000), 'standings read for both peers');

  await gossip(e, { chat: [await say(bondedKp, 'bonded speaks'), await say(unbondedKp, 'unbonded speaks'), await say(stranger, 'stranger speaks')] });
  const lines = e.chat();
  assert.deepEqual(lines.map((l) => [l.text, l.bonded]).sort(), [['bonded speaks', true], ['unbonded speaks', false]], 'held: bonded and unbonded; the stranger is not');
  assert.equal(lines.find((l) => l.bonded).wallet?.toLowerCase(), '0x' + 'aa'.repeat(20), 'the wallet behind the key, from the stake table');
  const g = (await health(e)).gossipLimits;
  assert.equal(g.refused.chat.unknown, 1);
  const out = await gossip(e, { chatNewest: 0 });
  assert.deepEqual(out.chat.map((x) => x.body.text), ['bonded speaks'], 'only the bonded line is forwarded');
  // this node itself is not bonded (the mock says so): it may read, not speak
  assert.ok(await until(async () => (await health(e)).bonded === false, 10_000));
  const mine = await post(e, 'can I?');
  assert.equal(mine.status, 403);
  assert.match((await mine.json()).error, /bond this node/);
});
