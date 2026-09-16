/** Self-update: a release is an artifact like a ruleset — fetched, checked,
 *  refused unless it verifies — plus one thing a ruleset does not need: a
 *  SIGNATURE, because "which build is the latest" is a claim only the
 *  publisher may make. A hash alone would let any peer advertise a poisoned
 *  build. The release public key is pinned here; tools/release.mjs signs
 *  with the private half, which lives outside the repo.
 *
 *  Manifest (release.json, sealed under RELEASE_TAG by the release key):
 *    { version, date, notes, files: { 'litnode-<kind>-<date>[-win-x64].zip': { sha256, size } } }
 *
 *  Apply: pick the zip that matches this install (portable/operator, with or
 *  without a vendored runtime), download, sha256, unpack to a staging dir,
 *  copy CODE over the install — never data/, node.env, litnode.log,
 *  node_modules — then ask to be restarted. A running node.exe cannot be
 *  overwritten on Windows, so a new runtime lands in runtime.new/ and
 *  start-node.cmd swaps it on relaunch. Zero dependencies. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { opened } from '../protocol/keys.js';

export const RELEASE_TAG = 'release';
/** The litnode release key. A manifest not signed by it is not a release. */
export const RELEASE_PUBKEY = '4d8759b0dab63817f0984a6eec1ec0d6ac4933a9c0aeb26a0de2d61755e08150';
export const RELEASE_URL = 'https://github.com/strodanodev/litnode/releases/latest/download/release.json';
export const RESTART_EXIT = 75; // start-node.cmd relaunches on this code

/** What gets replaced by an update. Everything else in the folder is the operator's. */
export const CODE = ['node', 'protocol', 'cabinet', 'rulesets', 'tools', 'contracts', 'titles', 'start-node.cmd', 'run-node.cmd', 'install-task.cmd', 'allow-firewall.cmd', 'update.cmd', 'node.env.example', 'README.md', 'package.json'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';

/** Compare "1.2.3" strings. */
export const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true; if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false; }
  return false;
};

/** Which zip this install wants: same kind (portable/operator), runtime iff we ship one. */
export function pickFile(files, { root }) {
  const kind = existsSync(join(root, 'install-task.cmd')) ? 'operator' : 'portable';
  const wantRuntime = existsSync(join(root, 'runtime', 'node.exe'));
  const names = Object.keys(files).filter((n) => n.startsWith(`litnode-${kind}-`) && n.endsWith('.zip') && n.includes('-win-x64') === wantRuntime);
  return names[0] ?? null;
}

export function createUpdater({ root, version, releaseUrl = RELEASE_URL, pubkey = RELEASE_PUBKEY, fetchImpl = globalThis.fetch, log = () => {} }) {
  let latest = null, checkedAt = 0, lastError = null, applying = false;

  /** Fetch and verify the manifest. Returns the verified body or null. */
  const check = async () => {
    try {
      const r = await fetchImpl(releaseUrl, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(`release manifest: HTTP ${r.status}`);
      const env = await r.json();
      if (env?.signer !== pubkey) throw new Error('release manifest signed by an unknown key');
      if (!(await opened(RELEASE_TAG, env))) throw new Error('release manifest signature invalid');
      if (!env.body?.version || typeof env.body.files !== 'object') throw new Error('release manifest malformed');
      latest = env.body; lastError = null;
    } catch (e) { lastError = String(e.message ?? e); }
    checkedAt = Date.now();
    return latest;
  };

  const status = () => ({
    version, latest: latest?.version ?? null, available: !!(latest && newer(latest.version, version)),
    notes: latest?.notes ?? null, date: latest?.date ?? null, checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null, lastError, applying,
    file: latest ? pickFile(latest.files, { root }) : null,
  });

  /** Download, verify, unpack, copy code over the install. Returns what changed. */
  const apply = async () => {
    if (applying) throw new Error('update already in progress');
    if (!latest) await check();
    const s = status();
    if (!s.available) throw new Error(s.lastError ?? `already on ${version}`);
    if (!s.file) throw new Error('no zip in this release matches this install');
    applying = true;
    try {
      const want = latest.files[s.file];
      const base = releaseUrl.replace(/\/[^/]+$/, '/');
      log(`update: downloading ${s.file} (${(want.size / 1024 / 1024).toFixed(1)} MB)`);
      const r = await fetchImpl(base + s.file, { redirect: 'follow' });
      if (!r.ok) throw new Error(`download: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const got = sha256(buf);
      if (got !== want.sha256) throw new Error(`sha256 mismatch: manifest ${want.sha256.slice(0, 12)} got ${got.slice(0, 12)} — refused`);
      const stage = join(root, '.update');
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(stage, { recursive: true });
      const zip = join(stage, s.file);
      writeFileSync(zip, buf);
      execFileSync(tar, ['-xf', zip, '-C', stage]);
      const top = readdirSync(stage).find((n) => n !== s.file && existsSync(join(stage, n, 'node')));
      if (!top) throw new Error('zip has no node/ directory');
      const src = join(stage, top);
      const changed = [];
      for (const item of CODE) {
        if (!existsSync(join(src, item))) continue;
        rmSync(join(root, item), { recursive: true, force: true });
        cpSync(join(src, item), join(root, item), { recursive: true });
        changed.push(item);
      }
      if (existsSync(join(src, 'runtime', 'node.exe'))) {
        const cur = existsSync(join(root, 'runtime', 'VERSION')) ? readFileSync(join(root, 'runtime', 'VERSION'), 'utf8').trim() : '';
        const next = readFileSync(join(src, 'runtime', 'VERSION'), 'utf8').trim();
        if (next !== cur) { rmSync(join(root, 'runtime.new'), { recursive: true, force: true }); cpSync(join(src, 'runtime'), join(root, 'runtime.new'), { recursive: true }); changed.push(`runtime.new (${next}, swapped on restart)`); }
      }
      rmSync(stage, { recursive: true, force: true });
      log(`update: ${version} → ${latest.version} applied (${changed.join(', ')}); restart to run it`);
      return { from: version, to: latest.version, changed };
    } finally { applying = false; }
  };

  return { check, status, apply };
}
