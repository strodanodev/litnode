/** Delegate a node's announcer on NodeDirectory and give it gas. YOU run
 *  this, with the operator key in the environment only.
 *
 *    set DEPLOYER_KEY=0x...
 *    node tools/set-announcer.mjs <nodeId> <announcerAddress> [--fund 0.005]
 *
 *  The node prints its announcer address on /health.directory.announcer
 *  (and in its dashboard) — a key it generated itself and keeps in
 *  <dataDir>/announcer.json. After this, the node publishes its own tunnel
 *  URL on chain whenever it changes; the operator key never touches it.
 *
 *  Uses the protocol's own signer (protocol/evm.js) and one JSON-RPC call at
 *  a time with retries: Liteforge's gateway answers 502 now and then, and a
 *  batching client that quits on the first one never gets through. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressOf, signTransaction } from '../protocol/evm.js';
import { setAnnouncerCalldata, announcerOfCall, entryOfCall, decodeAddress, decodeEntry } from '../protocol/directory.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const [nodeId, announcer] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fund = process.argv.includes('--fund') ? process.argv[process.argv.indexOf('--fund') + 1] : null;
const rawKey = (process.env.DEPLOYER_KEY ?? '').trim();
const key = /^(0x)?[0-9a-fA-F]{64}$/.test(rawKey) ? (rawKey.startsWith('0x') ? rawKey : '0x' + rawKey) : null;
if (!key) { console.error('DEPLOYER_KEY not set (expected 64 hex characters, with or without 0x)'); process.exit(1); }
if (!deployed.NodeDirectory?.address) { console.error('NodeDirectory not deployed — run npm run deploy:testnet'); process.exit(1); }
if (!/^[0-9a-f]{64}$/i.test(nodeId ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(announcer ?? '')) { console.error('usage: node tools/set-announcer.mjs <nodeId 64 hex> <announcer 0x…> [--fund <zkLTC>]'); process.exit(1); }

const from = addressOf(key);
const dir = deployed.NodeDirectory.address;
const chainId = BigInt(deployed.chainId);
let id = 0;
/** One request, retried on gateway errors. */
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
  const nonce = await rpc('eth_getTransactionCount', [from, 'pending']); const gasPrice = await rpc('eth_gasPrice', []); const gas = await rpc('eth_estimateGas', [{ from, to, data, value: '0x' + value.toString(16) }]);
  const raw = signTransaction({ nonce: BigInt(nonce), gasPrice: BigInt(gasPrice) * 12n / 10n, gasLimit: BigInt(gas) * 13n / 10n, to, value, data, chainId }, key);
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  for (let i = 0; i < 60; i++) { let rc = null; try { rc = await rpc('eth_getTransactionReceipt', [hash], 1); } catch { /* 429 or a blip: the tx is out, ask again */ } if (rc) { if (rc.status !== '0x1') throw new Error(`tx ${hash} reverted`); return hash; } await new Promise((r) => setTimeout(r, 2000)); }
  throw new Error(`tx ${hash} not confirmed in 120 s — it may still land; check the explorer before re-sending`);
}

try {
  console.log(`operator ${from} · ${fmt(await rpc('eth_getBalance', [from, 'latest']))} zkLTC · NodeDirectory ${dir}`);
  const cur = decodeAddress(await rpc('eth_call', [announcerOfCall(dir, nodeId), 'latest']));
  if (cur.toLowerCase() === announcer.toLowerCase()) console.log(`announcer already ${announcer}`);
  else { const h = await send({ to: dir, data: setAnnouncerCalldata(nodeId, announcer) }); console.log(`delegated ${announcer} for node ${nodeId.slice(0, 12)}… (tx ${h})`); }
  if (fund) { const h = await send({ to: announcer, value: wei(fund) }); console.log(`sent ${fund} zkLTC to ${announcer} (tx ${h})`); }
  console.log(`announcer balance ${fmt(await rpc('eth_getBalance', [announcer, 'latest']))} zkLTC`);
  const e = decodeEntry(await rpc('eth_call', [entryOfCall(dir, nodeId), 'latest']));
  console.log(`current entry: ${e.url || '(none yet — the node announces on its next directory cycle)'} ${e.wsAddr || ''} ${e.updatedAt ? new Date(e.updatedAt * 1000).toISOString() : ''}`);
} catch (e) { const m = String(e?.message ?? e); console.error('✗ ' + m + (/revert/i.test(m) ? ' (a revert here usually means DEPLOYER_KEY is not the wallet that bonded this node)' : '')); process.exit(1); }
