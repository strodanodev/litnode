/** Enrol a node in MatchBook's witness pool — the set the nine-seat
 *  escalation panel is drawn from (BUILD-SPEC v0.3 §11.3) — or leave it.
 *  YOU run this with the OPERATOR key (or the node's delegate key) in the
 *  environment only; MatchBook accepts either for the node key.
 *
 *    set OPERATOR_KEY=0x...            (DEPLOYER_KEY still accepted)
 *    node tools/enroll.mjs <nodeId>
 *    node tools/enroll.mjs <nodeId> --leave
 *    node tools/enroll.mjs --list
 *
 *  The first-panel draw (three seats) needs no enrolment — placement draws
 *  it from the bonded, witness-eligible mesh. Enrolment is for the nine. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressOf, signTransaction } from '../protocol/evm.js';
import { enrollCalldata, withdrawCalldata } from '../protocol/matchbook.js';
import { selector } from '../protocol/keccak.js';
import { decodeBytes32Array } from '../protocol/abi.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const args = process.argv.slice(2);
const nodeId = args.find((a) => !a.startsWith('--'));
const leave = args.includes('--leave'), list = args.includes('--list');
if (!deployed.MatchBook?.address) { console.error('MatchBook not deployed — run npm run deploy:testnet'); process.exit(1); }
const book = deployed.MatchBook.address;
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
const pool = async () => decodeBytes32Array(await rpc('eth_call', [{ to: book, data: selector('pool()') }, 'latest']));

async function main() {
try {
  if (list || !nodeId) {
    const p = await pool();
    console.log(`MatchBook ${book} · ${p.length} enrolled`);
    for (const k of p) console.log(`  ${k}`);
    if (!list) console.error('usage: node tools/enroll.mjs <nodeId 64 hex> [--leave] | --list');
    process.exitCode = list ? 0 : 1; return;
  }
  if (!/^[0-9a-f]{64}$/i.test(nodeId)) { console.error('nodeId must be 64 hex characters'); process.exit(1); }
  const rawKey = (process.env.OPERATOR_KEY ?? process.env.DEPLOYER_KEY ?? '').trim();
  const key = /^(0x)?[0-9a-fA-F]{64}$/.test(rawKey) ? (rawKey.startsWith('0x') ? rawKey : '0x' + rawKey) : null;
  if (!key) { console.error('OPERATOR_KEY not set (the wallet that bonded the node, or its delegate)'); process.exit(1); }
  const from = addressOf(key);
  const before = await pool();
  const isIn = before.includes(nodeId.toLowerCase());
  if (leave === false && isIn) { console.log(`node ${nodeId.slice(0, 12)}… already enrolled`); return; }
  if (leave && !isIn) { console.log(`node ${nodeId.slice(0, 12)}… is not enrolled`); return; }
  const data = leave ? withdrawCalldata(nodeId) : enrollCalldata(nodeId);
  const [nonce, gasPrice, gas] = await Promise.all([rpc('eth_getTransactionCount', [from, 'pending']), rpc('eth_gasPrice', []), rpc('eth_estimateGas', [{ from, to: book, data }])]);
  const raw = signTransaction({ nonce: BigInt(nonce), gasPrice: BigInt(gasPrice) * 12n / 10n, gasLimit: BigInt(gas) * 13n / 10n, to: book, value: 0n, data, chainId }, key);
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  let rc = null;
  for (let i = 0; i < 60 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [hash]); if (!rc) await new Promise((r) => setTimeout(r, 1000)); }
  if (!rc || rc.status !== '0x1') throw new Error(`tx ${hash} ${rc ? 'reverted' : 'not mined in 60 s'}`);
  console.log(`${leave ? 'left' : 'enrolled'} node ${nodeId.slice(0, 12)}… ${leave ? 'from' : 'in'} the MatchBook witness pool (tx ${hash})`);
  console.log(`pool now: ${(await pool()).length} node(s)`);
} catch (e) { const m = String(e?.message ?? e); console.error('✗ ' + m + (/revert/i.test(m) ? ' (a revert here usually means the key is neither the operator nor the delegate of this node)' : '')); process.exitCode = 1; }
}
await main();
