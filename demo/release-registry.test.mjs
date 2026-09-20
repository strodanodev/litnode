/** ReleaseRegistry (BUILD-SPEC v0.3 §2.4): the node-side encoders round-trip
 *  against ethers' ABI coder, and the updater refuses a signed release the
 *  chain has not registered, has not yet activated, has revoked, or cannot
 *  be asked about — and applies one that is registered and active. The
 *  registry is a fake statusOf(); the contract's own behaviour is covered
 *  by demo/contracts.test.mjs (compile, selectors) and on Liteforge.
 *    node --test demo/release-registry.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { generateKeypair, seal } from '../protocol/keys.js';
import { createUpdater, RELEASE_TAG } from '../node/update.js';
import { statusOfCall, registerCalldata, revokeCalldata, decodeStatus, releaseVerdict, STATUS_OF, REGISTER, REVOKE } from '../protocol/release.js';
import { setDelegateCalldata, nodeOfCall, decodeNode, SET_DELEGATE, NODE_OF } from '../protocol/staking.js';
import { selector } from '../protocol/keccak.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const coder = ethers.AbiCoder.defaultAbiCoder();
const iface = new ethers.Interface([
  'function statusOf(bytes32) view returns (bool registered, bool active, bool revoked, string version, uint64 activatesAt)',
  'function register(bytes32 zipHash, string version, bytes32 protocol, uint64 activatesAt)',
  'function revoke(bytes32)',
  'function setDelegate(bytes32,address)',
  'function nodeOf(bytes32) view returns (address operator, address delegate, uint256 amount, uint64 bondedSince, uint64 unbondAt, bool active, bool eligible)',
]);
const ZIP = 'ab'.repeat(32), CONTRACT = '0x' + '11'.repeat(20), NODE = 'cd'.repeat(32), ADDR = '0x' + 'ee'.repeat(20);

test('release registry: calldata and decoders agree with ethers', () => {
  assert.equal(statusOfCall(CONTRACT, ZIP).data, iface.encodeFunctionData('statusOf', ['0x' + ZIP]));
  assert.equal(selector(STATUS_OF), iface.getFunction('statusOf').selector);
  assert.equal(selector(REGISTER), iface.getFunction('register').selector);
  assert.equal(selector(REVOKE), iface.getFunction('revoke').selector);
  const activates = 1_800_000_000;
  assert.equal(registerCalldata(ZIP, '0.9.2', 3, activates), iface.encodeFunctionData('register', ['0x' + ZIP, '0.9.2', ethers.zeroPadValue('0x03', 32), activates]));
  assert.equal(revokeCalldata(ZIP), iface.encodeFunctionData('revoke', ['0x' + ZIP]));
  const encoded = coder.encode(['bool', 'bool', 'bool', 'string', 'uint64'], [true, false, false, 'litnode 0.9.2 — a long version label', activates]);
  assert.deepEqual(decodeStatus(encoded), { registered: true, active: false, revoked: false, version: 'litnode 0.9.2 — a long version label', activatesAt: activates });
  assert.throws(() => registerCalldata('not-a-hash', '1', 1, 1), /32 bytes/);
});

test('release registry: the verdict', () => {
  assert.deepEqual(releaseVerdict(null), { ok: false, reason: 'release registry unreadable' });
  assert.match(releaseVerdict({ registered: false, active: false, revoked: false, version: '', activatesAt: 0 }).reason, /not registered/);
  assert.match(releaseVerdict({ registered: true, active: false, revoked: true, version: '0.9.2', activatesAt: 0 }).reason, /revoked/);
  assert.match(releaseVerdict({ registered: true, active: false, revoked: false, version: '0.9.2', activatesAt: 1_800_000_000 }).reason, /activates at 2027-01-15/);
  assert.deepEqual(releaseVerdict({ registered: true, active: true, revoked: false, version: '0.9.2', activatesAt: 1 }), { ok: true, reason: null });
});

test('NodeStake v3: setDelegate calldata and nodeOf decode agree with ethers', () => {
  assert.equal(setDelegateCalldata(NODE, ADDR), iface.encodeFunctionData('setDelegate', ['0x' + NODE, ADDR]));
  assert.equal(selector(SET_DELEGATE), iface.getFunction('setDelegate').selector);
  assert.equal(selector(NODE_OF), iface.getFunction('nodeOf').selector);
  assert.equal(nodeOfCall(CONTRACT, NODE).data, iface.encodeFunctionData('nodeOf', ['0x' + NODE]));
  const enc = coder.encode(['address', 'address', 'uint256', 'uint64', 'uint64', 'bool', 'bool'], [ADDR, ethers.ZeroAddress, 5n * 10n ** 18n, 1_700_000_000, 0, true, false]);
  assert.deepEqual(decodeNode(enc), { operator: ADDR, delegate: null, amount: 5n * 10n ** 18n, bondedSince: 1_700_000_000, unbondAt: 0, active: true, eligible: false });
});

test('updater: a signed release is applied only when the registry says registered + active + not revoked', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-registry-'));
  try {
    const root = join(tmp, 'install');
    mkdirSync(join(root, 'node'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    writeFileSync(join(root, 'node', 'marker.txt'), 'old');
    const build = join(tmp, 'build', 'litnode-portable-2026-01-01');
    mkdirSync(join(build, 'node'), { recursive: true });
    writeFileSync(join(build, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    writeFileSync(join(build, 'node', 'marker.txt'), 'new');
    const zipName = 'litnode-portable-2026-01-01.zip';
    execFileSync(tar, ['-a', '-cf', join(tmp, 'build', zipName), '-C', join(tmp, 'build'), 'litnode-portable-2026-01-01']);
    const zip = readFileSync(join(tmp, 'build', zipName));
    const key = await generateKeypair();
    const env = await seal(RELEASE_TAG, { version: '0.2.0', date: '2026-01-01T00:00:00Z', files: { [zipName]: { sha256: sha(zip), size: zip.length } } }, key);
    const fetchImpl = async (url) => url.endsWith('/release.json') ? { ok: true, status: 200, json: async () => env }
      : url.endsWith('/' + zipName) ? { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) } : { ok: false, status: 404 };
    const RELEASE = 'https://example.test/releases/latest/download/release.json';
    const asked = [];
    const mk = (answer) => createUpdater({ root, version: '0.1.0', releaseUrl: RELEASE, pubkey: key.publicKey, fetchImpl, registry: { statusOf: async (h) => { asked.push(h); return typeof answer === 'function' ? answer() : answer; } } });

    // unregistered: the signature is fine, the chain has never heard of the zip
    let u = mk({ registered: false, active: false, revoked: false, version: '', activatesAt: 0 });
    await u.check();
    assert.equal(u.status().registry, 'unregistered'); assert.match(u.status().lastError, /not registered/);
    await assert.rejects(u.apply(), /not registered on chain — refused/);
    assert.equal(asked[0], sha(zip), 'asked about the zip the manifest names');
    // registered but the activation delay has not passed
    u = mk({ registered: true, active: false, revoked: false, version: '0.2.0', activatesAt: 4_000_000_000 });
    await u.check(); assert.equal(u.status().registry, 'pending');
    await assert.rejects(u.apply(), /activates at/);
    // revoked
    u = mk({ registered: true, active: false, revoked: true, version: '0.2.0', activatesAt: 1 });
    await u.check(); assert.equal(u.status().registry, 'revoked');
    await assert.rejects(u.apply(), /revoked/);
    // the chain cannot be read: the gate stays SHUT
    u = mk(() => { throw new Error('HTTP 502'); });
    await u.check(); assert.equal(u.status().registry, 'unreadable');
    await assert.rejects(u.apply(), /unreadable/);
    assert.equal(readFileSync(join(root, 'node', 'marker.txt'), 'utf8'), 'old', 'nothing applied through any refusal');
    // registered, active: applies. And apply() asks the chain AGAIN, so a revoke between check and apply is caught.
    let calls = 0;
    u = mk(() => (++calls === 1 ? { registered: true, active: true, revoked: false, version: '0.2.0', activatesAt: 1 } : { registered: true, active: false, revoked: true, version: '0.2.0', activatesAt: 1 }));
    await u.check(); assert.equal(u.status().registry, 'active'); assert.equal(u.status().available, true);
    await assert.rejects(u.apply(), /revoked/);
    calls = 0;
    u = mk({ registered: true, active: true, revoked: false, version: '0.2.0', activatesAt: 1 });
    const r = await u.apply();
    assert.equal(r.to, '0.2.0');
    assert.equal(readFileSync(join(root, 'node', 'marker.txt'), 'utf8'), 'new');
    // no registry configured: signature-only, and it says so
    u = createUpdater({ root, version: '0.1.0', releaseUrl: RELEASE, pubkey: key.publicKey, fetchImpl });
    await u.check(); assert.equal(u.status().registry, 'unset');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
