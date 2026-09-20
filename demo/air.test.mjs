/** Universal login (docs/UNIVERSAL-LOGIN.md): AIR session tokens verified
 *  against a JWKS, and a node that turns a verified AIR identity into a
 *  litVM proxy wallet + PlayerProfile with the AIR id bound — against a
 *  mocked chain that records every transaction the proxy signs.
 *    node --test demo/air.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../node/litnode.js';
import { verifyJwtWithKeys, createAirVerifier } from '../node/air.js';
import { airKey, nameFor, decodeJwtPayload } from '../protocol/air.js';
import { generateKeypair } from '../protocol/keys.js';
import { selector } from '../protocol/keccak.js';
import { OWNER_OF_KEY, PROFILE_OF, NAME_OF, REGISTER, BIND_KEY, REVOKE_KEY } from '../protocol/profile.js';

// ---------------------------------------------------------------- a throwaway AIR: ES256 keypair + JWKS + token minting
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-1', alg: 'ES256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (payload, { alg = 'ES256', kid = 'test-1', key = privateKey } = {}) => {
  const head = b64({ alg, typ: 'JWT', kid }), body = b64(payload);
  if (alg === 'none') return `${head}.${body}.`;
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
};
const now = Math.floor(Date.now() / 1000);
const SUB = '62e01755-138f-4e58-9cdc-fab71e037afd';

test('air: ES256 token verifies; exp required; alg none, wrong key, other partner refused', async () => {
  const p = verifyJwtWithKeys(mint({ sub: SUB, partnerId: 'p1', exp: now + 300 }), [JWK]);
  assert.equal(p.sub, SUB);
  assert.throws(() => verifyJwtWithKeys(mint({ sub: SUB }), [JWK]), /missing exp/);
  assert.throws(() => verifyJwtWithKeys(mint({ sub: SUB, exp: now - 10 }), [JWK]), /expired/);
  assert.throws(() => verifyJwtWithKeys(mint({ sub: SUB, exp: now + 300 }, { alg: 'none' }), [JWK]), /disallowed alg/);
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  assert.throws(() => verifyJwtWithKeys(mint({ sub: SUB, exp: now + 300 }, { key: other }), [JWK]), /bad signature/);
  assert.throws(() => verifyJwtWithKeys(mint({ sub: SUB, exp: now + 300 }, { kid: 'unknown' }), [JWK]), /no JWK/);

  let fetches = 0;
  const v = createAirVerifier({ jwksUrl: 'mock://a,mock://down', partnerId: 'p1', fetchImpl: async (u) => { fetches++; if (u === 'mock://down') throw new Error('down'); return { ok: true, json: async () => ({ keys: [JWK] }) }; } });
  const who = await v.verify(mint({ sub: SUB, partnerId: 'p1', email: 'Nezuko.K@example.com', abstractAccountAddress: '0xABCDEF0000000000000000000000000000000001', exp: now + 300 }));
  assert.deepEqual(who, { sub: SUB, partnerId: 'p1', address: '0xabcdef0000000000000000000000000000000001', email: 'Nezuko.K@example.com' });
  await assert.rejects(v.verify(mint({ sub: SUB, partnerId: 'p2', exp: now + 300 })), /another partner/);
  assert.equal(fetches, 2, 'one JWKS fetch per URL, cached after (the dead one counts as tried)');

  assert.equal(airKey(SUB).length, 64);
  assert.notEqual(airKey(SUB), airKey(SUB + 'x'));
  assert.equal(nameFor({ email: 'Nezuko.K@example.com' }), 'Nezuko.K');
  assert.equal(nameFor({ email: '@@@', sub: SUB }), 'air-62e01755');
  assert.equal(decodeJwtPayload(mint({ sub: SUB, exp: 1 })).sub, SUB);
});

// ---------------------------------------------------------------- a mocked litVM with one PlayerProfile
const CONTRACT = '0x' + '22'.repeat(20);
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const strRet = (s) => { const hx = Buffer.from(s).toString('hex'); return '0x' + word('20') + word((hx.length / 2).toString(16)) + hx.padEnd(Math.ceil(hx.length / 64) * 64 || 64, '0'); };
/** Minimal RLP decode: a list of byte strings (a legacy tx). */
function rlpDecode(buf) {
  const item = (pos) => {
    const b = buf[pos];
    if (b < 0x80) return [buf.subarray(pos, pos + 1), pos + 1];
    if (b < 0xb8) return [buf.subarray(pos + 1, pos + 1 + b - 0x80), pos + 1 + b - 0x80];
    if (b < 0xc0) { const n = b - 0xb7; const l = Number(BigInt('0x' + buf.subarray(pos + 1, pos + 1 + n).toString('hex'))); return [buf.subarray(pos + 1 + n, pos + 1 + n + l), pos + 1 + n + l]; }
    let n = 0, l; if (b < 0xf8) { l = b - 0xc0; n = 0; } else { n = b - 0xf7; l = Number(BigInt('0x' + buf.subarray(pos + 1, pos + 1 + n).toString('hex'))); }
    const out = []; let p = pos + 1 + n; const end = p + l;
    while (p < end) { const [v, np] = item(p); out.push(v); p = np; }
    return [out, p];
  };
  return item(0)[0];
}
function mockChain() {
  const st = { bindings: {}, profiles: {}, names: {}, balances: {}, nextToken: 1n, txs: [], lastFrom: null, nonces: {} };
  const bal = (a) => st.balances[a.toLowerCase()] ?? 0n;
  const fetchImpl = async (url, init) => {
    if (url === 'mock://jwks') return { ok: true, json: async () => ({ keys: [JWK] }) };
    const { id, method, params } = JSON.parse(init.body);
    let result = '0x';
    if (method === 'eth_getBlockByNumber') result = { number: '0x10', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + 'ff'.repeat(32) };
    else if (method === 'eth_call') {
      const data = params[0].data;
      if (data.startsWith(selector(OWNER_OF_KEY))) { const b = st.bindings[data.slice(10)]; result = b ? '0x' + word(b.owner) + word(b.tokenId.toString(16)) + word(b.active ? '1' : '0') : '0x' + '0'.repeat(192); }
      else if (data.startsWith(selector(PROFILE_OF))) { const t = st.profiles['0x' + data.slice(34)]; result = '0x' + word((t ?? 0n).toString(16)); }
      else if (data.startsWith(selector(NAME_OF))) result = strRet(st.names[BigInt('0x' + data.slice(10))] ?? '');
    }
    else if (method === 'eth_getBalance') result = '0x' + bal(params[0]).toString(16);
    else if (method === 'eth_getTransactionCount') result = '0x' + (st.nonces[params[0].toLowerCase()] ?? 0n).toString(16);
    else if (method === 'eth_gasPrice') result = '0x3b9aca00';
    else if (method === 'eth_estimateGas') { st.lastFrom = params[0].from.toLowerCase(); result = '0x186a0'; }
    else if (method === 'eth_sendRawTransaction') {
      const [, , , to, value, data] = rlpDecode(Buffer.from(params[0].slice(2), 'hex'));
      const from = st.lastFrom, toHex = '0x' + to.toString('hex'), v = value.length ? BigInt('0x' + value.toString('hex')) : 0n, d = '0x' + data.toString('hex');
      st.nonces[from] = (st.nonces[from] ?? 0n) + 1n;
      st.balances[from] = bal(from) - v - 21000n * 1000000000n;
      st.balances[toHex] = bal(toHex) + v;
      const tx = { from, to: toHex, value: v, data: d };
      if (toHex === CONTRACT) {
        if (d.startsWith(selector(REGISTER))) { if (st.profiles[from]) throw new Error('AlreadyRegistered'); const t = st.nextToken++; st.profiles[from] = t; const len = Number(BigInt('0x' + d.slice(10 + 128, 10 + 192))); st.names[t] = Buffer.from(d.slice(10 + 192, 10 + 192 + len * 2), 'hex').toString(); st.bindings[d.slice(10, 74)] = { owner: from, tokenId: t, active: true }; tx.op = 'register'; }
        else if (d.startsWith(selector(BIND_KEY))) { const t = st.profiles[from]; if (!t) throw new Error('NoProfile'); const k = d.slice(10, 74); if (st.bindings[k] && st.bindings[k].tokenId !== t) throw new Error('KeyTaken'); st.bindings[k] = { owner: from, tokenId: t, active: true }; tx.op = 'bind'; }
        else if (d.startsWith(selector(REVOKE_KEY))) { const k = d.slice(10, 74); if (st.bindings[k]?.owner !== from) throw new Error('NotYourKey'); st.bindings[k].active = false; tx.op = 'revoke'; }
      } else tx.op = 'transfer';
      st.txs.push(tx);
      result = '0x' + st.txs.length.toString(16).padStart(64, '0');
    }
    else if (method === 'eth_getTransactionReceipt') result = { status: '0x1', transactionHash: params[0] };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
  return { st, fetchImpl };
}

test('air: first sign-in mints a sponsored proxy profile with the AIR id bound; the browser key binds; idempotent; revoke; custody elsewhere', { timeout: 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-air-'));
  const { st, fetchImpl } = mockChain();
  const node = await createNode({ dataDir: join(tmp, 'n'), rpc: 'mock://', offline: false, playerProfile: CONTRACT, chainFetch: fetchImpl, heartbeatMs: 200, operator: 'publisher', updates: false, air: { partnerId: 'p1', jwksUrl: 'mock://jwks' } });
  t.after(async () => { await node.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const json = async (p, body) => { const r = await fetch(`${node.addr}${p}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined); return { status: r.status, body: await r.json() }; };

  const info = (await json('/air')).body;
  assert.equal(info.enabled, true); assert.equal(info.partnerId, 'p1'); assert.match(info.sponsor, /^0x[0-9a-f]{40}$/);
  st.balances[info.sponsor.toLowerCase()] = 10n ** 18n; // the operator funded the announcer/sponsor key

  const browser = await generateKeypair();
  const token = mint({ sub: SUB, partnerId: 'p1', email: 'nezuko@example.com', exp: now + 300 });
  assert.equal((await json('/air/session', { token: 'garbage', playerKey: browser.publicKey })).status, 401);
  assert.equal((await json('/air/session', { token: mint({ sub: SUB, partnerId: 'p2', exp: now + 300 }) })).status, 401, 'another partner app');

  const r1 = (await json('/air/session', { token, playerKey: browser.publicKey }));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const s1 = r1.body;
  assert.equal(s1.custody, 'here'); assert.equal(s1.tokenId, '1'); assert.equal(s1.name, 'nezuko'); assert.equal(s1.email, 'nezuko@example.com');
  assert.deepEqual(s1.steps.map((x) => x.step), ['sponsor', 'register', 'bind-player-key']);
  assert.deepEqual(st.txs.map((x) => x.op), ['transfer', 'register', 'bind'], 'sponsor top-up, then the proxy registers and binds');
  assert.equal(st.txs[0].from, info.sponsor.toLowerCase()); assert.equal(st.txs[0].to, s1.address);
  assert.equal(st.txs[1].from, s1.address, 'the proxy itself is msg.sender for register');
  assert.equal(st.bindings[airKey(SUB)].owner, s1.address, 'the AIR id is a key on the profile');
  assert.equal(s1.playerKey.owner, s1.address); assert.equal(s1.playerKey.active, true);
  assert.equal(readdirSync(join(tmp, 'n', 'proxies')).length, 1, 'one proxy key file');

  const s2 = (await json('/air/session', { token, playerKey: browser.publicKey })).body;
  assert.equal(s2.address, s1.address); assert.deepEqual(s2.steps, [], 'nothing to do the second time');
  assert.equal(st.txs.length, 3);

  const second = await generateKeypair();
  const s3 = (await json('/air/session', { token, playerKey: second.publicKey })).body;
  assert.deepEqual(s3.steps.map((x) => x.step), ['bind-player-key'], 'a second device binds without another profile');
  assert.equal(st.bindings[second.publicKey].tokenId, 1n);

  const res = (await json(`/air/resolve?sub=${SUB}`)).body;
  assert.equal(res.profile.address, s1.address); assert.equal(res.profile.name, 'nezuko');

  const rv = (await json('/air/revoke', { token, playerKey: second.publicKey })).body;
  assert.equal(rv.revoked, true); assert.equal(st.bindings[second.publicKey].active, false);
  assert.equal((await json(`/profile?player=${second.publicKey}`)).body.active, false, 'the node reads the revocation like any other');

  // A browser key already bound to someone else's wallet is left alone.
  const stranger = await generateKeypair();
  st.bindings[stranger.publicKey] = { owner: '0x' + 'ee'.repeat(20), tokenId: 9n, active: true };
  const s4 = (await json('/air/session', { token, playerKey: stranger.publicKey })).body;
  assert.match(s4.steps[0].skipped, /another wallet/);

  // The profile exists on chain but this node does not hold the key: resolvable, not signable.
  const other = 'ffffffff-0000-4000-8000-000000000000';
  st.profiles['0x' + 'dd'.repeat(20)] = 7n; st.names[7n] = 'Elsewhere'; st.bindings[airKey(other)] = { owner: '0x' + 'dd'.repeat(20), tokenId: 7n, active: true };
  const s5 = (await json('/air/session', { token: mint({ sub: other, partnerId: 'p1', exp: now + 300 }), playerKey: browser.publicKey })).body;
  assert.equal(s5.custody, 'elsewhere'); assert.equal(s5.name, 'Elsewhere'); assert.equal(s5.address, '0x' + 'dd'.repeat(20));
  assert.equal(existsSync(join(tmp, 'n', 'proxies', `${airKey(other)}.json`)), false, 'no key minted for a profile that exists elsewhere');
});
