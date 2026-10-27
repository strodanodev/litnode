/** Build the portable zips.
 *    node tools/pack.mjs             → dist/litnode-portable-v<version>.zip   (any node: laptop, handheld, volunteer)
 *    node tools/pack.mjs --operator  → dist/litnode-operator-v<version>.zip   (+ chain tooling, node.env, scheduled task)
 *    node tools/pack.mjs --all       → both
 *    node tools/pack.mjs --all --runtime[=v22.19.0]
 *        also vendors the official Node.js win-x64 runtime as runtime/node.exe,
 *        so the zip runs on a machine with nothing installed. The download is
 *        checked against nodejs.org's SHASUMS256.txt; default is the newest LTS.
 *  Same daemon in both; the operator build adds tools and an operator README. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stage, checkStage, scanStage } from './lib/pack-plan.mjs';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Zips are named by VERSION, not date: two releases cut on one day carried
// the same asset names, and a CDN edge that still held the earlier zip
// under that name failed a node's sha256 check on the later one.
const stamp = 'v' + (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0');
const dist = join(root, 'dist');
const args = process.argv.slice(2);
const kinds = args.includes('--all') ? ['portable', 'operator'] : args.includes('--operator') ? ['operator'] : ['portable'];
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeArg = args.find((a) => a.startsWith('--runtime'));

/** Fetch node-<v>-win-x64.zip (cached under dist/cache), verify its sha256
 *  against SHASUMS256.txt for that release, and return the path to node.exe
 *  extracted beside it. Nothing is trusted that nodejs.org did not publish a
 *  checksum for. */
async function vendorRuntime(want) {
  const cache = join(dist, 'cache');
  mkdirSync(cache, { recursive: true });
  let version = want;
  if (!version) {
    const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
    version = index.find((r) => r.lts && r.files.includes('win-x64-zip')).version; // newest LTS line
  }
  const name = `node-${version}-win-x64`;
  const zip = join(cache, `${name}.zip`);
  const exe = join(cache, name, 'node.exe');
  if (!existsSync(zip)) {
    console.log(`downloading ${name}.zip …`);
    const r = await fetch(`https://nodejs.org/dist/${version}/${name}.zip`);
    if (!r.ok) throw new Error(`nodejs.org: ${r.status} for ${version}`);
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${name}.zip`))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(zip)).digest('hex');
  if (!expected || expected !== actual) { rmSync(zip, { force: true }); throw new Error(`SHASUMS256 mismatch for ${name}.zip (expected ${expected?.slice(0, 12)}, got ${actual.slice(0, 12)}) — deleted, run again`); }
  if (!existsSync(exe)) execFileSync(tar, ['-xf', zip, '-C', cache, `${name}/node.exe`, `${name}/LICENSE`], { stdio: 'inherit' });
  console.log(`runtime ${version} verified (${actual.slice(0, 12)}…)`);
  return { version, exe, license: join(cache, name, 'LICENSE') };
}
const runtime = runtimeArg ? await vendorRuntime(runtimeArg.includes('=') ? runtimeArg.split('=')[1] : null) : null;

// What each zip holds comes from tools/lib/pack-plan.mjs: the scripts map is the one source, every script's import
// closure is copied with it, and the staged folder is checked whole before it is zipped (audit 2026-10-21 §4.4).
for (const kind of kinds) {
  const name = `litnode-${kind}-${stamp}${runtime ? '-win-x64' : ''}`;
  const { stage: dir } = stage(kind, { root, dist, name, runtime, pkg });
  const problems = checkStage(dir);
  if (problems.length) { console.error(`${name}: the staged folder is not whole:\n  ${problems.join('\n  ')}`); process.exit(1); }
  // No release carries a secret (docs/SETTLEMENT-ARCHITECTURE.md §11): a key file, an env file, credential content.
  const leaks = scanStage(dir);
  if (leaks.length) { console.error(`${name}: the staged folder carries secrets (paths only):\n  ${leaks.join('\n  ')}`); process.exit(1); }
  const zip = join(dist, `${name}.zip`);
  rmSync(zip, { force: true });
  execFileSync(tar, ['-a', '-cf', zip, '-C', dist, name], { stdio: 'inherit' });
  console.log(`wrote ${zip} (${(readFileSync(zip).length / 1024).toFixed(0)} KB)`);
}
