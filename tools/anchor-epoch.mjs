/** Propose an hour's root to EpochAnchor v2 as the operator of a bonded
 *  node. YOU run this, with the OPERATOR key in the environment only — the
 *  node never holds a chain key (§11).
 *
 *    set OPERATOR_KEY=0x...            (DEPLOYER_KEY still accepted)
 *    node tools/anchor-epoch.mjs [nodeUrl] [epochHour]
 *
 *  Fetches GET <nodeUrl>/epoch from a running node (frozen batches only —
 *  an open hour is refused, its leaf set can still change), sends the
 *  prepared propose(epoch, root, nodeKey) calldata, then reports support and
 *  finality: the root is final on chain when `quorum` distinct bonded
 *  operators proposed the same one. With a finalized root it verifies one
 *  inclusion proof on chain so the whole path is exercised end to end. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const nodeUrl = process.argv[2] ?? 'http://127.0.0.1:7801';
const epochArg = process.argv[3];
const key = process.env.OPERATOR_KEY ?? process.env.DEPLOYER_KEY;
if (!key) { console.error('OPERATOR_KEY not set'); process.exit(1); }
if (!deployed.EpochAnchor?.address) { console.error('EpochAnchor not deployed — run npm run deploy:testnet'); process.exit(1); }

const e = await (await fetch(`${nodeUrl}/epoch${epochArg ? `?epoch=${epochArg}` : ''}`)).json();
if (!e.count) { console.error(`epoch ${e.epoch} has no settled matches on ${nodeUrl}`); process.exit(1); }
if (e.status !== 'finalized') { console.error(`epoch ${e.epoch} is still open on the node (freezes at ${e.freezeAt}); only a frozen batch is proposed`); process.exit(1); }
console.log(`epoch ${e.epoch}: ${e.count} match(es), ${e.matches.filter((m) => m.verified).length} verified, root ${e.root}`);

const provider = new ethers.JsonRpcProvider(deployed.rpc, deployed.chainId);
const wallet = new ethers.Wallet(key, provider);
const abi = [
  'function propose(uint64 epoch, bytes32 root, bytes32 nodeKey)',
  'function rootOf(uint64 epoch) view returns (bytes32)',
  'function support(uint64 epoch, bytes32 root) view returns (uint32)',
  'function quorum() view returns (uint32)',
  'function verifyInclusion(uint64 epoch, bytes32 leaf, bytes32[] path, bool[] left) view returns (bool)',
];
if ((deployed.EpochAnchor.version ?? 1) < 2) { console.error('EpochAnchor v1 is deployed (anyone may anchor, no quorum). Deploy v2 first: npm run deploy:testnet -- --fresh'); process.exit(1); }
const anchor = new ethers.Contract(deployed.EpochAnchor.address, abi, wallet);

const existing = await anchor.rootOf(e.epoch);
if (existing !== ethers.ZeroHash) {
  console.log(`already final: ${existing} ${existing === '0x' + e.root ? '(matches this node)' : '(DIFFERS from this node: its batch is not the finalized one)'}`);
} else {
  const tx = await wallet.sendTransaction({ to: deployed.EpochAnchor.address, data: e.proposeCalldata });
  const rc = await tx.wait();
  const [sup, q] = await Promise.all([anchor.support(e.epoch, '0x' + e.root), anchor.quorum()]);
  console.log(`proposed in tx ${rc.hash} (block ${rc.blockNumber}) · support ${sup}/${q}${sup >= q ? ' — FINAL' : ' — waiting for other operators'}`);
  console.log(`explorer: https://liteforge.explorer.caldera.xyz/tx/${rc.hash}`);
}

const final = await anchor.rootOf(e.epoch);
if (final === ethers.ZeroHash) { console.log('not final yet: an inclusion proof verifies on chain only against a finalized root'); process.exit(0); }
const m = e.matches[0];
const proof = await (await fetch(`${nodeUrl}/proof/${encodeURIComponent(m.matchId)}`)).json();
const ok = await anchor.verifyInclusion(e.epoch, '0x' + proof.leaf, proof.path.map((p) => '0x' + p.hash), proof.path.map((p) => p.left));
console.log(`on-chain verifyInclusion(${m.matchId}) → ${ok} · leaf verified=${proof.verified} (inclusion ≠ verification: the leaf carries its own status)`);
process.exit(ok ? 0 : 1);
