/** Discovery and compatibility (audit finding 8): a discovered URL must
 *  prove possession of the key its directory entry names; peers on another
 *  protocol version are heard, listed, and excluded from placement.
 *    node --test demo/discovery.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { checkChallenge, newNonce } from '../protocol/challenge.js';
import { seal, generateKeypair } from '../protocol/keys.js';
import { HEARTBEAT_TAG, epochOf } from '../protocol/snapshot.js';
import { until } from './lib/mesh.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'litnode-disc-'));
const nodes = [];
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));

test('proof of possession: /whoami signs the nonce with the node key; a URL that is another node is refused as a seed', { timeout: 30_000 }, async (t) => {
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const a = await spawn({ operator: 'a', roles: ['mesh'] });
  const b = await spawn({ operator: 'b', roles: ['mesh'] });
  const nonce = newNonce();
  const ans = await (await fetch(`${a.addr}/whoami?nonce=${nonce}`)).json();
  assert.equal((await checkChallenge(ans, { expectNodeId: a.nodeId, nonce })).ok, true);
  assert.equal((await checkChallenge(ans, { expectNodeId: b.nodeId, nonce })).reason, 'identity');
  assert.equal((await checkChallenge(ans, { expectNodeId: a.nodeId, nonce: newNonce() })).reason, 'nonce');
  assert.equal((await checkChallenge({ ...ans, addr: 'https://evil.example' }, { expectNodeId: a.nodeId, nonce })).reason, 'signature');
  assert.equal((await fetch(`${a.addr}/whoami?nonce=zz`)).status, 400);
  // the directory says "key B is at A's URL": A cannot sign as B → not admitted as a peer
  assert.equal(await a.admitSeed({ nodeId: b.nodeId, url: a.addr }), false);
  assert.equal(a.peersKnown.has(a.addr), false);
  assert.equal(await a.admitSeed({ nodeId: b.nodeId, url: b.addr }), true);
  assert.equal(a.peersKnown.has(b.addr), true);
  assert.equal(a.seedChecks.get(a.addr).ok, false);

  // a peer on protocol 1 (an old build) is heard, listed as incompatible, and not in the snapshot
  const old = await generateKeypair();
  const hb = await seal(HEARTBEAT_TAG, { nodeId: old.publicKey, operator: 'legacy', roles: ['mesh', 'host'], region: 'local', addr: 'http://127.0.0.1:1', wsAddr: null, standing: 0, version: '0.6.5', buildHashes: {}, manifests: {}, epoch: epochOf(Date.now()) }, old);
  await fetch(`${a.addr}/gossip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ heartbeats: [hb] }) });
  const peers = await (await fetch(`${a.addr}/peers`)).json();
  assert.ok(peers.incompatible.some((p) => p.nodeId === old.publicKey && p.protocol === 1 && p.version === '0.6.5'));
  assert.ok(!peers.peers.some((p) => p.nodeId === old.publicKey));
  assert.ok(!(await (await fetch(`${a.addr}/snapshot`)).json()).peers.some((p) => p.nodeId === old.publicKey));
  assert.equal((await (await fetch(`${a.addr}/health`)).json()).incompatible, 1);
  // and a current peer is in
  assert.ok(await until(async () => (await (await fetch(`${a.addr}/snapshot`)).json()).peers.some((p) => p.nodeId === b.nodeId)));
});
