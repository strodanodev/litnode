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
 *    3. deploy NodeStake v3(token, minStake, lockTerm, eligibilityAge,
 *       unbondingPeriod, admin, treasury) with the values in
 *       contracts/deploy.testnet.json — refused when unbondingPeriod does not
 *       exceed the dispute windows (BUILD-SPEC v0.3 §2.2)
 *    4. deploy ERC6699Registry, EpochAnchor, PlayerProfile, NodeBadge(NodeStake),
 *       ReleaseRegistry(admin, activationDelay)
 *       TitleRegistry(activationDelay) — no admin: a title is an ERC-721, its holder publishes
 *    5. generate (or load) the local node identity and bond minStake behind it
 *    6. write contracts/deployed.testnet.json — the node reads this
 *
 *  --fresh   ignore contracts/deployed.testnet.json and deploy a NEW set of
 *            every contract (the v2 migration: a new deployer wallet, v2
 *            EpochAnchor with quorum, v2 ERC6699Registry with roles, NodeStake
 *            with transferOperator). The old file is archived as
 *            contracts/deployed.testnet.<timestamp>.json — the migration record.
 *  --quorum N  EpochAnchor v3 quorum in basis points of active bonded stake (default 5000).
 *  --only TitleRegistry[,ReleaseRegistry,…]  add just those contracts to the
 *            existing deployment; NodeStake and everything keyed on it untouched.
 *
 *  Needs zkLTC for gas on the deployer: https://liteforge.hub.caldera.xyz */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeypair } from '../protocol/keys.js';
