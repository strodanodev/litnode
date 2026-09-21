#!/usr/bin/env node
/** The fleet, from a terminal — the reference reader of GET /fleet (docs/FLEET-TELEMETRY.md), and a way to put
 *  a handful of extra nodes on this machine to watch the mesh with fewer than ten.
 *
 *    npm run fleet                          watch http://127.0.0.1:7801 (NODE_URL=… for another), 2 s refresh
 *    npm run fleet -- --once | --json       one screen, or the raw signed document
 *    npm run fleet -- spawn --count 3       three more nodes on 7811…, seeded from the watched node, until Ctrl-C
 *                    [--seed URL] [--port 7811] [--roles mesh,witness] [--operator demo] [--rulesets a.js,b.js]
 *
 *  Every read sends a nonce and checks the node key's answer over nonce + digest: the first answer pins the
 *  nodeId (or --node <id> pins it up front); a document another key signed, or one edited in flight, is refused. */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChallenge, newNonce } from '../protocol/challenge.js';
import { h } from '../protocol/canonical.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'watch';
const flag = (k, d = null) => { const i = argv.indexOf(`--${k}`); if (i < 0) return d; const v = argv[i + 1]; return v == null || v.startsWith('--') ? true : v; };
const url = (flag('url') ?? process.env.NODE_URL ?? 'http://127.0.0.1:7801').replace(/\/$/, '');
let pinned = flag('node');

