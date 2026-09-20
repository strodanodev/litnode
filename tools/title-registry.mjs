/** Publish a title on TitleRegistry — claim its rulesetId as an ERC-721,
 *  add or revoke builds, hand it over. YOU run this as the PUBLISHER: the
 *  wallet that will hold the title (and bond the host that lists it), with
 *  the key in the environment only.
 *
 *    set PUBLISHER_KEY=0x...            (OPERATOR_KEY / DEPLOYER_KEY still accepted)
 *    node tools/title-registry.mjs register  <rulesets/<id>.js | rulesetId --build <hash>>
 *    node tools/title-registry.mjs set-build <rulesets/<id>.js | rulesetId --build <hash>> [--activates <ISO time>]
 *    node tools/title-registry.mjs revoke    <rulesets/<id>.js | rulesetId --build <hash>>
 *    node tools/title-registry.mjs transfer  <rulesets/<id>.js | rulesetId> <to address>
 *    node tools/title-registry.mjs status    <rulesets/<id>.js | rulesetId>
 *
 *  Given a ruleset file, the build hash is H('ruleset', bytes) of the file —
 *  the hash every node pins and the one the sidecar .json carries. The
 *  first build activates at once; a later build waits the registry's
 *  activationDelay unless --activates names a later time. With a multisig
 *  the calldata is what you paste into it: --calldata prints it and sends
 *  nothing. `transfer` is an ERC-721 transferFrom: any wallet can do the
 *  same from its own UI — the token IS the publisher. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressOf, signTransaction } from '../protocol/evm.js';
import { h } from '../protocol/canonical.js';
import { buildStatusCall, decodeBuildStatus, titleOfCall, decodeTitle, buildsOfCall, decodeHashes, registerCalldata, setBuildCalldata, revokeBuildCalldata, transferCalldata, activationDelayCall, decodeUint, titleIdOf } from '../protocol/title.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const optValues = new Set(['--build', '--activates'].map(opt).filter(Boolean));
const positional = args.filter((a) => !a.startsWith('--') && !optValues.has(a));
const [cmd, target, extra] = positional;
const calldataOnly = args.includes('--calldata');
const usage = () => { console.error('usage: node tools/title-registry.mjs register|set-build|revoke|status <rulesets/<id>.js | rulesetId> [--build <hash>] [--activates <ISO>] [--calldata]\n       node tools/title-registry.mjs transfer <rulesets/<id>.js | rulesetId> <to> [--calldata]'); process.exit(1); };
if (!['register', 'set-build', 'revoke', 'status', 'transfer'].includes(cmd) || !target) usage();
if (!deployed.TitleRegistry?.address) { console.error('TitleRegistry not deployed — run npm run deploy:testnet'); process.exit(1); }
const reg = deployed.TitleRegistry.address;

/** The title and build this acts on. A file gives both; a bare rulesetId needs --build for the write commands. */
const it = (() => {
  if (existsSync(target)) {
    const source = readFileSync(target, 'utf8');
    const side = target.replace(/\.js$/, '.json');
    const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : {};
    const rulesetId = meta.rulesetId ?? /rulesetId:\s*["']([^"']+)["']/.exec(source)?.[1];
    if (!rulesetId) { console.error(`${target}: cannot determine rulesetId (no sidecar .json and none in source)`); process.exit(1); }
    return { rulesetId, buildHash: opt('--build') ?? h('ruleset', source), name: target };
  }
  if (/[\\/]|\.js$/.test(target)) { console.error(`${target}: no such file`); process.exit(1); }
  return { rulesetId: target, buildHash: opt('--build'), name: target };
})();
if (['register', 'set-build', 'revoke'].includes(cmd) && !it.buildHash) { console.error('--build <hash> required when the target is a rulesetId, not a file'); process.exit(1); }
if (cmd === 'transfer' && !/^0x[0-9a-fA-F]{40}$/.test(extra ?? '')) { console.error('transfer: <to> must be an address'); process.exit(1); }

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
const when = (t) => new Date(t * 1000).toISOString();
async function show() {
  const t = decodeTitle(await rpc('eth_call', [titleOfCall(reg, it.rulesetId), 'latest']));
  if (!t.publisher) { console.log(`${it.rulesetId}: not registered (titleId 0x${titleIdOf(it.rulesetId)})`); return t; }
  console.log(`${it.rulesetId}: publisher ${t.publisher} · registered ${when(t.registeredAt)} · ${t.buildCount} build${t.buildCount === 1 ? '' : 's'} · titleId 0x${titleIdOf(it.rulesetId)}`);
  for (const b of decodeHashes(await rpc('eth_call', [buildsOfCall(reg, it.rulesetId), 'latest']))) {
    const st = decodeBuildStatus(await rpc('eth_call', [buildStatusCall(reg, it.rulesetId, b), 'latest']));
    console.log(`  ${b.slice(0, 12)}… ${st.revoked ? 'REVOKED' : st.active ? 'active' : 'pending'} · activates ${when(st.activatesAt)}${it.buildHash === b ? '  ← this file' : ''}`);
  }
  return t;
}

