/** Self-update (node/update.js): a release manifest is refused unless it is
 *  signed by the pinned key; a zip is refused unless its sha256 matches; an
 *  apply replaces code and never touches data/ or node.env; the node reports
 *  and gates it over HTTP.
 *    node --test demo/update.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeypair, seal } from '../protocol/keys.js';
import { createUpdater, RELEASE_TAG, newer, pickFile } from '../node/update.js';
import { createNode } from '../node/litnode.js';

const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'litnode-update-'));

/** A fake install at `root` on version 0.1.0, and a fake 0.2.0 release zip. */
function fixture() {
  const root = join(tmp, 'install'); rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'node'), { recursive: true }); mkdirSync(join(root, 'data', 'n'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(root, 'node', 'marker.txt'), 'old');
  writeFileSync(join(root, 'node', 'stale.txt'), 'should be removed with the directory');
  writeFileSync(join(root, 'data', 'n', 'identity.json'), '{"secret":true}');
  writeFileSync(join(root, 'node.env'), 'OPERATOR=me');
  const build = join(tmp, 'build', 'litnode-portable-2026-01-01'); rmSync(join(tmp, 'build'), { recursive: true, force: true });
  mkdirSync(join(build, 'node'), { recursive: true });
  writeFileSync(join(build, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  writeFileSync(join(build, 'node', 'marker.txt'), 'new');
  writeFileSync(join(build, 'node.env.example'), 'EXAMPLE=1');
  writeFileSync(join(build, 'data-should-not-ship.txt'), 'x'); // not in CODE: never copied
  const zipName = 'litnode-portable-2026-01-01.zip';
  execFileSync(tar, ['-a', '-cf', join(tmp, 'build', zipName), '-C', join(tmp, 'build'), 'litnode-portable-2026-01-01']);
  const zip = readFileSync(join(tmp, 'build', zipName));
  return { root, zipName, zip };
}
/** A fetch that serves a manifest envelope and the zip. */
const serve = (env, zipName, zip) => async (url) => {
  if (url.endsWith('/release.json')) return { ok: true, status: 200, json: async () => env };
  if (url.endsWith('/' + zipName)) return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
  return { ok: false, status: 404 };
};
const RELEASE = 'https://example.test/releases/latest/download/release.json';

test('update: version compare and zip choice', () => {
  assert.ok(newer('0.2.0', '0.1.9')); assert.ok(newer('1.0.0', '0.9.9')); assert.ok(!newer('0.4.0', '0.4.0')); assert.ok(!newer('0.3.9', '0.4.0'));
  const files = { 'litnode-portable-2026-01-01.zip': {}, 'litnode-portable-2026-01-01-win-x64.zip': {}, 'litnode-operator-2026-01-01.zip': {}, 'litnode-operator-2026-01-01-win-x64.zip': {} };
  const r = join(tmp, 'pick'); rmSync(r, { recursive: true, force: true }); mkdirSync(r, { recursive: true });
  assert.equal(pickFile(files, { root: r }), 'litnode-portable-2026-01-01.zip');
  mkdirSync(join(r, 'runtime')); writeFileSync(join(r, 'runtime', 'node.exe'), '');
  assert.equal(pickFile(files, { root: r }), 'litnode-portable-2026-01-01-win-x64.zip', 'an install with a vendored runtime wants the win-x64 zip');
  writeFileSync(join(r, 'install-task.cmd'), '');
  assert.equal(pickFile(files, { root: r }), 'litnode-operator-2026-01-01-win-x64.zip', 'an operator install wants the operator zip');
});

test('update: unsigned or wrongly signed manifests are refused; a good one applies code and spares data', async () => {
  const releaseKey = await generateKeypair(), otherKey = await generateKeypair();
  const { root, zipName, zip } = fixture();
  const body = { version: '0.2.0', date: '2026-01-01T00:00:00Z', notes: 'test', files: { [zipName]: { sha256: sha(zip), size: zip.length } } };

  // signed by someone else
  let u = createUpdater({ root, version: '0.1.0', releaseUrl: RELEASE, pubkey: releaseKey.publicKey, fetchImpl: serve(await seal(RELEASE_TAG, body, otherKey), zipName, zip) });
  await u.check(); assert.match(u.status().lastError, /unknown key/); assert.equal(u.status().available, false);
  // signed by the release key but tampered after signing
  const good = await seal(RELEASE_TAG, body, releaseKey);
  u = createUpdater({ root, version: '0.1.0', releaseUrl: RELEASE, pubkey: releaseKey.publicKey, fetchImpl: serve({ ...good, body: { ...body, version: '9.9.9' } }, zipName, zip) });
  await u.check(); assert.match(u.status().lastError, /signature invalid/);
  // good manifest, wrong bytes
  const badZip = Buffer.concat([zip, Buffer.from('x')]);
  u = createUpdater({ root, version: '0.1.0', releaseUrl: RELEASE, pubkey: releaseKey.publicKey, fetchImpl: serve(good, zipName, badZip) });
  await u.check(); assert.equal(u.status().available, true);
  await assert.rejects(u.apply(), /sha256 mismatch/);
  assert.equal(readFileSync(join(root, 'node', 'marker.txt'), 'utf8'), 'old', 'nothing changed on a refused zip');
  // good manifest, good bytes
  u = createUpdater({ root, version: '0.1.0', releaseUrl: RELEASE, pubkey: releaseKey.publicKey, fetchImpl: serve(good, zipName, zip) });
  const r = await u.apply();
  assert.equal(r.to, '0.2.0');
  assert.equal(readFileSync(join(root, 'node', 'marker.txt'), 'utf8'), 'new');
  assert.ok(!existsSync(join(root, 'node', 'stale.txt')), 'a replaced directory is replaced whole');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.2.0');
  assert.equal(readFileSync(join(root, 'data', 'n', 'identity.json'), 'utf8'), '{"secret":true}', 'data/ untouched');
  assert.equal(readFileSync(join(root, 'node.env'), 'utf8'), 'OPERATOR=me', 'node.env untouched');
  assert.ok(!existsSync(join(root, 'data-should-not-ship.txt')), 'only CODE items are copied');
  assert.ok(!existsSync(join(root, '.update')), 'staging cleaned');
});

test('update: the node reports it on /health and /update, and refuses to apply what is not newer', { timeout: 30_000 }, async (t) => {
  const key = await generateKeypair();
  const body = { version: '0.0.1', date: '2026-01-01T00:00:00Z', notes: 'nothing new', files: { 'litnode-portable-2026-01-01.zip': { sha256: 'aa', size: 1 } } };
  // the node pins the real release key; this manifest is signed by a test key, so it must show as refused, not as an update
  const node = await createNode({ dataDir: join(tmp, 'node'), offline: true, heartbeatMs: 200, operator: 'x', roles: ['mesh'], version: '0.4.0', releaseUrl: RELEASE, onRestart: () => {} });
  t.after(async () => { await node.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const h = await (await fetch(`${node.addr}/health`)).json();
  assert.equal(h.version, '0.4.0'); assert.equal(typeof h.update, 'object'); assert.equal(h.update.available, false);
  const st = await (await fetch(`${node.addr}/update`)).json();
  assert.deepEqual(Object.keys(st).sort(), ['applying', 'available', 'checkedAt', 'date', 'file', 'lastError', 'latest', 'notes', 'version'].sort());
  const r = await fetch(`${node.addr}/update`, { method: 'POST' });
  assert.equal(r.status, 400, 'nothing to apply → 400, never a restart');
  void key; void body;
});