/** GET /fleet?nonce=, verified. Throws on a bad proof — never shows an unverified screen. */
export async function readFleet(base, { expectNodeId = null, fetchImpl = globalThis.fetch } = {}) {
  const nonce = newNonce();
  const r = await fetchImpl(`${base}/fleet?nonce=${nonce}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${base}/fleet: HTTP ${r.status}`);
  const doc = await r.json();
  const { digest, proof, ...body } = doc;
  if (h('fleet', body) !== digest) throw new Error('digest does not match the body');
  const c = await checkChallenge(proof, { expectNodeId: expectNodeId ?? doc.nodeId, nonce, expectDigest: digest });
  if (!c.ok) throw new Error(`proof refused: ${c.reason}`);
  return doc;
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const num = (s, n) => String(s ?? '—').padStart(n).slice(-n);
const ago = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3600_000).toFixed(1)}h`);
const short = (id, n = 10) => (id ? id.slice(0, n) : '—');

export function screen(f) {
  const L = [];
  const s = f.self, c = f.chain, m = f.mesh;
  L.push(`litnode ${s.operator} · ${short(f.nodeId, 12)} · v${f.version} (cabinet ${f.cabinet}) · up ${ago(s.uptimeMs)} · ${s.roles.join(',')} · ${s.bonded ? 'bonded' : s.bonded === false ? 'NOT bonded' : 'bond ?'}${s.eligible ? ' · eligible' : ''} · ${f.at.slice(11, 19)}Z`);
  L.push(`public ${s.addr}${s.tunnel ? ` (${s.tunnel.mode} ${s.tunnel.state})` : ''} · inbound ${s.inbound.reachable === null ? '?' : s.inbound.reachable ? `yes (${s.inbound.peers})` : 'NO'}${s.update?.available ? ` · UPDATE ${s.update.latest} available` : ''}`);
  L.push(`chain ${c.offline ? 'offline' : `head ${c.head ?? '?'} · lag ${c.lagS ?? '?'}s · rpc ${c.rpcMs ?? '?'}ms (last ${c.rpcLastMs ?? '?'}) · ${c.rpcFailures}/${c.rpcCalls} failed`}${c.lastError ? ` · ${c.lastError.slice(0, 60)}` : ''}`);
  if (c.matchBook) { const p = c.matchBook.purse; L.push(`hot key ${short(p.address, 12)} · ${p.balance ?? '?'} zkLTC · ~${p.matchesLeft ?? '?'} matches${p.low ? ' · LOW' : ''} · type-${p.txType ?? '?'} · cursor ${c.matchBook.cursor} · events ${c.matchBook.events} · sends ${c.matchBook.sends} · hosting ${c.matchBook.hosting} · seated ${c.matchBook.seated}${c.matchBook.lastError ? ` · ${c.matchBook.lastError.slice(0, 50)}` : ''}`); }
  L.push(`mesh active ${m.active} · known ${m.known} · bonded ${m.bonded} · eligible ${m.eligible} · incompatible ${m.incompatible} · versions ${Object.entries(m.versions).map(([v, n]) => `${v}×${n}`).join(' ')} · gossip ${m.gossip.outPerMin}↑ ${m.gossip.inPerMin}↓ /min (${(m.gossip.outBytesPerMin / 1024).toFixed(0)}k↑ ${(m.gossip.inBytesPerMin / 1024).toFixed(0)}k↓)${m.unreachable.length ? ` · unreachable ${m.unreachable.length}` : ''}`);
  L.push('');
  L.push(`${pad('peer', 14)}${pad('id', 12)}${pad('ver', 9)}${pad('roles', 20)}${num('age', 5)}${num('rtt', 6)}${num('ema', 6)}${num('loss', 6)}  ${pad('grade', 7)}${pad('bond', 6)}${pad('addr', 40)}`);
  for (const p of [...f.peers].sort((a, b) => b.quality.score - a.quality.score || a.operator.localeCompare(b.operator))) {
    L.push(`${pad(p.operator, 14)}${pad(short(p.nodeId), 12)}${pad(p.version ?? '?', 9)}${pad(p.roles.join(','), 20)}${num(p.ageS + 's', 5)}${num(p.link?.rttMs != null ? p.link.rttMs : '—', 6)}${num(p.link?.emaMs != null ? p.link.emaMs : '—', 6)}${num(p.link?.loss != null ? Math.round(p.link.loss * 100) + '%' : '—', 6)}  ${pad(`${p.quality.grade} ${p.quality.score}`, 7)}${pad(p.bonded === null ? '?' : p.bonded ? 'yes' : 'no', 6)}${pad(p.addr ?? '—', 40)}`);
  }
  if (!f.peers.length) L.push('  (no peers heard yet)');
  L.push('');
  L.push(`rooms ${f.rooms.length}${f.queue.length ? ` · queued ${f.queue.map((q) => `${q.rulesetId}/${q.mode}: ${q.waiting}`).join(', ')}` : ''}`);
  for (const r of f.rooms.slice(-8)) L.push(`  ${pad(r.room, 24)} ${pad(r.rulesetId, 16)} ${pad(r.mode, 7)} ${pad(r.state, 11)} host ${short(r.host)}${r.ours ? '*' : ''} · attests ${r.attests}${r.commitTx && r.commitTx !== 'on-chain' ? ` · ${short(r.commitTx, 12)}` : ''} · ${r.placedAt.slice(11, 19)}Z`);
  if (f.recent.length) L.push(`recent finals: ${f.recent.slice(-5).map((x) => `${short(x.matchId, 10)} ${x.status}${x.at ? ' ' + x.at.slice(11, 16) + 'Z' : ''}`).join(' · ')}`);
  L.push(`titles: ${f.titles.map((t) => `${t.rulesetId} (${t.hosts} host${t.hosts === 1 ? '' : 's'}${t.published ? ', published' : ''})`).join(' · ') || '—'}`);
  L.push('');
  for (const e of f.events.slice(-6)) { const { t, type, ...rest } = e; L.push(`  ${new Date(t).toISOString().slice(11, 19)} ${pad(type, 14)} ${JSON.stringify(rest).slice(0, 100)}`); }
  L.push('');
  L.push(`graph ${f.graph.nodes.length} nodes · ${f.graph.edges.length} edges (${f.graph.edges.filter((e) => e.measured).length} measured here) · digest ${short(f.digest, 12)} · proof ok`);
  return L.join('\n');
}

async function watch() {
  const once = flag('once') || flag('json');
  for (;;) {
    let out;
    try {
      const f = await readFleet(url, { expectNodeId: pinned });
      pinned ??= f.nodeId;
      out = flag('json') ? JSON.stringify(f, null, 2) : screen(f);
    } catch (e) { out = `fleet: ${url} — ${e.message}`; if (flag('json')) { console.error(out); process.exit(1); } }
    if (once) { console.log(out); return; }
    process.stdout.write('\x1b[2J\x1b[H' + out + '\n');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function spawnNodes() {
  const count = Number(flag('count', 3));
  const port0 = Number(flag('port', 7811));
  const op = flag('operator', 'demo');
  const roles = flag('roles', 'mesh,witness');
  const seed = flag('seed', url);
  const rulesets = flag('rulesets', '');
  const kids = [];
  for (let i = 0; i < count; i++) {
    const name = `${op}-${i + 1}`;
    const dataDir = join(root, 'data', 'fleet', name);
    mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, PORT: String(port0 + i), OPERATOR: name, DATA_DIR: dataDir, SEEDS: seed, ROLES: roles, LITNODE_PLAIN: '1', ANNOUNCE: '0', LITNODE_NO_UPDATE: '1', REGION: process.env.REGION ?? 'local' };
    delete env.TUNNEL; delete env.TUNNEL_NAME; delete env.RELAY_PORT; delete env.UPNP;
    if (rulesets) env.RULESETS = rulesets;
    const k = spawn(process.execPath, [join(root, 'node', 'cli.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tag = `[${name}:${port0 + i}]`;
    k.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.log(tag, l); });
    k.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.error(tag, l); });
    k.on('exit', (code) => console.log(tag, `exited ${code}`));
    kids.push(k);
  }
  console.log(`${count} node${count === 1 ? '' : 's'} on ${port0}…${port0 + count - 1}, seeded from ${seed}, roles ${roles}, data under data/fleet/ — Ctrl-C stops them all. Watch with: npm run fleet`);
  const stop = () => { for (const k of kids) k.kill(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('fleet.mjs')) {
  if (cmd === 'spawn') spawnNodes();
  else if (cmd === 'watch') await watch();
  else { console.error('usage: fleet [watch|spawn] …'); process.exit(1); }
}
