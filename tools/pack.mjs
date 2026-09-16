/** Build the portable zips.
 *    node tools/pack.mjs             → dist/litnode-portable-<date>.zip   (any node: laptop, handheld, volunteer)
 *    node tools/pack.mjs --operator  → dist/litnode-operator-<date>.zip   (+ chain tooling, node.env, scheduled task)
 *    node tools/pack.mjs --all       → both
 *  Same daemon in both; the operator build adds tools and an operator README. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().slice(0, 10);
const dist = join(root, 'dist');
const args = process.argv.slice(2);
const kinds = args.includes('--all') ? ['portable', 'operator'] : args.includes('--operator') ? ['operator'] : ['portable'];
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const kind of kinds) {
  const name = `litnode-${kind}-${stamp}`;
  const stage = join(dist, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const d of ['node', 'protocol', 'rulesets', 'arcade']) cpSync(join(root, d), join(stage, d), { recursive: true });
  mkdirSync(join(stage, 'contracts'), { recursive: true });
  for (const f of ['deployed.testnet.json', 'deploy.testnet.json']) if (existsSync(join(root, 'contracts', f))) cpSync(join(root, 'contracts', f), join(stage, 'contracts', f));
  mkdirSync(join(stage, 'tools'), { recursive: true });
  cpSync(join(root, 'portable', 'start-node.cmd'), join(stage, 'start-node.cmd'));
  cpSync(join(root, 'portable', 'node.env.example'), join(stage, 'node.env.example'));

  const scripts = { node: 'node node/cli.mjs', keygen: 'node tools/keygen.mjs' };
  let deps;
  if (kind === 'portable') {
    for (const f of ['keygen.mjs', 'bond-node.mjs']) cpSync(join(root, 'tools', f), join(stage, 'tools', f));
    cpSync(join(root, 'portable', 'README-PORTABLE.md'), join(stage, 'README.md'));
  } else {
    for (const f of ['keygen.mjs', 'bond-node.mjs', 'af-import-ledger.mjs', 'anchor-epoch.mjs', 'deploy-contracts.mjs']) cpSync(join(root, 'tools', f), join(stage, 'tools', f));
    for (const f of ['NodeStake.sol', 'TestLITVM.sol', 'ERC6699Registry.sol', 'EpochAnchor.sol']) cpSync(join(root, 'contracts', f), join(stage, 'contracts', f));
    for (const f of ['install-task.cmd', 'run-node.cmd']) cpSync(join(root, 'portable', f), join(stage, f));
    cpSync(join(root, 'portable', 'README-OPERATOR.md'), join(stage, 'README.md'));
    Object.assign(scripts, { bond: 'node tools/bond-node.mjs', 'import:af': 'node tools/af-import-ledger.mjs', anchor: 'node tools/anchor-epoch.mjs', 'deploy:testnet': 'node tools/deploy-contracts.mjs' });
    deps = { ethers: pkg.devDependencies.ethers, solc: pkg.devDependencies.solc };
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: `litnode-${kind}`, private: true, type: 'module', version: pkg.version ?? '0.2.0', license: 'Apache-2.0',
    engines: { node: '>=20' }, scripts, ...(deps ? { dependencies: deps } : {}),
  }, null, 2) + '\n');

  const zip = join(dist, `${name}.zip`);
  rmSync(zip, { force: true });
  execFileSync(tar, ['-a', '-cf', zip, '-C', dist, name], { stdio: 'inherit' });
  console.log(`wrote ${zip} (${(readFileSync(zip).length / 1024).toFixed(0)} KB)`);
}
