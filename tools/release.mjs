/** Cut a release: pack every zip, write and SIGN release.json, publish to
 *  GitHub Releases. Nodes update from it (node/update.js).
 *
 *    node tools/release.mjs                 build + sign + publish v<package.json version>
 *    node tools/release.mjs --dry           build + sign only (dist/release.json)
 *    node tools/release.mjs --notes "…"     release notes (default: CHANGELOG's top section title)
 *
 *  The release key: RELEASE_KEY_FILE, default ~/.litnode/release-key.json —
 *  an identity from tools/keygen.mjs whose PUBLIC half is pinned in
 *  node/update.js RELEASE_PUBKEY. It never enters the repo. A node refuses a
 *  manifest signed by any other key, so losing this key means shipping a
 *  new node build by hand once; leaking it means anyone can push code to
 *  every node — treat it like the deployer wallet. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { seal } from '../protocol/keys.js';
import { RELEASE_TAG, RELEASE_PUBKEY } from '../node/update.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
// --channel canary: publish release-canary.json (nodes with RELEASE_CHANNEL=canary
// take it first; stable nodes never see it). --rotate-to <pubkey> / --retire <pubkey>
// carry a release-key rotation, signed by the CURRENT key (node/update.js).
const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : 'stable';
const rotateTo = args.includes('--rotate-to') ? args[args.indexOf('--rotate-to') + 1] : null;
const retire = args.includes('--retire') ? [args[args.indexOf('--retire') + 1]] : [];
const manifestName = channel === 'stable' ? 'release.json' : `release-${channel}.json`;
const notesArg = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : null;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `v${pkg.version}`;

const keyFile = process.env.RELEASE_KEY_FILE ?? join(homedir(), '.litnode', 'release-key.json');
if (!existsSync(keyFile)) { console.error(`release key not found: ${keyFile}\n  node tools/keygen.mjs "${keyFile}"  — then pin its publicKey in node/update.js`); process.exit(1); }
const key = JSON.parse(readFileSync(keyFile, 'utf8'));
if (key.publicKey !== RELEASE_PUBKEY) { console.error(`release key ${key.publicKey.slice(0, 12)}… is not the pinned RELEASE_PUBKEY ${RELEASE_PUBKEY.slice(0, 12)}… — nodes would refuse this release`); process.exit(1); }

// ---------------------------------------------------------------- build
console.log(`release ${tag}: packing…`);
execFileSync(process.execPath, [join(root, 'tools', 'pack.mjs'), '--all'], { stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'tools', 'pack.mjs'), '--all', '--runtime'], { stdio: 'inherit' });
const zips = readdirSync(dist).filter((f) => /^litnode-(portable|operator)-\d{4}-\d{2}-\d{2}(-win-x64)?\.zip$/.test(f));
// keep only the newest date stamp per (kind, flavour)
const stamp = (f) => /(\d{4}-\d{2}-\d{2})/.exec(f)[1];
const latestStamp = zips.map(stamp).sort().at(-1);
const files = {};
for (const f of zips.filter((f) => stamp(f) === latestStamp)) {
  const buf = readFileSync(join(dist, f));
  files[f] = { sha256: createHash('sha256').update(buf).digest('hex'), size: statSync(join(dist, f)).size };
}
if (Object.keys(files).length < 2) { console.error('expected at least a portable and an operator zip'); process.exit(1); }

// ---------------------------------------------------------------- manifest, signed
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const section = changelog.split(/^## /m)[1] ?? '';
const notes = notesArg ?? section.split('\n').slice(1).join('\n').trim().slice(0, 4000);
const body = { version: pkg.version, date: new Date().toISOString(), notes, files };
const env = await seal(RELEASE_TAG, body, key);
writeFileSync(join(dist, 'release.json'), JSON.stringify(env, null, 2) + '\n');
console.log(`signed dist/release.json — ${Object.keys(files).length} files, key ${key.publicKey.slice(0, 12)}…`);
for (const [f, m] of Object.entries(files)) console.log(`  ${f}  ${(m.size / 1024 / 1024).toFixed(1)} MB  ${m.sha256.slice(0, 16)}…`);
if (dry) process.exit(0);

// ---------------------------------------------------------------- publish
const assets = [...Object.keys(files).map((f) => join(dist, f)), join(dist, manifestName)];
const exists = (() => { try { execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (exists) {
  console.log(`release ${tag} exists — replacing its assets`);
  execFileSync('gh', ['release', 'upload', tag, ...assets, '--clobber'], { stdio: 'inherit' });
} else {
  execFileSync('gh', ['release', 'create', tag, ...assets, '--title', `litnode ${tag}`, '--notes', notes || `litnode ${tag}`, '--latest'], { stdio: 'inherit' });
}
console.log(`\npublished ${tag}: nodes see it at https://github.com/strodanodev/litnode/releases/latest/download/release.json`);
