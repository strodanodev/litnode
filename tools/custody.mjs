/** Durable custody of match evidence: export everything a third party needs
 *  to re-verify a node's settled results without that node, and import such
 *  an archive into another node's data directory.
 *
 *    node tools/custody.mjs export <dataDir> <out.tar>      builds, ledgers, deltas, frozen epochs, identity.json's PUBLIC half
 *    node tools/custody.mjs import <archive.tar> <dataDir>  adds what is missing; never overwrites
 *    node tools/custody.mjs verify <dataDir>                every delta's commitment recomputes; every frozen leaf matches
 *
 *  What an archive proves: with the build bytes (hash-pinned), the ledger,
 *  the descriptor envelope and the delta, anyone can replay in the sandbox
 *  and recompute resultHash; with the frozen epoch file, anyone can
 *  recompute the root that was proposed on chain. Nothing here needs the
 *  original host to be alive (audit finding 7: "durable custody of required
 *  builds, assets and match evidence"). Assets a title serves from its own
 *  URL are the title's to keep; the ruleset build is what settlement needs. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resultHash, verification } from '../protocol/result.js';
import { leafOf, buildTree } from '../protocol/epoch.js';
import { h } from '../protocol/canonical.js';

const [cmd, a, b] = process.argv.slice(2);
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const PARTS = ['rulesets', 'ledgers', 'deltas', 'epochs'];

if (cmd === 'export') {
  if (!a || !b) { console.error('usage: custody export <dataDir> <out.tar>'); process.exit(2); }
  const stage = join(tmpdir(), `litnode-custody-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  for (const p of PARTS) if (existsSync(join(a, p))) cpSync(join(a, p), join(stage, p), { recursive: true });
  const id = existsSync(join(a, 'identity.json')) ? JSON.parse(readFileSync(join(a, 'identity.json'), 'utf8')) : null;
  writeFileSync(join(stage, 'NODE.json'), JSON.stringify({ nodeId: id?.publicKey ?? null, exportedAt: new Date().toISOString(), parts: PARTS }, null, 2));
  execFileSync(tar, ['-cf', b, '-C', stage, '.']);
  rmSync(stage, { recursive: true, force: true });
  const n = (p) => (existsSync(join(a, p)) ? readdirSync(join(a, p)).length : 0);
  console.log(`${b}: ${n('rulesets')} build file(s), ${n('ledgers')} ledger(s), ${n('deltas')} delta(s), ${n('epochs')} frozen epoch(s) — node ${id?.publicKey?.slice(0, 12) ?? '?'}… (public key only)`);
} else if (cmd === 'import') {
  if (!a || !b) { console.error('usage: custody import <archive.tar> <dataDir>'); process.exit(2); }
  const stage = join(tmpdir(), `litnode-custody-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  execFileSync(tar, ['-xf', a, '-C', stage]);
  let added = 0, kept = 0;
  for (const p of PARTS) {
    if (!existsSync(join(stage, p))) continue;
    mkdirSync(join(b, p), { recursive: true });
    for (const f of readdirSync(join(stage, p))) { const dst = join(b, p, f); if (existsSync(dst)) kept++; else { cpSync(join(stage, p, f), dst); added++; } }
  }
  rmSync(stage, { recursive: true, force: true });
  console.log(`imported ${added} file(s) into ${b}; ${kept} already present (never overwritten)`);
} else if (cmd === 'verify') {
  if (!a) { console.error('usage: custody verify <dataDir>'); process.exit(2); }
  let bad = 0;
  const deltas = existsSync(join(a, 'deltas')) ? readdirSync(join(a, 'deltas')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(a, 'deltas', f), 'utf8'))) : [];
  for (const d of deltas) {
    const ok = resultHash(d) === d.resultHash;
    const held = d.buildHash && existsSync(join(a, 'rulesets', `${d.buildHash}.mjs`)) && h('ruleset', readFileSync(join(a, 'rulesets', `${d.buildHash}.mjs`), 'utf8')) === d.buildHash;
    const ledger = existsSync(join(a, 'ledgers', `${encodeURIComponent(d.matchId)}.json`));
    if (!ok || !held || !ledger) bad++;
    console.log(`${ok && held && ledger ? ' ok ' : 'BAD '} ${d.matchId.slice(0, 16)}… ${d.rulesetId} ${d.attestation} ${verification(d)}${ok ? '' : ' commitment≠fields'}${held ? '' : ' build-missing'}${ledger ? '' : ' ledger-missing'}`);
  }
  const epochs = existsSync(join(a, 'epochs')) ? readdirSync(join(a, 'epochs')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(a, 'epochs', f), 'utf8'))) : [];
  for (const e of epochs) {
    const byId = new Map(deltas.map((d) => [d.matchId, d]));
    const leaves = e.matches.map((m) => { const d = byId.get(m.matchId); return d ? leafOf(d, { cosigners: m.cosigners, verified: m.verified }) : null; });
    const rootOk = leaves.every(Boolean) && buildTree(leaves).root === e.root && leaves.every((l, i) => l === e.matches[i].leaf);
    if (!rootOk) bad++;
    console.log(`${rootOk ? ' ok ' : 'BAD '} epoch ${e.epoch}: ${e.count} leaves, root ${e.root.slice(0, 16)}… (${e.status})`);
  }
  console.log(`${deltas.length} delta(s), ${epochs.length} frozen epoch(s), ${bad} problem(s)`);
  process.exit(bad ? 1 : 0);
} else { console.error('usage: node tools/custody.mjs export|import|verify …'); process.exit(2); }
