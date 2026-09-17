/** Update this install from the latest signed release, with or without a
 *  running node.
 *
 *    node tools/update.mjs            check, and apply if newer
 *    node tools/update.mjs --check    just say
 *    node tools/update.mjs --rollback put the previous build back (.previous/, no network)
 *
 *  RELEASE_CHANNEL=canary (node.env) follows release-canary.json instead.
 *
 *  Same code path as the dashboard's `u` key and the cabinet's Update
 *  button (node/update.js): signed manifest, sha256-checked zip, code
 *  replaced, data/ and node.env untouched. Exits 75 when a restart is
 *  needed so start-node.cmd relaunches the node. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater, RESTART_EXIT } from '../node/update.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const env = {};
try { for (const l of readFileSync(join(root, 'node.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m) env[m[1]] = m[2]; } } catch { /* no node.env */ }
const u = createUpdater({ root, version: pkg.version, channel: process.env.RELEASE_CHANNEL || env.RELEASE_CHANNEL || 'stable', dataDir: process.env.DATA_DIR || env.DATA_DIR || join(root, 'data', env.OPERATOR ?? 'node'), log: (m) => console.log(m) });
if (process.argv.includes('--rollback')) {
  const r = u.rollback();
  console.log(`rolled back ${r.from} → ${r.to}: ${r.changed.join(', ')}`);
  process.exit(RESTART_EXIT);
}
await u.check();
const s = u.status();
if (s.lastError) { console.error(`update check failed: ${s.lastError}`); process.exit(1); }
console.log(`installed ${s.version} · latest ${s.latest}${s.available ? ' — update available' : ' — up to date'}`);
if (!s.available || process.argv.includes('--check')) process.exit(0);
if (s.notes) console.log(`\n${s.notes}\n`);
const r = await u.apply();
console.log(`applied ${r.from} → ${r.to}: ${r.changed.join(', ')}`);
console.log('restart the node to run it (start-node.cmd relaunches automatically; a scheduled task restarts itself).');
process.exit(RESTART_EXIT);
