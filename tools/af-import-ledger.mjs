/** Turn a stored Agent Fighter ledger into a litnode settlement submission.
 *
 *    node tools/af-import-ledger.mjs [matchId] [--post http://127.0.0.1:7801]
 *
 *  Reads SUPABASE_URL / SUPABASE_SERVICE_KEY from the Agent Fighter repo's
 *  .env (server-side secrets, never printed), fetches the `match_ledgers`
 *  row, decodes both input tracks with the codec bundled in the ruleset
 *  artifact, embeds the two character bundles the pin names, and writes
 *  data/ledgers-import/<matchId>.json. With --post, submits it to a node. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { meshRooms, toSubmission } from './lib/af-submission.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const AF_ROOT = resolve(process.env.AF_ROOT ?? 'E:/NPC/AGENT FIGHTER/agent-fighter');
const args = process.argv.slice(2);
const post = args.includes('--post') ? args[args.indexOf('--post') + 1] : null;
const matchId = args.find((a) => !a.startsWith('--') && a !== post) ?? null;

const env = {};
for (const l of readFileSync(join(AF_ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m) env[m[1]] = m[2]; }
const url = env.SUPABASE_URL.replace(/\/+$/, '');
const headers = { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
const q = matchId ? `match_id=eq.${encodeURIComponent(matchId)}` : 'order=created_at.desc&limit=1';
const rows = await (await fetch(`${url}/rest/v1/match_ledgers?select=*&${q}`, { headers })).json();
const row = rows[0];
if (!row) { console.error('no ledger found'); process.exit(1); }

const manifest = JSON.parse(readFileSync(join(root, 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { engine } = await import(pathToFileURL(join(root, 'rulesets', 'agent-fighter.v1.js')).href);
if (row.engine !== engine.ENGINE_VERSION) console.warn(`WARNING: ledger engine ${row.engine} ≠ artifact engine ${engine.ENGINE_VERSION}; replay is not expected to reproduce`);

const pin = row.pin;
for (const [i, id] of pin.chars.entries()) {
  const digest = createHash('sha256').update(readFileSync(join(AF_ROOT, 'characters', id, 'character.json'))).digest('hex');
  if (pin.charDigests?.[i] && pin.charDigests[i] !== digest) console.warn(`WARNING: bundle ${id} retuned since the match (digest differs)`);
}
const rooms = post && pin.room ? await meshRooms(post) : new Map();
const submission = toSubmission(row, { engine, manifest, afRoot: AF_ROOT, rooms });
const outDir = join(root, 'data', 'ledgers-import');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${row.match_id}.json`);
writeFileSync(out, JSON.stringify(submission));
console.log(`${row.match_id}${submission.matchId !== row.match_id ? ` → mesh ${submission.matchId}` : ''}: ${submission.entries.length} ticks · ${submission.participants.map((p) => p.slice(0, 16)).join(' vs ')} · ${pin.result?.reason} · engine ${row.engine}
wrote ${out}`);

if (post) {
  const r = await fetch(`${post}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
  const j = await r.json();
  console.log(`POST ${post}/ledger → ${r.status}`, JSON.stringify(j).slice(0, 400));
}
