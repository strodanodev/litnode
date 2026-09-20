/** TitleRegistry: a title is an ERC-721 whose holder is the publisher.
 *  Behaviour on the in-process EVM (demo/lib/evm.mjs): first-come claim,
 *  the first build active at once, a retune held for activationDelay, an
 *  immediate revoke, a hand-over by transferFrom moving the right to set
 *  builds, and the refusals — a stranger, a re-claim, a too-soon retune.
 *  Then the node-side encoders against ethers' ABI coder, and the verdict
 *  a node acts on. The node's own use of it (a peer's build loading only
 *  when the chain says so) is in demo/hydration.test.mjs.
 *    node --test demo/title-registry.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createEvm } from './lib/evm.mjs';
import { sha256Hex } from '../protocol/canonical.js';
import { selector } from '../protocol/keccak.js';
import * as t from '../protocol/title.js';

const DELAY = 60;
const H = (s) => '0x' + sha256Hex(s);
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const STUDIO = 1, BUYER = 2, STRANGER = 3;

test('title registry: claim, retune, revoke, hand over', async () => {
  const evm = await createEvm();
  const reg = await evm.deploy('TitleRegistry.sol', 'TitleRegistry', [DELAY]);
  const id = (await evm.read(reg, 'titleIdOf', ['tug.v1']))[0];
  assert.equal(id, BigInt('0x' + t.titleIdOf('tug.v1')), 'the node computes the same tokenId as the contract');

  // unregistered: no publisher, nothing active
  let st = await evm.read(reg, 'buildStatus', [id, H('b1')]);
  assert.equal(st.publisher, ethers.ZeroAddress); assert.equal(st.registered, false); assert.equal(st.active, false);
  await rejects(evm.read(reg, 'ownerOf', [id]), /UnknownTitle/);

  // claim: the first build is active at once
  const r = await evm.send(STUDIO, reg, 'register', ['tug.v1', H('b1')]);
  assert.deepEqual(r.logs.map((l) => l.name), ['Transfer', 'Registered', 'BuildSet']);
  assert.equal((await evm.read(reg, 'ownerOf', [id]))[0].toLowerCase(), evm.addressOf(STUDIO));
  st = await evm.read(reg, 'buildStatus', [id, H('b1')]);
  assert.equal(st.publisher.toLowerCase(), evm.addressOf(STUDIO)); assert.equal(st.active, true);
  await rejects(evm.send(BUYER, reg, 'register', ['tug.v1', H('x')]), /AlreadyRegistered/);
  await rejects(evm.send(STUDIO, reg, 'register', ['', H('x')]), /BadRulesetId/);
  await rejects(evm.send(STUDIO, reg, 'register', ['other.v1', ethers.ZeroHash]), /UnknownBuild/);

  // a retune waits the delay; a stranger cannot set one; the same hash cannot be re-added
  await rejects(evm.send(STRANGER, reg, 'setBuild', [id, H('b2'), 0]), /NotOwner/);
  await rejects(evm.send(STUDIO, reg, 'setBuild', [id, H('b2'), evm.now() + 1]), /TooSoon/);
  await evm.send(STUDIO, reg, 'setBuild', [id, H('b2'), 0]);
  await rejects(evm.send(STUDIO, reg, 'setBuild', [id, H('b2'), 0]), /BuildExists/);
  st = await evm.read(reg, 'buildStatus', [id, H('b2')]);
  assert.equal(st.registered, true); assert.equal(st.active, false, 'pending until the delay runs');
  evm.warp(DELAY);
  st = await evm.read(reg, 'buildStatus', [id, H('b2')]);
  assert.equal(st.active, true);
  assert.deepEqual([...(await evm.read(reg, 'buildsOf', [id]))[0]], [H('b1'), H('b2')]);

  // revoke is immediate and only the holder's
  await rejects(evm.send(STRANGER, reg, 'revokeBuild', [id, H('b1')]), /NotOwner/);
  await rejects(evm.send(STUDIO, reg, 'revokeBuild', [id, H('nope')]), /UnknownBuild/);
  await evm.send(STUDIO, reg, 'revokeBuild', [id, H('b1')]);
  st = await evm.read(reg, 'buildStatus', [id, H('b1')]);
  assert.equal(st.revoked, true); assert.equal(st.active, false);

  // hand over: transferFrom moves the publisher; the old holder can no longer set builds, the new one can
  await rejects(evm.send(STRANGER, reg, 'transferFrom', [evm.addressOf(STUDIO), evm.addressOf(STRANGER), id]), /NotAuthorized/);
  await rejects(evm.send(STUDIO, reg, 'transferFrom', [evm.addressOf(BUYER), evm.addressOf(STRANGER), id]), /NotOwner/);
  await evm.send(STUDIO, reg, 'transferFrom', [evm.addressOf(STUDIO), evm.addressOf(BUYER), id]);
  assert.equal((await evm.read(reg, 'ownerOf', [id]))[0].toLowerCase(), evm.addressOf(BUYER));
  assert.equal((await evm.read(reg, 'balanceOf', [evm.addressOf(STUDIO)]))[0], 0n);
  assert.equal((await evm.read(reg, 'balanceOf', [evm.addressOf(BUYER)]))[0], 1n);
  await rejects(evm.send(STUDIO, reg, 'setBuild', [id, H('b3'), 0]), /NotOwner/);
  await evm.send(BUYER, reg, 'setBuild', [id, H('b3'), 0]);
  st = await evm.read(reg, 'buildStatus', [id, H('b2')]);
  assert.equal(st.publisher.toLowerCase(), evm.addressOf(BUYER)); assert.equal(st.active, true, 'the old active build survives the hand-over');
  // an approved operator may transfer on the holder's behalf
  await evm.send(BUYER, reg, 'approve', [evm.addressOf(STRANGER), id]);
  await evm.send(STRANGER, reg, 'transferFrom', [evm.addressOf(BUYER), evm.addressOf(STUDIO), id]);
  assert.equal((await evm.read(reg, 'ownerOf', [id]))[0].toLowerCase(), evm.addressOf(STUDIO));
  assert.equal((await evm.read(reg, 'getApproved', [id]))[0], ethers.ZeroAddress, 'approval cleared by the transfer');
  const info = await evm.read(reg, 'titleOf', [id]);
  assert.equal(info.rulesetId, 'tug.v1'); assert.equal(info.buildCount, 3n);
  assert.equal((await evm.read(reg, 'supportsInterface', ['0x80ac58cd']))[0], true, 'ERC-721');
  assert.equal((await evm.read(reg, 'tokenURI', [id]))[0], 'litvm-title:tug.v1');
});

test('title registry: node-side calldata and decoders agree with ethers', async () => {
  const iface = new ethers.Interface([
    'function buildStatus(uint256,bytes32) view returns (address publisher, bool registered, bool active, bool revoked, uint64 activatesAt)',
    'function titleOf(uint256) view returns (address publisher, string rulesetId, uint64 registeredAt, uint256 buildCount)',
    'function buildsOf(uint256) view returns (bytes32[])',
    'function register(string rulesetId, bytes32 buildHash)',
    'function setBuild(uint256,bytes32,uint64)',
    'function revokeBuild(uint256,bytes32)',
    'function transferFrom(address,address,uint256)',
    'function ownerOf(uint256) view returns (address)',
  ]);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const REG = '0x' + '11'.repeat(20), A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
  const id = BigInt('0x' + t.titleIdOf('agent-fighter.v1'));
  assert.equal(id, BigInt(ethers.keccak256(ethers.toUtf8Bytes('agent-fighter.v1'))));
  for (const sig of [t.BUILD_STATUS, t.TITLE_OF, t.BUILDS_OF, t.REGISTER_TITLE, t.SET_BUILD, t.REVOKE_BUILD, t.TRANSFER_FROM, t.OWNER_OF]) assert.equal(selector(sig), iface.getFunction(sig.slice(0, sig.indexOf('('))).selector, sig);
  assert.equal(t.buildStatusCall(REG, 'agent-fighter.v1', H('b')).data, iface.encodeFunctionData('buildStatus', [id, H('b')]));
  assert.equal(t.titleOfCall(REG, 'agent-fighter.v1').data, iface.encodeFunctionData('titleOf', [id]));
  assert.equal(t.registerCalldata('agent-fighter.v1', H('b')), iface.encodeFunctionData('register', ['agent-fighter.v1', H('b')]));
  assert.equal(t.registerCalldata('a-title-name-exactly-thirty-two!', H('b')), iface.encodeFunctionData('register', ['a-title-name-exactly-thirty-two!', H('b')]), 'a string filling a word exactly');
  assert.equal(t.setBuildCalldata('agent-fighter.v1', H('b'), 1_800_000_000), iface.encodeFunctionData('setBuild', [id, H('b'), 1_800_000_000]));
  assert.equal(t.revokeBuildCalldata('agent-fighter.v1', H('b')), iface.encodeFunctionData('revokeBuild', [id, H('b')]));
  assert.equal(t.transferCalldata(A, B, 'agent-fighter.v1'), iface.encodeFunctionData('transferFrom', [A, B, id]));
  assert.deepEqual(t.decodeBuildStatus(coder.encode(['address', 'bool', 'bool', 'bool', 'uint64'], [A, true, false, true, 7])), { publisher: A, registered: true, active: false, revoked: true, activatesAt: 7 });
  assert.deepEqual(t.decodeBuildStatus(coder.encode(['address', 'bool', 'bool', 'bool', 'uint64'], [ethers.ZeroAddress, false, false, false, 0])).publisher, null);
  assert.deepEqual(t.decodeTitle(coder.encode(['address', 'string', 'uint64', 'uint256'], [B, 'pickle-brawl.v1 — long label', 5, 2])), { publisher: B, rulesetId: 'pickle-brawl.v1 — long label', registeredAt: 5, buildCount: 2 });
  assert.deepEqual(t.decodeHashes(coder.encode(['bytes32[]'], [[H('1'), H('2')]])), [H('1').slice(2), H('2').slice(2)]);
  assert.equal(t.decodeOwner(coder.encode(['address'], [A])), A);
  assert.throws(() => t.registerCalldata('', H('b')), /1–64/);
  assert.throws(() => t.setBuildCalldata('x', 'nope', 0), /32 bytes/);
});

test('title registry: the verdict a node acts on', () => {
  const s = (o) => ({ publisher: '0x' + 'aa'.repeat(20), registered: true, active: true, revoked: false, activatesAt: 1, ...o });
  assert.match(t.titleVerdict(null).reason, /unreadable/);
  assert.match(t.titleVerdict(s({ publisher: null, registered: false, active: false })).reason, /title is not registered/);
  assert.match(t.titleVerdict(s({ registered: false, active: false })).reason, /build is not registered/);
  assert.match(t.titleVerdict(s({ revoked: true, active: false })).reason, /revoked/);
  assert.match(t.titleVerdict(s({ active: false, activatesAt: 1_800_000_000 })).reason, /activates at 2027-01-15/);
  assert.deepEqual(t.titleVerdict(s()), { ok: true, reason: null });
});

test('node: a peer\'s build loads only when TitleRegistry says so; published = the holder runs a bonded host', { timeout: 120_000 }, async (tc) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRpcEvm } = await import('./lib/rpc-evm.mjs');
  const { until } = await import('./lib/mesh.mjs');
  const { createNode } = await import('../node/litnode.js');
  const { generateKeypair } = await import('../protocol/keys.js');
  const { readFileSync } = await import('node:fs');
  const ROOT = process.cwd();
  const RULESET = join(ROOT, 'rulesets', 'tug.v1.js');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'rulesets', 'tug.v1.json'), 'utf8'));
  const ONE = 10n ** 18n, STUDIO = 1, WITNESS_OP = 2, BUYER = 3;

  const tmp = mkdtempSync(join(tmpdir(), 'litnode-title-'));
  const chain = await createRpcEvm();
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  tc.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });

  const token = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [token, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const reg = await chain.deploy('TitleRegistry.sol', 'TitleRegistry', [DELAY]);
  const bond = async (acct, name) => {
    const kp = await generateKeypair();
    const dir = join(tmp, name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(kp));
    await chain.send(acct, token, 'faucet', []);
    await chain.send(acct, token, 'approve', [stake, 10n * ONE]);
    await chain.send(acct, stake, 'stake', ['0x' + kp.publicKey, ONE]);
    return { kp, dir };
  };
  const hostId = await bond(STUDIO, 'host'), w1 = await bond(WITNESS_OP, 'w1'), w2 = await bond(WITNESS_OP + 2, 'w2'); // one faucet pull per wallet
  // TITLE_TRUST=trusted with NO trusted publisher keys: the chain is the only way a peer's build gets in
  const common = { rpc: 'mock://', offline: false, chainFetch: chain.fetch, nodeStake: stake, titleRegistry: reg, titleRefreshMs: 300, chainId: 4441, heartbeatMs: 200, updates: false, announce: false, titleTrust: 'trusted', trustedPublishers: [] };
  const events = [];
  const spawn = (opts) => createNode({ ...common, onEvent: (e) => events.push({ node: opts.operator, ...e }), ...opts }).then((n) => (nodes.push(n), n));
  const host = await spawn({ dataDir: hostId.dir, operator: 'studio', roles: ['mesh', 'host'], rulesets: [RULESET] });
  assert.equal(host.rulesets()['tug.v1'], manifest.buildHash, 'the operator\'s own RULESETS load regardless');

  // unregistered: the witness refuses the peer's build, naming the registry
  const witness1 = await spawn({ dataDir: w1.dir, operator: 'guild', roles: ['mesh', 'witness'], seeds: [host.addr] });
  const refusal = await until(() => events.find((e) => e.node === 'guild' && e.type === 'ruleset-refused' && e.stage === 'trust'), 20_000);
  assert.ok(refusal, 'refused on trust');
  assert.match(refusal.failed.join(';'), /title registry: title is not registered/);
  assert.equal(witness1.rulesets()['tug.v1'], undefined);
  let titles = (await (await fetch(`${host.addr}/titles`)).json()).titles;
  assert.equal(titles[0].owner, null); assert.equal(titles[0].published, false, 'hosted, bonded, but nobody holds the title');

  // the studio claims the title with this build: the witness loads it on its next look, and the arcade may list it
  await chain.send(STUDIO, reg, 'register', ['tug.v1', '0x' + manifest.buildHash]);
  assert.ok(await until(() => witness1.rulesets()['tug.v1'] === manifest.buildHash, 30_000), 'the witness loaded the build once the chain vouched for it');
  titles = await until(async () => { const { titles } = await (await fetch(`${host.addr}/titles`)).json(); return titles[0].published ? titles : null; }, 15_000);
  assert.ok(titles, 'published');
  assert.equal(titles[0].owner, chain.addressOf(STUDIO)); assert.equal(titles[0].publisherHosts, 1, 'the studio host; the witness holds the build but is not a host');

  // hand-over to a wallet that runs no host: still registered, still hosted, no longer listed — until the buyer bonds a host
  await chain.send(STUDIO, reg, 'transferFrom', [chain.addressOf(STUDIO), chain.addressOf(BUYER), BigInt('0x' + t.titleIdOf('tug.v1'))]);
  titles = await until(async () => { const { titles } = await (await fetch(`${host.addr}/titles`)).json(); return titles[0].owner === chain.addressOf(BUYER) ? titles : null; }, 15_000);
  assert.ok(titles, 'the node saw the new holder');
  assert.equal(titles[0].published, false, 'the holder runs no bonded host'); assert.equal(titles[0].publisherHosts, 0);
  const witness2 = await spawn({ dataDir: w2.dir, operator: 'guild2', roles: ['mesh', 'witness'], seeds: [host.addr] });
  assert.ok(await until(() => witness2.rulesets()['tug.v1'] === manifest.buildHash, 30_000), 'a hand-over does not unload an active build');

  // the new holder revokes the build: a fresh peer refuses it; nodes that hold it keep it (history stays replayable)
  await chain.send(BUYER, reg, 'revokeBuild', [BigInt('0x' + t.titleIdOf('tug.v1')), '0x' + manifest.buildHash]);
  const w3 = await bond(WITNESS_OP + 3, 'w3');
  await spawn({ dataDir: w3.dir, operator: 'guild3', roles: ['mesh', 'witness'], seeds: [host.addr] });
  const revoked = await until(() => events.find((e) => e.node === 'guild3' && e.type === 'ruleset-refused' && e.stage === 'trust'), 20_000);
  assert.match(revoked.failed.join(';'), /revoked/);
  assert.equal(witness2.rulesets()['tug.v1'], manifest.buildHash, 'already-held build stays');
  const health = await (await fetch(`${host.addr}/health`)).json();
  assert.equal(health.trust.titleRegistry, reg);
});

test('AIR publisher: the account\'s proxy on its own node claims the title, bonds the node, adds and revokes builds, hands the title over', { timeout: 120_000 }, async (tc) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
  const { generateKeyPairSync, sign: cryptoSign } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRpcEvm } = await import('./lib/rpc-evm.mjs');
  const { until } = await import('./lib/mesh.mjs');
  const { createNode } = await import('../node/litnode.js');
  const { generateKeypair } = await import('../protocol/keys.js');
  const ROOT = process.cwd();
  const RULESET = join(ROOT, 'rulesets', 'tug.v1.js');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'rulesets', 'tug.v1.json'), 'utf8'));
  const ONE = 10n ** 18n;
  // a throwaway AIR: ES256 keypair, JWKS answered by the same fetch the chain uses, token minting
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-1', alg: 'ES256', use: 'sig' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mint = (payload) => { const head = b64({ alg: 'ES256', typ: 'JWT', kid: 'test-1' }), body = b64(payload); const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }); return `${head}.${body}.${sig.toString('base64url')}`; };
  const now = Math.floor(Date.now() / 1000);
  const token = mint({ sub: 'studio-0000-4000-8000-000000000001', partnerId: 'p1', email: 'studio@example.com', exp: now + 600 });

  const tmp = mkdtempSync(join(tmpdir(), 'litnode-airpub-'));
  const chain = await createRpcEvm();
  const ticker = setInterval(() => chain.mine(), 250);
  const nodes = [];
  tc.after(async () => { clearInterval(ticker); for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const fetchImpl = async (url, init) => url === 'mock://jwks' ? { ok: true, status: 200, json: async () => ({ keys: [JWK] }), text: async () => JSON.stringify({ keys: [JWK] }) } : chain.fetch(url, init);

  const tokenC = await chain.deploy('TestLITVM.sol', 'TestLITVM', []);
  const stake = await chain.deploy('NodeStake.sol', 'NodeStake', [tokenC, ONE, 600, 1, 1200, chain.addressOf(0), chain.addressOf(0)]);
  const reg = await chain.deploy('TitleRegistry.sol', 'TitleRegistry', [DELAY]);
  const profile = await chain.deploy('PlayerProfile.sol', 'PlayerProfile', []);
  const dir = join(tmp, 'studio'); mkdirSync(dir, { recursive: true });
  const kp = await generateKeypair(); writeFileSync(join(dir, 'identity.json'), JSON.stringify(kp));
  writeFileSync(join(dir, 'announcer.json'), JSON.stringify({ privateKey: chain.keyOf(11) })); // the sponsor: a funded harness account
  const common = { rpc: 'mock://', offline: false, chainFetch: fetchImpl, nodeStake: stake, stakeToken: tokenC, titleRegistry: reg, titleRefreshMs: 300, playerProfile: profile, chainId: 4441, heartbeatMs: 200, updates: false, announce: false, titleTrust: 'trusted', trustedPublishers: [], air: { partnerId: 'p1', jwksUrl: 'mock://jwks' } };
  const host = await createNode({ ...common, dataDir: dir, operator: 'studio', roles: ['mesh', 'host'], rulesets: [RULESET] }); nodes.push(host);
  const post = async (p, body) => { const r = await fetch(`${host.addr}${p}`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const titles = async () => (await (await fetch(`${host.addr}/titles`)).json()).titles;

  // sign in: the node makes the proxy wallet + profile
  assert.equal((await post('/air/publish', { token: 'garbage', action: 'register', rulesetId: 'tug.v1' })).status, 401);
  const s = (await post('/air/session', { token })).body;
  assert.equal(s.custody, 'here', JSON.stringify(s)); const me = s.address.toLowerCase();
  assert.equal((await (await fetch(`${host.addr}/air`)).json()).titleRegistry, reg);

  // an unbonded node hosting an unclaimed title: nothing listed
  let t = (await titles())[0];
  assert.equal(t.owner, null); assert.equal(t.published, false);

  // claim from the proxy — the build defaults to the one this node serves
  assert.equal((await post('/air/publish', { token, action: 'register', rulesetId: 'nope.v1' })).status, 400, 'not hosted here and no buildHash given');
  let r = await post('/air/publish', { token, action: 'register', rulesetId: 'tug.v1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title.publisher, me); assert.equal(r.body.title.build.active, true); assert.equal(r.body.buildHash, manifest.buildHash);
  t = (await titles())[0];
  assert.equal(t.owner, me); assert.equal(t.build.ok, true); assert.equal(t.published, false, 'held, hosted, but the host is not bonded');
  assert.match((await post('/air/publish', { token, action: 'register', rulesetId: 'tug.v1' })).body.error, /already hold/);

  // bond the node from the proxy: faucet + approve + stake + delegate, sponsored gas — now the holder runs a bonded host
  r = await post('/air/bond', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.steps.map((x) => x.step), ['faucet', 'approve', 'stake', 'delegate']);
  assert.equal(r.body.operator, me);
  assert.equal((await post('/air/bond', { token })).body.already, true, 'idempotent');
  const bonded = await until(async () => { const [x] = await titles(); return x.published ? x : null; }, 20_000);
  assert.ok(bonded, 'published: the title holder is the operator of this bonded host');
  assert.equal(bonded.publisherHosts, 1);
  const health = await (await fetch(`${host.addr}/health`)).json();
  assert.equal(health.bonded, true); assert.equal(health.bond.delegate.toLowerCase(), chain.addressOf(11), 'the sponsor/announcer key is the delegate');

  // a retune: register another hash (pending until the delay), revoke the live one
  const other = 'ab'.repeat(32);
  r = await post('/air/publish', { token, action: 'set-build', rulesetId: 'tug.v1', buildHash: other });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.title.build.registered, true); assert.equal(r.body.title.build.active, false);
  r = await post('/air/publish', { token, action: 'revoke', rulesetId: 'tug.v1' });
  assert.equal(r.status, 200); assert.equal(r.body.title.build.revoked, true);
  t = (await titles())[0];
  assert.equal(t.build.ok, false); assert.match(t.build.reason, /revoked/);

  // hand over to a wallet the node does not hold: registered, still hosted, no longer listed; the proxy can no longer act
  const buyer = chain.addressOf(5);
  assert.equal((await post('/air/publish', { token, action: 'transfer', rulesetId: 'tug.v1', to: 'not-an-address' })).status, 502);
  r = await post('/air/publish', { token, action: 'transfer', rulesetId: 'tug.v1', to: buyer });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.title.publisher, buyer);
  t = (await titles())[0];
  assert.equal(t.owner, buyer); assert.equal(t.published, false);
  assert.match((await post('/air/publish', { token, action: 'revoke', rulesetId: 'tug.v1' })).body.error, /not your wallet/);
  // a second AIR account on this node cannot touch the buyer's title either
  const token2 = mint({ sub: 'other-0000-4000-8000-000000000002', partnerId: 'p1', exp: now + 600 });
  await post('/air/session', { token: token2 });
  assert.match((await post('/air/publish', { token: token2, action: 'set-build', rulesetId: 'tug.v1', buildHash: 'cd'.repeat(32) })).body.error, /not your wallet/);
});
