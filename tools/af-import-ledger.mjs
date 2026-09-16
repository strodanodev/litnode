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

const [t0, t1] = engine.decodeLedger(row.ledger);
const n = Math.min(t0.length, t1.length);
const entries = Array.from({ length: n }, (_, k) => ({ k, inputs: [t0[k] | 0, t1[k] | 0] }));

const pin = row.pin;
const bundles = {};
for (const id of pin.chars) {
  const file = join(AF_ROOT, 'characters', id, 'character.json');
  const bytes = readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const i = pin.chars.indexOf(id);
  if (pin.charDigests?.[i] && pin.charDigests[i] !== digest) console.warn(`WARNING: bundle ${id} retuned since the match (digest differs)`);
  bundles[id] = JSON.parse(bytes.toString('utf8'));
}

const participants = pin.names.map((name) => `af:${name}`); // same player on either side
const submission = {
  matchId: row.match_id, rulesetId: 'agent-fighter.v1', buildHash: manifest.buildHash,
  mode: 'ranked', participants, entries,
  hydration: { pin, bundles },
  expected: pin.result ? { hash: pin.result.hash, winner: pin.result.winner, rounds: pin.result.rounds, endTick: pin.result.endTick, reason: pin.result.reason } : null,
  source: { table: 'match_ledgers', engine: row.engine, protocol: row.protocol, codecVersion: row.codec_version, digest: row.digest, createdAt: row.created_at },
};
const outDir = join(root, 'data', 'ledgers-import');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${row.match_id}.json`);
writeFileSync(out, JSON.stringify(submission));
console.log(`${row.match_id}: ${n} ticks · ${pin.names[0]} (${pin.chars[0]}) vs ${pin.names[1]} (${pin.chars[1]}) · ${pin.result?.reason} · engine ${row.engine}\nwrote ${out}`);

if (post) {
  const r = await fetch(`${post}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
  const j = await r.json();
  console.log(`POST ${post}/ledger → ${r.status}`, JSON.stringify(j).slice(0, 400));
}
