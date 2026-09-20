/** Name a node's DELEGATE on NodeStake v3 — the hot EVM key the node process
 *  runs with (gas only, never the bond; BUILD-SPEC v0.3 §2.2) — and give it
 *  gas. YOU run this, with the OPERATOR key (the wallet that bonded the
 *  node) in the environment only.
 *
 *    set OPERATOR_KEY=0x...            (DEPLOYER_KEY still accepted)
 *    node tools/delegate.mjs <nodeId> <delegateAddress> [--fund 0.005]
 *    node tools/delegate.mjs <nodeId> --clear
 *
 *  The node's announcer address (/health.directory.announcer, kept in
 *  <dataDir>/announcer.json) is the natural delegate: one hot key the
 *  operator already funds. A leaked delegate is rotated by running this
 *  again with a new address; the bond, the node key and its history stay.
 *
 *  Uses the protocol's own signer (protocol/evm.js) and one JSON-RPC call at
 *  a time with retries, like tools/set-announcer.mjs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressOf, signTransaction } from '../protocol/evm.js';
import { setDelegateCalldata, nodeOfCall, decodeNode } from '../protocol/staking.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const args = process.argv.slice(2);
const [nodeId, delegateArg] = args.filter((a) => !a.startsWith('--'));
const clear = args.includes('--clear');
const fund = args.includes('--fund') ? args[args.indexOf('--fund') + 1] : null;
const ZERO = '0x0000000000000000000000000000000000000000';
const delegate = clear ? ZERO : delegateArg;
const rawKey = (process.env.OPERATOR_KEY ?? process.env.DEPLOYER_KEY ?? '').trim();
const key = /^(0x)?[0-9a-fA-F]{64}$/.test(rawKey) ? (rawKey.startsWith('0x') ? rawKey : '0x' + rawKey) : null;
if (!key) { console.error('OPERATOR_KEY not set (expected 64 hex characters, with or without 0x)'); process.exit(1); }
if (!deployed.NodeStake?.address) { console.error('NodeStake not deployed — run npm run deploy:testnet'); process.exit(1); }
if ((deployed.NodeStake.version ?? 1) < 3) { console.error('NodeStake v2 is deployed; delegates are a v3 feature. Migrate first: contracts/MIGRATION.md (v2 -> v3)'); process.exit(1); }
if (!/^[0-9a-f]{64}$/i.test(nodeId ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(delegate ?? '')) { console.error('usage: node tools/delegate.mjs <nodeId 64 hex> <delegate 0x...> [--fund <zkLTC>] | --clear'); process.exit(1); }

const from = addressOf(key);
const stake = deployed.NodeStake.address;
const chainId = BigInt(deployed.chainId);
let id = 0;
async function rpc(method, params, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(deployed.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { final: true });
      return j.result;
    } catch (e) {
      if (e.final || i >= tries - 1) throw e;
      const wait = 1500 * (i + 1);
      console.log(`  ${method}: ${e.message} — retrying in ${wait / 1000}s`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}
const wei = (zk) => BigInt(Math.round(Number(zk) * 1e6)) * 10n ** 12n;
const fmt = (w) => (Number(BigInt(w) / 10n ** 12n) / 1e6).toString();
async function send({ to, data = '0x', value = 0n }) {
  const [nonce, gasPrice, gas] = await Promise.all([rpc('eth_getTransactionCount', [from, 'pending']), rpc('eth_gasPrice', []), rpc('eth_estimateGas', [{ from, to, data, value: '0x' + value.toString(16) }])]);
  const raw = signTransaction({ nonce: BigInt(nonce), gasPrice: BigInt(gasPrice) * 12n / 10n, gasLimit: BigInt(gas) * 13n / 10n, to, value, data, chainId }, key);
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  for (let i = 0; i < 60; i++) { const rc = await rpc('eth_getTransactionReceipt', [hash]); if (rc) { if (rc.status !== '0x1') throw new Error(`tx ${hash} reverted`); return hash; } await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`tx ${hash} not mined in 60 s`);
}

try {
  console.log(`operator ${from} · ${fmt(await rpc('eth_getBalance', [from, 'latest']))} zkLTC · NodeStake v3 ${stake}`);
  const before = decodeNode(await rpc('eth_call', [nodeOfCall(stake, nodeId), 'latest']));
  if (!before.operator) { console.error(`node ${nodeId.slice(0, 12)}… is not bonded on this NodeStake`); process.exit(1); }
  if (before.operator.toLowerCase() !== from.toLowerCase()) { console.error(`node ${nodeId.slice(0, 12)}… is bonded by ${before.operator}, not by this key`); process.exit(1); }
  if ((before.delegate ?? ZERO).toLowerCase() === delegate.toLowerCase()) console.log(`delegate already ${clear ? 'cleared' : delegate}`);
  else { const h = await send({ to: stake, data: setDelegateCalldata(nodeId, delegate) }); console.log(`${clear ? 'cleared the delegate of' : `delegated ${delegate} for`} node ${nodeId.slice(0, 12)}… (tx ${h})`); }
  if (fund && !clear) { const h = await send({ to: delegate, value: wei(fund) }); console.log(`sent ${fund} zkLTC to ${delegate} (tx ${h})`); }
  const after = decodeNode(await rpc('eth_call', [nodeOfCall(stake, nodeId), 'latest']));
  console.log(`bond: ${fmt(after.amount)} tLITVM · since ${new Date(after.bondedSince * 1000).toISOString()} · active ${after.active} · witness-eligible ${after.eligible} · delegate ${after.delegate ?? 'unset'}`);
  if (after.delegate) console.log(`delegate balance ${fmt(await rpc('eth_getBalance', [after.delegate, 'latest']))} zkLTC`);
} catch (e) { const m = String(e?.message ?? e); console.error('✗ ' + m + (/revert/i.test(m) ? ' (a revert here usually means OPERATOR_KEY is not the wallet that bonded this node)' : '')); process.exit(1); }
