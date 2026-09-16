/** Bond another node's key from the deployer wallet — for a second machine
 *  whose identity was generated on first run. YOU run this, with the key in
 *  the environment only.
 *
 *    set DEPLOYER_KEY=0x...
 *    node tools/bond-node.mjs <nodeId hex>        # bonds minStake behind that key
 *
 *  The nodeId is printed by the other machine's /health (or its start-up
 *  line). Unbonded nodes gossip but are excluded from placement and cannot
 *  co-sign. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { nodeKeyBytes32 } from '../protocol/staking.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const nodeId = process.argv[2];
const key = process.env.DEPLOYER_KEY;
if (!nodeId) { console.error('usage: node tools/bond-node.mjs <nodeId>'); process.exit(1); }
if (!key) { console.error('DEPLOYER_KEY not set'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(deployed.rpc, deployed.chainId);
const wallet = new ethers.Wallet(key, provider);
const token = new ethers.Contract(deployed.TestLITVM.address, ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function faucet()'], wallet);
const stake = new ethers.Contract(deployed.NodeStake.address, ['function stake(bytes32,uint256)', 'function standingOf(bytes32) view returns (address,uint256,bool)'], wallet);
const minStake = BigInt(deployed.NodeStake.minStake);
const nodeKey = nodeKeyBytes32(nodeId);

/** Caldera's gateway answers 502 now and then. A bond is four calls; retry
 *  each transient failure a few times rather than abandon the whole run. */
const retry = async (label, fn, tries = 5) => {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const transient = e?.code === 'SERVER_ERROR' || e?.code === 'TIMEOUT' || e?.code === 'NETWORK_ERROR';
      if (!transient || i >= tries) throw e;
      console.log(`${label}: ${e.shortMessage ?? e.message} — retry ${i}/${tries - 1} in ${2 * i}s`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
};

const [, amount, active] = await retry('standingOf', () => stake.standingOf(nodeKey));
if (active) { console.log(`${nodeId.slice(0, 16)}… already bonded ${ethers.formatEther(amount)} tLITVM`); process.exit(0); }
if ((await retry('balanceOf', () => token.balanceOf(wallet.address))) < minStake) {
  console.log('faucet: pulling tLITVM');
  await retry('faucet', async () => (await token.faucet()).wait());
}
await retry('approve', async () => (await token.approve(deployed.NodeStake.address, minStake)).wait());
const rc = await retry('stake', async () => (await stake.stake(nodeKey, minStake)).wait());
const s = await retry('standingOf', () => stake.standingOf(nodeKey));
console.log(`bonded ${ethers.formatEther(s[1])} tLITVM behind ${nodeId.slice(0, 16)}… operator ${s[0]} active ${s[2]} (tx ${rc.hash})`);
