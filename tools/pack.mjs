/** Build the portable zips.
 *    node tools/pack.mjs             → dist/litnode-portable-<date>.zip   (any node: laptop, handheld, volunteer)
 *    node tools/pack.mjs --operator  → dist/litnode-operator-<date>.zip   (+ chain tooling, node.env, scheduled task)
 *    node tools/pack.mjs --all       → both
 *    node tools/pack.mjs --all --runtime[=v22.19.0]
 *        also vendors the official Node.js win-x64 runtime as runtime/node.exe,
 *        so the zip runs on a machine with nothing installed. The download is
 *        checked against nodejs.org's SHASUMS256.txt; default is the newest LTS.
 *  Same daemon in both; the operator build adds tools and an operator README. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().slice(0, 10);
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

for (const kind of kinds) {
  const name = `litnode-${kind}-${stamp}${runtime ? '-win-x64' : ''}`;
  const stage = join(dist, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const d of ['node', 'protocol', 'sdk', 'titles', 'rulesets', 'cabinet']) cpSync(join(root, d), join(stage, d), { recursive: true });
  mkdirSync(join(stage, 'contracts'), { recursive: true });
  for (const f of ['deployed.testnet.json', 'deploy.testnet.json']) if (existsSync(join(root, 'contracts', f))) cpSync(join(root, 'contracts', f), join(stage, 'contracts', f));
  mkdirSync(join(stage, 'tools'), { recursive: true });
  for (const f of ['start-node.cmd', 'allow-firewall.cmd', 'update.cmd', 'node.env.example']) cpSync(join(root, 'portable', f), join(stage, f));
  cpSync(join(root, 'tools', 'update.mjs'), join(stage, 'tools', 'update.mjs'));
  if (runtime) {
    mkdirSync(join(stage, 'runtime'), { recursive: true });
    cpSync(runtime.exe, join(stage, 'runtime', 'node.exe'));
    cpSync(runtime.license, join(stage, 'runtime', 'LICENSE-nodejs.txt'));
    writeFileSync(join(stage, 'runtime', 'VERSION'), `${runtime.version}\n`);
  }

  const scripts = { node: 'node node/cli.mjs', keygen: 'node tools/keygen.mjs', cabinet: 'node cabinet/serve.mjs', update: 'node tools/update.mjs' };
  let deps;
  if (kind === 'portable') {
    for (const f of ['keygen.mjs', 'bond-node.mjs']) cpSync(join(root, 'tools', f), join(stage, 'tools', f));
    cpSync(join(root, 'portable', 'README-PORTABLE.md'), join(stage, 'README.md'));
  } else {
    for (const f of ['keygen.mjs', 'bond-node.mjs', 'af-import-ledger.mjs', 'af-watch.mjs', 'anchor-epoch.mjs', 'deploy-contracts.mjs', 'set-announcer.mjs']) cpSync(join(root, 'tools', f), join(stage, 'tools', f));
    cpSync(join(root, 'tools', 'lib'), join(stage, 'tools', 'lib'), { recursive: true });
    for (const f of ['NodeStake.sol', 'TestLITVM.sol', 'ERC6699Registry.sol', 'EpochAnchor.sol']) cpSync(join(root, 'contracts', f), join(stage, 'contracts', f));
    for (const f of ['install-task.cmd', 'run-node.cmd', 'run-af-relay.cmd', 'run-af-watch.cmd']) cpSync(join(root, 'portable', f), join(stage, f));
    cpSync(join(root, 'portable', 'README-OPERATOR.md'), join(stage, 'README.md'));
    Object.assign(scripts, { bond: 'node tools/bond-node.mjs', 'import:af': 'node tools/af-import-ledger.mjs', 'watch:af': 'node tools/af-watch.mjs', anchor: 'node tools/anchor-epoch.mjs', announcer: 'node tools/set-announcer.mjs', 'deploy:testnet': 'node tools/deploy-contracts.mjs' });
    deps = { ethers: pkg.devDependencies.ethers, solc: pkg.devDependencies.solc };
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: `litnode-${kind}`, private: true, type: 'module', version: pkg.version ?? '0.2.0', license: 'Apache-2.0', runtime: runtime?.version ?? 'system',
    engines: { node: '>=20' }, scripts, ...(deps ? { dependencies: deps } : {}),
  }, null, 2) + '\n');

  const zip = join(dist, `${name}.zip`);
  rmSync(zip, { force: true });
  execFileSync(tar, ['-a', '-cf', zip, '-C', dist, name], { stdio: 'inherit' });
  console.log(`wrote ${zip} (${(readFileSync(zip).length / 1024).toFixed(0)} KB)`);
}
