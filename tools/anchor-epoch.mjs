/** Broadcast an hour's root to EpochAnchor. YOU run this, with the key in
 *  the environment only — the node never holds a chain key (§11).
 *
 *    set DEPLOYER_KEY=0x...
 *    node tools/anchor-epoch.mjs [nodeUrl] [epochHour]
 *
 *  Fetches GET <nodeUrl>/epoch from a running node, sends its prepared
 *  calldata as-is, then reads rootOf() back and verifies one inclusion proof
 *  on chain so the whole path — node tree, calldata, contract, proof — is
 *  exercised end to end. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const nodeUrl = process.argv[2] ?? 'http://127.0.0.1:7801';
const epochArg = process.argv[3];
const key = process.env.DEPLOYER_KEY;
if (!key) { console.error('DEPLOYER_KEY not set'); process.exit(1); }
if (!deployed.EpochAnchor?.address) { console.error('EpochAnchor not deployed — run npm run deploy:testnet'); process.exit(1); }

const e = await (await fetch(`${nodeUrl}/epoch${epochArg ? `?epoch=${epochArg}` : ''}`)).json();
if (!e.count) { console.error(`epoch ${e.epoch} has no settled matches on ${nodeUrl}`); process.exit(1); }
console.log(`epoch ${e.epoch}: ${e.count} match(es), root ${e.root}`);

const provider = new ethers.JsonRpcProvider(deployed.rpc, deployed.chainId);
const wallet = new ethers.Wallet(key, provider);
const abi = [
  'function anchorEpoch(uint64 epoch, bytes32 root)',
  'function rootOf(uint64 epoch) view returns (bytes32)',
  'function verifyInclusion(uint64 epoch, bytes32 leaf, bytes32[] path, bool[] left) view returns (bool)',
];
const anchor = new ethers.Contract(deployed.EpochAnchor.address, abi, wallet);

const existing = await anchor.rootOf(e.epoch);
if (existing !== ethers.ZeroHash) {
  console.log(`already anchored: ${existing} ${existing === '0x' + e.root ? '(matches)' : '(DIFFERS from this node)'}`);
} else {
  const tx = await wallet.sendTransaction({ to: deployed.EpochAnchor.address, data: e.anchorCalldata });
  const rc = await tx.wait();
  console.log(`anchored in tx ${rc.hash} (block ${rc.blockNumber})`);
  console.log(`explorer: https://liteforge.explorer.caldera.xyz/tx/${rc.hash}`);
}

const m = e.matches[0];
const proof = await (await fetch(`${nodeUrl}/proof/${encodeURIComponent(m.matchId)}`)).json();
const ok = await anchor.verifyInclusion(e.epoch, '0x' + proof.leaf, proof.path.map((p) => '0x' + p.hash), proof.path.map((p) => p.left));
console.log(`on-chain verifyInclusion(${m.matchId}) → ${ok}`);
process.exit(ok ? 0 : 1);
