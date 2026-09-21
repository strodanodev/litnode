/** Apply contracts/deploy.testnet.json's parameters to the LIVE MatchBook
 *  and NodeStake (admin only — the deployer on testnet, the multisig later;
 *  --calldata prints what the multisig should send). Refuses a set where
 *  NodeStake.unbondingPeriod does not exceed MatchBook.totalWindow().
 *
 *    set DEPLOYER_KEY=0x...            (ADMIN_KEY also accepted)
 *    node tools/params.mjs             show live vs configured, apply the difference
 *    node tools/params.mjs --show      show only
 *    node tools/params.mjs --calldata  print the two setParams calls, send nothing
 *
 *  Why this exists: the first real ranked match (21 Sep 2026) showed a
 *  60-second settle window — commit happens at placement, a human match
 *  lasts minutes. Windows are seconds. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'contracts', 'deploy.testnet.json'), 'utf8'));
const outPath = join(root, 'contracts', 'deployed.testnet.json');
const deployed = JSON.parse(readFileSync(outPath, 'utf8'));
const args = process.argv.slice(2);
const show = args.includes('--show'), calldataOnly = args.includes('--calldata');
if (!deployed.MatchBook?.address || (deployed.NodeStake?.version ?? 1) < 3) { console.error('generation 3 (NodeStake v3 + MatchBook) is not deployed'); process.exit(1); }

const want = {
  book: { settleWindow: BigInt(cfg.MatchBook.settleWindowS), attestWindow: BigInt(cfg.MatchBook.attestWindowS), escalationWindow: BigInt(cfg.MatchBook.escalationWindowS), drawDelay: BigInt(cfg.MatchBook.drawDelayBlocks ?? 2), hostSlashBps: Number(cfg.MatchBook.hostSlashBps), witnessSlashBps: Number(cfg.MatchBook.witnessSlashBps) },
  stake: { minStake: BigInt(cfg.NodeStake.minStake), lockTerm: BigInt(cfg.NodeStake.lockTerm), eligibilityAge: BigInt(cfg.NodeStake.eligibilityAge), unbondingPeriod: BigInt(cfg.NodeStake.unbondingPeriod) },
};
const total = want.book.settleWindow + 2n * want.book.attestWindow + 2n * want.book.escalationWindow;
if (want.stake.unbondingPeriod <= total) { console.error(`NodeStake.unbondingPeriod (${want.stake.unbondingPeriod}s) must exceed MatchBook.totalWindow() (${total}s): fix contracts/deploy.testnet.json first`); process.exit(1); }

const bookAbi = ['function params() view returns (uint64 settleWindow, uint64 attestWindow, uint64 escalationWindow, uint64 drawDelay, uint16 hostSlashBps, uint16 witnessSlashBps)', 'function admin() view returns (address)', 'function stake() view returns (address)', 'function setParams(address stake_, (uint64 settleWindow, uint64 attestWindow, uint64 escalationWindow, uint64 drawDelay, uint16 hostSlashBps, uint16 witnessSlashBps) p, address admin_)'];
const stakeAbi = ['function minStake() view returns (uint256)', 'function lockTerm() view returns (uint64)', 'function eligibilityAge() view returns (uint64)', 'function unbondingPeriod() view returns (uint64)', 'function admin() view returns (address)', 'function treasury() view returns (address)', 'function setParams(uint256 minStake_, uint64 lockTerm_, uint64 eligibilityAge_, uint64 unbondingPeriod_, address admin_, address treasury_)'];
const { ethers: E } = await import('ethers');
const provider = new E.JsonRpcProvider(deployed.rpc, deployed.chainId);
const book = new E.Contract(deployed.MatchBook.address, bookAbi, provider);
const stake = new E.Contract(deployed.NodeStake.address, stakeAbi, provider);
const retry = async (fn, tries = 6) => { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 2000 * i)); } } };

const live = { book: await retry(() => book.params()), stake: { minStake: await retry(() => stake.minStake()), lockTerm: await retry(() => stake.lockTerm()), eligibilityAge: await retry(() => stake.eligibilityAge()), unbondingPeriod: await retry(() => stake.unbondingPeriod()) } };
const [bookAdmin, stakeAdmin, treasury] = await Promise.all([retry(() => book.admin()), retry(() => stake.admin()), retry(() => stake.treasury())]);
const row = (k, a, b) => console.log(`  ${k.padEnd(18)} live ${String(a).padEnd(22)} config ${String(b)}${String(a) !== String(b) ? '  ← change' : ''}`);
console.log(`MatchBook ${deployed.MatchBook.address} (admin ${bookAdmin})`);
for (const k of Object.keys(want.book)) row(k, live.book[k], want.book[k]);
console.log(`NodeStake ${deployed.NodeStake.address} (admin ${stakeAdmin}, treasury ${treasury})`);
for (const k of Object.keys(want.stake)) row(k, live.stake[k], want.stake[k]);
const bookDiff = Object.keys(want.book).some((k) => String(live.book[k]) !== String(want.book[k]));
const stakeDiff = Object.keys(want.stake).some((k) => String(live.stake[k]) !== String(want.stake[k]));
if (show || (!bookDiff && !stakeDiff)) { console.log(bookDiff || stakeDiff ? 'differences shown; run without --show to apply' : 'live parameters match the config'); process.exitCode = 0; }
else {
  const bookData = book.interface.encodeFunctionData('setParams', [await retry(() => book.stake()), want.book, bookAdmin]);
  const stakeData = stake.interface.encodeFunctionData('setParams', [want.stake.minStake, want.stake.lockTerm, want.stake.eligibilityAge, want.stake.unbondingPeriod, stakeAdmin, treasury]);
  if (calldataOnly) { if (stakeDiff) console.log(`NodeStake.setParams → ${deployed.NodeStake.address}\n${stakeData}`); if (bookDiff) console.log(`MatchBook.setParams → ${deployed.MatchBook.address}\n${bookData}`); }
  else {
    const key = (process.env.ADMIN_KEY ?? process.env.DEPLOYER_KEY ?? '').trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) { console.error('DEPLOYER_KEY (the admin) not set, or pass --calldata'); process.exit(1); }
    const wallet = new E.Wallet(key.startsWith('0x') ? key : '0x' + key, provider);
    if (wallet.address.toLowerCase() !== stakeAdmin.toLowerCase() && stakeDiff) { console.error(`this key is ${wallet.address}, NodeStake's admin is ${stakeAdmin}`); process.exit(1); }
    if (wallet.address.toLowerCase() !== bookAdmin.toLowerCase() && bookDiff) { console.error(`this key is ${wallet.address}, MatchBook's admin is ${bookAdmin}`); process.exit(1); }
    // the stake period first, so the invariant holds at every step
    if (stakeDiff) { const tx = await retry(() => wallet.sendTransaction({ to: deployed.NodeStake.address, data: stakeData })); const rc = await tx.wait(); console.log(`NodeStake.setParams: tx ${rc.hash}`); }
    if (bookDiff) { const tx = await retry(() => wallet.sendTransaction({ to: deployed.MatchBook.address, data: bookData })); const rc = await tx.wait(); console.log(`MatchBook.setParams: tx ${rc.hash}`); }
    Object.assign(deployed.MatchBook, { settleWindowS: Number(want.book.settleWindow), attestWindowS: Number(want.book.attestWindow), escalationWindowS: Number(want.book.escalationWindow), drawDelayBlocks: Number(want.book.drawDelay), hostSlashBps: want.book.hostSlashBps, witnessSlashBps: want.book.witnessSlashBps });
    Object.assign(deployed.NodeStake, { minStake: String(want.stake.minStake), lockTerm: Number(want.stake.lockTerm), eligibilityAge: Number(want.stake.eligibilityAge), unbondingPeriod: Number(want.stake.unbondingPeriod) });
    writeFileSync(outPath, JSON.stringify(deployed, null, 2) + '\n');
    console.log(`wrote ${outPath} — nodes read the windows from it on restart (or the next release)`);
  }
}
void ethers;
