/** Hand a bonded node key to another wallet (NodeStake.transferOperator).
 *
 *    set DEPLOYER_KEY=0x...           the CURRENT operator's key (env only)
 *    node tools/transfer-operator.mjs <nodeId> <newOperatorAddress>
 *
 *  The bond, the key and the node's history stay put; only who may unstake,
 *  delegate and be counted as the operator changes. Two uses:
 *   - a witness must be under a DIFFERENT operator than the host it
 *     witnesses, so a node bonded from the wrong wallet is moved, not
 *     unbonded and re-bonded;
 *   - wallet rotation (the exposed-key case). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { nodeKeyBytes32 } from '../protocol/staking.js';
import { provider as retryingProvider } from './lib/rpc.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const [nodeId, to] = process.argv.slice(2);
const key = process.env.DEPLOYER_KEY;
if (!nodeId || !to) { console.error('usage: node tools/transfer-operator.mjs <nodeId> <newOperatorAddress>'); process.exit(1); }
if (!key) { console.error('DEPLOYER_KEY not set (the current operator\'s key)'); process.exit(1); }
if (!ethers.isAddress(to)) { console.error(`${to} is not an address`); process.exit(1); }

const provider = retryingProvider(deployed, { log: (m) => console.log(m) });
const wallet = new ethers.Wallet(key, provider);
const stake = new ethers.Contract(deployed.NodeStake.address, [
  'function transferOperator(bytes32,address)',
  'function standingOf(bytes32) view returns (address,uint256,bool)',
], wallet);
const nodeKey = nodeKeyBytes32(nodeId);

const [operator, amount, active] = await stake.standingOf(nodeKey);
if (!active) { console.error(`${nodeId.slice(0, 16)}… is not actively bonded (operator ${operator}, ${ethers.formatEther(amount)} tLITVM)`); process.exit(1); }
if (operator.toLowerCase() === to.toLowerCase()) { console.log(`${nodeId.slice(0, 16)}… already under ${to}`); process.exit(0); }
if (operator.toLowerCase() !== wallet.address.toLowerCase()) { console.error(`this key is ${wallet.address}, but the node's operator is ${operator} — only the operator can transfer`); process.exit(1); }

console.log(`transferring ${nodeId.slice(0, 16)}… (${ethers.formatEther(amount)} tLITVM) from ${operator} to ${to}`);
const rc = await (await stake.transferOperator(nodeKey, to)).wait();
const after = await stake.standingOf(nodeKey);
console.log(`done: operator ${after[0]} · bonded ${ethers.formatEther(after[1])} · active ${after[2]} (tx ${rc.hash})`);
