/** Who controls what on chain — read-only. No key needed, nothing printed
 *  that should not be.
 *
 *    node tools/authority.mjs [--json] [--compromised 0x...]
 *
 *  Reads every authority the deployed contracts know (NodeStake slasher and
 *  treasury, each bonded node key's operator, NodeDirectory announcers,
 *  EpochAnchor admin/quorum where v2, ERC6699Registry admin/minters where
 *  v2) and says which of them a compromised address still holds. The
 *  default compromised address is the deployer key the 17 Sep audit
 *  reported exposed. Writes audit/authority-<block>.json as the block-pinned
 *  ownership snapshot the audit asked for. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { nodeKeyBytes32 } from '../protocol/staking.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const args = process.argv.slice(2);
const COMPROMISED = (args.includes('--compromised') ? args[args.indexOf('--compromised') + 1] : '0xa6d840C28B3DF4f931F1ac2fB940c59B9e9DfdfE').toLowerCase();
/** Node keys to inspect: the deployment's first node plus any given as --node <hex> (repeatable) and KNOWN_NODES env (comma list). */
const nodeIds = [deployed.firstNode?.nodeId, ...args.flatMap((a, i) => (a === '--node' ? [args[i + 1]] : [])), ...(process.env.KNOWN_NODES ?? '').split(',').map((s) => s.trim())].filter((x) => /^[0-9a-f]{64}$/i.test(x ?? ''));

const provider = new ethers.JsonRpcProvider(deployed.rpc, deployed.chainId);
const retry = async (fn, tries = 5) => { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 1500 * i)); } } };
const block = await retry(() => provider.getBlockNumber());
const at = { blockTag: block };
const same = (a) => (a ?? '').toLowerCase() === COMPROMISED;

const stake = new ethers.Contract(deployed.NodeStake.address, ['function slasher() view returns (address)', 'function treasury() view returns (address)', 'function minStake() view returns (uint256)', 'function unbondingPeriod() view returns (uint64)', 'function standingOf(bytes32) view returns (address,uint256,bool)'], provider);
const dir = deployed.NodeDirectory?.address ? new ethers.Contract(deployed.NodeDirectory.address, ['function announcerOf(bytes32) view returns (address)', 'function entryOf(bytes32) view returns (string,string,uint64,address)', 'function keys() view returns (bytes32[])'], provider) : null;
const anchor = deployed.EpochAnchor?.address ? new ethers.Contract(deployed.EpochAnchor.address, ['function admin() view returns (address)', 'function quorum() view returns (uint32)'], provider) : null;
const registry = deployed.ERC6699Registry?.address ? new ethers.Contract(deployed.ERC6699Registry.address, ['function admin() view returns (address)'], provider) : null;

const report = { chainId: deployed.chainId, rpc: deployed.rpc, block, at: new Date().toISOString(), compromised: COMPROMISED, holdings: [], contracts: {} };
const hold = (contract, role, address, note = '') => { const held = same(address); report.holdings.push({ contract, role, address, heldByCompromised: held, note }); return held; };

