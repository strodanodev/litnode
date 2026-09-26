#!/usr/bin/env node
/** Lite guardian worker — spot-checks settled results and reports signed
 *  verdicts (protocol/guardian.js). No stake, no gas, no chain key; the only
 *  secret is a device key it creates on first run.
 *
 *    npm run guardian                                   # local node on :7801
 *    npm run guardian -- --node https://a --node https://b --every 60 --sample 3
 *    npm run guardian -- --once                         # one round, then exit
 *
 *  Fresh peers the given nodes know are checked too (at most 8); --no-discover
 *  checks only the nodes named. --data DIR (default ~/.litnode-guardian) holds
 *  guardian-key.json. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKeypair } from '../protocol/keys.js';
import { checkDelta, reportBody, signReport } from '../protocol/guardian.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const nodes = args.flatMap((a, i) => (a === '--node' && args[i + 1] ? [args[i + 1].replace(/\/+$/, '')] : []));
if (!nodes.length) nodes.push('http://127.0.0.1:7801');
const everyMs = Math.max(10, Number(opt('every', 60))) * 1000;
const sample = Math.max(1, Number(opt('sample', 3)));
const dataDir = opt('data', join(homedir(), '.litnode-guardian'));
const once = args.includes('--once');
const discover = !args.includes('--no-discover');

mkdirSync(dataDir, { recursive: true });
const keyFile = join(dataDir, 'guardian-key.json');
let kp;
if (existsSync(keyFile)) kp = JSON.parse(readFileSync(keyFile, 'utf8'));
else { kp = await generateKeypair(); writeFileSync(keyFile, JSON.stringify(kp), { mode: 0o600 }); }
console.log(`guardian ${kp.publicKey.slice(0, 16)}… → ${nodes.join(', ')} · every ${everyMs / 1000}s · ${sample}/round`);

const checked = new Set();
const getJson = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }); return r.ok ? await r.json() : null; } catch { return null; }
};
const pick = (arr, n) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

async function round(node) {
  const list = (await getJson(`${node}/deltas`))?.deltas;
  if (!list) { console.log(`  ${node} unreachable`); return false; }
  const todo = list.filter((d) => !checked.has(`${node} ${d.matchId} ${d.resultHash}`));
  for (const d of pick(todo, sample)) {
    const ledger = await getJson(`${node}/ledger/${encodeURIComponent(d.matchId)}`);
    const result = await checkDelta(d, ledger);
    const env = await signReport(reportBody(d, result), kp);
    const r = await fetch(`${node}/guardian`, { method: 'POST', body: JSON.stringify(env), signal: AbortSignal.timeout(15_000) })
      .then((x) => x.json()).catch((e) => ({ ok: false, reason: e.message }));
    if (checked.size > 50_000) checked.clear();
    checked.add(`${node} ${d.matchId} ${d.resultHash}`);
    console.log(`  ${d.matchId}  ${result.verdict}${result.failed.length ? ` (${result.failed.join(', ')})` : ''}  ${r.ok ? 'reported' : `not reported: ${r.reason}`}`);
  }
  return true;
}

// A node lists itself among its peers (often under a LAN address), so peers are keyed by nodeId.
async function targets() {
  if (!discover) return nodes;
  const found = [...nodes], seen = new Set();
  for (const node of nodes) {
    const self = (await getJson(`${node}/health`))?.nodeId;
    if (self) seen.add(self);
  }
  for (const node of nodes) {
    for (const p of (await getJson(`${node}/peers`))?.peers ?? []) {
      if (found.length >= nodes.length + 8) break;
      if (!p.fresh || seen.has(p.nodeId) || !/^https?:\/\//.test(p.addr ?? '')) continue;
      seen.add(p.nodeId);
      found.push(p.addr.replace(/\/+$/, ''));
    }
  }
  return found;
}

// While nothing answers (a node still starting), try again in 10 s rather than a full interval.
while (true) {
  let reached = false;
  for (const node of await targets()) reached = (await round(node)) || reached;
  if (once) break;
  await new Promise((r) => setTimeout(r, reached ? everyMs : Math.min(everyMs, 10_000)));
}
