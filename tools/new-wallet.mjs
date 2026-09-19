/** Make a fresh EVM wallet for the v2 deployment / authority rotation, and
 *  keep its key OUT of the repo, the shell history and this screen.
 *
 *    node tools/new-wallet.mjs [--file ~/.litnode/deployer-key.json]
 *
 *  Writes { address, privateKey } to the file (refuses to overwrite one that
 *  exists) and prints ONLY the address. Load it into the one shell that runs
 *  a chain tool without ever echoing it:
 *
 *    PowerShell:  $env:DEPLOYER_KEY = (Get-Content ~/.litnode/deployer-key.json | ConvertFrom-Json).privateKey
 *    bash:        export DEPLOYER_KEY=$(node -p "require(require('os').homedir()+'/.litnode/deployer-key.json').privateKey")
 *
 *  Then fund the address with zkLTC (https://liteforge.hub.caldera.xyz) and
 *  run `npm run deploy:testnet -- --fresh --quorum 2`. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomPrivateKey, addressOf } from '../protocol/evm.js';

const args = process.argv.slice(2);
const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : join(homedir(), '.litnode', 'deployer-key.json');
if (existsSync(file)) { console.error(`${file} already exists — not overwriting a wallet that may hold funds. Pass --file for another one.`); process.exit(1); }
const privateKey = randomPrivateKey();
const address = addressOf(privateKey);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ address, privateKey, createdAt: new Date().toISOString(), purpose: 'litnode testnet deployer / operator (v2 migration)' }, null, 2) + '\n', { mode: 0o600 });
const shown = file.split('\\').join('/');
console.log(`new wallet ${address}` + String.fromCharCode(10) + `key written to ${file} (never printed; never commit it)` + String.fromCharCode(10, 10) + 'next:' + String.fromCharCode(10) + `  1. fund ${address} with zkLTC: https://liteforge.hub.caldera.xyz` + String.fromCharCode(10) + `  2. PowerShell:  $env:DEPLOYER_KEY = (Get-Content "${shown}" | ConvertFrom-Json).privateKey` + String.fromCharCode(10) + '  3. npm run deploy:testnet -- --fresh --quorum 2');