try {
  if (cmd === 'status') { await show(); process.exit(0); }
  const rawKey = (process.env.PUBLISHER_KEY ?? process.env.OPERATOR_KEY ?? process.env.DEPLOYER_KEY ?? '').trim();
  const key = /^(0x)?[0-9a-fA-F]{64}$/.test(rawKey) ? (rawKey.startsWith('0x') ? rawKey : '0x' + rawKey) : null;
  const from = key ? addressOf(key) : null;
  let data;
  if (cmd === 'register') data = registerCalldata(it.rulesetId, it.buildHash);
  else if (cmd === 'set-build') data = setBuildCalldata(it.rulesetId, it.buildHash, opt('--activates') ? Math.floor(Date.parse(opt('--activates')) / 1000) : 0);
  else if (cmd === 'revoke') data = revokeBuildCalldata(it.rulesetId, it.buildHash);
  else if (cmd === 'transfer') {
    const cur = decodeTitle(await rpc('eth_call', [titleOfCall(reg, it.rulesetId), 'latest']));
    if (!cur.publisher) { console.error(`${it.rulesetId}: not registered`); process.exit(1); }
    data = transferCalldata(cur.publisher, extra, it.rulesetId);
  }
  if (calldataOnly) { console.log(`${cmd} ${it.rulesetId} -> to ${reg}\n0x${data.replace(/^0x/, '')}`); process.exit(0); }
  if (!key) { console.error('PUBLISHER_KEY not set (or pass --calldata to print what the multisig should send)'); process.exit(1); }
  const cur = decodeTitle(await rpc('eth_call', [titleOfCall(reg, it.rulesetId), 'latest']));
  if (cmd === 'register' && cur.publisher) { console.log(`${it.rulesetId}: already registered by ${cur.publisher}${cur.publisher.toLowerCase() === from.toLowerCase() ? ' (you) — use set-build for another build' : ''}`); await show(); process.exit(cur.publisher.toLowerCase() === from.toLowerCase() ? 0 : 1); }
  if (cmd !== 'register' && cur.publisher && cur.publisher.toLowerCase() !== from.toLowerCase()) { console.error(`${it.rulesetId}: held by ${cur.publisher}, not ${from}`); process.exit(1); }
  if (cmd !== 'register' && !cur.publisher) { console.error(`${it.rulesetId}: not registered — register first`); process.exit(1); }
  if (cmd === 'set-build') { const delay = Number(decodeUint(await rpc('eth_call', [activationDelayCall(reg), 'latest']))); console.log(`retune: activates no earlier than ${delay} s after mining`); }
  const chainId = BigInt(deployed.chainId);
  const [nonce, gasPrice, gas] = await Promise.all([rpc('eth_getTransactionCount', [from, 'pending']), rpc('eth_gasPrice', []), rpc('eth_estimateGas', [{ from, to: reg, data: '0x' + data.replace(/^0x/, '') }])]);
  const raw = signTransaction({ nonce: BigInt(nonce), gasPrice: BigInt(gasPrice) * 12n / 10n, gasLimit: BigInt(gas) * 13n / 10n, to: reg, value: 0n, data: '0x' + data.replace(/^0x/, ''), chainId }, key);
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  let rc = null;
  for (let i = 0; i < 60 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [hash]); if (!rc) await new Promise((r) => setTimeout(r, 1000)); }
  if (!rc || rc.status !== '0x1') throw new Error(`tx ${hash} ${rc ? 'reverted' : 'not mined in 60 s'}`);
  console.log(`${cmd} ${it.rulesetId}${cmd === 'transfer' ? ` → ${extra}` : ''} (tx ${hash})`);
  await show();
  if (cmd === 'register') console.log('next: host it on a node bonded from THIS wallet — the arcade lists a title only while its publisher runs a bonded host (npm run host -- init … --rulesets <file>; bond; publish)');
} catch (e) { const m = String(e?.message ?? e); console.error('✗ ' + m + (/revert/i.test(m) ? ' (a revert here usually means the key does not hold the title, the rulesetId is taken, the build is already registered, or --activates is inside the delay)' : '')); process.exit(1); }