// NodeStake
const [slasher, treasury, minStake, unbonding] = await retry(() => Promise.all([stake.slasher(at), stake.treasury(at), stake.minStake(at), stake.unbondingPeriod(at)]));
report.contracts.NodeStake = { address: deployed.NodeStake.address, slasher, treasury, minStake: minStake.toString(), unbondingPeriod: Number(unbonding), version: 1 };
hold('NodeStake', 'slasher (can slash any bond, can setParams)', slasher);
hold('NodeStake', 'treasury (receives slashed bonds)', treasury);
// bonded node keys
const keys = new Set(nodeIds);
if (dir) for (const k of await retry(() => dir.keys(at))) keys.add(k.replace(/^0x/, ''));
report.nodes = [];
for (const id of keys) {
  const key = nodeKeyBytes32(id);
  const [operator, amount, active] = await retry(() => stake.standingOf(key, at));
  const n = { nodeId: id, operator, bonded: ethers.formatEther(amount), active };
  if (dir) { n.announcer = await retry(() => dir.announcerOf(key, at)); const e = await retry(() => dir.entryOf(key, at)); n.entry = { url: e[0], wsAddr: e[1], updatedAt: Number(e[2]) ? new Date(Number(e[2]) * 1000).toISOString() : null, announcedBy: e[3] }; }
  report.nodes.push(n);
  if (operator !== ethers.ZeroAddress) hold('NodeStake', `operator of node ${id.slice(0, 12)}… (can unstake it${deployed.NodeStake?.version >= 2 ? '; movable with transferOperator' : '; NodeStake v1 binds the key to this operator forever'})`, operator, active ? 'active bond' : 'not active');
  if (n.announcer && n.announcer !== ethers.ZeroAddress) hold('NodeDirectory', `announcer for node ${id.slice(0, 12)}… (can misdirect discovery of that node)`, n.announcer, 'delegated key held by the node, not the operator');
}
// EpochAnchor
if (anchor) {
  try { const [admin, quorum] = await retry(() => Promise.all([anchor.admin(at), anchor.quorum(at)])); report.contracts.EpochAnchor = { address: deployed.EpochAnchor.address, version: 2, admin, quorum: Number(quorum) }; hold('EpochAnchor', 'admin (sets quorum and stake contract)', admin); }
  catch { report.contracts.EpochAnchor = { address: deployed.EpochAnchor.address, version: 1, note: 'v1: anyone may anchor the first root of any epoch; no admin, no quorum — replace with v2' }; report.holdings.push({ contract: 'EpochAnchor', role: 'anyone (v1 has no authority at all)', address: null, heldByCompromised: false, note: 'unauthorized roots possible until v2 is deployed' }); }
}
// ERC6699Registry
if (registry) {
  try { const admin = await retry(() => registry.admin(at)); report.contracts.ERC6699Registry = { address: deployed.ERC6699Registry.address, version: 2, admin }; hold('ERC6699Registry', 'admin (names minters and progressors)', admin); }
  catch { report.contracts.ERC6699Registry = { address: deployed.ERC6699Registry.address, version: 1, note: 'v1: anyone may forge any unused id with arbitrary stats; no admin — replace with v2' }; report.holdings.push({ contract: 'ERC6699Registry', role: 'anyone (v1 forge is open)', address: null, heldByCompromised: false, note: 'arbitrary competitive stats possible until v2 is deployed' }); }
}
for (const c of ['PlayerProfile', 'NodeBadge', 'TestLITVM']) if (deployed[c]?.address) report.contracts[c] = { address: deployed[c].address, note: 'no privileged role' };

report.summary = {
  heldByCompromised: report.holdings.filter((h) => h.heldByCompromised).length,
  rotatable: deployed.NodeStake?.version >= 2 ? 'v2 set: NodeStake slasher/treasury via setParams, operator bindings via transferOperator, EpochAnchor/ERC6699Registry admin via transferAdmin/setParams — no redeploy needed.' : 'NodeStake slasher/treasury via setParams (by the current slasher); EpochAnchor/ERC6699Registry admin via v2 admin. Node OPERATOR bindings in NodeStake v1 cannot be moved: re-bond the keys on a fresh NodeStake from the new wallet (contracts/MIGRATION.md).',
};
mkdirSync(join(root, 'audit'), { recursive: true });
const out = join(root, 'audit', `authority-${block}.json`);
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
console.log(`chain ${report.chainId} @ block ${block} · compromised address ${COMPROMISED}\n`);
for (const h of report.holdings) console.log(`${h.heldByCompromised ? '!! ' : '   '}${h.contract.padEnd(16)} ${h.role}\n${' '.repeat(19)}${h.address ?? '-'}${h.note ? `  (${h.note})` : ''}`);
console.log(`\n${report.summary.heldByCompromised} authority holding(s) remain with the compromised address.\n${report.summary.rotatable}\nsnapshot: ${out}`);
