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
import { meshRooms, toSubmission } from './lib/af-submission.mjs';

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
      // A LIT- room means the cabinet placed this match: settle it under the
      // mesh's own match id and the keys it placed, if the node still holds
      // the descriptor (15 min); the relay id otherwise.
      const rooms = row.pin?.room ? await meshRooms(nodeUrl) : new Map();
      const sub = toSubmission(row, { engine, manifest, afRoot: AF_ROOT, rooms });
      const r = await fetch(`${nodeUrl}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
      const d = await r.json();
      if (r.ok) { settled.add(row.match_id); log(`settled ${sub.matchId}${sub.matchId !== row.match_id ? ` (relay ${row.match_id}, room ${sub.source.room})` : ''} · ${d.ticks} ticks · ${d.attestation} · ${sub.source.identity === 'keys' ? sub.participants.map((k) => k.slice(0, 12)).join(' vs ') : sub.hydration.pin.names.join(' vs ')} · ${JSON.stringify(d.scores)}`); }
      else log(`${row.match_id}: node refused: ${d.error}`);
    }
  } catch (e) { log(`watch: ${e.message}`); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
