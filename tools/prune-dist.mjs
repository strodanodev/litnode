#!/usr/bin/env node
/** Prune dist/: keep the packs of the current version and the last KEEP released ones, drop the rest — every
 *  pack ever cut was there (4.4 GB, 22 Sep 2026). Registered zips live on GitHub Releases by hash; nothing here
 *  is the only copy. Dry run by default; --yes deletes. dist/cache (the Node runtime) and release*.json stay.
 *
 *    node tools/prune-dist.mjs            what would go
 *    node tools/prune-dist.mjs --yes      go
 *    node tools/prune-dist.mjs --keep 5   keep more versions */
import { readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const argv = process.argv.slice(2);
const yes = argv.includes('--yes');
const keep = Number(argv[argv.indexOf('--keep') + 1] || 0) || 2;
const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const cmp = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0); return 0; };
const entries = readdirSync(dist).filter((n) => n.startsWith('litnode-'));
const versionOf = (n) => n.match(/-v(\d+\.\d+\.\d+)/)?.[1] ?? null; // dated packs (litnode-portable-2026-09-16) have none: always pruned
const versions = [...new Set(entries.map(versionOf).filter(Boolean))].sort(cmp);
const kept = new Set([current, ...versions.slice(-keep)]);
const size = (p) => { try { const st = statSync(p); if (st.isFile()) return st.size; return readdirSync(p).reduce((a, c) => a + size(join(p, c)), 0); } catch { return 0; } };

let freed = 0;
for (const n of entries) {
  const v = versionOf(n);
  if (v && kept.has(v)) continue;
  const p = join(dist, n);
  const bytes = size(p); freed += bytes;
  console.log(`${yes ? 'removing' : 'would remove'} ${n} (${(bytes / 1e6).toFixed(0)} MB)`);
  if (yes) rmSync(p, { recursive: true, force: true });
}
console.log(`${yes ? 'freed' : 'would free'} ${(freed / 1e9).toFixed(2)} GB; keeping v${[...kept].sort(cmp).join(', v')}${yes ? '' : ' — add --yes to delete'}`);
