/** Register or revoke a litnode release on ReleaseRegistry (BUILD-SPEC v0.3
 *  §2.4). YOU run this as the registry's ADMIN — the multisig, or on testnet
 *  the deployer — with the key in the environment only.
 *
 *    set ADMIN_KEY=0x...               (DEPLOYER_KEY still accepted)
 *    node tools/release-registry.mjs register <release.json | zipHash> [--activates <ISO time>] [--version <label>]
 *    node tools/release-registry.mjs revoke   <release.json | zipHash>
 *    node tools/release-registry.mjs status   <release.json | zipHash>
 *
 *  Given a signed release.json (tools/release.mjs writes one), every zip it
 *  names is registered under its sha256, with the manifest's version and
 *  protocol. Without --activates, activatesAt = now + the registry's
 *  activationDelay — the earliest the contract allows. With a multisig the
 *  calldata is what you paste into it: --calldata prints it and sends
 *  nothing. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressOf, signTransaction } from '../protocol/evm.js';
import { statusOfCall, decodeStatus, registerCalldata, revokeCalldata, activationDelayCall, decodeUint } from '../protocol/release.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const optValues = new Set(['--activates', '--version'].map(opt).filter(Boolean));
const [cmd, target] = args.filter((a) => !a.startsWith('--') && !optValues.has(a));
const calldataOnly = args.includes('--calldata');
if (!['register', 'revoke', 'status'].includes(cmd) || !target) { console.error('usage: node tools/release-registry.mjs register|revoke|status <release.json | zipHash> [--activates <ISO>] [--version <label>] [--calldata]'); process.exit(1); }
if (!deployed.ReleaseRegistry?.address) { console.error('ReleaseRegistry not deployed — run npm run deploy:testnet'); process.exit(1); }
const reg = deployed.ReleaseRegistry.address;

/** What to act on: [{ zipHash, version, protocol, name }] */
const items = (() => {
  if (/^(0x)?[0-9a-f]{64}$/i.test(target)) return [{ zipHash: target.replace(/^0x/, '').toLowerCase(), version: opt('--version') ?? '', protocol: PROTOCOL_VERSION, name: target }];
  if (!existsSync(target)) { console.error(`${target}: not a zip hash and not a file`); process.exit(1); }
  const env = JSON.parse(readFileSync(target, 'utf8'));
  const body = env.body ?? env;
  if (!body.files) { console.error(`${target}: no files in the manifest`); process.exit(1); }
  return Object.entries(body.files).map(([name, f]) => ({ zipHash: f.sha256, version: body.version, protocol: body.protocol ?? PROTOCOL_VERSION, name }));
})();

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
const show = (it, st) => console.log(`${it.name}: ${st.registered ? `${st.revoked ? 'REVOKED' : st.active ? 'active' : 'pending'} · ${st.version} · activates ${new Date(st.activatesAt * 1000).toISOString()}` : 'not registered'}`);

async function main() {
try {
  if (cmd === 'status') { for (const it of items) show(it, decodeStatus(await rpc('eth_call', [statusOfCall(reg, it.zipHash), 'latest']))); return; }
  const delay = Number(decodeUint(await rpc('eth_call', [activationDelayCall(reg), 'latest'])));
  const activates = opt('--activates') ? Math.floor(Date.parse(opt('--activates')) / 1000) : Math.floor(Date.now() / 1000) + delay + 30; // + a little for mining
  const rawKey = (process.env.ADMIN_KEY ?? process.env.DEPLOYER_KEY ?? '').trim();
  const key = /^(0x)?[0-9a-fA-F]{64}$/.test(rawKey) ? (rawKey.startsWith('0x') ? rawKey : '0x' + rawKey) : null;
  for (const it of items) {
    const data = cmd === 'register' ? registerCalldata(it.zipHash, it.version, it.protocol, activates) : revokeCalldata(it.zipHash);
    if (calldataOnly) { console.log(`${it.name} -> to ${reg}\n${data}`); continue; }
    if (!key) { console.error('ADMIN_KEY not set (or pass --calldata to print what the multisig should send)'); process.exitCode = 1; return; }
    const from = addressOf(key), chainId = BigInt(deployed.chainId);
    const cur = decodeStatus(await rpc('eth_call', [statusOfCall(reg, it.zipHash), 'latest']));
    if (cmd === 'register' && cur.registered) { console.log(`${it.name}: already registered`); show(it, cur); continue; }
    if (cmd === 'revoke' && (!cur.registered || cur.revoked)) { console.log(`${it.name}: ${cur.registered ? 'already revoked' : 'not registered'}`); continue; }
    const nonce = await rpc('eth_getTransactionCount', [from, 'pending']); const gasPrice = await rpc('eth_gasPrice', []); const gas = await rpc('eth_estimateGas', [{ from, to: reg, data }]);
    const raw = signTransaction({ nonce: BigInt(nonce), gasPrice: BigInt(gasPrice) * 12n / 10n, gasLimit: BigInt(gas) * 13n / 10n, to: reg, value: 0n, data, chainId }, key);
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    let rc = null;
    for (let i = 0; i < 60 && !rc; i++) { try { rc = await rpc('eth_getTransactionReceipt', [hash], 1); } catch { /* 429 or a blip: the tx is out, ask again */ } if (!rc) await new Promise((r) => setTimeout(r, 2000)); }
    if (!rc || rc.status !== '0x1') throw new Error(`tx ${hash} ${rc ? 'reverted' : 'not confirmed in 120 s — it may still land; check the explorer before re-sending'}`);
    console.log(`${cmd === 'register' ? 'registered' : 'revoked'} ${it.name} (tx ${hash})`);
    show(it, decodeStatus(await rpc('eth_call', [statusOfCall(reg, it.zipHash), 'latest'])));
  }
} catch (e) { const m = String(e?.message ?? e); console.error('✗ ' + m + (/revert/i.test(m) ? ' (a revert here usually means the key is not the registry admin, or activatesAt is inside the delay)' : '')); process.exitCode = 1; }
}
await main();
