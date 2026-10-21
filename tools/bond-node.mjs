/** Bond another node's key from the deployer wallet — for a second machine
 *  whose identity was generated on first run. YOU run this, with the key in
 *  the environment only.
 *
 *    set DEPLOYER_KEY=0x...
 *    node tools/bond-node.mjs <nodeId hex>                      # generation 3: bonds minStake behind that key
 *    node tools/bond-node.mjs <nodeId hex> --proof <sig hex>    # generation 4: with the node key's proof
 *    node tools/bond-node.mjs <nodeId hex> --identity <file>    # generation 4: sign the proof here from that identity.json
 *
 *  Generation 4 binds a key only with the key's own signature over
 *  "litnode-bond-v1" ‖ 0x00 ‖ chainId ‖ NodeStake ‖ operator (protocol/
 *  staking.js bondMessage), so a stranger cannot squat a key it saw in
 *  gossip. The node's machine makes the proof — it never sends its key:
 *
 *    node tools/bond-node.mjs --sign <operator address> [--identity <file>]
 *
 *  prints the 64-byte proof (identity defaults to $LITNODE_DATA or
 *  data/node-1, identity.json). No DEPLOYER_KEY is needed for --sign.
 *  On generation 3 (no NodeStake.version()) the tool stakes as before.
 *  An already-bound key is topped up only from its own operator.
 *
 *  The nodeId is printed by the other machine's /health (or its start-up
 *  line). Unbonded nodes gossip but are excluded from placement and cannot
 *  co-sign. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { nodeKeyBytes32, bondProof, bondMessage } from '../protocol/staking.js';
import { verifyRaw, toHex } from '../protocol/keys.js';
import { provider as retryingProvider } from './lib/rpc.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const identityPath = opt('--identity') ?? join(process.env.LITNODE_DATA ?? join(root, 'data', 'node-1'), 'identity.json');
const loadIdentity = () => {
  if (!existsSync(identityPath)) { console.error(`no identity at ${identityPath} (--identity <file>)`); process.exit(1); }
  const id = JSON.parse(readFileSync(identityPath, 'utf8'));
  if (!/^[0-9a-f]{64}$/i.test(id.publicKey ?? '') || !/^[0-9a-f]{64}$/i.test(id.privateKey ?? '')) { console.error(`${identityPath} is not a litnode identity`); process.exit(1); }
  return id;
};

// ---- --sign: on the node's machine, print the proof for an operator; nothing is sent
if (argv.includes('--sign')) {
  const operator = opt('--sign');
  if (!/^0x[0-9a-fA-F]{40}$/.test(operator ?? '')) { console.error('usage: node tools/bond-node.mjs --sign <operator address> [--identity <file>]'); process.exit(1); }
  const id = loadIdentity();
  const chainId = BigInt(deployed.chainId ?? 4441);
  const sig = await bondProof(id.privateKey, chainId, deployed.NodeStake.address, operator);
  console.log(JSON.stringify({ nodeId: id.publicKey, operator, chainId: Number(chainId), nodeStake: deployed.NodeStake.address, message: toHex(bondMessage(chainId, deployed.NodeStake.address, operator)), proof: sig }, null, 2));
  console.log(`\non the operator's machine: node tools/bond-node.mjs ${id.publicKey} --proof ${sig}`);
  process.exit(0);
}

const nodeId = argv.find((a) => /^(0x)?[0-9a-fA-F]{64}$/.test(a));
const key = process.env.DEPLOYER_KEY;
if (!nodeId) { console.error('usage: node tools/bond-node.mjs <nodeId> [--proof <sig> | --identity <file>]   ·   node tools/bond-node.mjs --sign <operator>'); process.exit(1); }
if (!key) { console.error('DEPLOYER_KEY not set'); process.exit(1); }

// Retries live in the provider (tools/lib/rpc.mjs) so receipt polling
// survives a 502 too — the step-level retry below only re-issues a call.
const provider = retryingProvider(deployed, { log: (m) => console.log(m) });
const wallet = new ethers.Wallet(key, provider);
const token = new ethers.Contract(deployed.TestLITVM.address, ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function faucet()'], wallet);
const stake = new ethers.Contract(deployed.NodeStake.address, ['function stake(bytes32,uint256)', 'function bond(bytes32,uint256,bytes)', 'function version() view returns (uint16)', 'function standingOf(bytes32) view returns (address,uint256,bool)'], wallet);
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

const [operator, amount, active] = await retry('standingOf', () => stake.standingOf(nodeKey));
if (active) { console.log(`${nodeId.slice(0, 16)}… already bonded ${ethers.formatEther(amount)} tLITVM`); process.exit(0); }
// generation 4 answers version(); generation 3 reverts
const generation = await stake.version().then(Number).catch(() => 3);
const unbound = operator === ethers.ZeroAddress;
if (!unbound && operator.toLowerCase() !== wallet.address.toLowerCase()) { console.error(`${nodeId.slice(0, 16)}… is bound to operator ${operator}; only that wallet can add to it`); process.exit(1); }
let proof = null;
if (generation >= 4 && unbound) {
  const chainId = (await retry('network', () => provider.getNetwork())).chainId;
  const message = bondMessage(chainId, deployed.NodeStake.address, wallet.address);
  const local = argv.includes('--identity') || existsSync(identityPath) ? loadIdentity() : null;
  if (opt('--proof')) proof = opt('--proof').replace(/^0x/, '');
  else if (local && local.publicKey.toLowerCase() === nodeKey.slice(2)) proof = await bondProof(local.privateKey, chainId, deployed.NodeStake.address, wallet.address);
  else if (argv.includes('--identity')) { console.error(`${identityPath} is node ${local.publicKey.slice(0, 16)}…, not ${nodeId.slice(0, 16)}…`); process.exit(1); }
  else {
    console.error(`generation-4 NodeStake: the node key must sign the bond. On the node's machine run\n  node tools/bond-node.mjs --sign ${wallet.address}\nand pass its proof here with --proof <sig>.`);
    process.exit(1);
  }
  if (!(await verifyRaw(message, proof, nodeKey.slice(2)))) { console.error(`the proof is not ${nodeId.slice(0, 16)}…'s signature over the bond message for operator ${wallet.address} on chain ${chainId} (NodeStake ${deployed.NodeStake.address})`); process.exit(1); }
}
if ((await retry('balanceOf', () => token.balanceOf(wallet.address))) < minStake) {
  console.log('faucet: pulling tLITVM');
  await retry('faucet', async () => (await token.faucet()).wait());
}
await retry('approve', async () => (await token.approve(deployed.NodeStake.address, minStake)).wait());
// A retry after a lost receipt must not bond twice: re-read standing first.
const rc = await retry(proof ? 'bond' : 'stake', async () => {
  const [, , nowActive] = await stake.standingOf(nodeKey);
  if (nowActive) return { hash: '(already bonded by the previous attempt)' };
  return (await (proof ? stake.bond(nodeKey, minStake, '0x' + proof) : stake.stake(nodeKey, minStake))).wait();
});
const s = await retry('standingOf', () => stake.standingOf(nodeKey));
console.log(`bonded ${ethers.formatEther(s[1])} tLITVM behind ${nodeId.slice(0, 16)}… operator ${s[0]} active ${s[2]} (generation ${generation}, tx ${rc.hash})`);
