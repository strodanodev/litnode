/** Delegate a node's announcer on NodeDirectory and give it gas. YOU run
 *  this, with the operator key in the environment only.
 *
 *    set DEPLOYER_KEY=0x...
 *    node tools/set-announcer.mjs <nodeId> <announcerAddress> [--fund 0.02]
 *
 *  The node prints its announcer address on /health.directory.announcer
 *  (and in its dashboard) — a key it generated itself and keeps in
 *  <dataDir>/announcer.json. After this, the node publishes its own tunnel
 *  URL on chain whenever it changes; the operator key never touches it. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { nodeKeyBytes32 } from '../protocol/staking.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const [nodeId, announcer] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fund = process.argv.includes('--fund') ? process.argv[process.argv.indexOf('--fund') + 1] : null;
const key = process.env.DEPLOYER_KEY;
if (!key) { console.error('DEPLOYER_KEY not set'); process.exit(1); }
if (!deployed.NodeDirectory?.address) { console.error('NodeDirectory not deployed — run npm run deploy:testnet'); process.exit(1); }
if (!/^[0-9a-f]{64}$/i.test(nodeId ?? '') || !ethers.isAddress(announcer ?? '')) { console.error('usage: node tools/set-announcer.mjs <nodeId 64 hex> <announcer 0x…> [--fund <zkLTC>]'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(deployed.rpc, deployed.chainId);
const wallet = new ethers.Wallet(key, provider);
const dir = new ethers.Contract(deployed.NodeDirectory.address, ['function setAnnouncer(bytes32,address)', 'function announcerOf(bytes32) view returns (address)', 'function entryOf(bytes32) view returns (string,string,uint64,address)'], wallet);
const k = nodeKeyBytes32(nodeId);
const cur = await dir.announcerOf(k);
if (cur.toLowerCase() === announcer.toLowerCase()) console.log(`announcer already ${announcer}`);
else { const tx = await dir.setAnnouncer(k, announcer); const rc = await tx.wait(); console.log(`delegated ${announcer} for node ${nodeId.slice(0, 12)}… (tx ${rc.hash})`); }
if (fund) { const tx = await wallet.sendTransaction({ to: announcer, value: ethers.parseEther(fund) }); await tx.wait(); console.log(`sent ${fund} zkLTC to ${announcer}`); }
console.log(`announcer balance ${ethers.formatEther(await provider.getBalance(announcer))} zkLTC`);
const [url, ws, at] = await dir.entryOf(k);
console.log(`current entry: ${url || '(none)'} ${ws || ''} ${at ? new Date(Number(at) * 1000).toISOString() : ''}`);
