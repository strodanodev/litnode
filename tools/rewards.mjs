#!/usr/bin/env node
/** Season Zero reward POINTS, computed from the chain (docs/REWARDS.md).
 *  Read-only: sends nothing and pays nothing — there is no rewards contract.
 *
 *    npm run rewards                        sync the scan (cached) and report from the season start
 *    npm run rewards -- --hours 48          the hour table: the last 48 hours that saw work
 *    npm run rewards -- --json              the whole report as JSON (amounts in wei)
 *    npm run rewards -- --min-active 4      what the rules WOULD pay with the gate at 4 (a test, not the season)
 *    npm run rewards -- --pool 50000 --from 2026-09-28T00:00:00Z
 *    npm run rewards -- --no-sync           the cache as it is, no chain reads
 *
 *  Rules and parameters: contracts/deploy.testnet.json → Rewards. The scan
 *  cache is data/rewards/<chainId>.json (git-ignored): the first run reads the
 *  contracts' whole history from the chain (~10 minutes on Liteforge), later
 *  runs only the new blocks. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpcClient, syncRows, entriesFromRows, REWARD_CONTRACTS } from '../protocol/rewards-chain.js';
import { computeRewards, formatWei } from '../protocol/rewards.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const has = (k) => argv.includes(`--${k}`);
const fail = (msg) => { console.error(`rewards: ${msg}`); process.exitCode = 1; };

async function main() {
  const cfg = JSON.parse(readFileSync(join(root, 'contracts', 'deploy.testnet.json'), 'utf8'));
  const deployed = JSON.parse(readFileSync(join(root, 'contracts', 'deployed.testnet.json'), 'utf8'));
  const contracts = Object.fromEntries(REWARD_CONTRACTS.map((n) => [n, { address: deployed[n]?.address, block: deployed[n]?.block ?? 0 }]));
  const params = { ...(cfg.Rewards?.params ?? {}) };
  if (flag('pool')) params.pool = flag('pool');
  if (flag('from')) params.seasonStart = flag('from');
  if (flag('min-active')) params.minActive = Number(flag('min-active'));
  if (flag('count-by')) params.countBy = flag('count-by');
  if (has('no-profiles')) params.quality = { ...params.quality, requireProfiles: false };

  const cacheFile = join(root, 'data', 'rewards', `${deployed.chainId}.json`);
  let cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null;
  if (!has('no-sync')) {
    const client = rpcClient(flag('rpc') ?? deployed.rpc);
    const t0 = Date.now();
    let last = 0;
    const onProgress = (done, total) => { const pct = Math.floor((done / total) * 100); if (!has('json') && pct >= last + 10) { last = pct; process.stderr.write(`  scanning ${pct}% of ${total.toLocaleString('en-US')} blocks\n`); } };
    cache = await syncRows(client, { contracts, chainId: deployed.chainId, cache, onProgress });
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile + '.tmp', JSON.stringify({ chainId: cache.chainId, addresses: cache.addresses, scannedTo: cache.scannedTo, rows: cache.rows }));
    renameSync(cacheFile + '.tmp', cacheFile);
    if (!has('json')) process.stderr.write(`  chain read to block ${cache.scannedTo.toLocaleString('en-US')} (+${cache.added} logs, ${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
  } else if (!cache) return fail('no scan cache yet — run once without --no-sync');

  const report = computeRewards(entriesFromRows(cache.rows, contracts), params);
  if (has('json')) { console.log(JSON.stringify({ scannedTo: cache.scannedTo, ...report }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)); return; }
  print(report, cache, Number(flag('hours') ?? 24));
}

function print(r, cache, showHours) {
  const z = (w) => formatWei(w, 6), p = r.params, g = r.gate;
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
  console.log(`Season Zero points — read-only, nothing is paid (docs/REWARDS.md)`);
  console.log(`pool ${formatWei(r.pool.start)} zkLTC · gate: ${g.minActive}+ active ${g.countBy}s (on-chain work in the last ${g.windowH} h) · half-life ${p.halfLifeDays} d · chain to block ${cache.scannedTo.toLocaleString('en-US')}`);
  console.log('');
  console.log(g.open ? `Now: ${g.activeNow} active ${g.countBy}s → rewards ACTIVE` : `Now: ${g.activeNow} active ${g.countBy}s → rewards PAUSED (they resume at ${g.minActive})`);
  const open = r.hours.filter((h) => h.gate).length;
  console.log(`Since ${r.window.fromAt.slice(0, 16)}Z (${r.window.hours} h): gate open ${open} h, paused ${r.window.hours - open} h · released ${z(r.totals.released)} · paid ${z(r.totals.paid)} · rolled back ${z(r.totals.rolledBack)} · pool left ${z(r.pool.left)} zkLTC`);
  const ex = Object.entries(r.matches.excluded).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`Matches finalized ${r.matches.finalized} · counted ${r.matches.qualifying}${ex ? ` · not counted: ${ex}` : ''}`);
  if (r.forfeits.length) console.log(`Forfeits (operator:week): ${r.forfeits.join(', ')}`);
  console.log('');
  console.log(`${pad('Operator', 14)}${pad('points', 12, true)}${pad('gas back', 12, true)}${pad('host', 11, true)}${pad('witness', 11, true)}${pad('guardian', 11, true)}${pad('duties', 9, true)}${pad('reliability', 13, true)}`);
  for (const o of r.operators) console.log(`${pad(short(o.address), 14)}${pad(z(o.total), 12, true)}${pad(formatWei(o.gas, 9), 12, true)}${pad(z(o.host), 11, true)}${pad(z(o.witness), 11, true)}${pad(z(o.guardian), 11, true)}${pad(`${o.duties.answered}/${o.duties.drawn}`, 9, true)}${pad(`${Math.round(o.reliability * 100)}%`, 13, true)}`);
  if (!r.operators.length) console.log('  (no operator has done on-chain work yet)');
  if (r.publishers.length) {
    console.log('');
    console.log(`${pad('Publisher', 14)}${pad('points', 12, true)}${pad('matches', 9, true)}`);
    for (const x of r.publishers) console.log(`${pad(short(x.address), 14)}${pad(z(x.total), 12, true)}${pad(x.matches, 9, true)}`);
  }
  const busy = r.hours.filter((h) => h.matches || h.released > 0n || h.open).slice(-showHours);
  if (busy.length) {
    console.log('');
    console.log(`${pad('Hour (UTC)', 18)}${pad('active', 8, true)}${pad('gate', 7, true)}${pad('matches', 9, true)}${pad('Q', 8, true)}${pad('m', 7, true)}${pad('released', 12, true)}${pad('paid', 12, true)}`);
    for (const h of busy) console.log(`${pad(h.at.slice(0, 13) + (h.open ? '*' : ''), 18)}${pad(h.active, 8, true)}${pad(h.gate ? 'open' : 'paused', 7, true)}${pad(h.matches, 9, true)}${pad(h.qEff.toFixed(2), 8, true)}${pad(h.m ? h.m.toFixed(2) : '—', 7, true)}${pad(z(h.released), 12, true)}${pad(z(h.paid), 12, true)}`);
    if (busy.some((h) => h.open)) console.log('  * the current hour, still open');
  }
}

main().catch((e) => fail(e.message));
