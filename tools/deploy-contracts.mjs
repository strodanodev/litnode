/** Deploy the testnet contracts to litVM Liteforge and bond the first node.
 *
 *  YOU run this. It signs with a key it reads from the environment and the
 *  key never goes anywhere else. Never paste a private key into a chat, a
 *  file in the repo, or a shell history you keep.
 *
 *    set DEPLOYER_KEY=0x...            (PowerShell: $env:DEPLOYER_KEY="0x...")
 *    node tools/deploy-contracts.mjs
 *
 *  Steps, each idempotent via contracts/deployed.testnet.json:
 *    1. compile TestLITVM, NodeStake, ERC6699Registry (solc 0.8.28, shanghai)
 *    2. deploy TestLITVM, pull the faucet
 *    3. deploy NodeStake(token, minStake, unbondingPeriod, slasher, treasury)
 *       with the values in contracts/deploy.testnet.json
 *    4. deploy ERC6699Registry, EpochAnchor, PlayerProfile, NodeBadge(NodeStake)
 *    5. generate (or load) the local node identity and bond minStake behind it
 *    6. write contracts/deployed.testnet.json — the node reads this
 *
 *  Needs zkLTC for gas on the deployer: https://liteforge.hub.caldera.xyz */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import solc from 'solc';
import { generateKeypair } from '../protocol/keys.js';
import { nodeKeyBytes32 } from '../protocol/staking.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = join(root, 'contracts', 'deploy.testnet.json');
const outPath = join(root, 'contracts', 'deployed.testnet.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const deployed = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
const save = () => writeFileSync(outPath, JSON.stringify(deployed, null, 2) + '\n');

const key = process.env.DEPLOYER_KEY;
if (!key) { console.error('DEPLOYER_KEY is not set. Set it in this shell only and re-run.'); process.exit(1); }
const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const wallet = new ethers.Wallet(key, provider);
const balance = await provider.getBalance(wallet.address);
console.log(`deployer ${wallet.address} · ${ethers.formatEther(balance)} zkLTC · chain ${(await provider.getNetwork()).chainId}`);
if (balance === 0n) { console.error('no zkLTC for gas — use the faucet first'); process.exit(1); }

// ---------------------------------------------------------------- compile
const files = ['TestLITVM.sol', 'NodeStake.sol', 'ERC6699Registry.sol', 'EpochAnchor.sol', 'PlayerProfile.sol', 'NodeBadge.sol'];
const sources = Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(root, 'contracts', f), 'utf8') }]));
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources,
  settings: { evmVersion: cfg.evmVersion, optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
const errors = (compiled.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1); }
const artifact = (file, name) => compiled.contracts[file][name];

const deploy = async (label, file, name, args = []) => {
  if (deployed[label]?.address) {
    console.log(`${label}: already at ${deployed[label].address}`);
    return new ethers.Contract(deployed[label].address, artifact(file, name).abi, wallet);
  }
  const { abi, evm } = artifact(file, name);
  const factory = new ethers.ContractFactory(abi, '0x' + evm.bytecode.object, wallet);
  const c = await factory.deploy(...args);
  const receipt = await c.deploymentTransaction().wait();
  deployed[label] = { address: await c.getAddress(), tx: receipt.hash, block: receipt.blockNumber, args: args.map(String) };
  save();
  console.log(`${label}: deployed at ${deployed[label].address} (tx ${receipt.hash})`);
  return c;
};

// ---------------------------------------------------------------- token + faucet
const token = await deploy('TestLITVM', 'TestLITVM.sol', 'TestLITVM');
const tBal = await token.balanceOf(wallet.address);
if (tBal === 0n) {
  console.log('faucet: pulling 1000 tLITVM');
  await (await token.faucet()).wait();
}
console.log(`tLITVM balance ${ethers.formatEther(await token.balanceOf(wallet.address))}`);

// ---------------------------------------------------------------- NodeStake
const ns = cfg.NodeStake;
const minStake = BigInt(ns.minStake);
const stake = await deploy('NodeStake', 'NodeStake.sol', 'NodeStake', [
  await token.getAddress(), minStake, BigInt(ns.unbondingPeriod), wallet.address, wallet.address,
]);
deployed.NodeStake.minStake = ns.minStake;
deployed.NodeStake.unbondingPeriod = ns.unbondingPeriod;
save();

// ---------------------------------------------------------------- ERC-6699 + EpochAnchor
await deploy('ERC6699Registry', 'ERC6699Registry.sol', 'ERC6699Registry');
await deploy('EpochAnchor', 'EpochAnchor.sol', 'EpochAnchor');
// ---------------------------------------------------------------- identity: player profiles + node badges (docs/WALLET-IDENTITY.md)
await deploy('PlayerProfile', 'PlayerProfile.sol', 'PlayerProfile');
await deploy('NodeBadge', 'NodeBadge.sol', 'NodeBadge', [await stake.getAddress()]);

// ---------------------------------------------------------------- bond the first node
const dataDir = process.env.LITNODE_DATA ?? join(root, 'data', 'node-1');
mkdirSync(dataDir, { recursive: true });
const idPath = join(dataDir, 'identity.json');
const identity = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : await generateKeypair();
if (!existsSync(idPath)) writeFileSync(idPath, JSON.stringify(identity, null, 2) + '\n');
const nodeKey = nodeKeyBytes32(identity.publicKey);
const [, amount, active] = await stake.standingOf(nodeKey);
if (!active) {
  console.log(`bonding ${ethers.formatEther(minStake)} tLITVM behind node ${identity.publicKey.slice(0, 16)}…`);
  await (await token.approve(await stake.getAddress(), minStake)).wait();
  await (await stake.stake(nodeKey, minStake)).wait();
}
const standing = await stake.standingOf(nodeKey);
console.log(`node ${identity.publicKey.slice(0, 16)}… operator ${standing[0]} bonded ${ethers.formatEther(standing[1])} active ${standing[2]}`);
deployed.firstNode = { nodeId: identity.publicKey, bonded: ethers.formatEther(standing[1]) };
deployed.chainId = cfg.chainId;
deployed.rpc = cfg.rpc;
deployed.deployedAt = new Date().toISOString();
save();
console.log(`\nwrote ${outPath}`);
console.log(`explorer: https://liteforge.explorer.caldera.xyz/address/${deployed.NodeStake.address}`);
