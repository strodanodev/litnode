/** Relay-to-mesh glue for Agent Fighter: watch the studio database for
 *  finished matches and settle each one on a node as soon as its ledger
 *  lands. This is what the relay role does until the Agent Fighter server
 *  posts to the node itself.
 *
 *    node tools/af-watch.mjs [nodeUrl]        default http://127.0.0.1:7801
 *
 *  Reads the Agent Fighter .env for the Supabase service key (server-side
 *  secret, never printed). Idempotent: a ledger already settled on the node
 *  is skipped, and a node restart re-settles nothing. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const AF_ROOT = resolve(process.env.AF_ROOT ?? 'E:/NPC/AGENT FIGHTER/agent-fighter');
const nodeUrl = (process.argv[2] ?? 'http://127.0.0.1:7801').replace(/\/+$/, '');
const POLL_MS = Number(process.env.AF_WATCH_MS ?? 5000);

const env = {};
for (const l of readFileSync(join(AF_ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m) env[m[1]] = m[2]; }
const url = env.SUPABASE_URL.replace(/\/+$/, '');
const headers = { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };

const manifest = JSON.parse(readFileSync(join(root, 'rulesets', 'agent-fighter.v1.json'), 'utf8'));
const { engine } = await import(pathToFileURL(join(root, 'rulesets', 'agent-fighter.v1.js')).href);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const bundleFor = (id) => JSON.parse(readFileSync(join(AF_ROOT, 'characters', id, 'character.json'), 'utf8'));
const toSubmission = (row) => {
  const [t0, t1] = engine.decodeLedger(row.ledger);
  const n = Math.min(t0.length, t1.length);
  const pin = row.pin;
  return {
    matchId: row.match_id, rulesetId: 'agent-fighter.v1', buildHash: manifest.buildHash, mode: 'ranked',
    // A player is the same player on either side; no side suffix.
    participants: pin.names.map((name) => `af:${name}`),
    entries: Array.from({ length: n }, (_, k) => ({ k, inputs: [t0[k] | 0, t1[k] | 0] })),
    hydration: { pin, bundles: Object.fromEntries(pin.chars.map((id) => [id, bundleFor(id)])) },
    expected: pin.result ? { hash: pin.result.hash, winner: pin.result.winner, rounds: pin.result.rounds, endTick: pin.result.endTick, reason: pin.result.reason } : null,
    source: { table: 'match_ledgers', engine: row.engine, protocol: row.protocol, codecVersion: row.codec_version, digest: row.digest, createdAt: row.created_at },
  };
};

let since = new Date(Date.now() - 6 * 3600_000).toISOString();
const settled = new Set((await (await fetch(`${nodeUrl}/deltas`)).json()).deltas.map((d) => d.matchId));
log(`watching ${url.replace(/^https?:\/\//, '')} for ledgers → ${nodeUrl} (${settled.size} already settled)`);

for (;;) {
  try {
    const rows = await (await fetch(`${url}/rest/v1/match_ledgers?select=*&created_at=gt.${encodeURIComponent(since)}&order=created_at.asc&limit=20`, { headers })).json();
    for (const row of rows) {
      since = row.created_at;
      if (settled.has(row.match_id)) continue;
      if (row.engine !== engine.ENGINE_VERSION) { log(`${row.match_id}: engine ${row.engine} ≠ ${engine.ENGINE_VERSION}, skipped`); settled.add(row.match_id); continue; }
      const sub = toSubmission(row);
      const r = await fetch(`${nodeUrl}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
      const d = await r.json();
      if (r.ok) { settled.add(row.match_id); log(`settled ${row.match_id} · ${d.ticks} ticks · ${d.attestation} · ${sub.hydration.pin.names.join(' vs ')} · ${JSON.stringify(d.scores)}`); }
      else log(`${row.match_id}: node refused: ${d.error}`);
    }
  } catch (e) { log(`watch: ${e.message}`); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