import { nodeKeyBytes32 } from '../protocol/staking.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// DEPLOY_CONFIG / DEPLOY_OUT: a dry run (demo/deploy.test.mjs) points these at temp files and an in-process chain.
const cfgPath = process.env.DEPLOY_CONFIG ?? join(root, 'contracts', 'deploy.testnet.json');
const outPath = process.env.DEPLOY_OUT ?? join(root, 'contracts', 'deployed.testnet.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
// v3 invariant, checked BEFORE anything is sent: every adjudicator's dispute + escalation windows must fit
// inside the unbonding period, or a node can leave before it can be slashed for work it did.
// MatchBook.totalWindow() = settle + 2×attest (one extension) + 2×escalation (feed the ledger, then the nine).
{
  const w = Number(cfg.MatchBook?.settleWindowS ?? 0) + 2 * Number(cfg.MatchBook?.attestWindowS ?? 0) + 2 * Number(cfg.MatchBook?.escalationWindowS ?? 0);
  if (Number(cfg.NodeStake?.unbondingPeriod ?? 0) <= w) { console.error(`NodeStake.unbondingPeriod (${cfg.NodeStake?.unbondingPeriod}s) must exceed the MatchBook windows (${w}s): a node could unbond before a dispute against it resolves`); process.exit(1); }
}
const key = process.env.DEPLOYER_KEY;
if (!key) { console.error('DEPLOYER_KEY is not set. Set it in this shell only and re-run (tools/new-wallet.mjs makes one and says how).'); process.exit(1); }
const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
// --quorum: EpochAnchor v3 quorum in BASIS POINTS of the active bonded stake (default 5000 = a majority of stake).
const quorum = argv.includes('--quorum') ? Number(argv[argv.indexOf('--quorum') + 1]) : 5000;
if (!(quorum > 0 && quorum <= 10_000)) { console.error('--quorum is basis points of active stake: 1..10000'); process.exit(1); }
// ethers and solc load only once the run is going ahead: an early exit with them mid-initialisation
// trips a libuv assertion on Windows (seen 22 Sep 2026, "!(handle->flags & UV_HANDLE_CLOSING)").
const { ethers } = await import('ethers');
const solc = (await import('solc')).default;
const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
// --fresh is resumable: a file that already carries `migratedFrom` IS the new
// generation, half-deployed (Caldera's gateway 502s mid-run) — continue it
// rather than archiving it and starting over. Archive names come from the
// previous set's own deployedAt, so a re-run never makes a second copy.
const resuming = fresh && previous?.migratedFrom;
if (fresh && previous && !resuming) {
  const stamp = String(previous.deployedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
  const archived = join(dirname(outPath), `deployed.testnet.${stamp}.json`);
  if (!existsSync(archived)) writeFileSync(archived, JSON.stringify(previous, null, 2) + '\n');
  console.log(`--fresh: previous deployment archived as ${archived}`);
}
const deployed = previous && (!fresh || resuming) ? previous : {};
if (fresh && previous && !resuming) deployed.migratedFrom = { NodeStake: previous.NodeStake?.address ?? null, EpochAnchor: previous.EpochAnchor?.address ?? null, ERC6699Registry: previous.ERC6699Registry?.address ?? null, NodeDirectory: previous.NodeDirectory?.address ?? null, deployedAt: previous.deployedAt ?? null };
if (resuming) console.log(`--fresh: resuming the v2 deployment already in ${outPath}`);

/** Caldera's gateway answers 502 now and then. Every chain call and every
 *  transaction is retried a few times rather than abandoning the run; a
 *  deploy that already landed is skipped on re-run (see deploy()). */
const retry = async (label, fn, tries = 6) => {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      // BAD_DATA with an empty result: the gateway routed the eth_call to a
      // node that has not seen the contract we just deployed — a lag, not a bug.
      const transient = e?.code === 'SERVER_ERROR' || e?.code === 'TIMEOUT' || e?.code === 'NETWORK_ERROR' || (e?.code === 'BAD_DATA' && e?.value === '0x') || /502|503|504|ECONNRESET|fetch failed/i.test(e?.message ?? '');
      if (!transient || i >= tries) throw e;
      console.log(`${label}: ${e.shortMessage ?? e.message} — retry ${i}/${tries - 1} in ${3 * i}s`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
};
const save = () => writeFileSync(outPath, JSON.stringify(deployed, null, 2) + '\n');

const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
const wallet = new ethers.Wallet(key, provider);
const balance = await retry('balance', () => provider.getBalance(wallet.address));
console.log(`deployer ${wallet.address} · ${ethers.formatEther(balance)} zkLTC · chain ${(await retry('network', () => provider.getNetwork())).chainId}`);
if (balance === 0n) { console.error('no zkLTC for gas — use the faucet first'); process.exit(1); }

// ---------------------------------------------------------------- compile
const files = ['TestLITVM.sol', 'NodeStake.sol', 'ERC6699Registry.sol', 'EpochAnchor.sol', 'PlayerProfile.sol', 'NodeBadge.sol', 'NodeDirectory.sol', 'ReleaseRegistry.sol', 'MatchBook.sol', 'TitleRegistry.sol'];
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
  const c = await retry(`${label}: deploy`, () => factory.deploy(...args));
  const receipt = await retry(`${label}: receipt`, () => c.deploymentTransaction().wait());
  deployed[label] = { address: await c.getAddress(), tx: receipt.hash, block: receipt.blockNumber, args: args.map(String) };
  save();
  console.log(`${label}: deployed at ${deployed[label].address} (tx ${receipt.hash})`);
  return c;
};

// ---------------------------------------------------------------- --only: add contracts to an EXISTING deployment
// --only TitleRegistry[,ReleaseRegistry,PlayerProfile,ERC6699Registry]: deploy just
// those, each with its own constructor args, and leave NodeStake and everything
// keyed on it alone. Adding a contract must not become a migration.
if (argv.includes('--only')) {
  const wanted = String(argv[argv.indexOf('--only') + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const admin = cfg.admin && /^0x[0-9a-fA-F]{40}$/.test(cfg.admin) ? cfg.admin : wallet.address;
  const standalone = {
    TitleRegistry: () => deploy('TitleRegistry', 'TitleRegistry.sol', 'TitleRegistry', [BigInt(cfg.TitleRegistry?.activationDelay ?? 60)]).then(() => { deployed.TitleRegistry.activationDelay = Number(cfg.TitleRegistry?.activationDelay ?? 60); }),
    ReleaseRegistry: () => deploy('ReleaseRegistry', 'ReleaseRegistry.sol', 'ReleaseRegistry', [admin, BigInt(cfg.ReleaseRegistry?.activationDelay ?? 60)]).then(() => { deployed.ReleaseRegistry.activationDelay = Number(cfg.ReleaseRegistry?.activationDelay ?? 60); deployed.ReleaseRegistry.admin = admin; }),
    PlayerProfile: () => deploy('PlayerProfile', 'PlayerProfile.sol', 'PlayerProfile'),
    ERC6699Registry: () => deploy('ERC6699Registry', 'ERC6699Registry.sol', 'ERC6699Registry', [admin]),
  };
  const bad = wanted.filter((w) => !standalone[w]);
  if (!wanted.length || bad.length) { console.error(`--only takes a comma list of: ${Object.keys(standalone).join(', ')}${bad.length ? ` (not ${bad.join(', ')} — those depend on NodeStake; run without --only or with --fresh)` : ''}`); process.exit(1); }
  for (const w of wanted) { await standalone[w](); save(); }
  deployed.chainId ??= cfg.chainId; deployed.rpc ??= cfg.rpc; deployed.deployer ??= wallet.address;
  save();
  console.log(`
wrote ${outPath} — ${wanted.join(', ')} added; nothing else touched`);
  process.exit(0);
}

// ---------------------------------------------------------------- token + faucet
const token = await deploy('TestLITVM', 'TestLITVM.sol', 'TestLITVM');
const tBal = await retry('balanceOf', () => token.balanceOf(wallet.address));
if (tBal === 0n) {
  console.log('faucet: pulling 1000 tLITVM');
  await retry('faucet', async () => (await token.faucet()).wait());
}
console.log(`tLITVM balance ${ethers.formatEther(await retry('balanceOf', () => token.balanceOf(wallet.address)))}`);

// ---------------------------------------------------------------- NodeStake
const ns = cfg.NodeStake;
const minStake = BigInt(ns.minStake);
// admin: the multisig behind a timelock when there is one; the deployer until then, said loudly.
const admin = cfg.admin && /^0x[0-9a-fA-F]{40}$/.test(cfg.admin) ? cfg.admin : wallet.address;
if (admin === wallet.address) console.warn('WARNING: admin = the deployer wallet (an EOA). Every parameter, adjudicator and release is one key until a multisig behind a timelock takes admin (BUILD-SPEC v0.3 §2.3). /health will say admin: eoa.');
const stake = await deploy('NodeStake', 'NodeStake.sol', 'NodeStake', [
  await token.getAddress(), minStake, BigInt(ns.lockTerm), BigInt(ns.eligibilityAge), BigInt(ns.unbondingPeriod), admin, cfg.treasury && /^0x[0-9a-fA-F]{40}$/.test(cfg.treasury) ? cfg.treasury : wallet.address,
]);
deployed.NodeStake.minStake = ns.minStake;
deployed.NodeStake.lockTerm = ns.lockTerm;
deployed.NodeStake.eligibilityAge = ns.eligibilityAge;
deployed.NodeStake.unbondingPeriod = ns.unbondingPeriod;
deployed.NodeStake.admin = admin;
save();

// ---------------------------------------------------------------- ERC-6699 + EpochAnchor
// v2: the deployer is admin of both (names minters/progressors, sets quorum); hand admin over with transferAdmin / setParams later.
await deploy('ERC6699Registry', 'ERC6699Registry.sol', 'ERC6699Registry', [admin]);
deployed.ERC6699Registry.version = 2;
await deploy('EpochAnchor', 'EpochAnchor.sol', 'EpochAnchor', [await stake.getAddress(), quorum, admin]);
deployed.EpochAnchor.version = 3; deployed.EpochAnchor.quorumBps = quorum;
deployed.NodeStake.version = 3;
// the node reads the registry from here (ERC6699 in node.env overrides)
deployed.ERC6699RegistryV2 = { address: deployed.ERC6699Registry.address };
// ---------------------------------------------------------------- identity: player profiles + node badges (docs/WALLET-IDENTITY.md)
await deploy('PlayerProfile', 'PlayerProfile.sol', 'PlayerProfile');
await deploy('NodeBadge', 'NodeBadge.sol', 'NodeBadge', [await stake.getAddress()]);
// ---------------------------------------------------------------- discovery: the seed list on chain (docs, "decentralized bootstrap")
await deploy('NodeDirectory', 'NodeDirectory.sol', 'NodeDirectory', [await stake.getAddress()]);
// ---------------------------------------------------------------- releases: which builds a node may run, and from when (§2.4)
await deploy('ReleaseRegistry', 'ReleaseRegistry.sol', 'ReleaseRegistry', [admin, BigInt(cfg.ReleaseRegistry?.activationDelay ?? 60)]);
deployed.ReleaseRegistry.activationDelay = Number(cfg.ReleaseRegistry?.activationDelay ?? 60);
deployed.ReleaseRegistry.admin = admin;
save();
// ---------------------------------------------------------------- TitleRegistry: titles as ERC-721s, holder = publisher; no admin at all
await deploy('TitleRegistry', 'TitleRegistry.sol', 'TitleRegistry', [BigInt(cfg.TitleRegistry?.activationDelay ?? 60)]);
deployed.TitleRegistry.activationDelay = Number(cfg.TitleRegistry?.activationDelay ?? 60);
save();
// ---------------------------------------------------------------- MatchBook: every ranked match on chain (§11.2); an adjudicator on NodeStake
const mbc = cfg.MatchBook ?? {};
const mbParams = { settleWindow: BigInt(mbc.settleWindowS ?? 60), attestWindow: BigInt(mbc.attestWindowS ?? 120), escalationWindow: BigInt(mbc.escalationWindowS ?? 300), drawDelay: BigInt(mbc.drawDelayBlocks ?? 2), hostSlashBps: Number(mbc.hostSlashBps ?? 1000), witnessSlashBps: Number(mbc.witnessSlashBps ?? 500) };
const matchBook = await deploy('MatchBook', 'MatchBook.sol', 'MatchBook', [await stake.getAddress(), mbParams, admin]);
Object.assign(deployed.MatchBook, { settleWindowS: Number(mbParams.settleWindow), attestWindowS: Number(mbParams.attestWindow), escalationWindowS: Number(mbParams.escalationWindow), drawDelayBlocks: Number(mbParams.drawDelay), hostSlashBps: mbParams.hostSlashBps, witnessSlashBps: mbParams.witnessSlashBps, admin });
save();
const matchBookAddr = await matchBook.getAddress();
if (admin === wallet.address) {
  if (!(await retry('adjudicators', () => stake.adjudicators(matchBookAddr)))) {
    await retry('setAdjudicator', async () => (await stake.setAdjudicator(matchBookAddr, true)).wait());
    console.log(`MatchBook named an adjudicator on NodeStake`);
  }
} else console.log(`admin is ${admin}: it must call NodeStake.setAdjudicator(${matchBookAddr}, true) for MatchBook to slash`);

// ---------------------------------------------------------------- bond the first node
const dataDir = process.env.LITNODE_DATA ?? join(root, 'data', 'node-1');
mkdirSync(dataDir, { recursive: true });
const idPath = join(dataDir, 'identity.json');
const identity = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : await generateKeypair();
if (!existsSync(idPath)) writeFileSync(idPath, JSON.stringify(identity, null, 2) + '\n');
const nodeKey = nodeKeyBytes32(identity.publicKey);
const [, , active] = await retry('standingOf', () => stake.standingOf(nodeKey));
if (!active) {
  console.log(`bonding ${ethers.formatEther(minStake)} tLITVM behind node ${identity.publicKey.slice(0, 16)}…`);
  await retry('approve', async () => (await token.approve(await stake.getAddress(), minStake)).wait());
  await retry('stake', async () => (await stake.stake(nodeKey, minStake)).wait());
}
const standing = await retry('standingOf', () => stake.standingOf(nodeKey));
const info = await retry('nodeOf', () => stake.nodeOf(nodeKey));
console.log(`node ${identity.publicKey.slice(0, 16)}… operator ${standing[0]} bonded ${ethers.formatEther(standing[1])} active ${standing[2]} · locked until ${new Date(Number(info[3] + BigInt(ns.lockTerm)) * 1000).toISOString()} · witness-eligible from ${new Date(Number(info[3] + BigInt(ns.eligibilityAge)) * 1000).toISOString()}`);
console.log('next for this node: set its delegate (the hot key it runs with): npm run delegate -- <nodeId> <address>');
deployed.firstNode = { nodeId: identity.publicKey, bonded: ethers.formatEther(standing[1]) };
deployed.chainId = cfg.chainId;
deployed.rpc = cfg.rpc;
deployed.deployedAt = new Date().toISOString();
save();
deployed.deployer = wallet.address;
save();
console.log(`\nwrote ${outPath}`);
console.log('next: cabinet/config.js CHAIN addresses, then `npm run authority` to snapshot who holds what.');
console.log(`explorer: https://liteforge.explorer.caldera.xyz/address/${deployed.NodeStake.address}`);
